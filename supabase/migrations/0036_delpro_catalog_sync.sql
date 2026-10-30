-- 0036_delpro_catalog_sync.sql
-- DelPro catalog synchronization, phase 1: DelPro -> GVET, read-only towards
-- DelPro (Priedas Nr. 1 §4 — GVET liga/vaistas <-> DelPro įrašas).
--
-- The farm-PC worker reads DelPro's catalog through the local Gateway SOAP
-- service (GetData; delpro-worker/src/gateway.js) and uploads it here in
-- batches:
--
--   delpro_catalog_begin_run(jsonb)   -> run id
--   delpro_catalog_upload(jsonb)      -> one batch of one object type
--   delpro_catalog_finish_run(jsonb)  -> removals (complete types only) +
--                                        reconciliation
--
-- Five DelPro object types are mirrored in delpro_catalog_items:
--   Drug (Code), DrugParameters (Key), Diagnosis (Code),
--   Treatment (Code), TreatmentDrugUsage (Key).
-- Treatment / TreatmentDrugUsage are DelPro's treatment TEMPLATES (what to
-- give for a diagnosis), not treatment events — GVET's treatments table is
-- never touched here, and animal treatment history is not read or changed.
-- Stock (batches, balances) is never sent as or compared with a DelPro Drug.
--
-- Mapping GVET <-> DelPro (delpro_catalog_links): Diagnosis <-> diseases,
-- Drug <-> products. Never by name alone: an exact (normalized) name match is
-- only a *suggestion* an admin confirms. Links are retired, never deleted.
--
-- Change detection is a per-field three-way compare against the values both
-- sides last agreed on (links.synced_fields):
--   DelPro == GVET                  -> agreed; becomes the new base
--   no base yet, values differ      -> field_difference (admin picks a side)
--   GVET == base, DelPro moved      -> inbound_change (DelPro edited)
--   DelPro == base, GVET moved      -> outbound_pending (GVET edited)
--   both moved apart                -> conflict
-- Applying one side updates the base too, so a change GVET imported from
-- DelPro is never echoed back (no sync loops).
--
-- Withdrawal days and units are clinical data: they are never applied
-- automatically, in either mode. delpro_catalog_inbound_mode = 'auto' only
-- applies name / active substance / active.
--
-- GVET -> DelPro writes (CreateData / UpdateData for catalog records) are NOT
-- part of this migration: outbound_pending issues record what would be sent,
-- and delpro_catalog_write_enabled stays 'false' until the exact Gateway
-- behaviour has been validated on approved test records.
--
-- Single-tenant like the rest of this project: no integration/farm id.

insert into system_settings (setting_key, setting_value, description) values
  ('delpro_catalog_write_enabled', 'false',
   'GVET -> DelPro katalogo rašymas (Drug / Diagnosis / Treatment). Įjungiamas tik ištestavus CreateData/UpdateData su patvirtintais bandomaisiais įrašais.'),
  ('delpro_catalog_inbound_mode', 'review',
   'DelPro -> GVET pakeitimai susietiems įrašams: review (tvirtina administratorius) | auto (pavadinimas, veiklioji medžiaga, aktyvumas taikomi automatiškai; karencija ir vienetai visada tvirtinami ranka).'),
  ('delpro_catalog_sync_requested_at', null,
   'Administratoriaus prašymas sinchronizuoti DelPro katalogą (darbininkas patikrina kas minutę).')
on conflict (setting_key) do nothing;

-- ---------------------------------------------------------------------------
-- Normalization. Exact matching only — no fuzzy matching of clinically
-- sensitive names. Diacritics are kept: "Šluba" and "Sluba" differ.
-- ---------------------------------------------------------------------------

create or replace function fn_delpro_text(p text)
returns text
language sql
immutable
as $$
  select nullif(btrim(regexp_replace(p, '\s+', ' ', 'g')), '');
$$;

create or replace function fn_delpro_norm_name(p text)
returns text
language sql
immutable
as $$
  select lower(fn_delpro_text(p));
$$;

-- A JSON scalar as trimmed text (numbers/booleans as written, null/'' -> null).
create or replace function fn_delpro_scalar(p jsonb)
returns text
language sql
immutable
as $$
  select case jsonb_typeof(p)
    when 'string' then fn_delpro_text(p #>> '{}')
    when 'number' then p #>> '{}'
    when 'boolean' then p #>> '{}'
  end;
$$;

create or replace function fn_delpro_bool(p jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  v text := lower(fn_delpro_scalar(p));
begin
  if v is null then
    return null;
  elsif v in ('true', '1', 'yes') then
    return true;
  elsif v in ('false', '0', 'no') then
    return false;
  end if;
  raise exception 'netinkama loginė reikšmė: %', v;
end;
$$;

create or replace function fn_delpro_num(p jsonb)
returns numeric
language plpgsql
immutable
as $$
declare
  v text := replace(fn_delpro_scalar(p), ',', '.');
begin
  if v is null then
    return null;
  end if;
  if v !~ '^-?[0-9]+(\.[0-9]+)?$' then
    raise exception 'netinkamas skaičius: %', v;
  end if;
  return v::numeric;
end;
$$;

create or replace function fn_delpro_int(p jsonb)
returns integer
language plpgsql
immutable
as $$
declare
  v numeric := fn_delpro_num(p);
begin
  if v is null then
    return null;
  end if;
  if v <> trunc(v) then
    raise exception 'netinkamas sveikasis skaičius: %', v;
  end if;
  return v::integer;
end;
$$;

-- Reference lists (Treatment.DrugUsages): a JSON array or a comma-separated
-- string -> sorted, de-duplicated JSON array of key strings, so the record
-- hash doesn't change when DelPro returns the same list in another order.
create or replace function fn_delpro_keys(p jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(k order by length(k), k), '[]'::jsonb)
  from (
    select distinct fn_delpro_text(k) as k
    from (
      select jsonb_array_elements_text(p) as k where jsonb_typeof(p) = 'array'
      union all
      select regexp_split_to_table(p #>> '{}', ',') where jsonb_typeof(p) in ('string', 'number')
    ) raw
  ) keys
  where k is not null;
$$;

-- DelPro UOM spellings -> one canonical code. Only 'ml' has been seen on this
-- farm's Gateway so far; 'gm'/'pcs' are the codes DelPro uses elsewhere.
create or replace function fn_delpro_uom_canonical(p text)
returns text
language sql
immutable
as $$
  select case lower(fn_delpro_text(p))
    when 'ml' then 'ml'
    when 'g' then 'gm'
    when 'gm' then 'gm'
    when 'gr' then 'gm'
    when 'pcs' then 'pcs'
    when 'pc' then 'pcs'
    when 'vnt' then 'pcs'
    else lower(fn_delpro_text(p))
  end;
$$;

-- GVET unit -> DelPro UOM. Unit-preserving only: l / kg have no DelPro
-- equivalent and come back null (never a silent x1000 conversion).
create or replace function fn_delpro_uom(p_unit unit)
returns text
language sql
immutable
as $$
  select case p_unit::text
    when 'ml' then 'ml'
    when 'g' then 'gm'
    when 'pcs' then 'pcs'
    when 'vnt' then 'pcs'
    when 'tablet' then 'pcs'
    when 'dose' then 'pcs'
  end;
$$;

create or replace function fn_delpro_unit_from_uom(p text)
returns unit
language sql
immutable
as $$
  select case fn_delpro_uom_canonical(p)
    when 'ml' then 'ml'::unit
    when 'gm' then 'g'::unit
    when 'pcs' then 'vnt'::unit
  end;
$$;

-- ---------------------------------------------------------------------------
-- The mirror's normalized field set per object type. The worker sends typed
-- snake_case records (delpro-worker/src/catalog.js); this re-normalizes them
-- so the hash only changes when the data does. Keys are always present (null
-- when DelPro returned an empty property) so the hash is stable.
-- ---------------------------------------------------------------------------

create or replace function fn_delpro_catalog_key_field(p_type text)
returns text
language sql
immutable
as $$
  select case when p_type in ('Drug', 'Diagnosis', 'Treatment') then 'code' else 'key' end;
$$;

create or replace function fn_delpro_catalog_fields(p_type text, r jsonb)
returns jsonb
language plpgsql
immutable
as $$
begin
  case p_type
    when 'Drug' then
      return jsonb_build_object(
        'name', fn_delpro_scalar(r->'name'),
        'active', fn_delpro_bool(r->'active'),
        'medicine_name', fn_delpro_scalar(r->'medicine_name'),
        'active_substance', fn_delpro_scalar(r->'active_substance'),
        'default_parameters', fn_delpro_scalar(r->'default_parameters'));
    when 'DrugParameters' then
      return jsonb_build_object(
        'uom', fn_delpro_scalar(r->'uom'),
        'application_method', fn_delpro_scalar(r->'application_method'),
        'dump_milk_days', fn_delpro_int(r->'dump_milk_days'),
        'meat_withhold_days', fn_delpro_int(r->'meat_withhold_days'));
    when 'Diagnosis' then
      return jsonb_build_object(
        'name', fn_delpro_scalar(r->'name'),
        'active', fn_delpro_bool(r->'active'),
        'recommended_treatment', fn_delpro_scalar(r->'recommended_treatment'));
    when 'Treatment' then
      return jsonb_build_object(
        'name', fn_delpro_scalar(r->'name'),
        'active', fn_delpro_bool(r->'active'),
        'treatment_type', fn_delpro_scalar(r->'treatment_type'),
        'drug_usages', fn_delpro_keys(r->'drug_usages'));
    when 'TreatmentDrugUsage' then
      return jsonb_build_object(
        'treatment', fn_delpro_scalar(r->'treatment'),
        'drug', fn_delpro_scalar(r->'drug'),
        'drug_params', fn_delpro_scalar(r->'drug_params'),
        'dosage', fn_delpro_num(r->'dosage'),
        'frequency', fn_delpro_int(r->'frequency'),
        'treat_cow_days', fn_delpro_int(r->'treat_cow_days'));
    else
      raise exception 'Netinkamas DelPro objekto tipas: %', p_type;
  end case;
end;
$$;

-- References between catalog records (for the broken-reference check and the
-- dependency order the worker reads in).
create or replace function fn_delpro_catalog_refs(p_type text, p_fields jsonb)
returns table (field text, target_type text, target_key text)
language sql
immutable
as $$
  select 'default_parameters', 'DrugParameters', p_fields->>'default_parameters'
  where p_type = 'Drug' and p_fields->>'default_parameters' is not null
  union all
  select 'recommended_treatment', 'Treatment', p_fields->>'recommended_treatment'
  where p_type = 'Diagnosis' and p_fields->>'recommended_treatment' is not null
  union all
  select 'treatment', 'Treatment', p_fields->>'treatment'
  where p_type = 'TreatmentDrugUsage' and p_fields->>'treatment' is not null
  union all
  select 'drug', 'Drug', p_fields->>'drug'
  where p_type = 'TreatmentDrugUsage' and p_fields->>'drug' is not null
  union all
  select 'drug_params', 'DrugParameters', p_fields->>'drug_params'
  where p_type = 'TreatmentDrugUsage' and p_fields->>'drug_params' is not null
  union all
  select 'drug_usages', 'TreatmentDrugUsage', k
  from jsonb_array_elements_text(case when p_type = 'Treatment' then coalesce(p_fields->'drug_usages', '[]'::jsonb) else '[]'::jsonb end) k;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table delpro_catalog_runs (
  id uuid primary key default gen_random_uuid(),
  worker_id text,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  -- per object type: received / inserted / changed / unchanged / invalid /
  -- errors[] / returned / limit / complete / removed / note
  stats jsonb not null default '{}'::jsonb,
  reconcile jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index delpro_catalog_runs_started_at_idx on delpro_catalog_runs (started_at desc);

create table delpro_catalog_items (
  id uuid primary key default gen_random_uuid(),
  object_type text not null check (object_type in ('Drug', 'DrugParameters', 'Diagnosis', 'Treatment', 'TreatmentDrugUsage')),
  delpro_key text not null,
  name text,
  active boolean,
  fields jsonb not null,
  record_hash text not null,
  raw jsonb,
  last_run_id uuid references delpro_catalog_runs (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  changed_at timestamptz not null default now(),
  -- set when a COMPLETE snapshot of the type no longer contains the record;
  -- cleared if it comes back. Rows are never deleted.
  removed_at timestamptz,
  unique (object_type, delpro_key)
);

create table delpro_catalog_links (
  id uuid primary key default gen_random_uuid(),
  object_type text not null check (object_type in ('Diagnosis', 'Drug')),
  delpro_key text not null,
  disease_id uuid references diseases (id) on delete set null,
  product_id uuid references products (id) on delete set null,
  origin text not null check (origin in ('matched', 'manual', 'imported')),
  -- the shared field values both sides last agreed on (base of the 3-way compare)
  synced_fields jsonb,
  synced_hash text generated always as (md5(synced_fields::text)) stored,
  synced_at timestamptz,
  linked_by uuid references users (id) on delete set null,
  linked_at timestamptz not null default now(),
  retired_at timestamptz,
  retired_by uuid references users (id) on delete set null,
  retire_reason text,
  constraint delpro_catalog_links_target_check check (
    retired_at is not null
    or (object_type = 'Diagnosis' and disease_id is not null and product_id is null)
    or (object_type = 'Drug' and product_id is not null and disease_id is null)
  )
);

-- One active link per DelPro record and per GVET record; retired rows are history.
create unique index delpro_catalog_links_active_delpro_key
  on delpro_catalog_links (object_type, delpro_key) where retired_at is null;
create unique index delpro_catalog_links_active_disease_key
  on delpro_catalog_links (disease_id) where retired_at is null and disease_id is not null;
create unique index delpro_catalog_links_active_product_key
  on delpro_catalog_links (product_id) where retired_at is null and product_id is not null;

create table delpro_catalog_issues (
  id uuid primary key default gen_random_uuid(),
  issue_type text not null check (issue_type in (
    'suggested_match', 'ambiguous_match', 'field_difference', 'inbound_change', 'outbound_pending',
    'conflict', 'removed_in_delpro', 'broken_reference', 'clinical_review'
  )),
  object_type text not null,
  delpro_key text,
  link_id uuid references delpro_catalog_links (id) on delete set null,
  gvet_table text check (gvet_table in ('diseases', 'products')),
  gvet_id uuid,
  -- identity + content: the same finding keeps one row; a changed one is new
  fingerprint text not null,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution text,
  resolved_by uuid references users (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A dismissed finding stays dismissed (it is not re-opened by the next sync).
create unique index delpro_catalog_issues_fingerprint_key
  on delpro_catalog_issues (fingerprint) where status in ('open', 'dismissed');
create index delpro_catalog_issues_open_idx on delpro_catalog_issues (issue_type) where status = 'open';

create trigger trg_delpro_catalog_issues_updated_at
  before update on delpro_catalog_issues
  for each row execute function set_updated_at();

-- Deleting a GVET disease/product retires its link (history kept) instead of
-- tripping the target check through the FK's set null.
create or replace function fn_delpro_catalog_retire_links()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update delpro_catalog_links
  set retired_at = now(), retired_by = auth.uid(), retire_reason = 'GVET įrašas ištrintas'
  where retired_at is null and (disease_id = old.id or product_id = old.id);
  return old;
end;
$$;

create trigger trg_diseases_retire_delpro_links
  before delete on diseases
  for each row execute function fn_delpro_catalog_retire_links();
create trigger trg_products_retire_delpro_links
  before delete on products
  for each row execute function fn_delpro_catalog_retire_links();

-- Animal ID mapping for the later Gateway treatment write (CreateData
-- DiagnosesAndTreatmentEvent needs Animal = ObjectGuid).
alter table animals add column delpro_object_guid uuid;
create unique index animals_delpro_object_guid_key on animals (delpro_object_guid) where delpro_object_guid is not null;

-- ---------------------------------------------------------------------------
-- Projections: the shared fields of a link, in the same shape on both sides.
-- A Drug's clinical fields come from its DefaultParameters record and are
-- only compared when DelPro has one. Compared against the product's flat
-- withdrawal days (per-route overrides are GVET-only).
-- ---------------------------------------------------------------------------

create or replace function fn_delpro_catalog_projection(p_type text, p_key text)
returns jsonb
language sql
stable
as $$
  select case
    when i.id is null or i.removed_at is not null then null
    when p_type = 'Diagnosis' then jsonb_build_object('name', i.fields->'name')
    when p_type = 'Drug' then
      jsonb_build_object('name', i.fields->'name', 'active_substance', i.fields->'active_substance')
      || case when i.fields->'active' <> 'null'::jsonb then jsonb_build_object('active', i.fields->'active') else '{}'::jsonb end
      || coalesce((
        select jsonb_build_object(
          'uom', to_jsonb(fn_delpro_uom_canonical(dp.fields->>'uom')),
          'milk_days', dp.fields->'dump_milk_days',
          'meat_days', dp.fields->'meat_withhold_days')
        from delpro_catalog_items dp
        where dp.object_type = 'DrugParameters'
          and dp.delpro_key = i.fields->>'default_parameters'
          and dp.removed_at is null
      ), '{}'::jsonb)
  end
  from (select 1) one
  left join delpro_catalog_items i on i.object_type = p_type and i.delpro_key = p_key;
$$;

create or replace function fn_delpro_gvet_projection(p_disease_id uuid, p_product_id uuid)
returns jsonb
language sql
stable
as $$
  select coalesce(
    (select jsonb_build_object('name', fn_delpro_text(d.name)) from diseases d where d.id = p_disease_id),
    (select jsonb_build_object(
       'name', fn_delpro_text(p.name),
       'active_substance', fn_delpro_text(p.active_substance),
       'active', p.is_active,
       'uom', fn_delpro_uom(p.unit),
       'milk_days', p.withdrawal_days_milk,
       'meat_days', p.withdrawal_days_meat)
     from products p where p.id = p_product_id)
  );
$$;

create or replace function fn_delpro_catalog_type_complete(p_type text)
returns boolean
language sql
stable
as $$
  select coalesce((
    select (r.stats->p_type->>'complete')::boolean
    from delpro_catalog_runs r
    where r.status = 'completed' and r.stats ? p_type
    order by r.started_at desc
    limit 1
  ), false);
$$;

-- Writes one DelPro value into the linked GVET record. Raises (with the
-- reason) instead of guessing: empty values, unknown units, and a unit
-- change on a product that has stock are refused.
create or replace function fn_delpro_apply_field(p_disease_id uuid, p_product_id uuid, p_field text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_text text := fn_delpro_scalar(p_value);
  v_unit unit;
  v_int integer;
begin
  if p_disease_id is not null then
    if p_field <> 'name' then
      raise exception 'Laukas % ligai netaikomas.', p_field;
    end if;
    if v_text is null then
      raise exception 'DelPro pavadinimas tuščias.';
    end if;
    begin
      update diseases set name = v_text where id = p_disease_id;
    exception when unique_violation then
      raise exception 'GVET jau turi ligą pavadinimu „%“.', v_text;
    end;
    return;
  end if;

  case p_field
    when 'name' then
      if v_text is null then
        raise exception 'DelPro pavadinimas tuščias.';
      end if;
      update products set name = v_text where id = p_product_id;
    when 'active_substance' then
      update products set active_substance = v_text where id = p_product_id;
    when 'active' then
      if jsonb_typeof(p_value) <> 'boolean' then
        raise exception 'DelPro aktyvumo reikšmė tuščia.';
      end if;
      update products set is_active = (p_value #>> '{}')::boolean where id = p_product_id;
    when 'uom' then
      v_unit := fn_delpro_unit_from_uom(v_text);
      if v_unit is null then
        raise exception 'DelPro matavimo vienetas „%“ neatpažintas.', coalesce(v_text, '');
      end if;
      if fn_delpro_uom((select unit from products where id = p_product_id)) is distinct from fn_delpro_uom_canonical(v_text) then
        if exists (select 1 from batches where product_id = p_product_id) then
          raise exception 'Produktas turi atsargų partijų — matavimo vieneto keisti negalima. Pakeiskite DelPro arba sukurkite naują produktą.';
        end if;
        update products set unit = v_unit where id = p_product_id;
      end if;
    when 'milk_days', 'meat_days' then
      v_int := fn_delpro_int(p_value);
      if v_int is null or v_int < 0 then
        raise exception 'DelPro karencijos reikšmė tuščia arba neigiama.';
      end if;
      if p_field = 'milk_days' then
        update products set withdrawal_days_milk = v_int where id = p_product_id;
      else
        update products set withdrawal_days_meat = v_int where id = p_product_id;
      end if;
    else
      raise exception 'Nežinomas laukas %.', p_field;
  end case;
end;
$$;

-- ---------------------------------------------------------------------------
-- fn_delpro_catalog_reconcile — full recompute of what needs attention, over
-- the whole mirror and GVET (hundreds of rows; cheap). Run after every
-- catalog upload and after every admin decision. Open issues that no longer
-- apply are closed ('auto'); clinical_review issues are only closed by hand.
-- ---------------------------------------------------------------------------

create or replace function fn_delpro_catalog_reconcile()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_want jsonb := '[]'::jsonb;
  v_mode text := coalesce((select setting_value from system_settings where setting_key = 'delpro_catalog_inbound_mode'), 'review');
  r record;
  l delpro_catalog_links%rowtype;
  k text;
  v_d jsonb;
  v_g jsonb;
  v_b jsonb;
  v_base jsonb;
  v_dv jsonb;
  v_gv jsonb;
  v_bv jsonb;
  v_sets jsonb;
  v_kind text;
  v_gvet_table text;
  v_gvet_id uuid;
  v_gvet_name text;
  v_applied integer := 0;
  v_opened integer := 0;
  v_closed integer := 0;
begin
  -- 1. Unlinked DelPro diagnoses/drugs with a GVET record of the same
  --    normalized name: a suggestion when unique on both sides, else ambiguous.
  for r in
    with cands as (
      select 'Diagnosis'::text as object_type, 'diseases'::text as gvet_table, d.id, d.name, fn_delpro_norm_name(d.name) as norm,
             exists (select 1 from delpro_catalog_links x where x.retired_at is null and x.disease_id = d.id) as linked
      from diseases d
      union all
      select 'Drug', 'products', p.id, p.name, fn_delpro_norm_name(p.name),
             exists (select 1 from delpro_catalog_links x where x.retired_at is null and x.product_id = p.id)
      from products p
      where p.is_active and fn_is_drug_category(p.category)
    ),
    items as (
      select i.object_type, i.delpro_key, i.name, fn_delpro_norm_name(i.name) as norm
      from delpro_catalog_items i
      where i.object_type in ('Diagnosis', 'Drug') and i.removed_at is null
    )
    select i.object_type, i.delpro_key, i.name,
           (select count(*) from items i2 where i2.object_type = i.object_type and i2.norm = i.norm) as same_name_in_delpro,
           (select coalesce(jsonb_agg(jsonb_build_object('gvet_table', c.gvet_table, 'gvet_id', c.id, 'name', c.name, 'linked', c.linked)
                                      order by c.name, c.id), '[]'::jsonb)
            from cands c where c.object_type = i.object_type and c.norm = i.norm) as candidates
    from items i
    where i.norm is not null
      and not exists (
        select 1 from delpro_catalog_links x
        where x.retired_at is null and x.object_type = i.object_type and x.delpro_key = i.delpro_key
      )
  loop
    continue when jsonb_array_length(r.candidates) = 0;
    if r.same_name_in_delpro = 1 and jsonb_array_length(r.candidates) = 1 and not (r.candidates->0->>'linked')::boolean then
      v_want := v_want || jsonb_build_object(
        'fingerprint', format('suggest:%s:%s:%s', r.object_type, r.delpro_key, r.candidates->0->>'gvet_id'),
        'issue_type', 'suggested_match', 'object_type', r.object_type, 'delpro_key', r.delpro_key,
        'gvet_table', r.candidates->0->>'gvet_table', 'gvet_id', r.candidates->0->>'gvet_id',
        'details', jsonb_build_object('delpro_name', r.name, 'candidate', r.candidates->0));
    else
      v_want := v_want || jsonb_build_object(
        'fingerprint', format('ambiguous:%s:%s:%s', r.object_type, r.delpro_key, md5(r.candidates::text || r.same_name_in_delpro::text)),
        'issue_type', 'ambiguous_match', 'object_type', r.object_type, 'delpro_key', r.delpro_key,
        'details', jsonb_build_object('delpro_name', r.name, 'candidates', r.candidates, 'same_name_in_delpro', r.same_name_in_delpro));
    end if;
  end loop;

  -- 2. Active links: three-way compare per shared field.
  for l in select * from delpro_catalog_links where retired_at is null order by linked_at, id
  loop
    v_gvet_table := case when l.disease_id is not null then 'diseases' else 'products' end;
    v_gvet_id := coalesce(l.disease_id, l.product_id);
    v_gvet_name := coalesce((select name from diseases where id = l.disease_id), (select name from products where id = l.product_id));
    v_d := fn_delpro_catalog_projection(l.object_type, l.delpro_key);

    if v_d is null then
      v_want := v_want || jsonb_build_object(
        'fingerprint', 'removed:' || l.id, 'issue_type', 'removed_in_delpro', 'object_type', l.object_type,
        'delpro_key', l.delpro_key, 'link_id', l.id, 'gvet_table', v_gvet_table, 'gvet_id', v_gvet_id,
        'details', jsonb_build_object('gvet_name', v_gvet_name,
          'delpro_name', (select name from delpro_catalog_items where object_type = l.object_type and delpro_key = l.delpro_key)));
      continue;
    end if;

    v_g := fn_delpro_gvet_projection(l.disease_id, l.product_id);
    v_b := l.synced_fields;
    v_base := coalesce(v_b, '{}'::jsonb);
    v_sets := jsonb_build_object('field_difference', '{}'::jsonb, 'inbound_change', '{}'::jsonb,
                                 'outbound_pending', '{}'::jsonb, 'conflict', '{}'::jsonb);

    for k in select jsonb_object_keys(v_d)
    loop
      v_dv := coalesce(v_d->k, 'null'::jsonb);
      v_gv := coalesce(v_g->k, 'null'::jsonb);
      v_bv := v_b->k; -- SQL null: no agreed value for this field yet
      v_kind := null;

      if v_dv = v_gv then
        v_base := v_base || jsonb_build_object(k, v_dv);
      elsif v_bv is null then
        v_kind := 'field_difference';
      elsif v_gv = v_bv then
        v_kind := 'inbound_change';
        if v_mode = 'auto' and k in ('name', 'active_substance', 'active') then
          begin
            perform fn_delpro_apply_field(l.disease_id, l.product_id, k, v_dv);
            v_base := v_base || jsonb_build_object(k, v_dv);
            v_applied := v_applied + 1;
            v_kind := null;
          exception when others then
            v_kind := 'inbound_change'; -- left for the admin, with the same values
          end;
        end if;
      elsif v_dv = v_bv then
        v_kind := 'outbound_pending';
      else
        v_kind := 'conflict';
      end if;

      if v_kind is not null then
        v_sets := jsonb_set(v_sets, array[v_kind],
          (v_sets->v_kind) || jsonb_build_object(k, jsonb_build_object('delpro', v_dv, 'gvet', v_gv, 'synced', v_bv)));
      end if;
    end loop;

    if v_base is distinct from coalesce(v_b, '{}'::jsonb) then
      update delpro_catalog_links set synced_fields = v_base, synced_at = now() where id = l.id;
    end if;

    for v_kind in select key from jsonb_each(v_sets) where value <> '{}'::jsonb
    loop
      v_want := v_want || jsonb_build_object(
        'fingerprint', format('%s:%s:%s', v_kind, l.id, md5((v_sets->v_kind)::text)),
        'issue_type', v_kind, 'object_type', l.object_type, 'delpro_key', l.delpro_key, 'link_id', l.id,
        'gvet_table', v_gvet_table, 'gvet_id', v_gvet_id,
        'details', jsonb_build_object('fields', v_sets->v_kind, 'gvet_name', v_gvet_name, 'delpro_name', v_d->>'name'));
    end loop;
  end loop;

  -- 3. Broken references — only against types whose latest snapshot was
  --    complete (a truncated read must not look like missing records).
  for r in
    with complete as (
      select t, fn_delpro_catalog_type_complete(t) as ok
      from unnest(array['Drug', 'DrugParameters', 'Diagnosis', 'Treatment', 'TreatmentDrugUsage']) t
    )
    select i.object_type, i.delpro_key, i.name,
           jsonb_agg(jsonb_build_object('field', ref.field, 'object_type', ref.target_type, 'key', ref.target_key)
                     order by ref.field, ref.target_key) as missing
    from delpro_catalog_items i
    cross join lateral fn_delpro_catalog_refs(i.object_type, i.fields) ref
    join complete c on c.t = ref.target_type and c.ok
    where i.removed_at is null
      and not exists (
        select 1 from delpro_catalog_items t
        where t.object_type = ref.target_type and t.delpro_key = ref.target_key and t.removed_at is null
      )
    group by i.object_type, i.delpro_key, i.name
  loop
    v_want := v_want || jsonb_build_object(
      'fingerprint', format('ref:%s:%s:%s', r.object_type, r.delpro_key, md5(r.missing::text)),
      'issue_type', 'broken_reference', 'object_type', r.object_type, 'delpro_key', r.delpro_key,
      'details', jsonb_build_object('delpro_name', r.name, 'missing', r.missing));
  end loop;

  -- 4. Sync the issue table with what should be open.
  for r in
    select * from jsonb_to_recordset(v_want)
      as x(fingerprint text, issue_type text, object_type text, delpro_key text, link_id uuid,
           gvet_table text, gvet_id uuid, details jsonb)
  loop
    if exists (select 1 from delpro_catalog_issues where fingerprint = r.fingerprint and status in ('open', 'dismissed')) then
      update delpro_catalog_issues set details = r.details
      where fingerprint = r.fingerprint and status = 'open' and details is distinct from r.details;
    else
      insert into delpro_catalog_issues (issue_type, object_type, delpro_key, link_id, gvet_table, gvet_id, fingerprint, details)
      values (r.issue_type, r.object_type, r.delpro_key, r.link_id, r.gvet_table, r.gvet_id, r.fingerprint, r.details);
      v_opened := v_opened + 1;
    end if;
  end loop;

  update delpro_catalog_issues
  set status = 'resolved', resolution = 'auto', resolved_at = now()
  where status = 'open'
    and issue_type <> 'clinical_review'
    and fingerprint not in (select x->>'fingerprint' from jsonb_array_elements(v_want) x);
  get diagnostics v_closed = row_count;

  return jsonb_build_object(
    'opened', v_opened,
    'closed', v_closed,
    'auto_applied', v_applied,
    'open', (select count(*) from delpro_catalog_issues where status = 'open')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker-facing RPCs (service_role only; unnamed jsonb body, see AGENTS.md).
-- ---------------------------------------------------------------------------

-- delpro_catalog_begin_run(jsonb): { "worker_id": "..." } -> { "run_id": uuid }
-- One worker per farm: a new run supersedes any run still marked running
-- (the worker crashed or the PC was switched off mid-sync).
create or replace function delpro_catalog_begin_run(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_id uuid;
begin
  update delpro_catalog_runs
  set status = 'failed', finished_at = now(), error = coalesce(error, 'Sinchronizacija nebaigta — pradėta nauja.')
  where status = 'running';

  insert into delpro_catalog_runs (worker_id) values (nullif($1->>'worker_id', '')) returning id into v_id;
  update system_settings set setting_value = now()::text where setting_key = 'delpro_worker_last_seen_at';
  return jsonb_build_object('run_id', v_id);
end;
$$;

-- delpro_catalog_upload(jsonb):
--   { "run_id": uuid, "object_type": "Drug", "records": [ {code, name, ...}, ... ] }
-- One bad record is counted (stats.<type>.invalid / errors) and skipped, never
-- aborts the batch.
create or replace function delpro_catalog_upload(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  v_run delpro_catalog_runs%rowtype;
  v_type text := p_body->>'object_type';
  rec jsonb;
  v_key text;
  v_fields jsonb;
  v_hash text;
  v_old record;
  v_now timestamptz := now();
  v_received integer := 0;
  v_inserted integer := 0;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_invalid integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_prev jsonb;
begin
  select * into v_run from delpro_catalog_runs where id = nullif(p_body->>'run_id', '')::uuid for update;
  if v_run.id is null then
    raise exception 'Katalogo sinchronizacija nerasta.';
  end if;
  if v_run.status <> 'running' then
    raise exception 'Katalogo sinchronizacija % jau baigta (status=%).', v_run.id, v_run.status;
  end if;
  if v_type is null or v_type not in ('Drug', 'DrugParameters', 'Diagnosis', 'Treatment', 'TreatmentDrugUsage') then
    raise exception 'Netinkamas DelPro objekto tipas: %', coalesce(v_type, '(nėra)');
  end if;
  if jsonb_typeof(p_body->'records') is distinct from 'array' then
    raise exception 'Laukiamas įrašų sąrašas (records).';
  end if;

  for rec in select * from jsonb_array_elements(p_body->'records')
  loop
    v_received := v_received + 1;
    v_key := null;
    begin
      v_key := fn_delpro_scalar(rec->fn_delpro_catalog_key_field(v_type));
      if v_key is null then
        raise exception 'trūksta rakto (%)', fn_delpro_catalog_key_field(v_type);
      end if;
      v_fields := fn_delpro_catalog_fields(v_type, rec);
      v_hash := md5(v_fields::text);

      select record_hash, removed_at into v_old from delpro_catalog_items where object_type = v_type and delpro_key = v_key;

      insert into delpro_catalog_items as i
        (object_type, delpro_key, name, active, fields, record_hash, raw, last_run_id, first_seen_at, last_seen_at, changed_at)
      values
        (v_type, v_key, v_fields->>'name', (v_fields->>'active')::boolean, v_fields, v_hash, rec, v_run.id, v_now, v_now, v_now)
      on conflict (object_type, delpro_key) do update set
        name = excluded.name,
        active = excluded.active,
        fields = excluded.fields,
        record_hash = excluded.record_hash,
        raw = excluded.raw,
        last_run_id = excluded.last_run_id,
        last_seen_at = excluded.last_seen_at,
        changed_at = case
          when i.record_hash is distinct from excluded.record_hash or i.removed_at is not null then excluded.changed_at
          else i.changed_at
        end,
        removed_at = null;

      if v_old.record_hash is null then
        v_inserted := v_inserted + 1;
      elsif v_old.record_hash <> v_hash or v_old.removed_at is not null then
        v_changed := v_changed + 1;
      else
        v_unchanged := v_unchanged + 1;
      end if;
    exception when others then
      v_invalid := v_invalid + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_object('key', v_key, 'error', sqlerrm);
      end if;
    end;
  end loop;

  v_prev := coalesce(v_run.stats->v_type, '{}'::jsonb);
  update delpro_catalog_runs
  set stats = jsonb_set(stats, array[v_type], v_prev || jsonb_build_object(
    'received', coalesce((v_prev->>'received')::int, 0) + v_received,
    'inserted', coalesce((v_prev->>'inserted')::int, 0) + v_inserted,
    'changed', coalesce((v_prev->>'changed')::int, 0) + v_changed,
    'unchanged', coalesce((v_prev->>'unchanged')::int, 0) + v_unchanged,
    'invalid', coalesce((v_prev->>'invalid')::int, 0) + v_invalid,
    'errors', (
      select coalesce(jsonb_agg(e), '[]'::jsonb)
      from (select e from jsonb_array_elements(coalesce(v_prev->'errors', '[]'::jsonb) || v_errors) e limit 20) x
    )))
  where id = v_run.id;

  return jsonb_build_object('received', v_received, 'inserted', v_inserted, 'changed', v_changed,
                            'unchanged', v_unchanged, 'invalid', v_invalid, 'errors', v_errors);
end;
$$;

-- delpro_catalog_finish_run(jsonb):
--   { "run_id": uuid,
--     "types": { "Drug": { "complete": true, "returned": 117, "limit": 5000 }, ... },
--     "error": "optional — what failed on the farm PC" }
-- Records are marked removed only for a type the worker reports as complete
-- (fewer rows than the requested limit), never on an empty snapshot, and not
-- when it would remove more than half of the type (a broken query looks like
-- that — the run notes it and removes nothing).
create or replace function delpro_catalog_finish_run(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  v_run delpro_catalog_runs%rowtype;
  v_type text;
  v_info jsonb;
  v_complete boolean;
  v_note text;
  v_seen integer;
  v_existing integer;
  v_to_remove integer;
  v_removed integer;
  v_stats jsonb;
  v_reconcile jsonb;
  v_error text := fn_delpro_text(p_body->>'error');
  v_any_seen boolean := false;
  v_status text;
begin
  select * into v_run from delpro_catalog_runs where id = nullif(p_body->>'run_id', '')::uuid for update;
  if v_run.id is null then
    raise exception 'Katalogo sinchronizacija nerasta.';
  end if;
  if v_run.status <> 'running' then
    return jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'stats', v_run.stats, 'reconcile', v_run.reconcile);
  end if;

  v_stats := v_run.stats;
  foreach v_type in array array['DrugParameters', 'Drug', 'TreatmentDrugUsage', 'Treatment', 'Diagnosis']
  loop
    v_info := p_body->'types'->v_type;
    continue when v_info is null and not (v_stats ? v_type);

    v_complete := coalesce((v_info->>'complete')::boolean, false);
    v_note := null;
    v_removed := 0;
    select count(*) into v_seen from delpro_catalog_items where object_type = v_type and last_run_id = v_run.id;
    v_any_seen := v_any_seen or v_seen > 0;

    if v_complete and v_seen = 0 then
      v_complete := false;
      v_note := 'empty_snapshot';
    end if;

    if v_complete then
      select count(*) filter (where last_run_id is distinct from v_run.id), count(*)
      into v_to_remove, v_existing
      from delpro_catalog_items
      where object_type = v_type and removed_at is null;

      if v_to_remove > 10 and v_to_remove * 2 > v_existing then
        v_complete := false;
        v_note := 'mass_removal_refused';
      elsif v_to_remove > 0 then
        update delpro_catalog_items
        set removed_at = now()
        where object_type = v_type and removed_at is null and last_run_id is distinct from v_run.id;
        get diagnostics v_removed = row_count;
      end if;
    end if;

    v_stats := jsonb_set(v_stats, array[v_type], coalesce(v_stats->v_type, '{}'::jsonb) || jsonb_build_object(
      'complete', v_complete,
      'returned', v_info->'returned',
      'limit', v_info->'limit',
      'seen', v_seen,
      'removed', v_removed,
      'note', coalesce(v_note, v_info->>'note')));
  end loop;

  v_status := case when v_error is not null and not v_any_seen then 'failed' else 'completed' end;

  -- The run must be 'completed' before reconciling: type completeness is read
  -- from the latest completed run.
  update delpro_catalog_runs
  set status = v_status, stats = v_stats, error = v_error, finished_at = now()
  where id = v_run.id;

  if v_status = 'completed' then
    v_reconcile := fn_delpro_catalog_reconcile();
    update delpro_catalog_runs set reconcile = v_reconcile where id = v_run.id;
  end if;

  update system_settings set setting_value = null
  where setting_key = 'delpro_catalog_sync_requested_at'
    and nullif(setting_value, '')::timestamptz <= v_run.started_at;
  update system_settings set setting_value = now()::text where setting_key = 'delpro_worker_last_seen_at';

  return jsonb_build_object('run_id', v_run.id, 'status', v_status, 'stats', v_stats, 'reconcile', v_reconcile);
end;
$$;

-- delpro_catalog_sync_requested(jsonb): {} -> true when an admin pressed
-- "Sinchronizuoti dabar" after the latest run started.
create or replace function delpro_catalog_sync_requested(jsonb)
returns boolean
language sql
stable
security invoker
as $$
  select coalesce(
    nullif(s.setting_value, '')::timestamptz
      > coalesce((select max(started_at) from delpro_catalog_runs), '-infinity'::timestamptz),
    false)
  from system_settings s
  where s.setting_key = 'delpro_catalog_sync_requested_at';
$$;

-- delpro_ingest_animal_ids(jsonb):
--   { "run_id": uuid (optional), "animals": [ { "object_guid": uuid, "number": "337" }, ... ] }
-- Gateway Animal.ObjectGuid -> animals.delpro_object_guid, matched on the
-- herd number (animals.animal_no) of ACTIVE animals only (DelPro reuses
-- numbers). Never overwrites a different GUID; a number that is ambiguous on
-- either side (two active GVET animals, or several GUIDs in the payload) is
-- skipped.
create or replace function delpro_ingest_animal_ids(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  elem jsonb;
  v_guid uuid;
  v_no text;
  v_n integer;
  v_id uuid;
  v_current uuid;
  v_received integer := 0;
  v_matched integer := 0;
  v_unchanged integer := 0;
  v_unmatched integer := 0;
  v_ambiguous integer := 0;
  v_conflicts jsonb := '[]'::jsonb;
  v_dup_numbers text[];
  v_result jsonb;
begin
  if jsonb_typeof(p_body->'animals') is distinct from 'array' then
    raise exception 'Laukiamas gyvulių sąrašas (animals).';
  end if;

  -- A number DelPro reports with several GUIDs (reused after an animal left)
  -- can't be resolved here: skip it rather than pick one.
  select coalesce(array_agg(n), '{}') into v_dup_numbers
  from (
    select fn_delpro_text(e->>'number') as n
    from jsonb_array_elements(p_body->'animals') e
    where fn_delpro_text(e->>'number') is not null
    group by 1
    having count(distinct lower(btrim(e->>'object_guid'))) > 1
  ) d;

  for elem in select * from jsonb_array_elements(p_body->'animals')
  loop
    v_received := v_received + 1;
    v_no := fn_delpro_text(elem->>'number');
    begin
      v_guid := nullif(btrim(elem->>'object_guid'), '')::uuid;
    exception when invalid_text_representation then
      v_guid := null;
    end;
    if v_no is null or v_guid is null then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;
    if v_no = any (v_dup_numbers) then
      v_ambiguous := v_ambiguous + 1;
      continue;
    end if;

    select count(*), (array_agg(id))[1] into v_n, v_id
    from animals where active and fn_delpro_text(animal_no) = v_no;

    if v_n = 0 then
      v_unmatched := v_unmatched + 1;
      continue;
    elsif v_n > 1 then
      v_ambiguous := v_ambiguous + 1;
      continue;
    end if;

    select delpro_object_guid into v_current from animals where id = v_id;
    if v_current = v_guid then
      v_unchanged := v_unchanged + 1;
    elsif v_current is not null then
      v_conflicts := v_conflicts || jsonb_build_object('number', v_no, 'reason', 'different_guid_already_set');
    elsif exists (select 1 from animals where delpro_object_guid = v_guid) then
      v_conflicts := v_conflicts || jsonb_build_object('number', v_no, 'reason', 'guid_used_by_other_animal');
    else
      update animals set delpro_object_guid = v_guid where id = v_id;
      v_matched := v_matched + 1;
    end if;
  end loop;

  v_result := jsonb_build_object('received', v_received, 'matched', v_matched, 'unchanged', v_unchanged,
    'unmatched', v_unmatched, 'ambiguous', v_ambiguous, 'conflicts', jsonb_array_length(v_conflicts),
    'conflict_samples', (select coalesce(jsonb_agg(c), '[]'::jsonb) from (select c from jsonb_array_elements(v_conflicts) c limit 20) x));

  if nullif(p_body->>'run_id', '') is not null then
    update delpro_catalog_runs
    set stats = jsonb_set(stats, '{Animal}', v_result)
    where id = (p_body->>'run_id')::uuid and status = 'running';
  end if;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs (SECURITY DEFINER; the catalog tables have no client write
-- policies). Every decision is written to user_audit_logs.
-- ---------------------------------------------------------------------------

create or replace function fn_delpro_catalog_require_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali tvarkyti DelPro katalogo susiejimus.' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- Internal: creates one link (callers check admin + reconcile afterwards).
create or replace function fn_delpro_catalog_create_link(p_object_type text, p_delpro_key text, p_gvet_id uuid, p_origin text, p_synced jsonb default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item delpro_catalog_items%rowtype;
  v_id uuid;
begin
  select * into v_item from delpro_catalog_items where object_type = p_object_type and delpro_key = p_delpro_key;
  if v_item.id is null then
    raise exception 'DelPro įrašas %/% nerastas.', p_object_type, p_delpro_key;
  end if;
  if v_item.removed_at is not null then
    raise exception 'DelPro įrašas „%“ pašalintas iš DelPro — susieti negalima.', coalesce(v_item.name, p_delpro_key);
  end if;

  if p_object_type = 'Diagnosis' then
    if not exists (select 1 from diseases where id = p_gvet_id) then
      raise exception 'GVET liga nerasta.';
    end if;
  elsif p_object_type = 'Drug' then
    if not exists (select 1 from products where id = p_gvet_id and fn_is_drug_category(category)) then
      raise exception 'GVET vaistas nerastas (susieti galima tik vaistus, vakcinas, profilaktikos priemones ir boliusus).';
    end if;
  else
    raise exception 'DelPro % susieti su GVET negalima.', p_object_type;
  end if;

  begin
    insert into delpro_catalog_links (object_type, delpro_key, disease_id, product_id, origin, synced_fields, synced_at, linked_by)
    values (p_object_type, p_delpro_key,
            case when p_object_type = 'Diagnosis' then p_gvet_id end,
            case when p_object_type = 'Drug' then p_gvet_id end,
            p_origin, p_synced, case when p_synced is not null then now() end, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'DelPro įrašas arba GVET įrašas jau susietas. Pirmiausia atsiekite esamą susiejimą.';
  end;

  insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
  values (auth.uid(), 'delpro_catalog_link', 'delpro_catalog_links', v_id,
          jsonb_build_object('object_type', p_object_type, 'delpro_key', p_delpro_key, 'gvet_id', p_gvet_id, 'origin', p_origin));
  return v_id;
end;
$$;

create or replace function delpro_catalog_request_sync()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform fn_delpro_catalog_require_admin();
  update system_settings set setting_value = now()::text where setting_key = 'delpro_catalog_sync_requested_at';
end;
$$;

create or replace function delpro_catalog_link(p_object_type text, p_delpro_key text, p_gvet_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform fn_delpro_catalog_require_admin();
  v_id := fn_delpro_catalog_create_link(p_object_type, p_delpro_key, p_gvet_id, 'manual');
  perform fn_delpro_catalog_reconcile();
  return jsonb_build_object('ok', true, 'link_id', v_id, 'message', 'Susieta.');
end;
$$;

create or replace function delpro_catalog_unlink(p_link_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link delpro_catalog_links%rowtype;
begin
  perform fn_delpro_catalog_require_admin();
  update delpro_catalog_links
  set retired_at = now(), retired_by = auth.uid(), retire_reason = coalesce(fn_delpro_text(p_reason), 'Atsieta administratoriaus')
  where id = p_link_id and retired_at is null
  returning * into v_link;
  if v_link.id is null then
    raise exception 'Aktyvus susiejimas nerastas.';
  end if;

  insert into user_audit_logs (user_id, action, table_name, record_id, old_data)
  values (auth.uid(), 'delpro_catalog_unlink', 'delpro_catalog_links', v_link.id, to_jsonb(v_link));
  perform fn_delpro_catalog_reconcile();
  return jsonb_build_object('ok', true, 'message', 'Susiejimas panaikintas (istorija išsaugota).');
end;
$$;

create or replace function delpro_catalog_confirm_suggestions()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  i delpro_catalog_issues%rowtype;
  v_linked integer := 0;
  v_skipped integer := 0;
begin
  perform fn_delpro_catalog_require_admin();
  for i in select * from delpro_catalog_issues where status = 'open' and issue_type = 'suggested_match' order by created_at for update
  loop
    begin
      perform fn_delpro_catalog_create_link(i.object_type, i.delpro_key, i.gvet_id, 'matched');
      update delpro_catalog_issues set status = 'resolved', resolution = 'confirm', resolved_by = auth.uid(), resolved_at = now()
      where id = i.id;
      v_linked := v_linked + 1;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;
  perform fn_delpro_catalog_reconcile();
  return jsonb_build_object('ok', true, 'linked', v_linked, 'skipped', v_skipped,
    'message', format('Susieta: %s.', v_linked) || case when v_skipped > 0 then format(' Praleista: %s.', v_skipped) else '' end);
end;
$$;

-- delpro_catalog_resolve_issue(issue, action):
--   suggested_match                       confirm | dismiss
--   field_difference / inbound_change /
--   conflict                              take_delpro | keep_gvet | dismiss
--   outbound_pending                      take_delpro | dismiss
--   removed_in_delpro                     unlink | dismiss
--   ambiguous_match / broken_reference    dismiss   (link by hand to resolve an ambiguity)
--   clinical_review                       reviewed
-- take_delpro writes DelPro's CURRENT values into GVET; keep_gvet records
-- DelPro's value as the agreed base, so GVET's differing value becomes an
-- outbound change (sent once catalog writing is enabled).
create or replace function delpro_catalog_resolve_issue(p_issue_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  i delpro_catalog_issues%rowtype;
  l delpro_catalog_links%rowtype;
  v_d jsonb;
  v_base jsonb;
  k text;
  v_allowed text[];
  v_message text;
begin
  perform fn_delpro_catalog_require_admin();

  select * into i from delpro_catalog_issues where id = p_issue_id for update;
  if i.id is null then
    raise exception 'Įrašas nerastas.';
  end if;
  if i.status <> 'open' then
    return jsonb_build_object('ok', true, 'message', 'Jau išspręsta.');
  end if;

  v_allowed := case i.issue_type
    when 'suggested_match' then array['confirm', 'dismiss']
    when 'field_difference' then array['take_delpro', 'keep_gvet', 'dismiss']
    when 'inbound_change' then array['take_delpro', 'keep_gvet', 'dismiss']
    when 'conflict' then array['take_delpro', 'keep_gvet', 'dismiss']
    when 'outbound_pending' then array['take_delpro', 'dismiss']
    when 'removed_in_delpro' then array['unlink', 'dismiss']
    when 'clinical_review' then array['reviewed']
    else array['dismiss']
  end;
  if not (p_action = any (v_allowed)) then
    raise exception 'Veiksmas „%“ šiam įrašui negalimas.', p_action;
  end if;

  if p_action = 'confirm' then
    perform fn_delpro_catalog_create_link(i.object_type, i.delpro_key, i.gvet_id, 'matched');
    v_message := 'Susieta.';
  elsif p_action in ('take_delpro', 'keep_gvet') then
    select * into l from delpro_catalog_links where id = i.link_id and retired_at is null for update;
    if l.id is null then
      raise exception 'Susiejimas nebegalioja — atnaujinkite puslapį.';
    end if;
    v_d := fn_delpro_catalog_projection(l.object_type, l.delpro_key);
    if v_d is null then
      raise exception 'DelPro įrašas pašalintas.';
    end if;
    v_base := coalesce(l.synced_fields, '{}'::jsonb);
    for k in select jsonb_object_keys(i.details->'fields')
    loop
      continue when not (v_d ? k);
      if p_action = 'take_delpro' then
        perform fn_delpro_apply_field(l.disease_id, l.product_id, k, v_d->k);
      end if;
      v_base := v_base || jsonb_build_object(k, v_d->k);
    end loop;
    update delpro_catalog_links set synced_fields = v_base, synced_at = now() where id = l.id;
    v_message := case when p_action = 'take_delpro' then 'GVET atnaujintas pagal DelPro.'
                      else 'Paliktos GVET reikšmės — bus siunčiamos į DelPro, kai katalogo rašymas bus įjungtas.' end;
  elsif p_action = 'unlink' then
    update delpro_catalog_links
    set retired_at = now(), retired_by = auth.uid(), retire_reason = 'Pašalinta iš DelPro'
    where id = i.link_id and retired_at is null;
    v_message := 'Susiejimas panaikintas (istorija išsaugota).';
  else
    v_message := case when p_action = 'reviewed' then 'Pažymėta kaip patikrinta.' else 'Atmesta.' end;
  end if;

  update delpro_catalog_issues
  set status = case when p_action = 'dismiss' then 'dismissed' else 'resolved' end,
      resolution = p_action, resolved_by = auth.uid(), resolved_at = now()
  where id = i.id;

  insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), 'delpro_catalog_' || p_action, 'delpro_catalog_issues', i.id,
          jsonb_build_object('issue_type', i.issue_type, 'details', i.details),
          jsonb_build_object('action', p_action));

  perform fn_delpro_catalog_reconcile();
  return jsonb_build_object('ok', true, 'message', v_message);
end;
$$;

-- delpro_catalog_import(type, keys[]) — creates GVET records for unlinked
-- DelPro diagnoses / drugs and links them ('imported'). Refuses (per key,
-- reported in `skipped`) anything that would duplicate: an existing link, or a
-- GVET record with the same name (link that one instead). A drug needs its
-- DefaultParameters (UOM + withdrawal days) and is created with an open
-- clinical_review issue: the vet confirms the withdrawal days before use.
create or replace function delpro_catalog_import(p_object_type text, p_delpro_keys text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_item delpro_catalog_items%rowtype;
  v_params jsonb;
  v_unit unit;
  v_id uuid;
  v_link uuid;
  v_created integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_reason text;
begin
  perform fn_delpro_catalog_require_admin();
  if p_object_type not in ('Diagnosis', 'Drug') then
    raise exception 'Importuoti galima tik DelPro diagnozes ir vaistus.';
  end if;

  foreach v_key in array coalesce(p_delpro_keys, '{}')
  loop
    v_reason := null;
    select * into v_item from delpro_catalog_items where object_type = p_object_type and delpro_key = v_key;

    if v_item.id is null then
      v_reason := 'DelPro įrašas nerastas';
    elsif v_item.removed_at is not null then
      v_reason := 'pašalintas iš DelPro';
    elsif fn_delpro_text(v_item.name) is null then
      v_reason := 'DelPro įrašas be pavadinimo';
    elsif exists (select 1 from delpro_catalog_links where retired_at is null and object_type = p_object_type and delpro_key = v_key) then
      v_reason := 'jau susietas';
    elsif p_object_type = 'Diagnosis' and exists (select 1 from diseases where fn_delpro_norm_name(name) = fn_delpro_norm_name(v_item.name)) then
      v_reason := 'GVET jau turi ligą tokiu pavadinimu — susiekite ją';
    elsif p_object_type = 'Drug' and exists (
      select 1 from products where fn_is_drug_category(category) and fn_delpro_norm_name(name) = fn_delpro_norm_name(v_item.name)
    ) then
      v_reason := 'GVET jau turi vaistą tokiu pavadinimu — susiekite jį';
    end if;

    if v_reason is null and p_object_type = 'Drug' then
      select dp.fields into v_params
      from delpro_catalog_items dp
      where dp.object_type = 'DrugParameters' and dp.delpro_key = v_item.fields->>'default_parameters' and dp.removed_at is null;
      v_unit := fn_delpro_unit_from_uom(v_params->>'uom');
      if v_params is null then
        v_reason := 'DelPro vaistas neturi numatytų parametrų (UOM, karencija) — sukurkite produktą ranka ir susiekite';
      elsif v_unit is null then
        v_reason := format('DelPro matavimo vienetas „%s“ neatpažintas', coalesce(v_params->>'uom', ''));
      elsif (v_params->>'dump_milk_days') is null or (v_params->>'meat_withhold_days') is null then
        v_reason := 'DelPro neturi karencijos dienų (pienui / mėsai)';
      end if;
    end if;

    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('key', v_key, 'name', v_item.name, 'reason', v_reason);
      continue;
    end if;

    if p_object_type = 'Diagnosis' then
      insert into diseases (name) values (fn_delpro_text(v_item.name)) returning id into v_id;
    else
      insert into products (name, category, unit, active_substance, withdrawal_days_milk, withdrawal_days_meat, is_active)
      values (fn_delpro_text(v_item.name), 'medicines', v_unit, v_item.fields->>'active_substance',
              (v_params->>'dump_milk_days')::int, (v_params->>'meat_withhold_days')::int, coalesce(v_item.active, true))
      returning id into v_id;
    end if;

    v_link := fn_delpro_catalog_create_link(p_object_type, v_key, v_id, 'imported',
                                            fn_delpro_catalog_projection(p_object_type, v_key));

    if p_object_type = 'Drug' then
      insert into delpro_catalog_issues (issue_type, object_type, delpro_key, link_id, gvet_table, gvet_id, fingerprint, details)
      values ('clinical_review', 'Drug', v_key, v_link, 'products', v_id, 'clinical:' || v_link,
              jsonb_build_object('gvet_name', v_item.name, 'delpro_name', v_item.name, 'uom', v_params->>'uom',
                                 'milk_days', v_params->'dump_milk_days', 'meat_days', v_params->'meat_withhold_days',
                                 'application_method', v_params->>'application_method'));
    end if;
    v_created := v_created + 1;
  end loop;

  perform fn_delpro_catalog_reconcile();
  return jsonb_build_object('ok', true, 'created', v_created, 'skipped', v_skipped,
    'message', format('Importuota: %s.', v_created)
               || case when jsonb_array_length(v_skipped) > 0 then format(' Praleista: %s.', jsonb_array_length(v_skipped)) else '' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Read models for the admin screen (security_invoker: RLS of the caller).
-- ---------------------------------------------------------------------------

create view vw_delpro_catalog_items
with (security_invoker = true) as
select
  i.*,
  l.id as link_id,
  l.origin as link_origin,
  l.disease_id,
  l.product_id,
  coalesce(d.name, p.name) as gvet_name
from delpro_catalog_items i
left join delpro_catalog_links l
  on l.retired_at is null and l.object_type = i.object_type and l.delpro_key = i.delpro_key
left join diseases d on d.id = l.disease_id
left join products p on p.id = l.product_id;

create view vw_delpro_catalog_summary
with (security_invoker = true) as
select
  t.object_type,
  count(i.id) filter (where i.removed_at is null)::integer as items,
  count(i.id) filter (where i.removed_at is null and l.id is not null)::integer as linked,
  count(i.id) filter (where i.removed_at is null and l.id is null)::integer as unlinked,
  count(i.id) filter (where i.removed_at is not null)::integer as removed,
  max(i.last_seen_at) as last_seen_at,
  fn_delpro_catalog_type_complete(t.object_type) as complete
from unnest(array['Diagnosis', 'Drug', 'DrugParameters', 'Treatment', 'TreatmentDrugUsage']) as t (object_type)
left join delpro_catalog_items i on i.object_type = t.object_type
left join delpro_catalog_links l
  on l.retired_at is null and l.object_type = i.object_type and l.delpro_key = i.delpro_key
group by t.object_type;

-- GVET diseases / drugs with no DelPro link (later: candidates for creation in DelPro).
create view vw_delpro_catalog_gvet_unlinked
with (security_invoker = true) as
select 'Diagnosis'::text as object_type, 'diseases'::text as gvet_table, d.id as gvet_id, d.name
from diseases d
where not exists (select 1 from delpro_catalog_links l where l.retired_at is null and l.disease_id = d.id)
union all
select 'Drug', 'products', p.id, p.name
from products p
where p.is_active and fn_is_drug_category(p.category)
  and not exists (select 1 from delpro_catalog_links l where l.retired_at is null and l.product_id = p.id);

-- DelPro treatment TEMPLATES with their drug usages resolved (read-only).
-- Usages are found both ways (Treatment.DrugUsages and Usage.Treatment): the
-- Gateway exposes Treatment.DrugUsages read-only, so a later write has to go
-- through the individual TreatmentDrugUsage records.
create view vw_delpro_catalog_treatments
with (security_invoker = true) as
select
  t.delpro_key as code,
  t.name,
  t.active,
  t.fields->>'treatment_type' as treatment_type,
  t.removed_at,
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'key', u.delpro_key,
             'drug_code', u.fields->>'drug',
             'drug_name', dr.name,
             'dosage', u.fields->'dosage',
             'frequency', u.fields->'frequency',
             'treat_cow_days', u.fields->'treat_cow_days',
             'uom', dp.fields->>'uom',
             'application_method', dp.fields->>'application_method',
             'dump_milk_days', dp.fields->'dump_milk_days',
             'meat_withhold_days', dp.fields->'meat_withhold_days')
           order by length(u.delpro_key), u.delpro_key)
    from delpro_catalog_items u
    left join delpro_catalog_items dr on dr.object_type = 'Drug' and dr.delpro_key = u.fields->>'drug'
    left join delpro_catalog_items dp on dp.object_type = 'DrugParameters' and dp.delpro_key = u.fields->>'drug_params'
    where u.object_type = 'TreatmentDrugUsage' and u.removed_at is null
      and (u.fields->>'treatment' = t.delpro_key or coalesce(t.fields->'drug_usages', '[]'::jsonb) ? u.delpro_key)
  ), '[]'::jsonb) as drug_usages,
  (select count(*)::integer from delpro_catalog_items dg
   where dg.object_type = 'Diagnosis' and dg.removed_at is null and dg.fields->>'recommended_treatment' = t.delpro_key) as recommended_for
from delpro_catalog_items t
where t.object_type = 'Treatment';

create view vw_delpro_catalog_issues
with (security_invoker = true) as
select
  iss.*,
  coalesce(iss.details->>'delpro_name', i.name) as delpro_name,
  coalesce(d.name, p.name, iss.details->>'gvet_name') as gvet_name
from delpro_catalog_issues iss
left join delpro_catalog_items i on i.object_type = iss.object_type and i.delpro_key = iss.delpro_key
left join diseases d on iss.gvet_table = 'diseases' and d.id = iss.gvet_id
left join products p on iss.gvet_table = 'products' and p.id = iss.gvet_id;

-- ---------------------------------------------------------------------------
-- Privileges + RLS. Catalog tables: any active user reads, nobody writes
-- through the API — the worker uses service_role (bypasses RLS) and admins
-- go through the SECURITY DEFINER RPCs above.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['delpro_catalog_runs', 'delpro_catalog_items', 'delpro_catalog_links', 'delpro_catalog_issues']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (fn_is_authenticated_active())', t || '_select', t);
  end loop;
end;
$$;

revoke all on function fn_delpro_apply_field(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function fn_delpro_catalog_reconcile() from public, anon, authenticated;
grant execute on function fn_delpro_catalog_reconcile() to service_role; -- delpro_catalog_finish_run (invoker)
revoke all on function fn_delpro_catalog_create_link(text, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function fn_delpro_catalog_retire_links() from public, anon, authenticated;

revoke all on function delpro_catalog_begin_run(jsonb) from public, anon, authenticated;
revoke all on function delpro_catalog_upload(jsonb) from public, anon, authenticated;
revoke all on function delpro_catalog_finish_run(jsonb) from public, anon, authenticated;
revoke all on function delpro_catalog_sync_requested(jsonb) from public, anon, authenticated;
revoke all on function delpro_ingest_animal_ids(jsonb) from public, anon, authenticated;
grant execute on function delpro_catalog_begin_run(jsonb) to service_role;
grant execute on function delpro_catalog_upload(jsonb) to service_role;
grant execute on function delpro_catalog_finish_run(jsonb) to service_role;
grant execute on function delpro_catalog_sync_requested(jsonb) to service_role;
grant execute on function delpro_ingest_animal_ids(jsonb) to service_role;

revoke all on function delpro_catalog_request_sync() from public, anon;
revoke all on function delpro_catalog_link(text, text, uuid) from public, anon;
revoke all on function delpro_catalog_unlink(uuid, text) from public, anon;
revoke all on function delpro_catalog_confirm_suggestions() from public, anon;
revoke all on function delpro_catalog_resolve_issue(uuid, text) from public, anon;
revoke all on function delpro_catalog_import(text, text[]) from public, anon;
grant execute on function delpro_catalog_request_sync() to authenticated;
grant execute on function delpro_catalog_link(text, text, uuid) to authenticated;
grant execute on function delpro_catalog_unlink(uuid, text) to authenticated;
grant execute on function delpro_catalog_confirm_suggestions() to authenticated;
grant execute on function delpro_catalog_resolve_issue(uuid, text) to authenticated;
grant execute on function delpro_catalog_import(text, text[]) to authenticated;

notify pgrst, 'reload schema';

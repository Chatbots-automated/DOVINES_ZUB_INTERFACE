-- 0037_delpro_catalog_write_and_templates.sql
-- DelPro catalog sync, phase 2 (Priedas Nr. 1 §4), on top of 0036:
--
--   A. GVET treatment templates (treatment_templates / _items) — the GVET side
--      of DelPro's Treatment + TreatmentDrugUsage templates, and
--      diseases.recommended_template_id <-> Diagnosis.RecommendedTreatment.
--      Linked, compared and reconciled exactly like diagnoses and drugs.
--   B. GVET -> DelPro catalog writes: delpro_catalog_jobs, a queue of frozen,
--      step-by-step Gateway plans (CreateData / UpdateData) executed by the
--      farm-PC worker with read-back verification. Gated three ways:
--        * system_settings.delpro_catalog_write_enabled = 'true'
--        * the worker's own CATALOG_WRITE_ENABLED=true
--        * the operation (e.g. Drug.create) is in delpro_catalog_validated_operations,
--          which an admin can only add after a TEST job for it (an inactive
--          "GVET TEST ..." record) succeeded and read back correctly.
--      No deletes, ever. A DrugParameters record used by anything else is
--      never edited in place (a new one is created and re-pointed).
--   C. Gateway channel for treatment events (Kairaitienės pattern), built but
--      OFF: delpro_write_channel = 'ui_script' stays the default. With
--      'gateway' a treatment becomes a DiagnosesAndTreatmentEvent (the shape
--      verified on the farm: Animal guid, Diagnosis code, EventDate (UTC),
--      EventTime (local), Comment) carrying a GVET:<job> marker, looked up
--      before any retry whose previous outcome is unknown.

insert into system_settings (setting_key, setting_value, description) values
  ('delpro_catalog_validated_operations', '',
   'Patikrintos DelPro katalogo rašymo operacijos (pvz. Diagnosis.create,Drug.update). Pridedamos tik po sėkmingos bandomosios užduoties.'),
  ('delpro_catalog_outbound_mode', 'manual',
   'GVET -> DelPro katalogo pakeitimai: manual (administratorius spaudžia „Siųsti“) | auto (nauji ir pakeisti GVET įrašai eilėje automatiškai).'),
  ('delpro_write_channel', 'ui_script',
   'Kaip gydymai rašomi į DelPro: ui_script (delpro.ps1 / sql, payload v2) | gateway (DelPro Gateway CreateData DiagnosesAndTreatmentEvent).')
on conflict (setting_key) do nothing;

-- ===========================================================================
-- A. GVET treatment templates
-- ===========================================================================

create table treatment_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  treatment_type text,
  notes text,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index treatment_templates_name_key on treatment_templates (lower(name));

create trigger trg_treatment_templates_updated_at
  before update on treatment_templates
  for each row execute function set_updated_at();

-- One line per medicine: what DelPro keeps in a TreatmentDrugUsage + its
-- DrugParameters. The delpro_* keys are set by import / a successful write.
create table treatment_template_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references treatment_templates (id) on delete cascade,
  sort_order integer not null default 0,
  product_id uuid not null references products (id),
  dosage numeric not null check (dosage > 0),
  frequency integer not null default 1 check (frequency > 0),
  treat_cow_days integer not null default 1 check (treat_cow_days > 0),
  uom text,
  application_method text,
  milk_days integer not null default 0 check (milk_days >= 0),
  meat_days integer not null default 0 check (meat_days >= 0),
  delpro_usage_key text,
  delpro_params_key text,
  created_at timestamptz not null default now()
);

create index treatment_template_items_template_idx on treatment_template_items (template_id, sort_order);

alter table diseases add column recommended_template_id uuid references treatment_templates (id) on delete set null;

alter table treatment_templates enable row level security;
alter table treatment_template_items enable row level security;
create policy treatment_templates_select on treatment_templates for select using (fn_is_authenticated_active());
create policy treatment_template_items_select on treatment_template_items for select using (fn_is_authenticated_active());

-- save_treatment_template(jsonb) — admin / vet. Items are replaced as a set;
-- an item keeps its DelPro keys when its id is sent back.
--   { id?, name, active, treatment_type, notes, disease_ids: [uuid],
--     items: [{ id?, product_id, dosage, frequency, treat_cow_days,
--               uom?, application_method?, milk_days?, meat_days? }] }
-- uom / withdrawal days default to the product's.
create or replace function save_treatment_template(p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_data->>'id', '')::uuid;
  v_name text := fn_delpro_text(p_data->>'name');
  v_item jsonb;
  v_keep uuid[] := '{}';
  v_item_id uuid;
  v_product products%rowtype;
  v_order integer := 0;
begin
  if not fn_can_approve_delpro() then
    raise exception 'Gydymo šablonus tvarko administratorius arba veterinaras.' using errcode = 'insufficient_privilege';
  end if;
  if v_name is null then
    raise exception 'Įveskite šablono pavadinimą.';
  end if;
  if jsonb_typeof(coalesce(p_data->'items', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_data->'items', '[]'::jsonb)) = 0 then
    raise exception 'Šablone turi būti bent vienas vaistas.';
  end if;

  begin
    if v_id is null then
      insert into treatment_templates (name, active, treatment_type, notes, created_by)
      values (v_name, coalesce((p_data->>'active')::boolean, true), fn_delpro_text(p_data->>'treatment_type'),
              fn_delpro_text(p_data->>'notes'), auth.uid())
      returning id into v_id;
    else
      update treatment_templates
      set name = v_name, active = coalesce((p_data->>'active')::boolean, true),
          treatment_type = fn_delpro_text(p_data->>'treatment_type'), notes = fn_delpro_text(p_data->>'notes')
      where id = v_id;
      if not found then
        raise exception 'Šablonas nerastas.';
      end if;
    end if;
  exception when unique_violation then
    raise exception 'Šablonas pavadinimu „%“ jau yra.', v_name;
  end;

  for v_item in select * from jsonb_array_elements(p_data->'items')
  loop
    v_order := v_order + 1;
    select * into v_product from products where id = nullif(v_item->>'product_id', '')::uuid;
    if v_product.id is null then
      raise exception 'Šablono eilutė %: pasirinkite vaistą.', v_order;
    end if;
    if not fn_is_drug_category(v_product.category) then
      raise exception '„%“ nėra vaistas.', v_product.name;
    end if;
    if fn_delpro_num(v_item->'dosage') is null or fn_delpro_num(v_item->'dosage') <= 0 then
      raise exception 'Šablono eilutė % („%“): nurodykite dozę.', v_order, v_product.name;
    end if;

    v_item_id := nullif(v_item->>'id', '')::uuid;
    if v_item_id is not null and exists (select 1 from treatment_template_items where id = v_item_id and template_id = v_id) then
      update treatment_template_items set
        sort_order = v_order,
        product_id = v_product.id,
        dosage = fn_delpro_num(v_item->'dosage'),
        frequency = coalesce(fn_delpro_int(v_item->'frequency'), 1),
        treat_cow_days = coalesce(fn_delpro_int(v_item->'treat_cow_days'), 1),
        uom = coalesce(fn_delpro_text(v_item->>'uom'), fn_delpro_uom(v_product.unit)),
        application_method = fn_delpro_text(v_item->>'application_method'),
        milk_days = coalesce(fn_delpro_int(v_item->'milk_days'), v_product.withdrawal_days_milk),
        meat_days = coalesce(fn_delpro_int(v_item->'meat_days'), v_product.withdrawal_days_meat)
      where id = v_item_id;
    else
      insert into treatment_template_items (template_id, sort_order, product_id, dosage, frequency, treat_cow_days, uom,
                                            application_method, milk_days, meat_days)
      values (v_id, v_order, v_product.id, fn_delpro_num(v_item->'dosage'),
              coalesce(fn_delpro_int(v_item->'frequency'), 1), coalesce(fn_delpro_int(v_item->'treat_cow_days'), 1),
              coalesce(fn_delpro_text(v_item->>'uom'), fn_delpro_uom(v_product.unit)), fn_delpro_text(v_item->>'application_method'),
              coalesce(fn_delpro_int(v_item->'milk_days'), v_product.withdrawal_days_milk),
              coalesce(fn_delpro_int(v_item->'meat_days'), v_product.withdrawal_days_meat))
      returning id into v_item_id;
    end if;
    v_keep := v_keep || v_item_id;
  end loop;

  delete from treatment_template_items where template_id = v_id and not (id = any (v_keep));

  if p_data ? 'disease_ids' then
    update diseases set recommended_template_id = null
    where recommended_template_id = v_id
      and not (id = any (coalesce(array(select jsonb_array_elements_text(p_data->'disease_ids'))::uuid[], '{}')));
    update diseases set recommended_template_id = v_id
    where id = any (coalesce(array(select jsonb_array_elements_text(p_data->'disease_ids'))::uuid[], '{}'));
  end if;

  insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
  values (auth.uid(), 'treatment_template_saved', 'treatment_templates', v_id, p_data);

  perform fn_delpro_catalog_reconcile();
  return v_id;
end;
$$;

-- A template linked to DelPro is not deleted (it would orphan the link); make it inactive instead.
create or replace function delete_treatment_template(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not fn_can_approve_delpro() then
    raise exception 'Gydymo šablonus tvarko administratorius arba veterinaras.' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from delpro_catalog_links where template_id = p_id and retired_at is null) then
    raise exception 'Šablonas susietas su DelPro — pažymėkite jį neaktyviu arba pirmiausia atsiekite.';
  end if;
  delete from treatment_templates where id = p_id;
  insert into user_audit_logs (user_id, action, table_name, record_id) values (auth.uid(), 'treatment_template_deleted', 'treatment_templates', p_id);
end;
$$;

-- ===========================================================================
-- Links / issues: Treatment <-> treatment_templates
-- ===========================================================================

alter table delpro_catalog_links add column template_id uuid references treatment_templates (id) on delete set null;
alter table delpro_catalog_links drop constraint delpro_catalog_links_object_type_check;
alter table delpro_catalog_links add constraint delpro_catalog_links_object_type_check
  check (object_type in ('Diagnosis', 'Drug', 'Treatment'));
alter table delpro_catalog_links drop constraint delpro_catalog_links_origin_check;
alter table delpro_catalog_links add constraint delpro_catalog_links_origin_check
  check (origin in ('matched', 'manual', 'imported', 'created'));
alter table delpro_catalog_links drop constraint delpro_catalog_links_target_check;
alter table delpro_catalog_links add constraint delpro_catalog_links_target_check check (
  retired_at is not null
  or (object_type = 'Diagnosis' and num_nonnulls(disease_id, product_id, template_id) = 1 and disease_id is not null)
  or (object_type = 'Drug' and num_nonnulls(disease_id, product_id, template_id) = 1 and product_id is not null)
  or (object_type = 'Treatment' and num_nonnulls(disease_id, product_id, template_id) = 1 and template_id is not null)
);
create unique index delpro_catalog_links_active_template_key
  on delpro_catalog_links (template_id) where retired_at is null and template_id is not null;

create or replace function fn_delpro_catalog_retire_links()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update delpro_catalog_links
  set retired_at = now(), retired_by = auth.uid(), retire_reason = 'GVET įrašas ištrintas'
  where retired_at is null and (disease_id = old.id or product_id = old.id or template_id = old.id);
  return old;
end;
$$;

create trigger trg_treatment_templates_retire_delpro_links
  before delete on treatment_templates
  for each row execute function fn_delpro_catalog_retire_links();

alter table delpro_catalog_issues drop constraint delpro_catalog_issues_gvet_table_check;
alter table delpro_catalog_issues add constraint delpro_catalog_issues_gvet_table_check
  check (gvet_table in ('diseases', 'products', 'treatment_templates'));

-- ===========================================================================
-- Projections v2: Diagnosis.RecommendedTreatment, Treatment templates
-- ===========================================================================

-- Usage lists are compared as an order-independent set (sorted canonical JSON);
-- drugs by their DelPro Drug code (GVET: the product's link, 'gvet:<id>' if none).
create or replace function fn_delpro_treatment_usages(p_code text)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(e order by e::text), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'drug', u.fields->>'drug',
             'dosage', trim_scale((u.fields->>'dosage')::numeric),
             'frequency', (u.fields->>'frequency')::integer,
             'treat_cow_days', (u.fields->>'treat_cow_days')::integer,
             'uom', fn_delpro_uom_canonical(dp.fields->>'uom'),
             'application_method', dp.fields->>'application_method',
             'milk_days', (dp.fields->>'dump_milk_days')::integer,
             'meat_days', (dp.fields->>'meat_withhold_days')::integer) as e
    from delpro_catalog_items t
    join delpro_catalog_items u
      on u.object_type = 'TreatmentDrugUsage' and u.removed_at is null
     and (u.fields->>'treatment' = t.delpro_key or coalesce(t.fields->'drug_usages', '[]'::jsonb) ? u.delpro_key)
    left join delpro_catalog_items dp
      on dp.object_type = 'DrugParameters' and dp.delpro_key = u.fields->>'drug_params' and dp.removed_at is null
    where t.object_type = 'Treatment' and t.delpro_key = p_code
  ) x;
$$;

create or replace function fn_delpro_template_item_usage(i treatment_template_items)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'drug', coalesce((select l.delpro_key from delpro_catalog_links l where l.retired_at is null and l.product_id = i.product_id),
                     'gvet:' || i.product_id),
    'dosage', trim_scale(i.dosage),
    'frequency', i.frequency,
    'treat_cow_days', i.treat_cow_days,
    'uom', fn_delpro_uom_canonical(i.uom),
    'application_method', fn_delpro_text(i.application_method),
    'milk_days', i.milk_days,
    'meat_days', i.meat_days);
$$;

create or replace function fn_delpro_template_usages(p_template_id uuid)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(fn_delpro_template_item_usage(i) order by fn_delpro_template_item_usage(i)::text), '[]'::jsonb)
  from treatment_template_items i
  where i.template_id = p_template_id;
$$;

create or replace function fn_delpro_catalog_projection(p_type text, p_key text)
returns jsonb
language sql
stable
as $$
  select case
    when i.id is null or i.removed_at is not null then null
    when p_type = 'Diagnosis' then
      jsonb_build_object('name', i.fields->'name', 'recommended_treatment', i.fields->'recommended_treatment')
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
    when p_type = 'Treatment' then
      jsonb_build_object('name', i.fields->'name', 'treatment_type', i.fields->'treatment_type', 'usages', fn_delpro_treatment_usages(p_key))
      || case when i.fields->'active' <> 'null'::jsonb then jsonb_build_object('active', i.fields->'active') else '{}'::jsonb end
  end
  from (select 1) one
  left join delpro_catalog_items i on i.object_type = p_type and i.delpro_key = p_key;
$$;

create or replace function fn_delpro_link_gvet_projection(p_disease_id uuid, p_product_id uuid, p_template_id uuid)
returns jsonb
language sql
stable
as $$
  select coalesce(
    (select jsonb_build_object(
       'name', fn_delpro_text(d.name),
       'recommended_treatment', case when d.recommended_template_id is null then null else coalesce(
         (select l.delpro_key from delpro_catalog_links l where l.retired_at is null and l.template_id = d.recommended_template_id),
         'gvet:' || d.recommended_template_id) end)
     from diseases d where d.id = p_disease_id),
    case when p_product_id is not null then fn_delpro_gvet_projection(null, p_product_id) end,
    (select jsonb_build_object(
       'name', fn_delpro_text(t.name),
       'active', t.active,
       'treatment_type', fn_delpro_text(t.treatment_type),
       'usages', fn_delpro_template_usages(t.id))
     from treatment_templates t where t.id = p_template_id)
  );
$$;

-- Rebuilds a GVET template's lines from the linked DelPro Treatment (take DelPro / import).
create or replace function fn_delpro_template_items_from_delpro(p_template_id uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_product uuid;
  v_order integer := 0;
begin
  delete from treatment_template_items where template_id = p_template_id;
  for r in
    select u.delpro_key as usage_key, u.fields as uf, dp.delpro_key as params_key, dp.fields as pf, dr.name as drug_name
    from delpro_catalog_items t
    join delpro_catalog_items u
      on u.object_type = 'TreatmentDrugUsage' and u.removed_at is null
     and (u.fields->>'treatment' = t.delpro_key or coalesce(t.fields->'drug_usages', '[]'::jsonb) ? u.delpro_key)
    left join delpro_catalog_items dp on dp.object_type = 'DrugParameters' and dp.delpro_key = u.fields->>'drug_params' and dp.removed_at is null
    left join delpro_catalog_items dr on dr.object_type = 'Drug' and dr.delpro_key = u.fields->>'drug'
    where t.object_type = 'Treatment' and t.delpro_key = p_code
    order by length(u.delpro_key), u.delpro_key
  loop
    v_order := v_order + 1;
    select product_id into v_product from delpro_catalog_links
    where retired_at is null and object_type = 'Drug' and delpro_key = r.uf->>'drug';
    if v_product is null then
      raise exception 'DelPro vaistas „%“ (%) nesusietas su GVET produktu — pirmiausia susiekite arba importuokite jį.',
        coalesce(r.drug_name, '?'), coalesce(r.uf->>'drug', '?');
    end if;
    if (r.uf->>'dosage') is null then
      raise exception 'DelPro šablono vaisto „%“ dozė tuščia.', coalesce(r.drug_name, '?');
    end if;
    if r.pf is null or (r.pf->>'dump_milk_days') is null or (r.pf->>'meat_withhold_days') is null then
      raise exception 'DelPro šablono vaisto „%“ parametrai (karencija) tušti.', coalesce(r.drug_name, '?');
    end if;
    insert into treatment_template_items (template_id, sort_order, product_id, dosage, frequency, treat_cow_days, uom,
                                          application_method, milk_days, meat_days, delpro_usage_key, delpro_params_key)
    values (p_template_id, v_order, v_product, (r.uf->>'dosage')::numeric,
            coalesce((r.uf->>'frequency')::integer, 1), coalesce((r.uf->>'treat_cow_days')::integer, 1),
            r.pf->>'uom', r.pf->>'application_method', (r.pf->>'dump_milk_days')::integer, (r.pf->>'meat_withhold_days')::integer,
            r.usage_key, r.params_key);
  end loop;
end;
$$;

-- Applies one DelPro value to whatever GVET record the link points at.
create or replace function fn_delpro_apply_link_field(p_link_id uuid, p_field text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l delpro_catalog_links%rowtype;
  v_text text := fn_delpro_scalar(p_value);
  v_template uuid;
begin
  select * into l from delpro_catalog_links where id = p_link_id;

  if l.disease_id is not null and p_field = 'recommended_treatment' then
    if v_text is null then
      update diseases set recommended_template_id = null where id = l.disease_id;
      return;
    end if;
    select template_id into v_template from delpro_catalog_links
    where retired_at is null and object_type = 'Treatment' and delpro_key = v_text;
    if v_template is null then
      raise exception 'DelPro gydymo šablonas % nesusietas su GVET šablonu — pirmiausia susiekite arba importuokite jį.', v_text;
    end if;
    update diseases set recommended_template_id = v_template where id = l.disease_id;
    return;
  end if;

  if l.template_id is not null then
    case p_field
      when 'name' then
        if v_text is null then
          raise exception 'DelPro pavadinimas tuščias.';
        end if;
        begin
          update treatment_templates set name = v_text where id = l.template_id;
        exception when unique_violation then
          raise exception 'GVET jau turi šabloną pavadinimu „%“.', v_text;
        end;
      when 'active' then
        if jsonb_typeof(p_value) <> 'boolean' then
          raise exception 'DelPro aktyvumo reikšmė tuščia.';
        end if;
        update treatment_templates set active = (p_value #>> '{}')::boolean where id = l.template_id;
      when 'treatment_type' then
        update treatment_templates set treatment_type = v_text where id = l.template_id;
      when 'usages' then
        perform fn_delpro_template_items_from_delpro(l.template_id, l.delpro_key);
      else
        raise exception 'Nežinomas laukas %.', p_field;
    end case;
    return;
  end if;

  perform fn_delpro_apply_field(l.disease_id, l.product_id, p_field, p_value);
end;
$$;

-- ===========================================================================
-- B. delpro_catalog_jobs — GVET -> DelPro catalog writes
-- ===========================================================================
-- steps (frozen at enqueue), executed in order by the worker:
--   { "id": "params", "object": "DrugParameters", "operation": "create" | "update",
--     "key_property": "Key", "key": "218" (update only),
--     "lookup_name": "..." (create of a named record: same-name DelPro records are
--                           listed as review candidates when the outcome is unknown),
--     "item_id": uuid (template line the created usage/params belong to),
--     "properties": [ { "name": "UOM", "value": "ml" },
--                     { "name": "Drug", "object_type": "Drug", "value": "7" },
--                     { "name": "DrugParams", "object_type": "DrugParameters", "ref_step": "params" } ] }
--   { "id": "verify", "operation": "verify_refs", "object": "Treatment", "ref_step": "main",
--     "property": "DrugUsages", "expect_steps": ["usage_1", ...] }
-- progress: { step_id: { started_at, key?, done_at? } } — reported by the worker
-- BEFORE (start) and AFTER (done) each write. A step started but never done
-- has an unknown outcome: never re-sent or adopted by name — needs_review
-- until an admin adopts a DelPro record or confirms a resend (job_action).

create table delpro_catalog_jobs (
  id uuid primary key default gen_random_uuid(),
  object_type text not null check (object_type in ('Diagnosis', 'Drug', 'Treatment')),
  operation text not null check (operation in ('create', 'update')),
  is_test boolean not null default false,
  link_id uuid references delpro_catalog_links (id) on delete set null,
  disease_id uuid references diseases (id) on delete set null,
  product_id uuid references products (id) on delete set null,
  template_id uuid references treatment_templates (id) on delete set null,
  delpro_key text,
  label text,
  steps jsonb not null,
  gvet_values jsonb,
  progress jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in (
    'queued', 'processing', 'success', 'failed', 'verification_failed', 'needs_review', 'cancelled'
  )),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz,
  worker_id text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  readback jsonb,
  error text,
  error_details jsonb,
  validated_at timestamptz,
  validated_by uuid references users (id) on delete set null,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index delpro_catalog_jobs_active_entity_key
  on delpro_catalog_jobs (object_type, coalesce(disease_id, product_id, template_id))
  where status in ('queued', 'processing') and not is_test;
create index delpro_catalog_jobs_claimable_idx on delpro_catalog_jobs (created_at) where status = 'queued';

create trigger trg_delpro_catalog_jobs_updated_at
  before update on delpro_catalog_jobs
  for each row execute function set_updated_at();

alter table delpro_catalog_jobs enable row level security;
create policy delpro_catalog_jobs_select on delpro_catalog_jobs for select using (fn_is_authenticated_active());

-- Step builders -------------------------------------------------------------

create or replace function fn_dp_prop(p_name text, p_value jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('name', p_name, 'value', coalesce(p_value, 'null'::jsonb));
$$;

create or replace function fn_dp_ref(p_name text, p_object_type text, p_key text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('name', p_name, 'object_type', p_object_type, 'value', to_jsonb(p_key));
$$;

create or replace function fn_dp_ref_step(p_name text, p_object_type text, p_step text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('name', p_name, 'object_type', p_object_type, 'ref_step', p_step);
$$;

create or replace function fn_dp_step(p_id text, p_object text, p_operation text, p_properties jsonb,
                                      p_key text default null, p_lookup_name text default null, p_item_id uuid default null)
returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_id, 'object', p_object, 'operation', p_operation,
    'key_property', case when p_object in ('DrugParameters', 'TreatmentDrugUsage') then 'Key' else 'Code' end,
    'key', p_key, 'lookup_name', p_lookup_name, 'item_id', p_item_id)) || jsonb_build_object('properties', p_properties);
$$;

-- How many live DelPro records reference a DrugParameters record.
create or replace function fn_delpro_params_refcount(p_key text)
returns integer language sql stable as $$
  select count(*)::integer from delpro_catalog_items
  where removed_at is null
    and ((object_type = 'Drug' and fields->>'default_parameters' = p_key)
      or (object_type = 'TreatmentDrugUsage' and fields->>'drug_params' = p_key));
$$;

create or replace function fn_delpro_params_props(p_uom text, p_application_method text, p_milk integer, p_meat integer)
returns jsonb language sql immutable as $$
  select jsonb_build_array(fn_dp_prop('UOM', to_jsonb(p_uom)))
    || case when p_application_method is not null then jsonb_build_array(fn_dp_prop('ApplicationMethod', to_jsonb(p_application_method))) else '[]'::jsonb end
    || jsonb_build_array(fn_dp_prop('DumpMilkDays', to_jsonb(p_milk)), fn_dp_prop('MeatWithholdDays', to_jsonb(p_meat)));
$$;

-- RecommendedTreatment value for a GVET disease (null, a linked Treatment code, or an error).
create or replace function fn_delpro_recommended_code(p_disease_id uuid)
returns text language plpgsql stable as $$
declare
  v_template uuid;
  v_code text;
begin
  select recommended_template_id into v_template from diseases where id = p_disease_id;
  if v_template is null then
    return null;
  end if;
  select delpro_key into v_code from delpro_catalog_links where retired_at is null and template_id = v_template;
  if v_code is null then
    raise exception 'Ligos rekomenduojamas šablonas dar nesusietas su DelPro — pirmiausia sukurkite / susiekite šabloną.';
  end if;
  return v_code;
end;
$$;

-- Plan for creating a GVET record in DelPro. Returns { steps, gvet_values, label }.
create or replace function fn_delpro_catalog_plan_create(p_object_type text, p_gvet_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  d diseases%rowtype;
  p products%rowtype;
  t treatment_templates%rowtype;
  i treatment_template_items%rowtype;
  v_steps jsonb := '[]'::jsonb;
  v_uom text;
  v_code text;
  v_drug text;
  v_n integer := 0;
  v_usages text[] := '{}';
begin
  if p_object_type = 'Diagnosis' then
    select * into d from diseases where id = p_gvet_id;
    if d.id is null then raise exception 'GVET liga nerasta.'; end if;
    v_code := fn_delpro_recommended_code(d.id);
    v_steps := jsonb_build_array(fn_dp_step('main', 'Diagnosis', 'create',
      jsonb_build_array(fn_dp_prop('Name', to_jsonb(fn_delpro_text(d.name))), fn_dp_prop('Active', 'true'::jsonb))
      || case when v_code is not null then jsonb_build_array(fn_dp_ref('RecommendedTreatment', 'Treatment', v_code)) else '[]'::jsonb end,
      null, fn_delpro_text(d.name)));
    return jsonb_build_object('steps', v_steps, 'label', d.name,
      'gvet_values', fn_delpro_link_gvet_projection(d.id, null, null));

  elsif p_object_type = 'Drug' then
    select * into p from products where id = p_gvet_id;
    if p.id is null or not fn_is_drug_category(p.category) then raise exception 'GVET vaistas nerastas.'; end if;
    v_uom := fn_delpro_uom(p.unit);
    if v_uom is null then
      raise exception 'Produkto „%“ matavimo vienetas (%) neturi DelPro atitikmens.', p.name, p.unit;
    end if;
    v_steps := jsonb_build_array(
      fn_dp_step('params', 'DrugParameters', 'create', fn_delpro_params_props(v_uom, null, p.withdrawal_days_milk, p.withdrawal_days_meat)),
      fn_dp_step('main', 'Drug', 'create',
        jsonb_build_array(fn_dp_prop('Name', to_jsonb(fn_delpro_text(p.name))), fn_dp_prop('Active', to_jsonb(p.is_active)))
        || case when fn_delpro_text(p.active_substance) is not null
                then jsonb_build_array(fn_dp_prop('ActiveSubstance', to_jsonb(fn_delpro_text(p.active_substance)))) else '[]'::jsonb end
        || jsonb_build_array(fn_dp_ref_step('DefaultParameters', 'DrugParameters', 'params')),
        null, fn_delpro_text(p.name)));
    return jsonb_build_object('steps', v_steps, 'label', p.name,
      'gvet_values', fn_delpro_link_gvet_projection(null, p.id, null));

  elsif p_object_type = 'Treatment' then
    select * into t from treatment_templates where id = p_gvet_id;
    if t.id is null then raise exception 'GVET šablonas nerastas.'; end if;
    v_steps := jsonb_build_array(fn_dp_step('main', 'Treatment', 'create',
      jsonb_build_array(fn_dp_prop('Name', to_jsonb(fn_delpro_text(t.name))), fn_dp_prop('Active', to_jsonb(t.active)))
      || case when fn_delpro_text(t.treatment_type) is not null
              then jsonb_build_array(fn_dp_prop('TreatmentType', to_jsonb(fn_delpro_text(t.treatment_type)))) else '[]'::jsonb end,
      null, fn_delpro_text(t.name)));
    for i in select * from treatment_template_items where template_id = t.id order by sort_order, created_at
    loop
      v_n := v_n + 1;
      select l.delpro_key into v_drug from delpro_catalog_links l where l.retired_at is null and l.product_id = i.product_id;
      if v_drug is null then
        raise exception 'Šablono vaistas „%“ nesusietas su DelPro vaistu — pirmiausia sukurkite / susiekite jį.',
          (select name from products where id = i.product_id);
      end if;
      v_steps := v_steps
        || fn_dp_step('params_' || v_n, 'DrugParameters', 'create',
             fn_delpro_params_props(fn_delpro_uom_canonical(i.uom), fn_delpro_text(i.application_method), i.milk_days, i.meat_days),
             null, null, i.id)
        || fn_dp_step('usage_' || v_n, 'TreatmentDrugUsage', 'create', jsonb_build_array(
             fn_dp_ref_step('Treatment', 'Treatment', 'main'),
             fn_dp_ref('Drug', 'Drug', v_drug),
             fn_dp_ref_step('DrugParams', 'DrugParameters', 'params_' || v_n),
             fn_dp_prop('Dosage', to_jsonb(trim_scale(i.dosage))),
             fn_dp_prop('Frequency', to_jsonb(i.frequency)),
             fn_dp_prop('TreatCowDays', to_jsonb(i.treat_cow_days))),
             null, null, i.id);
      v_usages := v_usages || ('usage_' || v_n);
    end loop;
    if v_n = 0 then raise exception 'Šablonas be vaistų.'; end if;
    v_steps := v_steps || jsonb_build_object('id', 'verify', 'operation', 'verify_refs', 'object', 'Treatment', 'key_property', 'Code',
      'ref_step', 'main', 'property', 'DrugUsages', 'expect_steps', to_jsonb(v_usages));
    return jsonb_build_object('steps', v_steps, 'label', t.name,
      'gvet_values', fn_delpro_link_gvet_projection(null, null, t.id));
  end if;
  raise exception 'Netinkamas tipas %.', p_object_type;
end;
$$;

-- Plan for sending a linked GVET record's differing fields to DelPro.
create or replace function fn_delpro_catalog_plan_update(p_link_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  l delpro_catalog_links%rowtype;
  v_d jsonb;
  v_g jsonb;
  k text;
  v_changed text[] := '{}';
  v_props jsonb := '[]'::jsonb;
  v_steps jsonb := '[]'::jsonb;
  v_item delpro_catalog_items%rowtype;
  v_params text;
  v_clinical jsonb := '[]'::jsonb;
  p products%rowtype;
  i treatment_template_items%rowtype;
  v_n integer := 0;
  v_drug text;
  v_existing jsonb;
  v_usages text[] := '{}';
  v_label text;
begin
  select * into l from delpro_catalog_links where id = p_link_id and retired_at is null;
  if l.id is null then raise exception 'Susiejimas nerastas.'; end if;
  v_d := fn_delpro_catalog_projection(l.object_type, l.delpro_key);
  if v_d is null then raise exception 'DelPro įrašas pašalintas.'; end if;
  v_g := fn_delpro_link_gvet_projection(l.disease_id, l.product_id, l.template_id);
  select * into v_item from delpro_catalog_items where object_type = l.object_type and delpro_key = l.delpro_key;
  v_label := v_item.name;

  for k in select jsonb_object_keys(v_d) loop
    if coalesce(v_d->k, 'null'::jsonb) <> coalesce(v_g->k, 'null'::jsonb) then
      v_changed := v_changed || k;
    end if;
  end loop;
  if cardinality(v_changed) = 0 then
    raise exception 'GVET ir DelPro reikšmės sutampa — nėra ką siųsti.';
  end if;

  if l.object_type = 'Diagnosis' then
    if 'name' = any (v_changed) then v_props := v_props || fn_dp_prop('Name', v_g->'name'); end if;
    if 'recommended_treatment' = any (v_changed) then
      v_props := v_props || fn_dp_ref('RecommendedTreatment', 'Treatment', fn_delpro_recommended_code(l.disease_id));
    end if;
    v_steps := jsonb_build_array(fn_dp_step('main', 'Diagnosis', 'update', v_props, l.delpro_key));

  elsif l.object_type = 'Drug' then
    select * into p from products where id = l.product_id;
    if 'name' = any (v_changed) then v_props := v_props || fn_dp_prop('Name', v_g->'name'); end if;
    if 'active_substance' = any (v_changed) then v_props := v_props || fn_dp_prop('ActiveSubstance', v_g->'active_substance'); end if;
    if 'active' = any (v_changed) then v_props := v_props || fn_dp_prop('Active', v_g->'active'); end if;
    if v_changed && array['uom', 'milk_days', 'meat_days'] then
      if v_g->>'uom' is null then
        raise exception 'Produkto „%“ matavimo vienetas neturi DelPro atitikmens.', p.name;
      end if;
      v_params := v_item.fields->>'default_parameters';
      if fn_delpro_params_refcount(v_params) > 1 then
        -- shared parameters: never edit in place — new record, re-point the drug
        v_steps := v_steps || fn_dp_step('params', 'DrugParameters', 'create',
          fn_delpro_params_props(v_g->>'uom', null, p.withdrawal_days_milk, p.withdrawal_days_meat));
        v_props := v_props || fn_dp_ref_step('DefaultParameters', 'DrugParameters', 'params');
      else
        if 'uom' = any (v_changed) then v_clinical := v_clinical || fn_dp_prop('UOM', v_g->'uom'); end if;
        if 'milk_days' = any (v_changed) then v_clinical := v_clinical || fn_dp_prop('DumpMilkDays', v_g->'milk_days'); end if;
        if 'meat_days' = any (v_changed) then v_clinical := v_clinical || fn_dp_prop('MeatWithholdDays', v_g->'meat_days'); end if;
        v_steps := v_steps || fn_dp_step('params', 'DrugParameters', 'update', v_clinical, v_params);
      end if;
    end if;
    if jsonb_array_length(v_props) > 0 then
      v_steps := v_steps || fn_dp_step('main', 'Drug', 'update', v_props, l.delpro_key);
    end if;

  else -- Treatment
    if 'name' = any (v_changed) then v_props := v_props || fn_dp_prop('Name', v_g->'name'); end if;
    if 'active' = any (v_changed) then v_props := v_props || fn_dp_prop('Active', v_g->'active'); end if;
    if 'treatment_type' = any (v_changed) then v_props := v_props || fn_dp_prop('TreatmentType', v_g->'treatment_type'); end if;
    if jsonb_array_length(v_props) > 0 then
      v_steps := v_steps || fn_dp_step('main', 'Treatment', 'update', v_props, l.delpro_key);
    end if;

    if 'usages' = any (v_changed) then
      -- DelPro usages no GVET line points at would have to be deleted: never automatic.
      if exists (
        select 1 from delpro_catalog_items u
        where u.object_type = 'TreatmentDrugUsage' and u.removed_at is null
          and (u.fields->>'treatment' = l.delpro_key or coalesce(v_item.fields->'drug_usages', '[]'::jsonb) ? u.delpro_key)
          and not exists (select 1 from treatment_template_items ti where ti.template_id = l.template_id and ti.delpro_usage_key = u.delpro_key)
      ) then
        raise exception 'DelPro šablone yra vaistų, kurių GVET šablone nebėra. Pašalinkite juos DelPro programoje (automatinis trynimas nevykdomas).';
      end if;

      for i in select * from treatment_template_items where template_id = l.template_id order by sort_order, created_at
      loop
        v_n := v_n + 1;
        select ll.delpro_key into v_drug from delpro_catalog_links ll where ll.retired_at is null and ll.product_id = i.product_id;
        if v_drug is null then
          raise exception 'Šablono vaistas „%“ nesusietas su DelPro vaistu.', (select name from products where id = i.product_id);
        end if;

        if i.delpro_usage_key is null then
          v_steps := v_steps
            || fn_dp_step('params_' || v_n, 'DrugParameters', 'create',
                 fn_delpro_params_props(fn_delpro_uom_canonical(i.uom), fn_delpro_text(i.application_method), i.milk_days, i.meat_days), null, null, i.id)
            || fn_dp_step('usage_' || v_n, 'TreatmentDrugUsage', 'create', jsonb_build_array(
                 fn_dp_ref('Treatment', 'Treatment', l.delpro_key), fn_dp_ref('Drug', 'Drug', v_drug),
                 fn_dp_ref_step('DrugParams', 'DrugParameters', 'params_' || v_n),
                 fn_dp_prop('Dosage', to_jsonb(trim_scale(i.dosage))), fn_dp_prop('Frequency', to_jsonb(i.frequency)),
                 fn_dp_prop('TreatCowDays', to_jsonb(i.treat_cow_days))), null, null, i.id);
          v_usages := v_usages || ('usage_' || v_n);
          continue;
        end if;

        -- existing line: write only when it differs from its DelPro usage
        select jsonb_build_object(
                 'drug', u.fields->>'drug', 'dosage', trim_scale((u.fields->>'dosage')::numeric),
                 'frequency', (u.fields->>'frequency')::integer, 'treat_cow_days', (u.fields->>'treat_cow_days')::integer,
                 'uom', fn_delpro_uom_canonical(dp.fields->>'uom'), 'application_method', dp.fields->>'application_method',
                 'milk_days', (dp.fields->>'dump_milk_days')::integer, 'meat_days', (dp.fields->>'meat_withhold_days')::integer)
               || jsonb_build_object('_params', u.fields->>'drug_params')
        into v_existing
        from delpro_catalog_items u
        left join delpro_catalog_items dp on dp.object_type = 'DrugParameters' and dp.delpro_key = u.fields->>'drug_params' and dp.removed_at is null
        where u.object_type = 'TreatmentDrugUsage' and u.delpro_key = i.delpro_usage_key and u.removed_at is null;
        if v_existing is null then
          raise exception 'DelPro šablono vaistas % nebeegzistuoja — atnaujinkite katalogą.', i.delpro_usage_key;
        end if;
        continue when (v_existing - '_params') = fn_delpro_template_item_usage(i);

        if (v_existing->>'_params') is null or fn_delpro_params_refcount(v_existing->>'_params') > 1 then
          v_steps := v_steps
            || fn_dp_step('params_' || v_n, 'DrugParameters', 'create',
                 fn_delpro_params_props(fn_delpro_uom_canonical(i.uom), fn_delpro_text(i.application_method), i.milk_days, i.meat_days), null, null, i.id)
            || fn_dp_step('usage_' || v_n, 'TreatmentDrugUsage', 'update', jsonb_build_array(
                 fn_dp_ref('Drug', 'Drug', v_drug), fn_dp_ref_step('DrugParams', 'DrugParameters', 'params_' || v_n),
                 fn_dp_prop('Dosage', to_jsonb(trim_scale(i.dosage))), fn_dp_prop('Frequency', to_jsonb(i.frequency)),
                 fn_dp_prop('TreatCowDays', to_jsonb(i.treat_cow_days))), i.delpro_usage_key, null, i.id);
        else
          v_steps := v_steps
            || fn_dp_step('params_' || v_n, 'DrugParameters', 'update',
                 fn_delpro_params_props(fn_delpro_uom_canonical(i.uom), fn_delpro_text(i.application_method), i.milk_days, i.meat_days),
                 v_existing->>'_params', null, i.id)
            || fn_dp_step('usage_' || v_n, 'TreatmentDrugUsage', 'update', jsonb_build_array(
                 fn_dp_ref('Drug', 'Drug', v_drug),
                 fn_dp_prop('Dosage', to_jsonb(trim_scale(i.dosage))), fn_dp_prop('Frequency', to_jsonb(i.frequency)),
                 fn_dp_prop('TreatCowDays', to_jsonb(i.treat_cow_days))), i.delpro_usage_key, null, i.id);
        end if;
        v_usages := v_usages || ('usage_' || v_n);
      end loop;
      if cardinality(v_usages) > 0 then
        v_steps := v_steps || jsonb_build_object('id', 'verify', 'operation', 'verify_refs', 'object', 'Treatment', 'key_property', 'Code',
          'key', l.delpro_key, 'property', 'DrugUsages', 'expect_steps', to_jsonb(v_usages));
      end if;
    end if;
  end if;

  if jsonb_array_length(v_steps) = 0 then
    raise exception 'Nėra ką siųsti.';
  end if;
  return jsonb_build_object('steps', v_steps, 'label', v_label, 'gvet_values', v_g);
end;
$$;

-- Inserts a job (superseding a queued one for the same GVET record).
create or replace function fn_delpro_catalog_enqueue(
  p_object_type text, p_operation text, p_link_id uuid, p_gvet_id uuid, p_plan jsonb, p_is_test boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not p_is_test then
    if exists (
      select 1 from delpro_catalog_jobs
      where status = 'processing' and not is_test and object_type = p_object_type
        and coalesce(disease_id, product_id, template_id) = p_gvet_id
    ) then
      raise exception 'Šio įrašo DelPro užduotis šiuo metu vykdoma — palaukite.';
    end if;
    update delpro_catalog_jobs
    set status = 'cancelled', error = 'Pakeista naujesne užduotimi.', completed_at = now()
    where status = 'queued' and not is_test and object_type = p_object_type
      and coalesce(disease_id, product_id, template_id) = p_gvet_id;
  end if;

  insert into delpro_catalog_jobs (object_type, operation, is_test, link_id, disease_id, product_id, template_id, delpro_key,
                                   label, steps, gvet_values, created_by)
  values (p_object_type, p_operation, p_is_test, p_link_id,
          case when p_object_type = 'Diagnosis' then p_gvet_id end,
          case when p_object_type = 'Drug' then p_gvet_id end,
          case when p_object_type = 'Treatment' then p_gvet_id end,
          (select delpro_key from delpro_catalog_links where id = p_link_id),
          p_plan->>'label', p_plan->'steps', p_plan->'gvet_values', auth.uid())
  returning id into v_id;

  insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
  values (auth.uid(), 'delpro_catalog_job_queued', 'delpro_catalog_jobs', v_id,
          jsonb_build_object('object_type', p_object_type, 'operation', p_operation, 'is_test', p_is_test, 'steps', p_plan->'steps'));
  return v_id;
end;
$$;

-- ===========================================================================
-- Reconcile v2 (templates, recommended treatment, auto outbound)
-- ===========================================================================

create or replace function fn_delpro_catalog_reconcile()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_want jsonb := '[]'::jsonb;
  v_mode text := coalesce((select setting_value from system_settings where setting_key = 'delpro_catalog_inbound_mode'), 'review');
  v_out_mode text := coalesce((select setting_value from system_settings where setting_key = 'delpro_catalog_outbound_mode'), 'manual');
  v_out_since timestamptz := (select updated_at from system_settings where setting_key = 'delpro_catalog_outbound_mode');
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
  v_outbound_links uuid[] := '{}';
  v_applied integer := 0;
  v_queued integer := 0;
  v_opened integer := 0;
  v_closed integer := 0;
begin
  -- GVET edits made here (applying DelPro values) must not re-trigger a reconcile.
  perform set_config('delpro.reconciling', '1', true);

  -- 1. Unlinked DelPro records with a same-name GVET record: suggestion / ambiguity.
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
      union all
      select 'Treatment', 'treatment_templates', t.id, t.name, fn_delpro_norm_name(t.name),
             exists (select 1 from delpro_catalog_links x where x.retired_at is null and x.template_id = t.id)
      from treatment_templates t
    ),
    items as (
      select i.object_type, i.delpro_key, i.name, fn_delpro_norm_name(i.name) as norm
      from delpro_catalog_items i
      where i.object_type in ('Diagnosis', 'Drug', 'Treatment') and i.removed_at is null
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
    v_gvet_table := case when l.disease_id is not null then 'diseases' when l.product_id is not null then 'products' else 'treatment_templates' end;
    v_gvet_id := coalesce(l.disease_id, l.product_id, l.template_id);
    v_gvet_name := coalesce((select name from diseases where id = l.disease_id), (select name from products where id = l.product_id),
                            (select name from treatment_templates where id = l.template_id));
    v_d := fn_delpro_catalog_projection(l.object_type, l.delpro_key);

    if v_d is null then
      v_want := v_want || jsonb_build_object(
        'fingerprint', 'removed:' || l.id, 'issue_type', 'removed_in_delpro', 'object_type', l.object_type,
        'delpro_key', l.delpro_key, 'link_id', l.id, 'gvet_table', v_gvet_table, 'gvet_id', v_gvet_id,
        'details', jsonb_build_object('gvet_name', v_gvet_name,
          'delpro_name', (select name from delpro_catalog_items where object_type = l.object_type and delpro_key = l.delpro_key)));
      continue;
    end if;

    v_g := fn_delpro_link_gvet_projection(l.disease_id, l.product_id, l.template_id);
    v_b := l.synced_fields;
    v_base := coalesce(v_b, '{}'::jsonb);
    v_sets := jsonb_build_object('field_difference', '{}'::jsonb, 'inbound_change', '{}'::jsonb,
                                 'outbound_pending', '{}'::jsonb, 'conflict', '{}'::jsonb);

    for k in select jsonb_object_keys(v_d)
    loop
      v_dv := coalesce(v_d->k, 'null'::jsonb);
      v_gv := coalesce(v_g->k, 'null'::jsonb);
      v_bv := v_b->k;
      v_kind := null;

      if v_dv = v_gv then
        v_base := v_base || jsonb_build_object(k, v_dv);
      elsif v_bv is null and k = 'recommended_treatment' and v_gv = 'null'::jsonb then
        -- GVET never had an opinion: adopt DelPro's recommendation once its template is linked; until then, nothing to show.
        begin
          perform fn_delpro_apply_link_field(l.id, k, v_dv);
          v_base := v_base || jsonb_build_object(k, v_dv);
          v_applied := v_applied + 1;
        exception when others then
          null;
        end;
      elsif v_bv is null then
        v_kind := 'field_difference';
      elsif v_gv = v_bv then
        v_kind := 'inbound_change';
        if v_mode = 'auto' and k in ('name', 'active_substance', 'active', 'treatment_type') then
          begin
            perform fn_delpro_apply_link_field(l.id, k, v_dv);
            v_base := v_base || jsonb_build_object(k, v_dv);
            v_applied := v_applied + 1;
            v_kind := null;
          exception when others then
            v_kind := 'inbound_change';
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

    if v_sets->'outbound_pending' <> '{}'::jsonb and v_sets->'conflict' = '{}'::jsonb then
      v_outbound_links := v_outbound_links || l.id;
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

  -- 3. Broken references (complete types only).
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

  -- 4. Sync the issue table.
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

  -- 5. Auto outbound: queue edits of linked records and GVET records created
  --    since auto mode was switched on. Still behind the write gate; a plan
  --    that can't be built (missing dependency) is simply left for later.
  if v_out_mode = 'auto' then
    for l in select * from delpro_catalog_links where id = any (v_outbound_links)
    loop
      continue when exists (
        select 1 from delpro_catalog_jobs j where j.status in ('queued', 'processing') and not j.is_test
          and j.object_type = l.object_type and coalesce(j.disease_id, j.product_id, j.template_id) = coalesce(l.disease_id, l.product_id, l.template_id));
      begin
        perform fn_delpro_catalog_enqueue(l.object_type, 'update', l.id, coalesce(l.disease_id, l.product_id, l.template_id),
                                          fn_delpro_catalog_plan_update(l.id));
        v_queued := v_queued + 1;
      exception when others then
        null;
      end;
    end loop;

    for r in
      select g.object_type, g.gvet_id
      from (
        select 'Diagnosis'::text as object_type, d.id as gvet_id, d.created_at from diseases d
        where not exists (select 1 from delpro_catalog_links x where x.retired_at is null and x.disease_id = d.id)
        union all
        select 'Drug', p.id, p.created_at from products p
        where p.is_active and fn_is_drug_category(p.category)
          and not exists (select 1 from delpro_catalog_links x where x.retired_at is null and x.product_id = p.id)
        union all
        select 'Treatment', t.id, t.created_at from treatment_templates t
        where not exists (select 1 from delpro_catalog_links x where x.retired_at is null and x.template_id = t.id)
      ) g
      where g.created_at >= v_out_since
        and not exists (
          select 1 from delpro_catalog_jobs j where not j.is_test and j.operation = 'create' and j.object_type = g.object_type
            and coalesce(j.disease_id, j.product_id, j.template_id) = g.gvet_id and j.status <> 'cancelled')
    loop
      begin
        perform fn_delpro_catalog_enqueue(r.object_type, 'create', null, r.gvet_id, fn_delpro_catalog_plan_create(r.object_type, r.gvet_id));
        v_queued := v_queued + 1;
      exception when others then
        null;
      end;
    end loop;
  end if;

  perform set_config('delpro.reconciling', '0', true);
  return jsonb_build_object(
    'opened', v_opened,
    'closed', v_closed,
    'auto_applied', v_applied,
    'queued', v_queued,
    'open', (select count(*) from delpro_catalog_issues where status = 'open')
  );
end;
$$;

-- GVET edits anywhere in the app (Produktai, ligos, šablonai) are picked up at
-- once: shared-field changes re-run the reconcile, so an edited linked record
-- shows as "Laukia siuntimo į DelPro" (or is queued in auto mode) without
-- waiting for the next catalog sync. A failure here never blocks the save.
create or replace function fn_delpro_catalog_gvet_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('delpro.reconciling', true), '0') = '1' then
    return null;
  end if;
  if not exists (select 1 from delpro_catalog_items limit 1) then
    return null; -- catalog never synced: nothing to compare with
  end if;
  begin
    perform fn_delpro_catalog_reconcile();
  exception when others then
    raise warning 'DelPro katalogo palyginimas nepavyko: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function fn_delpro_catalog_gvet_changed() from public, anon, authenticated;

create trigger trg_diseases_delpro_catalog
  after insert or update of name, recommended_template_id on diseases
  for each statement execute function fn_delpro_catalog_gvet_changed();
create trigger trg_products_delpro_catalog
  after insert or update of name, active_substance, is_active, unit, withdrawal_days_milk, withdrawal_days_meat, category on products
  for each statement execute function fn_delpro_catalog_gvet_changed();
create trigger trg_treatment_templates_delpro_catalog
  after insert or update or delete on treatment_templates
  for each statement execute function fn_delpro_catalog_gvet_changed();
create trigger trg_treatment_template_items_delpro_catalog
  after insert or update or delete on treatment_template_items
  for each statement execute function fn_delpro_catalog_gvet_changed();

-- ===========================================================================
-- Admin RPCs v2 (templates in link / import / resolve; outbound "send")
-- ===========================================================================

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
  elsif p_object_type = 'Treatment' then
    if not exists (select 1 from treatment_templates where id = p_gvet_id) then
      raise exception 'GVET gydymo šablonas nerastas.';
    end if;
  else
    raise exception 'DelPro % susieti su GVET negalima.', p_object_type;
  end if;

  begin
    insert into delpro_catalog_links (object_type, delpro_key, disease_id, product_id, template_id, origin, synced_fields, synced_at, linked_by)
    values (p_object_type, p_delpro_key,
            case when p_object_type = 'Diagnosis' then p_gvet_id end,
            case when p_object_type = 'Drug' then p_gvet_id end,
            case when p_object_type = 'Treatment' then p_gvet_id end,
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

-- Adds 'send' (queue a DelPro update) for outbound_pending / field_difference /
-- conflict after keep_gvet; take_delpro now covers templates and recommendations.
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
    when 'outbound_pending' then array['send', 'take_delpro', 'dismiss']
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
  elsif p_action = 'send' then
    select * into l from delpro_catalog_links where id = i.link_id and retired_at is null;
    if l.id is null then
      raise exception 'Susiejimas nebegalioja — atnaujinkite puslapį.';
    end if;
    perform fn_delpro_catalog_enqueue(l.object_type, 'update', l.id, coalesce(l.disease_id, l.product_id, l.template_id),
                                      fn_delpro_catalog_plan_update(l.id));
    insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
    values (auth.uid(), 'delpro_catalog_send', 'delpro_catalog_issues', i.id, jsonb_build_object('link_id', l.id));
    -- the issue stays open until DelPro reads back the new values
    perform fn_delpro_catalog_reconcile();
    return jsonb_build_object('ok', true, 'message', 'Įtraukta į siuntimo į DelPro eilę.');
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
        perform fn_delpro_apply_link_field(l.id, k, v_d->k);
      end if;
      v_base := v_base || jsonb_build_object(k, v_d->k);
    end loop;
    update delpro_catalog_links set synced_fields = v_base, synced_at = now() where id = l.id;
    v_message := case when p_action = 'take_delpro' then 'GVET atnaujintas pagal DelPro.'
                      else 'Paliktos GVET reikšmės — jas galima siųsti į DelPro („Siųsti į DelPro“).' end;
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

-- Import v2: Treatment templates too (their drugs must be linked first).
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
  if p_object_type not in ('Diagnosis', 'Drug', 'Treatment') then
    raise exception 'Importuoti galima tik DelPro diagnozes, vaistus ir gydymo šablonus.';
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
    elsif p_object_type = 'Treatment' and exists (
      select 1 from treatment_templates where fn_delpro_norm_name(name) = fn_delpro_norm_name(v_item.name)
    ) then
      v_reason := 'GVET jau turi šabloną tokiu pavadinimu — susiekite jį';
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

    begin
      if p_object_type = 'Diagnosis' then
        insert into diseases (name) values (fn_delpro_text(v_item.name)) returning id into v_id;
      elsif p_object_type = 'Drug' then
        insert into products (name, category, unit, active_substance, withdrawal_days_milk, withdrawal_days_meat, is_active)
        values (fn_delpro_text(v_item.name), 'medicines', v_unit, v_item.fields->>'active_substance',
                (v_params->>'dump_milk_days')::int, (v_params->>'meat_withhold_days')::int, coalesce(v_item.active, true))
        returning id into v_id;
      else
        insert into treatment_templates (name, active, treatment_type, created_by)
        values (fn_delpro_text(v_item.name), coalesce(v_item.active, true), v_item.fields->>'treatment_type', auth.uid())
        returning id into v_id;
        perform fn_delpro_template_items_from_delpro(v_id, v_key);
      end if;

      v_link := fn_delpro_catalog_create_link(p_object_type, v_key, v_id, 'imported',
                                              fn_delpro_catalog_projection(p_object_type, v_key));
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('key', v_key, 'name', v_item.name, 'reason', sqlerrm);
      continue;
    end;

    if p_object_type in ('Drug', 'Treatment') then
      insert into delpro_catalog_issues (issue_type, object_type, delpro_key, link_id, gvet_table, gvet_id, fingerprint, details)
      values ('clinical_review', p_object_type, v_key, v_link,
              case when p_object_type = 'Drug' then 'products' else 'treatment_templates' end, v_id, 'clinical:' || v_link,
              case when p_object_type = 'Drug' then
                jsonb_build_object('gvet_name', v_item.name, 'delpro_name', v_item.name, 'uom', v_params->>'uom',
                                   'milk_days', v_params->'dump_milk_days', 'meat_days', v_params->'meat_withhold_days',
                                   'application_method', v_params->>'application_method')
              else jsonb_build_object('gvet_name', v_item.name, 'delpro_name', v_item.name, 'usages', fn_delpro_template_usages(v_id)) end);
    end if;
    v_created := v_created + 1;
  end loop;

  perform fn_delpro_catalog_reconcile();
  return jsonb_build_object('ok', true, 'created', v_created, 'skipped', v_skipped,
    'message', format('Importuota: %s.', v_created)
               || case when jsonb_array_length(v_skipped) > 0 then format(' Praleista: %s.', jsonb_array_length(v_skipped)) else '' end);
end;
$$;

-- delpro_catalog_enqueue_create(type, gvet id) — "Sukurti DelPro".
create or replace function delpro_catalog_enqueue_create(p_object_type text, p_gvet_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform fn_delpro_catalog_require_admin();
  if exists (
    select 1 from delpro_catalog_links where retired_at is null and object_type = p_object_type
      and coalesce(disease_id, product_id, template_id) = p_gvet_id
  ) then
    raise exception 'Įrašas jau susietas su DelPro.';
  end if;
  v_id := fn_delpro_catalog_enqueue(p_object_type, 'create', null, p_gvet_id, fn_delpro_catalog_plan_create(p_object_type, p_gvet_id));
  return jsonb_build_object('ok', true, 'job_id', v_id, 'message', 'Įtraukta į sukūrimo DelPro eilę.');
end;
$$;

-- Test jobs: one inactive "GVET TEST <time>" record per operation, used to
-- prove the Gateway behaviour before real writes are allowed.
--   Diagnosis.create | Drug.create (params + drug) | Treatment.create (needs a
--   successful Drug.create test) | X.update (renames X's latest test record).
create or replace function delpro_catalog_create_test_job(p_operation_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_object text := split_part(p_operation_key, '.', 1);
  v_op text := split_part(p_operation_key, '.', 2);
  v_name text := 'GVET TEST ' || to_char(now() at time zone 'Europe/Vilnius', 'YYYY-MM-DD HH24:MI:SS');
  v_prev delpro_catalog_jobs%rowtype;
  v_drug_test delpro_catalog_jobs%rowtype;
  v_type text;
  v_steps jsonb;
  v_id uuid;
begin
  perform fn_delpro_catalog_require_admin();
  if v_object not in ('Diagnosis', 'Drug', 'Treatment') or v_op not in ('create', 'update') then
    raise exception 'Netinkama operacija %.', p_operation_key;
  end if;

  if v_op = 'update' then
    select * into v_prev from delpro_catalog_jobs
    where is_test and status = 'success' and object_type = v_object and operation = 'create' and progress->'main'->>'key' is not null
    order by completed_at desc limit 1;
    if v_prev.id is null then
      raise exception 'Pirmiausia sėkmingai atlikite bandomąjį % sukūrimą.', v_object;
    end if;
    v_steps := jsonb_build_array(fn_dp_step('main', v_object, 'update',
      jsonb_build_array(fn_dp_prop('Name', to_jsonb(v_name || ' (atnaujinta)'))), v_prev.progress->'main'->>'key'));
  elsif v_object = 'Diagnosis' then
    v_steps := jsonb_build_array(fn_dp_step('main', 'Diagnosis', 'create',
      jsonb_build_array(fn_dp_prop('Name', to_jsonb(v_name)), fn_dp_prop('Active', 'false'::jsonb)), null, v_name));
  elsif v_object = 'Drug' then
    v_steps := jsonb_build_array(
      fn_dp_step('params', 'DrugParameters', 'create', fn_delpro_params_props('ml', null, 0, 0)),
      fn_dp_step('main', 'Drug', 'create', jsonb_build_array(
        fn_dp_prop('Name', to_jsonb(v_name)), fn_dp_prop('Active', 'false'::jsonb),
        fn_dp_ref_step('DefaultParameters', 'DrugParameters', 'params')), null, v_name));
  else
    select * into v_drug_test from delpro_catalog_jobs
    where is_test and status = 'success' and object_type = 'Drug' and operation = 'create' and progress->'main'->>'key' is not null
    order by completed_at desc limit 1;
    if v_drug_test.id is null then
      raise exception 'Pirmiausia sėkmingai atlikite bandomąjį vaisto (Drug.create) sukūrimą — šablonui reikia vaisto.';
    end if;
    -- TreatmentType: the value DelPro itself uses most, if any template has one
    select fields->>'treatment_type' into v_type from delpro_catalog_items
    where object_type = 'Treatment' and fields->>'treatment_type' is not null
    group by 1 order by count(*) desc limit 1;
    v_steps := jsonb_build_array(
      fn_dp_step('main', 'Treatment', 'create',
        jsonb_build_array(fn_dp_prop('Name', to_jsonb(v_name)), fn_dp_prop('Active', 'false'::jsonb))
        || case when v_type is not null then jsonb_build_array(fn_dp_prop('TreatmentType', to_jsonb(v_type))) else '[]'::jsonb end,
        null, v_name),
      fn_dp_step('params_1', 'DrugParameters', 'create', fn_delpro_params_props('ml', null, 0, 0)),
      fn_dp_step('usage_1', 'TreatmentDrugUsage', 'create', jsonb_build_array(
        fn_dp_ref_step('Treatment', 'Treatment', 'main'),
        fn_dp_ref('Drug', 'Drug', v_drug_test.progress->'main'->>'key'),
        fn_dp_ref_step('DrugParams', 'DrugParameters', 'params_1'),
        fn_dp_prop('Dosage', '1'::jsonb), fn_dp_prop('Frequency', '1'::jsonb), fn_dp_prop('TreatCowDays', '1'::jsonb))),
      jsonb_build_object('id', 'verify', 'operation', 'verify_refs', 'object', 'Treatment', 'key_property', 'Code',
        'ref_step', 'main', 'property', 'DrugUsages', 'expect_steps', jsonb_build_array('usage_1')));
  end if;

  v_id := fn_delpro_catalog_enqueue(v_object, v_op, null, null,
    jsonb_build_object('steps', v_steps, 'label', 'Bandymas: ' || p_operation_key), true);
  return jsonb_build_object('ok', true, 'job_id', v_id,
    'message', 'Bandomoji užduotis sukurta. Ji vykdoma tik kai rašymas į DelPro įjungtas ir ūkio kompiuteryje CATALOG_WRITE_ENABLED=true.');
end;
$$;

-- After a successful, read-back-verified test job an admin marks its operation as validated.
create or replace function delpro_catalog_mark_validated(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j delpro_catalog_jobs%rowtype;
  v_op text;
  v_list text[];
begin
  perform fn_delpro_catalog_require_admin();
  select * into j from delpro_catalog_jobs where id = p_job_id for update;
  if j.id is null or not j.is_test then
    raise exception 'Tai ne bandomoji užduotis.';
  end if;
  if j.status <> 'success' then
    raise exception 'Bandomoji užduotis dar neįvykdyta sėkmingai.';
  end if;
  v_op := j.object_type || '.' || j.operation;
  select coalesce(array_remove(string_to_array(setting_value, ','), ''), '{}') into v_list
  from system_settings where setting_key = 'delpro_catalog_validated_operations';
  if not (v_op = any (v_list)) then
    v_list := v_list || v_op;
  end if;
  update system_settings set setting_value = array_to_string(v_list, ',') where setting_key = 'delpro_catalog_validated_operations';
  update delpro_catalog_jobs set validated_at = now(), validated_by = auth.uid() where id = j.id;
  insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
  values (auth.uid(), 'delpro_catalog_operation_validated', 'delpro_catalog_jobs', j.id, jsonb_build_object('operation', v_op, 'readback', j.readback));
  return jsonb_build_object('ok', true, 'message', format('Operacija %s pažymėta kaip patikrinta.', v_op));
end;
$$;

create or replace function delpro_catalog_unvalidate(p_operation_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform fn_delpro_catalog_require_admin();
  update system_settings
  set setting_value = array_to_string(array_remove(string_to_array(coalesce(setting_value, ''), ','), p_operation_key), ',')
  where setting_key = 'delpro_catalog_validated_operations';
  insert into user_audit_logs (user_id, action, table_name, new_data)
  values (auth.uid(), 'delpro_catalog_operation_unvalidated', 'system_settings', jsonb_build_object('operation', p_operation_key));
  return jsonb_build_object('ok', true, 'message', 'Pašalinta iš patikrintų.');
end;
$$;

create or replace function delpro_catalog_set_write_enabled(p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform fn_delpro_catalog_require_admin();
  update system_settings set setting_value = case when p_enabled then 'true' else 'false' end
  where setting_key = 'delpro_catalog_write_enabled';
  insert into user_audit_logs (user_id, action, table_name, new_data)
  values (auth.uid(), case when p_enabled then 'delpro_catalog_write_enabled' else 'delpro_catalog_write_disabled' end,
          'system_settings', jsonb_build_object('enabled', p_enabled));
  return jsonb_build_object('ok', true, 'message', case when p_enabled then 'Rašymas į DelPro įjungtas.' else 'Rašymas į DelPro išjungtas.' end);
end;
$$;

-- cancel: queued / failed / needs_review / verification_failed. retry: back to
-- queued; steps already done are skipped. A create step that was started but
-- never reported done has an unknown outcome: the worker never re-sends it and
-- never adopts a record by name, so retry is refused until an admin decides it:
--   adopt  (p_step, p_key): this DelPro record IS the one the step created —
--          the worker reads it back and compares every property before "done";
--   resend (p_step): checked in DelPro, the record does not exist — send again.
create or replace function delpro_catalog_job_action(p_job_id uuid, p_action text, p_step text default null, p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j delpro_catalog_jobs%rowtype;
  v_step jsonb;
  v_key text := nullif(btrim(coalesce(p_key, '')), '');
  v_uncertain text[];
begin
  perform fn_delpro_catalog_require_admin();
  select * into j from delpro_catalog_jobs where id = p_job_id for update;
  if j.id is null then
    raise exception 'Užduotis nerasta.';
  end if;
  select coalesce(array_agg(s->>'id'), '{}') into v_uncertain
  from jsonb_array_elements(j.steps) s
  where s->>'operation' = 'create'
    and j.progress->(s->>'id') ? 'started_at'
    and coalesce(j.progress->(s->>'id')->>'key', '') = '';

  if p_action = 'cancel' then
    if j.status not in ('queued', 'failed', 'needs_review', 'verification_failed') then
      raise exception 'Šios užduoties atšaukti negalima (būsena %).', j.status;
    end if;
    update delpro_catalog_jobs set status = 'cancelled', completed_at = now() where id = j.id;
  elsif p_action = 'retry' then
    if j.status not in ('failed', 'needs_review', 'verification_failed') then
      raise exception 'Kartoti galima tik nepavykusią užduotį.';
    end if;
    if cardinality(v_uncertain) > 0 then
      raise exception 'Nežinomas ankstesnio įrašymo rezultatas (%): pirmiausia priskirkite DelPro įrašą arba patvirtinkite, kad jo nėra.',
        array_to_string(v_uncertain, ', ');
    end if;
    update delpro_catalog_jobs
    set status = 'queued', next_attempt_at = null, attempts = 0, error = null, error_details = null, completed_at = null
    where id = j.id;
  elsif p_action in ('adopt', 'resend') then
    if j.status not in ('failed', 'needs_review', 'verification_failed') then
      raise exception 'Šiai užduočiai sprendimo nereikia (būsena %).', j.status;
    end if;
    if p_step is null or not (p_step = any (v_uncertain)) then
      raise exception 'Žingsnis % neturi nežinomo rezultato.', coalesce(p_step, '—');
    end if;
    select s into v_step from jsonb_array_elements(j.steps) s where s->>'id' = p_step;
    if p_action = 'adopt' then
      if v_key is null then
        raise exception 'Nurodykite DelPro įrašo raktą (%).', v_step->>'key_property';
      end if;
      if exists (select 1 from jsonb_each(j.progress) e where e.key <> p_step and e.value->>'key' = v_key
                   and (select x->>'object' from jsonb_array_elements(j.steps) x where x->>'id' = e.key) = v_step->>'object') then
        raise exception 'DelPro įrašas % jau priskirtas kitam šios užduoties žingsniui.', v_key;
      end if;
      if exists (select 1 from delpro_catalog_links l where l.object_type = v_step->>'object' and l.delpro_key = v_key and l.retired_at is null) then
        raise exception 'DelPro įrašas % jau susietas su kitu GVET įrašu.', v_key;
      end if;
      update delpro_catalog_jobs
      set progress = jsonb_set(progress, array[p_step], progress->p_step
            || jsonb_build_object('key', v_key, 'adopted_by', auth.uid(), 'adopted_at', now())),
          status = 'queued', next_attempt_at = null, attempts = 0, error = null, error_details = null, completed_at = null
      where id = j.id;
    else
      update delpro_catalog_jobs
      set progress = jsonb_set(progress, array[p_step], ((progress->p_step) - 'started_at')
            || jsonb_build_object('resend_confirmed_by', auth.uid(), 'resend_confirmed_at', now())),
          status = 'queued', next_attempt_at = null, attempts = 0, error = null, error_details = null, completed_at = null
      where id = j.id;
    end if;
  else
    raise exception 'Nežinomas veiksmas %.', p_action;
  end if;
  insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), 'delpro_catalog_job_' || p_action, 'delpro_catalog_jobs', j.id, jsonb_build_object('status', j.status),
          jsonb_strip_nulls(jsonb_build_object('step', p_step, 'key', v_key)));
  return jsonb_build_object('ok', true, 'message', case p_action
    when 'cancel' then 'Atšaukta.'
    when 'adopt' then 'DelPro įrašas priskirtas — bus nuskaitytas ir palygintas.'
    when 'resend' then 'Bus siunčiama iš naujo.'
    else 'Grąžinta į eilę.' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker RPCs for catalog jobs (service_role; unnamed jsonb)
-- ---------------------------------------------------------------------------

-- Stores one record read back from DelPro into the mirror (same normalization as an upload).
create or replace function fn_delpro_catalog_put_item(p_type text, p_rec jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := fn_delpro_scalar(p_rec->fn_delpro_catalog_key_field(p_type));
  v_fields jsonb := fn_delpro_catalog_fields(p_type, p_rec);
  v_hash text := md5(v_fields::text);
begin
  if v_key is null then
    raise exception 'trūksta rakto';
  end if;
  insert into delpro_catalog_items as i (object_type, delpro_key, name, active, fields, record_hash, raw)
  values (p_type, v_key, v_fields->>'name', (v_fields->>'active')::boolean, v_fields, v_hash, p_rec)
  on conflict (object_type, delpro_key) do update set
    name = excluded.name, active = excluded.active, fields = excluded.fields, record_hash = excluded.record_hash,
    raw = excluded.raw, last_seen_at = now(),
    changed_at = case when i.record_hash is distinct from excluded.record_hash or i.removed_at is not null then now() else i.changed_at end,
    removed_at = null;
end;
$$;

-- delpro_catalog_claim_job(jsonb): { "worker_id", "lease_seconds"? } -> job envelope | null.
-- Nothing is handed out unless writing is enabled AND the job is a test job or
-- its operation has been validated.
create or replace function delpro_catalog_claim_job(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_worker text := nullif($1->>'worker_id', '');
  v_lease integer := coalesce(nullif($1->>'lease_seconds', '')::integer, 300);
  v_validated text[];
  j delpro_catalog_jobs%rowtype;
begin
  update system_settings set setting_value = now()::text where setting_key = 'delpro_worker_last_seen_at';

  -- expired leases: the worker died mid-job. Progress is kept; started-but-not-done steps are uncertain.
  update delpro_catalog_jobs
  set status = case when attempts >= max_attempts then 'needs_review' else 'queued' end,
      lease_expires_at = null,
      error = 'Darbininkas neatsakė — užduotis grąžinta (nebaigti žingsniai bus patikrinti prieš kartojant).'
  where status = 'processing' and lease_expires_at < now();

  if coalesce((select setting_value from system_settings where setting_key = 'delpro_catalog_write_enabled'), 'false') <> 'true' then
    return null;
  end if;
  select coalesce(array_remove(string_to_array(setting_value, ','), ''), '{}') into v_validated
  from system_settings where setting_key = 'delpro_catalog_validated_operations';

  select * into j from delpro_catalog_jobs
  where status = 'queued'
    and coalesce(next_attempt_at, created_at) <= now()
    and (is_test or (object_type || '.' || operation) = any (v_validated))
  order by created_at
  for update skip locked
  limit 1;
  if j.id is null then
    return null;
  end if;

  update delpro_catalog_jobs
  set status = 'processing', attempts = attempts + 1, worker_id = v_worker, started_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease)
  where id = j.id
  returning * into j;

  return jsonb_build_object('job_id', j.id, 'object_type', j.object_type, 'operation', j.operation, 'is_test', j.is_test,
                            'attempt', j.attempts, 'steps', j.steps, 'progress', j.progress);
end;
$$;

-- delpro_catalog_job_step(jsonb): { job_id, step, phase: "start" | "done", key? }
-- "start" MUST succeed before the worker writes; "done" records the DelPro key.
create or replace function delpro_catalog_job_step(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_id uuid := nullif($1->>'job_id', '')::uuid;
  v_step text := $1->>'step';
  v_phase text := $1->>'phase';
  j delpro_catalog_jobs%rowtype;
  v_entry jsonb;
begin
  select * into j from delpro_catalog_jobs where id = v_id for update;
  if j.id is null or j.status <> 'processing' then
    raise exception 'Užduotis % nevykdoma.', v_id;
  end if;
  if v_phase not in ('start', 'done') or v_step is null then
    raise exception 'Netinkamas žingsnio pranešimas.';
  end if;
  v_entry := coalesce(j.progress->v_step, '{}'::jsonb)
    || case when v_phase = 'start' then jsonb_build_object('started_at', now())
            else jsonb_build_object('done_at', now(), 'key', $1->>'key') end;
  update delpro_catalog_jobs
  set progress = jsonb_set(progress, array[v_step], v_entry),
      lease_expires_at = greatest(lease_expires_at, now() + interval '5 minutes')
  where id = j.id;
  return jsonb_build_object('ok', true);
end;
$$;

-- delpro_catalog_job_result(jsonb):
--   { job_id, success: bool,
--     readback: [ { object_type, record } ],     -- typed like an upload
--     error, error_code, retryable, verification_failed, needs_review, details }
-- Success: mirror updated from the read-back, link created (create jobs) /
-- template lines get their DelPro keys, base := what GVET sent, reconcile.
create or replace function delpro_catalog_job_result(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  j delpro_catalog_jobs%rowtype;
  rb jsonb;
  s jsonb;
  v_link uuid;
  v_key text;
  v_status text;
  v_reconcile jsonb;
begin
  select * into j from delpro_catalog_jobs where id = nullif(p_body->>'job_id', '')::uuid for update;
  if j.id is null then
    raise exception 'Užduotis nerasta.';
  end if;
  if j.status <> 'processing' then
    return jsonb_build_object('ok', true, 'status', j.status, 'already', true);
  end if;

  if coalesce((p_body->>'success')::boolean, false) then
    for rb in select * from jsonb_array_elements(coalesce(p_body->'readback', '[]'::jsonb))
    loop
      perform fn_delpro_catalog_put_item(rb->>'object_type', rb->'record');
    end loop;

    if not j.is_test then
      v_key := coalesce(j.progress->'main'->>'key', j.delpro_key);
      if j.operation = 'create' then
        begin
          v_link := fn_delpro_catalog_create_link(j.object_type, v_key, coalesce(j.disease_id, j.product_id, j.template_id), 'created', j.gvet_values);
        exception when others then
          update delpro_catalog_jobs
          set status = 'needs_review', completed_at = now(), lease_expires_at = null, readback = p_body->'readback',
              error = 'Įrašas sukurtas DelPro (' || coalesce(v_key, '?') || '), bet nepavyko susieti: ' || sqlerrm
          where id = j.id;
          return jsonb_build_object('ok', true, 'status', 'needs_review');
        end;
      else
        v_link := j.link_id;
        update delpro_catalog_links
        set synced_fields = coalesce(synced_fields, '{}'::jsonb) || coalesce(j.gvet_values, '{}'::jsonb), synced_at = now()
        where id = v_link and retired_at is null;
      end if;

      -- template lines remember the DelPro usage / parameters they became
      for s in select * from jsonb_array_elements(j.steps)
      loop
        continue when s->>'item_id' is null or j.progress->(s->>'id')->>'key' is null;
        if s->>'object' = 'TreatmentDrugUsage' then
          update treatment_template_items set delpro_usage_key = j.progress->(s->>'id')->>'key' where id = (s->>'item_id')::uuid;
        elsif s->>'object' = 'DrugParameters' then
          update treatment_template_items set delpro_params_key = j.progress->(s->>'id')->>'key' where id = (s->>'item_id')::uuid;
        end if;
      end loop;
    end if;

    update delpro_catalog_jobs
    set status = 'success', completed_at = now(), lease_expires_at = null, readback = p_body->'readback', error = null,
        link_id = coalesce(v_link, link_id), delpro_key = coalesce(v_key, delpro_key)
    where id = j.id;
    v_reconcile := fn_delpro_catalog_reconcile();
    return jsonb_build_object('ok', true, 'status', 'success', 'reconcile', v_reconcile);
  end if;

  v_status := case
    when coalesce((p_body->>'verification_failed')::boolean, false) then 'verification_failed'
    when coalesce((p_body->>'needs_review')::boolean, false) then 'needs_review'
    when coalesce((p_body->>'retryable')::boolean, false) and j.attempts < j.max_attempts then 'queued'
    else 'failed'
  end;
  update delpro_catalog_jobs
  set status = v_status,
      error = left(coalesce(nullif(p_body->>'error', ''), 'Nežinoma klaida'), 2000),
      error_details = jsonb_strip_nulls(jsonb_build_object('code', p_body->>'error_code', 'details', p_body->'details')),
      readback = coalesce(p_body->'readback', readback),
      next_attempt_at = case when v_status = 'queued' then now() + make_interval(secs => least(60 * power(2, j.attempts), 3600)::int) end,
      completed_at = case when v_status = 'queued' then null else now() end,
      lease_expires_at = null
  where id = j.id;
  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

-- ===========================================================================
-- Views v2
-- ===========================================================================

create or replace view vw_delpro_catalog_items
with (security_invoker = true) as
select
  i.*,
  l.id as link_id,
  l.origin as link_origin,
  l.disease_id,
  l.product_id,
  coalesce(d.name, p.name, t.name) as gvet_name,
  l.template_id
from delpro_catalog_items i
left join delpro_catalog_links l
  on l.retired_at is null and l.object_type = i.object_type and l.delpro_key = i.delpro_key
left join diseases d on d.id = l.disease_id
left join products p on p.id = l.product_id
left join treatment_templates t on t.id = l.template_id;

create or replace view vw_delpro_catalog_gvet_unlinked
with (security_invoker = true) as
select 'Diagnosis'::text as object_type, 'diseases'::text as gvet_table, d.id as gvet_id, d.name
from diseases d
where not exists (select 1 from delpro_catalog_links l where l.retired_at is null and l.disease_id = d.id)
union all
select 'Drug', 'products', p.id, p.name
from products p
where p.is_active and fn_is_drug_category(p.category)
  and not exists (select 1 from delpro_catalog_links l where l.retired_at is null and l.product_id = p.id)
union all
select 'Treatment', 'treatment_templates', t.id, t.name
from treatment_templates t
where not exists (select 1 from delpro_catalog_links l where l.retired_at is null and l.template_id = t.id);

create or replace view vw_delpro_catalog_issues
with (security_invoker = true) as
select
  iss.*,
  coalesce(iss.details->>'delpro_name', i.name) as delpro_name,
  coalesce(d.name, p.name, t.name, iss.details->>'gvet_name') as gvet_name
from delpro_catalog_issues iss
left join delpro_catalog_items i on i.object_type = iss.object_type and i.delpro_key = iss.delpro_key
left join diseases d on iss.gvet_table = 'diseases' and d.id = iss.gvet_id
left join products p on iss.gvet_table = 'products' and p.id = iss.gvet_id
left join treatment_templates t on iss.gvet_table = 'treatment_templates' and t.id = iss.gvet_id;

create view vw_treatment_templates
with (security_invoker = true) as
select
  t.*,
  l.delpro_key,
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', i.id, 'product_id', i.product_id, 'product_name', p.name, 'unit', p.unit,
             'dosage', i.dosage, 'frequency', i.frequency, 'treat_cow_days', i.treat_cow_days,
             'uom', i.uom, 'application_method', i.application_method, 'milk_days', i.milk_days, 'meat_days', i.meat_days,
             'delpro_usage_key', i.delpro_usage_key) order by i.sort_order, i.created_at)
    from treatment_template_items i join products p on p.id = i.product_id
    where i.template_id = t.id
  ), '[]'::jsonb) as items,
  coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.name)
            from diseases d where d.recommended_template_id = t.id), '[]'::jsonb) as diseases
from treatment_templates t
left join delpro_catalog_links l on l.retired_at is null and l.template_id = t.id;

-- ===========================================================================
-- C. Gateway channel for treatment events (built, off by default)
-- ===========================================================================

alter table delpro_sync_jobs
  add column gateway_entry jsonb,
  add column requires_verification boolean not null default false;

comment on column delpro_sync_jobs.gateway_entry is
  'Gateway channel only: the DiagnosesAndTreatmentEvent values, frozen at first claim (the Comment marker must never change between attempts).';

-- The verified CreateData shape: Animal (ObjectGuid), Diagnosis (Code),
-- EventDate (UTC instant), EventTime (local), Comment — with the
-- GVET:<sync_id> marker first, so a retry can find an earlier write.
create or replace function fn_delpro_gateway_entry(p_treatment_id uuid, p_sync_id uuid)
returns jsonb
language sql
stable
as $$
  with t as (
    select t.*,
           (t.reg_date + (t.created_at at time zone 'Europe/Vilnius')::time) as local_ts
    from treatments t where t.id = p_treatment_id
  ),
  meds as (
    select string_agg(format('%s %s %s', p.name, trim_scale(x.qty), x.unit), '; ' order by p.name) as text
    from (select ui.product_id, sum(ui.qty) as qty, ui.unit from usage_items ui where ui.treatment_id = p_treatment_id
          group by ui.product_id, ui.unit) x
    join products p on p.id = x.product_id
  )
  select jsonb_build_object(
    'animal_guid', a.delpro_object_guid,
    'animal_no', a.animal_no,
    'diagnosis_code', (select l.delpro_key from delpro_catalog_links l where l.retired_at is null and l.disease_id = t.disease_id),
    'event_at', to_char((t.local_ts at time zone 'Europe/Vilnius') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'event_date_local', to_char(t.local_ts, 'YYYY-MM-DD'),
    'event_time', to_char(t.local_ts, 'HH24:MI:SS'),
    'comment', left(
      'GVET:' || p_sync_id::text
      || coalesce(' ' || nullif(btrim(t.diagnosis), ''), '')
      || coalesce(' | ' || (select text from meds), '')
      || coalesce(' | kursas ' || (select max(tc.days) from treatment_courses tc where tc.treatment_id = t.id and tc.status <> 'cancelled') || ' d.', ''),
      250))
  from t join animals a on a.id = t.animal_id;
$$;

-- Problems depend on the channel. The UI-script checks (0034) stay as they
-- were; the Gateway channel needs the animal's ObjectGuid and a catalog-linked
-- diagnosis instead of a herd number and single-medicine shape (medicines go
-- into the Comment, so several lines / course variations are fine).
alter function fn_delpro_transfer_problems(uuid) rename to fn_delpro_transfer_problems_ui;

create or replace function fn_delpro_transfer_problems(p_treatment_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_probs jsonb := fn_delpro_transfer_problems_ui(p_treatment_id);
  t treatments%rowtype;
begin
  if coalesce((select setting_value from system_settings where setting_key = 'delpro_write_channel'), 'ui_script') <> 'gateway' then
    return v_probs;
  end if;
  select * into t from treatments where id = p_treatment_id;
  if t.id is null or t.procedure_type <> 'gydymas' then
    return v_probs;
  end if;

  select coalesce(jsonb_agg(p), '[]'::jsonb) into v_probs
  from jsonb_array_elements(v_probs) p
  where p->>'code' not in ('animal_number', 'multi_medicine', 'course_variants', 'medicine_name_invalid');

  if (select delpro_object_guid from animals where id = t.animal_id) is null then
    v_probs := v_probs || fn_delpro_problem('animal_guid',
      'Gyvulio DelPro ObjectGuid dar nežinomas (gaunamas katalogo sinchronizacijos metu pagal gyvulio numerį).');
  end if;
  if t.disease_id is not null and not exists (
    select 1 from delpro_catalog_links where retired_at is null and object_type = 'Diagnosis' and disease_id = t.disease_id
  ) then
    v_probs := v_probs || fn_delpro_problem('diagnosis_link',
      format('Liga „%s“ nesusieta su DelPro diagnoze (DelPro → Katalogo sinchronizacija).', (select name from diseases where id = t.disease_id)),
      jsonb_build_object('kind', 'disease', 'local_id', t.disease_id, 'name', (select name from diseases where id = t.disease_id)));
  end if;
  return v_probs;
end;
$$;

-- Views bind functions by OID: re-create the queue view so preview_problems
-- uses the channel-aware function, not the renamed UI one. Same columns, the
-- two new job columns appended.
create or replace view vw_delpro_sync_jobs
with (security_invoker = true) as
select
  j.id, j.treatment_id, j.status, j.approved_payload, j.auto_approved, j.approved_by, j.approved_at,
  j.rejected_by, j.rejected_at, j.rejection_reason, j.worker_id, j.started_at, j.completed_at, j.attempts,
  j.actual_result, j.verified, j.verified_at, j.error, j.error_details, j.created_at, j.updated_at,
  case when j.approved_payload is null then fn_build_delpro_payload(j.treatment_id) end as preview_payload,
  a.tag_no,
  a.animal_no,
  t.reg_date,
  t.diagnosis,
  case when j.status = 'pending_approval' then fn_delpro_transfer_problems(j.treatment_id) end as preview_problems,
  case when j.approved_payload is not null then fn_delpro_payload_stale(j.treatment_id, j.approved_payload) else false end as payload_stale,
  (select coalesce(u.full_name, u.email) from users u where u.id = j.approved_by) as approved_by_name,
  j.gateway_entry,
  j.requires_verification
from delpro_sync_jobs j
join treatments t on t.id = j.treatment_id
join animals a on a.id = t.animal_id;

-- Claim v3: optional p_channel — a worker states which channel it executes and
-- gets nothing if the farm is configured for another one (so a gateway worker
-- can never consume ui_script jobs or vice versa). The gateway entry is frozen
-- at first claim; verify_before_write tells the worker to look for the marker.
drop function delpro_claim_next_job(text);

create or replace function delpro_claim_next_job(p_worker_id text, p_channel text default null)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_mode text;
  v_channel text := coalesce((select setting_value from system_settings where setting_key = 'delpro_write_channel'), 'ui_script');
  v_delay integer;
  v_job delpro_sync_jobs%rowtype;
  v_skip uuid[] := '{}';
  v_entry jsonb;
begin
  update system_settings set setting_value = now()::text where setting_key = 'delpro_worker_last_seen_at';

  if p_channel is not null and p_channel <> v_channel then
    return null;
  end if;

  select setting_value into v_mode from system_settings where setting_key = 'delpro_outbound_mode';
  if coalesce(v_mode, 'approval') = 'off' then
    return null;
  end if;
  select coalesce(nullif(setting_value, '')::integer, 10) into v_delay from system_settings where setting_key = 'delpro_auto_delay_minutes';

  loop
    select * into v_job
    from delpro_sync_jobs
    where (status = 'approved'
           or (v_mode = 'auto' and status = 'pending_approval' and created_at < now() - make_interval(mins => coalesce(v_delay, 10))))
      and id <> all (v_skip)
    order by coalesce(approved_at, created_at) asc
    for update skip locked
    limit 1;

    if not found then
      return null;
    end if;

    if v_job.status = 'approved' then
      if v_job.approved_payload is null or fn_delpro_payload_stale(v_job.treatment_id, v_job.approved_payload) then
        update delpro_sync_jobs
        set status = 'pending_approval',
            approved_payload = null,
            approved_by = null,
            approved_at = null,
            error = 'Gydymo ar susiejimų duomenys pasikeitė po patvirtinimo — reikia patvirtinti iš naujo.'
        where id = v_job.id;
        insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
        values (null, 'delpro_transfer_invalidated', 'delpro_sync_jobs', v_job.id,
                jsonb_build_object('status', 'approved', 'approved_payload', v_job.approved_payload),
                jsonb_build_object('status', 'pending_approval', 'worker_id', p_worker_id));
        v_skip := v_skip || v_job.id;
        continue;
      end if;
    else
      if jsonb_array_length(fn_delpro_transfer_problems(v_job.treatment_id)) > 0 then
        v_skip := v_skip || v_job.id;
        continue;
      end if;
      v_job.approved_payload := fn_build_delpro_payload(v_job.treatment_id) || jsonb_build_object('sync_id', v_job.id);
      update delpro_sync_jobs
      set approved_payload = v_job.approved_payload, auto_approved = true, approved_at = now(), error = null
      where id = v_job.id;
    end if;

    if v_channel = 'gateway' then
      v_entry := coalesce(v_job.gateway_entry, fn_delpro_gateway_entry(v_job.treatment_id, v_job.id));
      if v_entry->>'animal_guid' is null or v_entry->>'diagnosis_code' is null then
        update delpro_sync_jobs
        set status = 'error', completed_at = now(),
            error = 'Trūksta gyvulio ObjectGuid arba DelPro diagnozės susiejimo — Gateway įrašas negalimas.'
        where id = v_job.id;
        v_skip := v_skip || v_job.id;
        continue;
      end if;
      update delpro_sync_jobs set gateway_entry = v_entry where id = v_job.id;
    end if;

    update delpro_sync_jobs
    set status = 'processing', started_at = now(), worker_id = p_worker_id
    where id = v_job.id;

    return v_job.approved_payload
      || jsonb_build_object('sync_id', v_job.id, 'channel', v_channel)
      || case when v_channel = 'gateway'
              then jsonb_build_object('gateway', v_entry, 'verify_before_write', v_job.requires_verification)
              else '{}'::jsonb end;
  end loop;
end;
$$;

revoke all on function delpro_claim_next_job(text, text) from public, anon, authenticated;
grant execute on function delpro_claim_next_job(text, text) to service_role;

-- Report v2: a gateway read-back is compared with the frozen gateway entry
-- (animal guid, diagnosis code, comment marker, event date). outcome_unknown
-- (timeout after the write was sent) makes the next attempt verify first.
create or replace function delpro_report_job_result(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  v_sync_id uuid;
  v_job delpro_sync_jobs%rowtype;
  v_actual jsonb;
  v_expected jsonb;
  v_verified boolean;
begin
  v_sync_id := (p_body->>'sync_id')::uuid;
  if v_sync_id is null then
    raise exception 'Trūksta sync_id.';
  end if;

  select * into v_job from delpro_sync_jobs where id = v_sync_id for update;
  if not found then
    raise exception 'Sync užduotis nerasta: %', v_sync_id;
  end if;

  if v_job.status in ('success', 'error', 'verification_failed') then
    return to_jsonb(v_job);
  end if;
  if v_job.status <> 'processing' then
    raise exception 'Sync užduotis % nėra vykdoma (status=%).', v_sync_id, v_job.status;
  end if;

  if coalesce((p_body->>'success')::boolean, false) then
    v_actual := p_body->'actual_result';
    if v_actual->>'channel' = 'gateway' then
      v_expected := v_job.gateway_entry;
      v_verified := v_actual is not null and v_expected is not null
        and lower(v_actual->>'animal_guid') = lower(v_expected->>'animal_guid')
        and (v_actual->>'diagnosis_code') = (v_expected->>'diagnosis_code')
        and (v_actual->>'comment') = (v_expected->>'comment')
        and left(v_actual->>'event_date', 10) in (left(v_expected->>'event_at', 10), v_expected->>'event_date_local');
    else
      v_expected := v_job.approved_payload->'delpro';
      v_verified := v_actual is not null
        and (v_actual->>'event_date') is not distinct from (v_expected->>'event_date')
        and (v_actual->>'animal_no') is not distinct from (v_job.approved_payload->'animal'->>'animal_no')
        and coalesce((v_actual->>'milk_withdrawal_days')::int, -1) = coalesce((v_expected->>'milk_withdrawal_days')::int, -1)
        and coalesce((v_actual->>'meat_withdrawal_days')::int, -1) = coalesce((v_expected->>'meat_withdrawal_days')::int, -1);
    end if;

    update delpro_sync_jobs
    set status = case when v_verified then 'success' else 'verification_failed' end,
        actual_result = v_actual,
        verified = v_verified,
        verified_at = now(),
        completed_at = now(),
        attempts = attempts + 1
    where id = v_sync_id
    returning * into v_job;
  else
    update delpro_sync_jobs
    set status = 'error',
        error = coalesce(nullif(p_body->>'error_message', ''), 'Nežinoma klaida'),
        error_details = p_body->'error_details',
        requires_verification = requires_verification or coalesce((p_body->>'outcome_unknown')::boolean, false),
        completed_at = now(),
        attempts = attempts + 1
    where id = v_sync_id
    returning * into v_job;
  end if;

  return to_jsonb(v_job);
end;
$$;

revoke all on function delpro_report_job_result(jsonb) from public, anon, authenticated;
grant execute on function delpro_report_job_result(jsonb) to service_role;

-- A job released after the worker went silent mid-write may have been written.
create or replace function delpro_release_stale_jobs()
returns integer
language sql
security invoker
as $$
  with released as (
    update delpro_sync_jobs
    set status = 'approved', worker_id = null, requires_verification = true,
        error = 'Darbininkas neatsakė — užduotis grąžinta į eilę (prieš kartojant bus patikrinta DelPro).'
    where status = 'processing' and started_at < now() - interval '30 minutes'
    returning 1
  )
  select count(*)::integer from released;
$$;

revoke all on function delpro_release_stale_jobs() from public, anon, authenticated;
grant execute on function delpro_release_stale_jobs() to service_role;

-- ===========================================================================
-- Privileges
-- ===========================================================================

revoke all on function fn_delpro_apply_link_field(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function fn_delpro_template_items_from_delpro(uuid, text) from public, anon, authenticated;
revoke all on function fn_delpro_catalog_enqueue(text, text, uuid, uuid, jsonb, boolean) from public, anon, authenticated;
revoke all on function fn_delpro_catalog_put_item(text, jsonb) from public, anon, authenticated;
grant execute on function fn_delpro_catalog_put_item(text, jsonb) to service_role;
revoke all on function fn_delpro_catalog_create_link(text, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function fn_delpro_catalog_create_link(text, text, uuid, text, jsonb) to service_role; -- delpro_catalog_job_result (invoker)
revoke all on function fn_delpro_catalog_reconcile() from public, anon, authenticated;
grant execute on function fn_delpro_catalog_reconcile() to service_role;

revoke all on function delpro_catalog_claim_job(jsonb) from public, anon, authenticated;
revoke all on function delpro_catalog_job_step(jsonb) from public, anon, authenticated;
revoke all on function delpro_catalog_job_result(jsonb) from public, anon, authenticated;
grant execute on function delpro_catalog_claim_job(jsonb) to service_role;
grant execute on function delpro_catalog_job_step(jsonb) to service_role;
grant execute on function delpro_catalog_job_result(jsonb) to service_role;

revoke all on function save_treatment_template(jsonb) from public, anon;
revoke all on function delete_treatment_template(uuid) from public, anon;
revoke all on function delpro_catalog_enqueue_create(text, uuid) from public, anon;
revoke all on function delpro_catalog_create_test_job(text) from public, anon;
revoke all on function delpro_catalog_mark_validated(uuid) from public, anon;
revoke all on function delpro_catalog_unvalidate(text) from public, anon;
revoke all on function delpro_catalog_set_write_enabled(boolean) from public, anon;
revoke all on function delpro_catalog_job_action(uuid, text, text, text) from public, anon;
grant execute on function save_treatment_template(jsonb) to authenticated;
grant execute on function delete_treatment_template(uuid) to authenticated;
grant execute on function delpro_catalog_enqueue_create(text, uuid) to authenticated;
grant execute on function delpro_catalog_create_test_job(text) to authenticated;
grant execute on function delpro_catalog_mark_validated(uuid) to authenticated;
grant execute on function delpro_catalog_unvalidate(text) to authenticated;
grant execute on function delpro_catalog_set_write_enabled(boolean) to authenticated;
grant execute on function delpro_catalog_job_action(uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';

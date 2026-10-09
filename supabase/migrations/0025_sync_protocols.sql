-- 0025_sync_protocols.sql
-- Dovinės ŽŪB GVET PRO — Sinchronizacijos protokolai (estrus synchronization),
-- requested by the farm (2026-10). NOT in Priedas Nr. 1 — billed separately
-- per Sutartis §2.5/§4.6. Ported from Vaida's sync_protocols (functional spec).
--
-- A protocol is the farm's own reusable template (e.g. "Ovsynch"): dated steps
-- (day offset from the start date + what is done + optional medicine lines).
-- Applying one to an animal creates ONE planned visit (animal_visits, 0018)
-- per step, so sinchronizacija is simply another visit procedure.
--
-- Stock is NOT touched when a protocol is applied. The medicine on a step is
-- only staged on the visit (planned_medications); when the vet records that
-- step it goes through the normal create_treatment_for_visit() ->
-- fn_consume_fefo(), so FEFO, karencija and the nurašymo aktai work as for any
-- other treatment. Visits copy the step, so editing or deleting a protocol
-- never rewrites visits that were already planned.
--
-- Recording a step creates a treatment with procedure_type 'sinchronizacija'.
-- Like 'apziura' / 'profilaktika' it is NOT queued for DelPro (only 'gydymas'
-- is, see fn_treatments_enqueue_delpro_sync, 0006).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table sync_protocols (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  description text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index sync_protocols_name_key on sync_protocols (lower(name));

create trigger trg_sync_protocols_updated_at
  before update on sync_protocols
  for each row execute function set_updated_at();

create table sync_protocol_steps (
  id uuid primary key default gen_random_uuid(),
  protocol_id uuid not null references sync_protocols (id) on delete cascade,
  day_offset integer not null check (day_offset between 0 and 120),
  title text not null check (btrim(title) <> ''),
  notes text,
  sort_order integer not null default 0,
  -- 'veiksmas' = a procedure / injection (its visit is recorded as a treatment);
  -- 'sekinimas' = the insemination step (its visit is closed by recording a
  -- sėklinimas, see 0029). A sekinimas step plans no medicine: semen and gloves
  -- are picked from stock when the insemination is recorded.
  kind text not null default 'veiksmas' check (kind in ('veiksmas', 'sekinimas')),
  -- [{ product_id, qty, unit, administration_route }] — staged on the visit.
  medications jsonb not null default '[]'::jsonb check (jsonb_typeof(medications) = 'array')
);
create index sync_protocol_steps_protocol_id_idx on sync_protocol_steps (protocol_id);

-- One row per "protocol applied to an animal". protocol_name is a snapshot so
-- the history survives renaming / deleting the template.
create table sync_protocol_applications (
  id uuid primary key default gen_random_uuid(),
  protocol_id uuid references sync_protocols (id) on delete set null,
  protocol_name text not null,
  animal_id uuid not null references animals (id),
  start_date date not null,
  applied_by text,
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);
create index sync_protocol_applications_animal_id_idx on sync_protocol_applications (animal_id);

-- ---------------------------------------------------------------------------
-- Visits: the new procedure + the step they were generated from
-- ---------------------------------------------------------------------------

alter table animal_visits drop constraint animal_visits_procedures_check;
alter table animal_visits add constraint animal_visits_procedures_check
  check (procedures <@ array['temperatura', 'apziura', 'profilaktika', 'gydymas', 'vakcina', 'sinchronizacija', 'sekinimas', 'kita']::text[]);

alter table animal_visits
  add column sync_application_id uuid references sync_protocol_applications (id) on delete set null,
  add column sync_step_title text,
  add column sync_step_no integer,
  add column sync_step_total integer,
  add column planned_medications jsonb not null default '[]'::jsonb check (jsonb_typeof(planned_medications) = 'array');
create index animal_visits_sync_application_id_idx on animal_visits (sync_application_id) where sync_application_id is not null;

alter table treatments drop constraint treatments_procedure_type_check;
alter table treatments add constraint treatments_procedure_type_check
  check (procedure_type in ('apziura', 'gydymas', 'profilaktika', 'sinchronizacija'));

-- ---------------------------------------------------------------------------
-- RLS: same shape as visits (every active user reads, active staff writes)
-- ---------------------------------------------------------------------------

alter table sync_protocols enable row level security;
alter table sync_protocol_steps enable row level security;
alter table sync_protocol_applications enable row level security;

create policy sync_protocols_select on sync_protocols for select using (fn_is_authenticated_active());
create policy sync_protocols_insert on sync_protocols for insert with check (fn_is_active_staff());
create policy sync_protocols_update on sync_protocols for update using (fn_is_active_staff());
create policy sync_protocols_delete on sync_protocols for delete using (fn_is_active_staff());

create policy sync_protocol_steps_select on sync_protocol_steps for select using (fn_is_authenticated_active());
create policy sync_protocol_steps_insert on sync_protocol_steps for insert with check (fn_is_active_staff());
create policy sync_protocol_steps_update on sync_protocol_steps for update using (fn_is_active_staff());
create policy sync_protocol_steps_delete on sync_protocol_steps for delete using (fn_is_active_staff());

create policy sync_protocol_applications_select on sync_protocol_applications for select using (fn_is_authenticated_active());
create policy sync_protocol_applications_insert on sync_protocol_applications for insert with check (fn_is_active_staff());
create policy sync_protocol_applications_update on sync_protocol_applications for update using (fn_is_active_staff());
create policy sync_protocol_applications_delete on sync_protocol_applications for delete using (fn_is_active_staff());

-- ---------------------------------------------------------------------------
-- fn_sync_clean_medications(jsonb) — validates a step's medicine lines and
-- normalises them: the unit always comes from the product (as the treatment
-- dialog does), never from the client. Blank lines are dropped.
-- ---------------------------------------------------------------------------

create or replace function fn_sync_clean_medications(p_meds jsonb)
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  m jsonb;
  v_prod products%rowtype;
  v_out jsonb := '[]'::jsonb;
begin
  if p_meds is null or jsonb_typeof(p_meds) <> 'array' then
    return '[]'::jsonb;
  end if;
  for m in select * from jsonb_array_elements(p_meds) loop
    continue when nullif(m->>'product_id', '') is null and coalesce(nullif(m->>'qty', '')::numeric, 0) <= 0;
    if nullif(m->>'product_id', '') is null then
      raise exception 'Pasirinkite produktą vaisto eilutei.';
    end if;
    select * into v_prod from products where id = (m->>'product_id')::uuid;
    if not found then
      raise exception 'Produktas nerastas.';
    end if;
    if coalesce(nullif(m->>'qty', '')::numeric, 0) <= 0 then
      raise exception 'Nurodykite produkto „%“ kiekį (didesnį už 0).', v_prod.name;
    end if;
    -- Same categories the treatment dialog can give (TREATMENT_PRODUCT_CATEGORIES):
    -- a planned medicine must be recordable when the step is done.
    if v_prod.category::text not in ('medicines', 'vakcina', 'profilaktika', 'boliusai', 'treatment_materials') then
      raise exception 'Produktas „%“ netinka sinchronizacijos protokolui.', v_prod.name;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'product_id', v_prod.id,
      'qty', (m->>'qty')::numeric,
      'unit', v_prod.unit,
      'administration_route', nullif(m->>'administration_route', '')
    ));
  end loop;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- save_sync_protocol(jsonb) — { id?, name, description, steps:
-- [{ day_offset, title, notes, kind, medications[] }] }. Creates or replaces a
-- protocol and ALL its steps in one transaction. Returns the protocol id.
-- Visits already generated keep their own copy of the steps.
-- ---------------------------------------------------------------------------

create or replace function save_sync_protocol(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid := nullif(p_data->>'id', '')::uuid;
  v_name text := btrim(coalesce(p_data->>'name', ''));
  v_steps jsonb := coalesce(p_data->'steps', '[]'::jsonb);
  s jsonb;
  i integer := 0;
begin
  if v_name = '' then
    raise exception 'Įveskite protokolo pavadinimą.';
  end if;
  if jsonb_typeof(v_steps) <> 'array' or jsonb_array_length(v_steps) = 0 then
    raise exception 'Pridėkite bent vieną protokolo žingsnį.';
  end if;
  if exists (select 1 from sync_protocols where lower(name) = lower(v_name) and id is distinct from v_id) then
    raise exception 'Protokolas „%“ jau yra.', v_name;
  end if;

  if v_id is null then
    insert into sync_protocols (name, description, created_by)
    values (v_name, nullif(btrim(coalesce(p_data->>'description', '')), ''), auth.uid())
    returning id into v_id;
  else
    update sync_protocols
       set name = v_name,
           description = nullif(btrim(coalesce(p_data->>'description', '')), '')
     where id = v_id;
    if not found then
      raise exception 'Protokolas nerastas.';
    end if;
    delete from sync_protocol_steps where protocol_id = v_id;
  end if;

  for s in select * from jsonb_array_elements(v_steps) loop
    i := i + 1;
    if btrim(coalesce(s->>'title', '')) = '' then
      raise exception '% žingsniui įveskite veiksmo pavadinimą.', i;
    end if;
    if coalesce(nullif(s->>'day_offset', '')::integer, 0) not between 0 and 120 then
      raise exception '% žingsnio diena turi būti nuo 0 iki 120.', i;
    end if;
    if coalesce(nullif(s->>'kind', ''), 'veiksmas') not in ('veiksmas', 'sekinimas') then
      raise exception '% žingsnio tipas netinkamas.', i;
    end if;
    insert into sync_protocol_steps (protocol_id, day_offset, title, notes, sort_order, kind, medications)
    values (v_id, coalesce(nullif(s->>'day_offset', '')::integer, 0), btrim(s->>'title'),
            nullif(btrim(coalesce(s->>'notes', '')), ''), i, coalesce(nullif(s->>'kind', ''), 'veiksmas'),
            case when coalesce(nullif(s->>'kind', ''), 'veiksmas') = 'sekinimas' then '[]'::jsonb
                 else fn_sync_clean_medications(s->'medications') end);
  end loop;

  return v_id;
end;
$$;

grant execute on function save_sync_protocol(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- apply_sync_protocol(protocol, animal, start_date, start_time, vet) — one
-- planned visit per step at start_date + day_offset (wall-clock time in
-- Europe/Vilnius, so a DST change inside the protocol cannot shift it).
-- An animal can run one protocol at a time: refused while it still has open
-- steps of an earlier application (cancel it first). Returns the number of
-- visits created.
-- ---------------------------------------------------------------------------

create or replace function apply_sync_protocol(
  p_protocol_id uuid,
  p_animal_id uuid,
  p_start_date date,
  p_start_time text default '09:00',
  p_vet_name text default null
)
returns integer
language plpgsql
security invoker
as $$
declare
  v_protocol sync_protocols%rowtype;
  v_app uuid;
  v_total integer;
  v_open text;
  v_time text := coalesce(nullif(btrim(p_start_time), ''), '09:00');
  st record;
  n integer := 0;
begin
  if p_animal_id is null then
    raise exception 'Pasirinkite gyvūną.';
  end if;
  if p_start_date is null then
    raise exception 'Įveskite pradžios datą.';
  end if;
  select * into v_protocol from sync_protocols where id = p_protocol_id;
  if not found then
    raise exception 'Pasirinkite sinchronizacijos protokolą.';
  end if;
  select count(*) into v_total from sync_protocol_steps where protocol_id = p_protocol_id;
  if v_total = 0 then
    raise exception 'Protokolas „%“ neturi žingsnių.', v_protocol.name;
  end if;

  select a.protocol_name into v_open
  from animal_visits v
  join sync_protocol_applications a on a.id = v.sync_application_id
  where v.animal_id = p_animal_id and v.status in ('planuojamas', 'vykdomas')
  limit 1;
  if v_open is not null then
    raise exception 'Gyvūnui jau taikomas protokolas „%“ — pirmiausia nutraukite jį.', v_open;
  end if;

  insert into sync_protocol_applications (protocol_id, protocol_name, animal_id, start_date, applied_by, created_by)
  values (p_protocol_id, v_protocol.name, p_animal_id, p_start_date, nullif(p_vet_name, ''), auth.uid())
  returning id into v_app;

  for st in select * from sync_protocol_steps where protocol_id = p_protocol_id order by day_offset, sort_order loop
    n := n + 1;
    insert into animal_visits (animal_id, visit_datetime, procedures, status, notes, vet_name, created_by,
                               sync_application_id, sync_step_title, sync_step_no, sync_step_total, planned_medications)
    values (p_animal_id, ((p_start_date + st.day_offset)::text || ' ' || v_time || ' Europe/Vilnius')::timestamptz,
            case st.kind when 'sekinimas' then array['sekinimas'] else array['sinchronizacija'] end,
            'planuojamas', st.notes, nullif(p_vet_name, ''), auth.uid(),
            v_app, st.title, n, v_total, st.medications);
  end loop;

  return n;
end;
$$;

grant execute on function apply_sync_protocol(uuid, uuid, date, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- cancel_sync_application(uuid) — stops a running protocol: its open step
-- visits become 'atsauktas'. Steps already recorded stay as they are.
-- Returns the number of visits cancelled.
-- ---------------------------------------------------------------------------

create or replace function cancel_sync_application(p_application_id uuid)
returns integer
language plpgsql
security invoker
as $$
declare
  n integer;
begin
  update animal_visits set status = 'atsauktas'
   where sync_application_id = p_application_id and status in ('planuojamas', 'vykdomas');
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function cancel_sync_application(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_visit_refresh_status: a sinchronizacija step with medicine is done once a
-- sinchronizacija treatment is linked (the generic procedure_type match);
-- a step without medicine has no record and is closed by hand ("Atlikta").
-- Everything else is unchanged from 0018.
-- ---------------------------------------------------------------------------

create or replace function fn_visit_refresh_status(p_visit_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v animal_visits%rowtype;
  v_pending boolean;
begin
  select * into v from animal_visits where id = p_visit_id;
  if not found or v.status not in ('planuojamas', 'vykdomas') then
    return;
  end if;

  v_pending :=
    exists (
      select 1 from unnest(v.procedures) p
      where p in ('apziura', 'gydymas', 'profilaktika')
        and not exists (select 1 from treatments t where t.visit_id = v.id and t.procedure_type = p)
    )
    or ('vakcina' = any (v.procedures) and not exists (select 1 from vaccinations x where x.visit_id = v.id))
    or ('temperatura' = any (v.procedures) and v.temperature is null)
    or ('sinchronizacija' = any (v.procedures)
        and (jsonb_array_length(v.planned_medications) = 0
             or not exists (select 1 from treatments t where t.visit_id = v.id and t.procedure_type = 'sinchronizacija')))
    or 'kita' = any (v.procedures);

  update animal_visits set status = case when v_pending then 'vykdomas' else 'baigtas' end where id = p_visit_id;
end;
$$;

notify pgrst, 'reload schema';

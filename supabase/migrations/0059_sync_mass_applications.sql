-- 0059_sync_mass_applications.sql
-- Dovinės ŽŪB GVET PRO — Sinchronizacijos tab (farm's request, 2026-11).
-- Extends Sinchronizacijos protokolai (0025) — NOT in Priedas Nr. 1, billed
-- separately per Sutartis §2.5/§4.6 together with them.
--
-- /veterinarija/sinchronizacijos: one protocol for many animals at once, the
-- due steps of every animal on one list, running / finished protocols, and the
-- protocol templates. Oksana / Monika start a protocol one animal at a time
-- with several client inserts (no transaction); here everything is an RPC:
--
--   apply_sync_protocol_mass(jsonb) — apply_sync_protocol() once per animal in
--     ONE transaction (an animal that already runs a protocol refuses the whole
--     batch, so nothing is half-applied). Header in sync_mass_applications.
--     Like a single application it consumes NO stock.
--   complete_sync_steps(jsonb) — records many due steps at once: a step with
--     planned medicine becomes the same 'sinchronizacija' treatment the visit
--     card creates (create_treatment_with_visits → FEFO, karencija, never queued
--     for DelPro); a step without medicine is closed. One transaction: a stock
--     shortfall records none. Insemination steps are refused — they need the
--     semen picked in the Sėklinimas dialog.
--   cancel_sync_applications(uuid[]) — cancel_sync_application() for each.

create table sync_mass_applications (
  id uuid primary key default gen_random_uuid(),
  protocol_id uuid references sync_protocols (id) on delete set null,
  protocol_name text not null,
  start_date date not null,
  start_time text not null default '09:00',
  vet_name text,
  notes text,
  animal_count integer not null check (animal_count > 0),
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);

alter table sync_protocol_applications
  add column mass_application_id uuid references sync_mass_applications (id) on delete set null;
create index sync_protocol_applications_mass_idx on sync_protocol_applications (mass_application_id) where mass_application_id is not null;

alter table sync_mass_applications enable row level security;
create policy sync_mass_applications_select on sync_mass_applications for select using (fn_is_authenticated_active());
create policy sync_mass_applications_insert on sync_mass_applications for insert with check (fn_is_active_staff());
create policy sync_mass_applications_update on sync_mass_applications for update using (fn_is_active_staff());
grant select, insert, update on sync_mass_applications to authenticated;

-- ---------------------------------------------------------------------------
-- apply_sync_protocol_mass(jsonb) —
-- { protocol_id, animal_ids:[uuid], start_date, start_time?, vet_name?, notes? }
-- Returns { mass_application_id, animals, visits }.
-- ---------------------------------------------------------------------------

create or replace function apply_sync_protocol_mass(p_data jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_protocol sync_protocols%rowtype;
  v_ids uuid[];
  v_start date := nullif(p_data->>'start_date', '')::date;
  v_time text := coalesce(nullif(btrim(p_data->>'start_time'), ''), '09:00');
  v_vet text := nullif(btrim(p_data->>'vet_name'), '');
  v_busy text;
  v_mass uuid;
  v_visits integer := 0;
  a uuid;
begin
  if jsonb_typeof(p_data->'animal_ids') is distinct from 'array' then
    raise exception 'Pasirinkite bent vieną gyvūną.';
  end if;
  select array_agg(distinct (x #>> '{}')::uuid) into v_ids
  from jsonb_array_elements(p_data->'animal_ids') x where nullif(x #>> '{}', '') is not null;
  if v_ids is null then
    raise exception 'Pasirinkite bent vieną gyvūną.';
  end if;
  if array_length(v_ids, 1) > 2000 then
    raise exception 'Vienu kartu galima ne daugiau kaip 2000 gyvūnų.';
  end if;
  if v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Netinkamas laikas „%“.', v_time;
  end if;
  if v_start is null then
    raise exception 'Įveskite pradžios datą.';
  end if;
  select * into v_protocol from sync_protocols where id = nullif(p_data->>'protocol_id', '')::uuid;
  if not found then
    raise exception 'Pasirinkite sinchronizacijos protokolą.';
  end if;

  if (select count(*) from animals where id = any (v_ids) and active) <> array_length(v_ids, 1) then
    raise exception 'Kai kurie pasirinkti gyvūnai nerasti arba neaktyvūs — atnaujinkite puslapį.';
  end if;

  -- Same rule as apply_sync_protocol(), but named for every animal at once.
  select string_agg(coalesce(an.animal_no, an.tag_no) || ' („' || x.protocol_name || '“)', ', ' order by an.animal_no)
  into v_busy
  from (
    select distinct on (v.animal_id) v.animal_id, ap.protocol_name
    from animal_visits v join sync_protocol_applications ap on ap.id = v.sync_application_id
    where v.animal_id = any (v_ids) and v.status in ('planuojamas', 'vykdomas')
  ) x join animals an on an.id = x.animal_id;
  if v_busy is not null then
    raise exception 'Šiems gyvūnams jau taikomas protokolas: % — nuimkite juos arba pirmiausia nutraukite protokolą.', v_busy;
  end if;

  insert into sync_mass_applications (protocol_id, protocol_name, start_date, start_time, vet_name, notes, animal_count, created_by)
  values (v_protocol.id, v_protocol.name, v_start, v_time, v_vet, nullif(btrim(p_data->>'notes'), ''), array_length(v_ids, 1), auth.uid())
  returning id into v_mass;

  foreach a in array v_ids loop
    v_visits := v_visits + apply_sync_protocol(v_protocol.id, a, v_start, v_time, v_vet);
  end loop;

  -- now() is the transaction start, so these are exactly the rows just inserted.
  update sync_protocol_applications
     set mass_application_id = v_mass
   where animal_id = any (v_ids) and protocol_id = v_protocol.id and created_at = now() and mass_application_id is null;

  return jsonb_build_object('mass_application_id', v_mass, 'animals', array_length(v_ids, 1), 'visits', v_visits);
end;
$$;

grant execute on function apply_sync_protocol_mass(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- complete_sync_steps(jsonb) — { visit_ids:[uuid], vet_name? }
-- Only open protocol-step visits planned for today or earlier. Each step is
-- recorded on its own planned day. Returns { steps, treatments }.
-- ---------------------------------------------------------------------------

create or replace function complete_sync_steps(p_data jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_vet text := nullif(btrim(p_data->>'vet_name'), '');
  v_today date := (now() at time zone 'Europe/Vilnius')::date;
  v_ids uuid[];
  v animal_visits%rowtype;
  v_day date;
  v_steps integer := 0;
  v_treat integer := 0;
begin
  if jsonb_typeof(p_data->'visit_ids') is distinct from 'array' then
    raise exception 'Pasirinkite bent vieną žingsnį.';
  end if;
  select array_agg(distinct (x #>> '{}')::uuid) into v_ids
  from jsonb_array_elements(p_data->'visit_ids') x where nullif(x #>> '{}', '') is not null;
  if v_ids is null then
    raise exception 'Pasirinkite bent vieną žingsnį.';
  end if;
  if (select count(*) from animal_visits where id = any (v_ids)) <> array_length(v_ids, 1) then
    raise exception 'Kai kurie žingsniai nerasti — atnaujinkite puslapį.';
  end if;

  for v in
    select * from animal_visits where id = any (v_ids) order by visit_datetime, animal_id for update
  loop
    v_day := (v.visit_datetime at time zone 'Europe/Vilnius')::date;
    if v.sync_application_id is null then
      raise exception 'Vizitas nėra sinchronizacijos protokolo žingsnis.';
    end if;
    if v.status not in ('planuojamas', 'vykdomas') then
      raise exception 'Žingsnis „%“ (%) jau uždarytas.', v.sync_step_title, v_day;
    end if;
    if v_day > v_today then
      raise exception 'Žingsnis „%“ suplanuotas %, jo dar negalima įrašyti.', v.sync_step_title, v_day;
    end if;
    if 'sekinimas' = any (v.procedures) then
      raise exception 'Sėklinimo žingsnį („%“) įrašykite atskirai — reikia pasirinkti spermą.', v.sync_step_title;
    end if;

    if jsonb_array_length(v.planned_medications) > 0 then
      perform create_treatment_with_visits(
        jsonb_build_object(
          'procedure_type', 'sinchronizacija',
          'reg_date', v_day,
          'vet_name', coalesce(v_vet, v.vet_name),
          'notes', v.sync_step_title,
          'medications', v.planned_medications
        ),
        v.id
      );
      v_treat := v_treat + 1;
    else
      update animal_visits set status = 'baigtas', vet_name = coalesce(v_vet, vet_name) where id = v.id;
    end if;
    v_steps := v_steps + 1;
  end loop;

  return jsonb_build_object('steps', v_steps, 'treatments', v_treat);
end;
$$;

grant execute on function complete_sync_steps(jsonb) to authenticated;

create or replace function cancel_sync_applications(p_ids uuid[])
returns integer
language plpgsql
security invoker
as $$
declare
  a uuid;
  n integer := 0;
begin
  foreach a in array coalesce(p_ids, '{}'::uuid[]) loop
    n := n + cancel_sync_application(a);
  end loop;
  return n;
end;
$$;

grant execute on function cancel_sync_applications(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Views (security invoker — RLS of the underlying tables applies)
-- ---------------------------------------------------------------------------

-- One row per protocol applied to an animal, with progress.
create or replace view vw_sync_applications with (security_invoker = true) as
select
  ap.id,
  ap.protocol_id,
  ap.protocol_name,
  ap.animal_id,
  an.animal_no,
  an.tag_no,
  an.group_name,
  ap.start_date,
  ap.applied_by,
  ap.mass_application_id,
  ap.created_at,
  coalesce(s.total, 0) as steps_total,
  coalesce(s.done, 0) as steps_done,
  coalesce(s.cancelled, 0) as steps_cancelled,
  coalesce(s.open, 0) as steps_open,
  s.next_at as next_step_at,
  s.next_title as next_step_title,
  s.last_at as last_step_at,
  case when coalesce(s.open, 0) > 0 then 'aktyvus'
       when coalesce(s.cancelled, 0) > 0 then 'nutrauktas'
       else 'baigtas' end as status
from sync_protocol_applications ap
join animals an on an.id = ap.animal_id
left join lateral (
  select count(*)::integer as total,
         count(*) filter (where v.status = 'baigtas')::integer as done,
         count(*) filter (where v.status in ('atsauktas', 'neivykes'))::integer as cancelled,
         count(*) filter (where v.status in ('planuojamas', 'vykdomas'))::integer as open,
         min(v.visit_datetime) filter (where v.status in ('planuojamas', 'vykdomas')) as next_at,
         (array_agg(v.sync_step_title order by v.visit_datetime) filter (where v.status in ('planuojamas', 'vykdomas')))[1] as next_title,
         max(v.visit_datetime) as last_at
  from animal_visits v where v.sync_application_id = ap.id
) s on true;

-- Every open protocol step (one per animal + step).
create or replace view vw_sync_open_steps with (security_invoker = true) as
select
  v.id as visit_id,
  v.visit_datetime,
  (v.visit_datetime at time zone 'Europe/Vilnius')::date as step_date,
  v.status,
  v.procedures,
  v.sync_step_title,
  v.sync_step_no,
  v.sync_step_total,
  v.planned_medications,
  v.vet_name,
  v.notes,
  v.animal_id,
  an.animal_no,
  an.tag_no,
  an.group_name,
  ap.id as application_id,
  ap.protocol_name,
  ap.mass_application_id
from animal_visits v
join sync_protocol_applications ap on ap.id = v.sync_application_id
join animals an on an.id = v.animal_id
where v.status in ('planuojamas', 'vykdomas');

-- Mass applications with how many of their animals are still running.
create or replace view vw_sync_mass_applications with (security_invoker = true) as
select
  m.*,
  coalesce(x.active, 0) as active_count,
  coalesce(x.finished, 0) as finished_count,
  coalesce(x.cancelled, 0) as cancelled_count
from sync_mass_applications m
left join lateral (
  select count(*) filter (where a.status = 'aktyvus')::integer as active,
         count(*) filter (where a.status = 'baigtas')::integer as finished,
         count(*) filter (where a.status = 'nutrauktas')::integer as cancelled
  from vw_sync_applications a where a.mass_application_id = m.id
) x on true;

-- Per animal: the protocol it runs now and its latest insemination — the
-- warnings on the bulk picker.
create or replace view vw_sync_animal_flags with (security_invoker = true) as
select
  an.id as animal_id,
  op.protocol_name as open_protocol_name,
  li.insemination_date as last_insemination_date,
  li.pregnancy_confirmed as last_pregnancy_confirmed
from animals an
left join lateral (
  select ap.protocol_name
  from animal_visits v join sync_protocol_applications ap on ap.id = v.sync_application_id
  where v.animal_id = an.id and v.status in ('planuojamas', 'vykdomas')
  limit 1
) op on true
left join lateral (
  select r.insemination_date, r.pregnancy_confirmed
  from insemination_records r
  where r.animal_id = an.id
  order by r.insemination_date desc, r.created_at desc
  limit 1
) li on true
where an.active and (op.protocol_name is not null or li.insemination_date is not null);

grant select on vw_sync_applications, vw_sync_open_steps, vw_sync_mass_applications, vw_sync_animal_flags to authenticated;

notify pgrst, 'reload schema';

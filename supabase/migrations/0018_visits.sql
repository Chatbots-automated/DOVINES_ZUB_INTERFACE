-- 0018_visits.sql
-- Dovinės ŽŪB GVET PRO — Vizitai (veterinarijos vizitai), requested by the
-- farm after signing: a scheduling/status layer per animal, ported from
-- Monika's animal_visits (functional spec) and Kairaičių ūkis 0017.
--
-- A visit is only the scheduling wrapper ("patikrinti karvę ketvirtadienį"):
-- it may never involve medicine. The real clinical records stay in
-- `treatments` / `vaccinations` (and their stock in usage_items); they link
-- back through a nullable visit_id (on delete set null — deleting a visit
-- never deletes a legal treatment/vaccination record).
--
-- Stock-consuming work done "during a visit" goes through the *_for_visit
-- wrappers below, which call the existing create_treatment() /
-- create_vaccinations() (-> fn_consume_fefo) and link + advance the visit in
-- the SAME transaction: a stock shortfall rolls back the record, the link and
-- the status change together.
--
-- Out of scope here (see AGENTS.md): nagų sveikata, sinchronizacijos
-- protokolai, masinis gydymas — so those are not visit procedures.

create table animal_visits (
  id uuid primary key default gen_random_uuid(),
  animal_id uuid not null references animals (id),
  visit_datetime timestamptz not null default now(),
  procedures text[] not null default '{}',
  temperature numeric(4,1),
  temperature_measured_at timestamptz,
  status text not null default 'planuojamas',
  notes text,
  vet_name text,
  next_visit_required boolean not null default false,
  next_visit_date date,
  related_visit_id uuid references animal_visits (id) on delete set null,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint animal_visits_status_check
    check (status in ('planuojamas', 'vykdomas', 'baigtas', 'atsauktas', 'neivykes')),
  constraint animal_visits_procedures_check
    check (procedures <@ array['temperatura', 'apziura', 'profilaktika', 'gydymas', 'vakcina', 'kita']::text[])
);

create index animal_visits_animal_id_idx on animal_visits (animal_id);
create index animal_visits_visit_datetime_idx on animal_visits (visit_datetime);
create index animal_visits_status_idx on animal_visits (status);

create trigger trg_animal_visits_updated_at
  before update on animal_visits
  for each row execute function set_updated_at();

alter table treatments add column visit_id uuid references animal_visits (id) on delete set null;
alter table vaccinations add column visit_id uuid references animal_visits (id) on delete set null;
create index treatments_visit_id_idx on treatments (visit_id) where visit_id is not null;
create index vaccinations_visit_id_idx on vaccinations (visit_id) where visit_id is not null;

-- RLS: same shape as 0009 (every active user reads, active staff writes).
alter table animal_visits enable row level security;
create policy animal_visits_select on animal_visits for select using (fn_is_authenticated_active());
create policy animal_visits_insert on animal_visits for insert with check (fn_is_active_staff());
create policy animal_visits_update on animal_visits for update using (fn_is_active_staff());
create policy animal_visits_delete on animal_visits for delete using (fn_is_active_staff());

-- ---------------------------------------------------------------------------
-- create_visit(jsonb) — { animal_id, visit_datetime, procedures[], status,
-- temperature, notes, vet_name, next_visit_required, next_visit_date }.
-- With next_visit_required + next_visit_date a follow-up visit (planuojamas,
-- same procedures, related_visit_id -> this one) is created in the same
-- transaction.
-- ---------------------------------------------------------------------------

create or replace function create_visit(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid;
  v_procs text[];
  v_temp numeric := nullif(p_data->>'temperature', '')::numeric;
  v_when timestamptz := coalesce(nullif(p_data->>'visit_datetime', '')::timestamptz, now());
  v_status text := coalesce(nullif(p_data->>'status', ''), 'planuojamas');
  v_next boolean := coalesce((p_data->>'next_visit_required')::boolean, false);
  v_next_date date := nullif(p_data->>'next_visit_date', '')::date;
begin
  if nullif(p_data->>'animal_id', '') is null then
    raise exception 'Pasirinkite gyvūną.';
  end if;
  select coalesce(array_agg(x), '{}') into v_procs from jsonb_array_elements_text(coalesce(p_data->'procedures', '[]'::jsonb)) x;
  if cardinality(v_procs) = 0 then
    raise exception 'Pasirinkite bent vieną procedūrą.';
  end if;
  if v_next and v_next_date is null then
    raise exception 'Nurodykite kito vizito datą.';
  end if;

  insert into animal_visits (animal_id, visit_datetime, procedures, temperature, temperature_measured_at, status,
                             notes, vet_name, next_visit_required, next_visit_date, created_by)
  values (
    (p_data->>'animal_id')::uuid, v_when, v_procs, v_temp, case when v_temp is not null then now() end, v_status,
    nullif(p_data->>'notes', ''), nullif(p_data->>'vet_name', ''), v_next, case when v_next then v_next_date end, auth.uid()
  )
  returning id into v_id;

  if v_next then
    insert into animal_visits (animal_id, visit_datetime, procedures, status, vet_name, related_visit_id, created_by)
    values ((p_data->>'animal_id')::uuid, (v_next_date::text || ' 09:00 Europe/Vilnius')::timestamptz, v_procs, 'planuojamas',
            nullif(p_data->>'vet_name', ''), v_id, auth.uid());
  end if;

  return v_id;
end;
$$;

grant execute on function create_visit(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_visit_refresh_status(visit) — after a record is linked: 'baigtas' once
-- every tagged clinical procedure (apžiūra / gydymas / profilaktika ->
-- treatments of that procedure_type, vakcina -> vaccinations) has a linked
-- record, otherwise 'vykdomas'. Temperatūra counts as done once a temperature is
-- recorded; "kita" has no record and is closed by hand ("Atlikta"). Only open visits are touched.
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
    or 'kita' = any (v.procedures);

  update animal_visits set status = case when v_pending then 'vykdomas' else 'baigtas' end where id = p_visit_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_treatment_for_visit(visit, create_treatment payload) — the animal
-- always comes from the visit (any animal_id in the payload is overridden).
-- ---------------------------------------------------------------------------

create or replace function create_treatment_for_visit(p_visit_id uuid, p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v animal_visits%rowtype;
  v_id uuid;
begin
  select * into v from animal_visits where id = p_visit_id for update;
  if not found then
    raise exception 'Vizitas nerastas.';
  end if;
  if v.status in ('atsauktas', 'neivykes') then
    raise exception 'Vizitas atšauktas — įrašo pridėti negalima.';
  end if;

  v_id := create_treatment(p_data || jsonb_build_object('animal_id', v.animal_id));
  update treatments set visit_id = p_visit_id where id = v_id;
  perform fn_visit_refresh_status(p_visit_id);
  return v_id;
end;
$$;

grant execute on function create_treatment_for_visit(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- create_vaccination_for_visit(visit, create_vaccinations payload) — single
-- animal (the visit's), returns the number of vaccinations created (1).
-- ---------------------------------------------------------------------------

create or replace function create_vaccination_for_visit(p_visit_id uuid, p_data jsonb)
returns integer
language plpgsql
security invoker
as $$
declare
  v animal_visits%rowtype;
  v_before uuid[];
  v_count integer;
begin
  select * into v from animal_visits where id = p_visit_id for update;
  if not found then
    raise exception 'Vizitas nerastas.';
  end if;
  if v.status in ('atsauktas', 'neivykes') then
    raise exception 'Vizitas atšauktas — įrašo pridėti negalima.';
  end if;

  select coalesce(array_agg(id), '{}') into v_before from vaccinations where animal_id = v.animal_id;
  v_count := create_vaccinations(
    (p_data - 'target_group_name') || jsonb_build_object('animal_ids', jsonb_build_array(v.animal_id))
  );
  update vaccinations set visit_id = p_visit_id where animal_id = v.animal_id and id <> all (v_before) and visit_id is null;
  perform fn_visit_refresh_status(p_visit_id);
  return v_count;
end;
$$;

grant execute on function create_vaccination_for_visit(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

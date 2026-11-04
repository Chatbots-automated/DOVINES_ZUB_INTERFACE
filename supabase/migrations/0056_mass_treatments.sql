-- 0056_mass_treatments.sql
-- Masinis gydymas: the same treatment for many animals at once (pattern from
-- Oksana's BulkTreatment). NOT in Priedas Nr. 1 — billed separately (Sutartis §2.5/§4.6).
--
-- A mass treatment is only a header (mass_treatments) + N ordinary treatments.
-- create_mass_treatment() calls create_treatment_with_visits() once per animal
-- inside ONE transaction, so:
--   * FEFO, karencija, the finished visit and 0046 frequency/duration are exactly
--     those of a single treatment; a stock shortfall for any animal rolls back all;
--   * every gydymas gets its own delpro_sync_jobs row through the existing
--     trg_treatments_enqueue_delpro_sync (0006) — the farm-PC worker sees normal
--     single-animal jobs, so nothing changes on the farm PC.
-- Releasing them to DelPro reuses delpro_approve_jobs() (0033/0045 rules: admin gate,
-- validation, frozen payload) through delpro_approve_mass_treatment().

create table mass_treatments (
  id uuid primary key default gen_random_uuid(),
  reg_date date not null,
  procedure_type text not null check (procedure_type in ('gydymas', 'profilaktika')),
  disease_id uuid references diseases (id),
  diagnosis text,
  vet_name text,
  notes text,
  medications jsonb not null default '[]'::jsonb, -- per-animal lines as saved (display only)
  animal_count integer not null check (animal_count > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

alter table treatments add column mass_treatment_id uuid references mass_treatments (id) on delete set null;
create index treatments_mass_treatment_id_idx on treatments (mass_treatment_id) where mass_treatment_id is not null;

alter table mass_treatments enable row level security;
create policy mass_treatments_select on mass_treatments for select using (fn_is_authenticated_active());
create policy mass_treatments_insert on mass_treatments for insert with check (fn_is_active_staff());
grant select, insert on mass_treatments to authenticated;

-- p_data: the create_treatment_with_visits() payload without animal_id, plus
-- animal_ids (uuid[] as a JSON array). Only gydymas / profilaktika; gydymas needs a
-- disease (DelPro diagnosis) and at least one medicine.
create or replace function create_mass_treatment(p_data jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ids uuid[];
  v_type text := coalesce(nullif(p_data->>'procedure_type', ''), 'gydymas');
  v_mass uuid;
  v_animal uuid;
  v_treatment uuid;
  v_inactive integer;
  v_one jsonb;
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės kurti gydymo įrašų.';
  end if;
  if jsonb_typeof(p_data->'animal_ids') is distinct from 'array' then
    raise exception 'Pasirinkite gyvūnus.';
  end if;
  select array_agg(distinct x::uuid) into v_ids from jsonb_array_elements_text(p_data->'animal_ids') x;
  if v_ids is null or cardinality(v_ids) = 0 then
    raise exception 'Pasirinkite bent vieną gyvūną.';
  end if;
  if cardinality(v_ids) > 2000 then
    raise exception 'Vienu kartu galima gydyti ne daugiau kaip 2000 gyvūnų (pasirinkta %).', cardinality(v_ids);
  end if;
  select cardinality(v_ids) - count(*) into v_inactive from animals where id = any (v_ids) and active;
  if v_inactive > 0 then
    raise exception 'Pasirinkta neaktyvių arba nerastų gyvūnų: %.', v_inactive;
  end if;
  if v_type not in ('gydymas', 'profilaktika') then
    raise exception 'Masinis gydymas gali būti tik „Gydymas“ arba „Profilaktika“.';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(coalesce(p_data->'medications', '[]'::jsonb)) m
    where nullif(m->>'product_id', '') is not null and coalesce(nullif(m->>'qty', '')::numeric, 0) > 0
  ) then
    raise exception 'Pridėkite bent vieną vaistą su doze.';
  end if;
  if v_type = 'gydymas' and nullif(p_data->>'disease_id', '') is null then
    raise exception 'Gydymui pasirinkite ligą — ji perduodama į DelPro kaip diagnozė.';
  end if;
  if jsonb_array_length(coalesce(p_data->'course_days', '[]'::jsonb)) > 0 then
    raise exception 'Masiniame gydyme kurso dienų planuoti negalima.';
  end if;
  perform fn_check_medicine_schedule(p_data || jsonb_build_object('procedure_type', v_type));

  insert into mass_treatments (reg_date, procedure_type, disease_id, diagnosis, vet_name, notes, medications, animal_count)
  values (
    coalesce(nullif(p_data->>'reg_date', '')::date, (now() at time zone 'Europe/Vilnius')::date),
    v_type,
    nullif(p_data->>'disease_id', '')::uuid,
    nullif(p_data->>'diagnosis', ''),
    nullif(p_data->>'vet_name', ''),
    nullif(p_data->>'notes', ''),
    coalesce(p_data->'medications', '[]'::jsonb),
    cardinality(v_ids)
  )
  returning id into v_mass;

  v_one := (p_data - 'animal_ids' - 'course_days') || jsonb_build_object('procedure_type', v_type);
  -- stable order: FEFO hands out the oldest lot to the lowest DelPro number first
  for v_animal in
    select a.id from animals a where a.id = any (v_ids) order by a.animal_no nulls last, a.tag_no, a.id
  loop
    v_treatment := create_treatment_with_visits(v_one || jsonb_build_object('animal_id', v_animal), null);
    update treatments set mass_treatment_id = v_mass where id = v_treatment;
  end loop;

  return jsonb_build_object('id', v_mass, 'count', cardinality(v_ids));
end;
$$;

revoke all on function create_mass_treatment(jsonb) from public, anon;
grant execute on function create_mass_treatment(jsonb) to authenticated;

-- History: one row per mass treatment with its DelPro job status counts.
create or replace view vw_mass_treatments
with (security_invoker = true) as
select
  m.id, m.reg_date, m.procedure_type, m.disease_id, d.name as disease_name, m.diagnosis, m.vet_name, m.notes,
  m.medications, m.animal_count, m.created_at,
  (select count(*) from treatments t where t.mass_treatment_id = m.id)::integer as treatment_count,
  coalesce((
    select jsonb_object_agg(s.status, s.n)
    from (
      select j.status::text as status, count(*) as n
      from treatments t join delpro_sync_jobs j on j.treatment_id = t.id
      where t.mass_treatment_id = m.id
      group by j.status
    ) s
  ), '{}'::jsonb) as delpro_status_counts
from mass_treatments m
left join diseases d on d.id = m.disease_id;

grant select on vw_mass_treatments to authenticated;

-- "Siųsti į DelPro" for a whole mass treatment = delpro_approve_jobs() over its
-- waiting jobs (same per-job validation, admin gate and audit as the queue).
create or replace function delpro_approve_mass_treatment(p_mass_treatment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_approved integer;
begin
  if not fn_can_approve_delpro() then
    raise exception 'Neturite teisės tvirtinti gydymo perdavimo į DelPro.';
  end if;
  select coalesce(array_agg(j.id), '{}') into v_ids
  from treatments t join delpro_sync_jobs j on j.treatment_id = t.id
  where t.mass_treatment_id = p_mass_treatment_id and j.status = 'pending_approval';
  if cardinality(v_ids) = 0 then
    return jsonb_build_object('waiting', 0, 'approved', 0);
  end if;
  v_approved := delpro_approve_jobs(v_ids);
  return jsonb_build_object('waiting', cardinality(v_ids), 'approved', v_approved);
end;
$$;

revoke all on function delpro_approve_mass_treatment(uuid) from public, anon;
grant execute on function delpro_approve_mass_treatment(uuid) to authenticated;

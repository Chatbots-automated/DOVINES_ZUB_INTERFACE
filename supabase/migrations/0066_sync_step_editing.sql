-- 0066_sync_step_editing.sql
-- Sinchronizacijos → Žingsniai: change planned steps after the protocol was applied
-- (farm's request 2026-11-05, billed with the Sinchronizacijos tab 0059).
--   edit_sync_steps(jsonb)       — date / time (optionally moving the animal's later steps by the
--                                  same number of days), planned medicine, step title, notes
--   skip_sync_steps(uuid[])      — this step is not done for these animals (visit 'atsauktas'),
--                                  the rest of their protocol stays
--   add_sync_animals(jsonb)      — the same protocol for more animals, joined to the same mass
--                                  application, with its start date (or another one)
-- Only open protocol-step visits are touched; recorded steps (and their stock / karencija) never.
-- Nothing here consumes stock. A visit copies its step (0025), so the protocol template is unchanged.

create or replace function fn_sync_open_step_ids(p_ids jsonb)
returns uuid[]
language plpgsql
stable
security invoker
as $$
declare
  v_ids uuid[];
  v_ok integer;
begin
  if jsonb_typeof(p_ids) is distinct from 'array' then
    raise exception 'Pasirinkite bent vieną gyvūną.';
  end if;
  select array_agg(distinct (x #>> '{}')::uuid) into v_ids
  from jsonb_array_elements(p_ids) x where nullif(x #>> '{}', '') is not null;
  if v_ids is null then
    raise exception 'Pasirinkite bent vieną gyvūną.';
  end if;
  select count(*) into v_ok from animal_visits
  where id = any (v_ids) and sync_application_id is not null and status in ('planuojamas', 'vykdomas');
  if v_ok <> array_length(v_ids, 1) then
    raise exception 'Kai kurie žingsniai jau įrašyti arba atšaukti — atnaujinkite puslapį.';
  end if;
  return v_ids;
end;
$$;

-- { visit_ids:[uuid], date?:'YYYY-MM-DD', time?:'HH:MM', shift_following?:bool,
--   medications?:[{product_id,qty,unit,administration_route}] (present = replace), title?, notes? }
-- Returns { steps, moved_following }.
create or replace function edit_sync_steps(p_data jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_ids uuid[] := fn_sync_open_step_ids(p_data->'visit_ids');
  v_date date := nullif(p_data->>'date', '')::date;
  v_time text := nullif(btrim(p_data->>'time'), '');
  v_shift boolean := coalesce((p_data->>'shift_following')::boolean, false);
  v_title text := nullif(btrim(p_data->>'title'), '');
  v_meds jsonb;
  v_moved integer := 0;
  v_n integer;
  r record;
  v_new timestamptz;
  v_delta integer;
begin
  if v_time is not null and v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Netinkamas laikas „%“.', v_time;
  end if;
  if p_data ? 'medications' then
    v_meds := fn_sync_clean_medications(p_data->'medications');
  end if;

  if v_date is not null or v_time is not null then
    for r in
      select v.id, v.sync_application_id, v.sync_step_no,
             (v.visit_datetime at time zone 'Europe/Vilnius') as local_at
      from animal_visits v where v.id = any (v_ids)
      for update
    loop
      v_new := ((coalesce(v_date, r.local_at::date))::text || ' ' || coalesce(v_time, to_char(r.local_at, 'HH24:MI')) || ' Europe/Vilnius')::timestamptz;
      v_delta := coalesce(v_date, r.local_at::date) - r.local_at::date;
      update animal_visits set visit_datetime = v_new where id = r.id;
      if v_shift and v_delta <> 0 then
        update animal_visits
           set visit_datetime = visit_datetime + make_interval(days => v_delta)
         where sync_application_id = r.sync_application_id
           and sync_step_no > r.sync_step_no
           and status in ('planuojamas', 'vykdomas')
           and id <> all (v_ids);
        get diagnostics v_n = row_count;
        v_moved := v_moved + v_n;
      end if;
    end loop;
  end if;

  update animal_visits
     set planned_medications = case when v_meds is not null then v_meds else planned_medications end,
         sync_step_title = coalesce(v_title, sync_step_title),
         notes = case when p_data ? 'notes' then nullif(btrim(p_data->>'notes'), '') else notes end
   where id = any (v_ids);

  return jsonb_build_object('steps', array_length(v_ids, 1), 'moved_following', v_moved);
end;
$$;

grant execute on function edit_sync_steps(jsonb) to authenticated;

-- This step is skipped for these animals; their other steps stay planned.
create or replace function skip_sync_steps(p_visit_ids uuid[])
returns integer
language plpgsql
security invoker
as $$
declare
  v_ids uuid[] := fn_sync_open_step_ids(to_jsonb(p_visit_ids));
begin
  update animal_visits set status = 'atsauktas' where id = any (v_ids);
  return array_length(v_ids, 1);
end;
$$;

grant execute on function skip_sync_steps(uuid[]) to authenticated;

-- { mass_application_id, animal_ids:[uuid], start_date? } — same protocol, same time / vet as the
-- mass application, start date = the mass one unless given (earlier steps then show as overdue).
-- One transaction; an animal already running a protocol refuses all (apply_sync_protocol's rule).
create or replace function add_sync_animals(p_data jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  m sync_mass_applications%rowtype;
  v_ids uuid[];
  v_start date;
  v_visits integer := 0;
  v_busy text;
  a uuid;
begin
  select * into m from sync_mass_applications where id = nullif(p_data->>'mass_application_id', '')::uuid;
  if not found then
    raise exception 'Masinis pritaikymas nerastas.';
  end if;
  if m.protocol_id is null or not exists (select 1 from sync_protocols where id = m.protocol_id) then
    raise exception 'Protokolas „%“ ištrintas — pritaikykite naują sinchronizaciją.', m.protocol_name;
  end if;
  if jsonb_typeof(p_data->'animal_ids') is distinct from 'array' then
    raise exception 'Pasirinkite bent vieną gyvūną.';
  end if;
  select array_agg(distinct (x #>> '{}')::uuid) into v_ids
  from jsonb_array_elements(p_data->'animal_ids') x where nullif(x #>> '{}', '') is not null;
  if v_ids is null then
    raise exception 'Pasirinkite bent vieną gyvūną.';
  end if;
  if (select count(*) from animals where id = any (v_ids) and active) <> array_length(v_ids, 1) then
    raise exception 'Kai kurie pasirinkti gyvūnai nerasti arba neaktyvūs — atnaujinkite puslapį.';
  end if;
  select string_agg(coalesce(an.animal_no, an.tag_no) || ' („' || x.protocol_name || '“)', ', ')
  into v_busy
  from (
    select distinct on (v.animal_id) v.animal_id, ap.protocol_name
    from animal_visits v join sync_protocol_applications ap on ap.id = v.sync_application_id
    where v.animal_id = any (v_ids) and v.status in ('planuojamas', 'vykdomas')
  ) x join animals an on an.id = x.animal_id;
  if v_busy is not null then
    raise exception 'Šiems gyvūnams jau taikomas protokolas: % — nuimkite juos arba pirmiausia nutraukite protokolą.', v_busy;
  end if;

  v_start := coalesce(nullif(p_data->>'start_date', '')::date, m.start_date);
  foreach a in array v_ids loop
    v_visits := v_visits + apply_sync_protocol(m.protocol_id, a, v_start, m.start_time, m.vet_name);
  end loop;

  update sync_protocol_applications
     set mass_application_id = m.id
   where animal_id = any (v_ids) and protocol_id = m.protocol_id and created_at = now() and mass_application_id is null;
  update sync_mass_applications set animal_count = animal_count + array_length(v_ids, 1) where id = m.id;

  return jsonb_build_object('animals', array_length(v_ids, 1), 'visits', v_visits);
end;
$$;

grant execute on function add_sync_animals(jsonb) to authenticated;

notify pgrst, 'reload schema';

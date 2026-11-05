-- 0064_course_dose_times.sql
-- Kurso planavimas per day and per time (farm's request 2026-11-05; course planning is
-- Priedas §2.4, the visits it creates are Vizitai 0035 — billed with Vizitai).
--   * course_doses.scheduled_time (Europe/Vilnius wall clock): a course day can hold several
--     doses of one medicine (times per day / every N hours). NULL = the old behaviour (09:00).
--   * Each distinct (course, date, time) is ONE planned visit at that time — medicines given at
--     the same time share it, a second time of the day gets its own visit.
--   * Day 1 may now have extra doses later on the treatment day (e.g. 2× per day: the first is
--     the treatment itself, the second a planned dose at 20:00): day_number 1 is accepted only
--     with scheduled_date = reg_date AND a scheduled_time. Stock is still taken only when a
--     planned dose is given (administer_course_dose).
--   * create_treatment = 0021 body + scheduled_time + the day-1 rule.

alter table course_doses add column scheduled_time time;

create or replace function fn_course_dose_visit_at(p_date date, p_time time)
returns timestamptz
language sql
stable
as $$
  select ((p_date::text || ' ' || to_char(coalesce(p_time, time '09:00'), 'HH24:MI')) || ' Europe/Vilnius')::timestamptz;
$$;

create or replace function fn_course_dose_plan_visit()
returns trigger
language plpgsql
security invoker
as $$
declare
  c record;
  v_visit uuid;
begin
  if new.visit_id is not null then
    return new;
  end if;

  select tc.days, t.animal_id, t.procedure_type, t.vet_name, t.reg_date
    into c
  from treatment_courses tc
  join treatments t on t.id = tc.treatment_id
  where tc.id = new.course_id;
  if not found then
    return new;
  end if;

  -- 0064: share only with doses of the same day AND time
  select cd.visit_id into v_visit
  from course_doses cd
  where cd.course_id = new.course_id and cd.scheduled_date = new.scheduled_date
    and cd.scheduled_time is not distinct from new.scheduled_time and cd.visit_id is not null
  limit 1;

  if v_visit is null then
    insert into animal_visits (animal_id, visit_datetime, procedures, status, notes, vet_name, created_by)
    values (c.animal_id,
            fn_course_dose_visit_at(new.scheduled_date, new.scheduled_time),
            array[c.procedure_type],
            'planuojamas',
            format('Gydymo kurso diena %s iš %s', new.day_number, c.days)
              || case when new.scheduled_time is not null then ' · ' || to_char(new.scheduled_time, 'HH24:MI') else '' end,
            c.vet_name,
            auth.uid())
    returning id into v_visit;
  end if;

  new.visit_id := v_visit;
  return new;
end;
$$;

-- A dose moved to another day / time moves its visit along (when the visit holds only that dose).
create or replace function fn_course_dose_move_visit()
returns trigger
language plpgsql
security invoker
as $$
begin
  if new.visit_id is not null
     and (new.scheduled_date is distinct from old.scheduled_date or new.scheduled_time is distinct from old.scheduled_time)
     and (select count(*) from course_doses where visit_id = new.visit_id) = 1 then
    update animal_visits
    set visit_datetime = fn_course_dose_visit_at(new.scheduled_date, new.scheduled_time)
    where id = new.visit_id and status in ('planuojamas', 'vykdomas');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_course_doses_move_visit on course_doses;
create trigger trg_course_doses_move_visit
  after update of scheduled_date, scheduled_time on course_doses
  for each row execute function fn_course_dose_move_visit();

create or replace function create_treatment(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_treatment_id uuid;
  v_course_id uuid;
  v_meds jsonb := coalesce(p_data->'medications', '[]'::jsonb);
  v_days jsonb := coalesce(p_data->'course_days', '[]'::jsonb);
  v_reg_date date := coalesce(nullif(p_data->>'reg_date', '')::date, current_date);
  v_route administration_route;
  v_course_route administration_route;
  v_day integer;
  v_max_day integer := 1;
  v_auto_day integer := 1;
  m jsonb;
  d jsonb;
begin
  if nullif(p_data->>'animal_id', '') is null then
    raise exception 'Pasirinkite gyvūną.';
  end if;

  -- Treatment-level route is an informational summary: the shared route
  -- if every medication line agrees, else null.
  select case when count(distinct m2->>'administration_route') = 1
              then max(m2->>'administration_route')::administration_route end
  into v_route
  from jsonb_array_elements(v_meds) m2
  where nullif(m2->>'administration_route', '') is not null;

  insert into treatments (animal_id, disease_id, procedure_type, reg_date, diagnosis, administration_route,
                          outcome, outcome_date, vet_name, notes, created_by)
  values (
    (p_data->>'animal_id')::uuid,
    nullif(p_data->>'disease_id', '')::uuid,
    coalesce(nullif(p_data->>'procedure_type', ''), 'gydymas'),
    v_reg_date,
    nullif(p_data->>'diagnosis', ''),
    v_route,
    nullif(p_data->>'outcome', ''),
    nullif(p_data->>'outcome_date', '')::date,
    nullif(p_data->>'vet_name', ''),
    nullif(p_data->>'notes', ''),
    auth.uid()
  )
  returning id into v_treatment_id;

  for m in select * from jsonb_array_elements(v_meds) loop
    continue when nullif(m->>'product_id', '') is null or coalesce((m->>'qty')::numeric, 0) <= 0;
    perform fn_consume_fefo(
      (m->>'product_id')::uuid,
      (m->>'qty')::numeric,
      nullif(m->>'unit', '')::unit,
      nullif(m->>'administration_route', '')::administration_route,
      p_treatment_id => v_treatment_id
    );
  end loop;

  if jsonb_array_length(v_days) > 0 then
    -- Pass 1: resolve day numbers (explicit, else the next consecutive one).
    for d in select * from jsonb_array_elements(v_days) loop
      if nullif(d->>'day_number', '') is not null then
        v_day := (d->>'day_number')::integer;
        -- 0064: day 1 = an extra dose later on the treatment day (needs its time)
        if v_day < 1 or (v_day = 1 and (nullif(d->>'scheduled_time', '') is null
                                        or (d->>'scheduled_date')::date is distinct from v_reg_date)) then
          raise exception 'Kurso dienos numeris turi būti ne mažesnis už 2 (1 — tik papildomai dozei gydymo dieną su laiku).';
        end if;
      else
        v_auto_day := v_auto_day + 1;
        v_day := v_auto_day;
      end if;
      v_max_day := greatest(v_max_day, v_day);
    end loop;

    select case when count(distinct d2->>'administration_route') = 1
                then max(d2->>'administration_route')::administration_route end
    into v_course_route
    from jsonb_array_elements(v_days) d2
    where nullif(d2->>'administration_route', '') is not null;

    insert into treatment_courses (treatment_id, days, administration_route, start_date, status)
    values (v_treatment_id, v_max_day, v_course_route, v_reg_date, 'active')
    returning id into v_course_id;

    -- Pass 2: insert the planned doses.
    v_auto_day := 1;
    for d in select * from jsonb_array_elements(v_days) loop
      if nullif(d->>'day_number', '') is not null then
        v_day := (d->>'day_number')::integer;
      else
        v_auto_day := v_auto_day + 1;
        v_day := v_auto_day;
      end if;
      if (d->>'scheduled_date')::date < v_reg_date then
        raise exception 'Kurso dozės data negali būti ankstesnė už gydymo datą.';
      end if;
      insert into course_doses (course_id, day_number, scheduled_date, scheduled_time, product_id, dose_amount, unit, administration_route)
      values (
        v_course_id,
        v_day,
        (d->>'scheduled_date')::date,
        nullif(d->>'scheduled_time', '')::time,
        nullif(d->>'product_id', '')::uuid,
        nullif(d->>'qty', '')::numeric,
        nullif(d->>'unit', '')::unit,
        nullif(d->>'administration_route', '')::administration_route
      );
    end loop;
  end if;

  return v_treatment_id;
end;
$$;

grant execute on function create_treatment(jsonb) to authenticated;

notify pgrst, 'reload schema';

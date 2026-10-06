-- 0021_treatment_course_scheduling.sql
-- Dovinės ŽŪB GVET PRO — course planning (Priedas §2.4): a planned course day
-- may now hold several products, and karencija counts from the course's real
-- last day instead of "reg_date + days".
--
-- 1. create_treatment(): every course_days entry may carry an explicit
--    `day_number` (>= 2). Entries without one keep the old behaviour (each
--    row is its own consecutive day). treatment_courses.days = highest day
--    number, so "kas antrą dieną" courses and multi-product days both work.
-- 2. calculate_withdrawal_dates(): course usage uses the LAST scheduled (or,
--    if later, administered) date per product+route:
--        last_date + withdrawal_days + 1
--    — the same formula single-day usage already used (reg_date + w + 1).
--    The previous "reg_date + days + w + 1" over-shot by one day for daily
--    courses and under-shot for courses with gaps between doses.
-- 3. Recalculate when a dose's date changes or it is administered later than
--    scheduled.

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
        if v_day < 2 then
          raise exception 'Kurso dienos numeris turi būti ne mažesnis už 2.';
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
      insert into course_doses (course_id, day_number, scheduled_date, product_id, dose_amount, unit, administration_route)
      values (
        v_course_id,
        v_day,
        (d->>'scheduled_date')::date,
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

create or replace function calculate_withdrawal_dates(p_treatment_id uuid)
returns void
language plpgsql
as $$
declare
  v_reg_date date;
  v_milk_until date;
  v_meat_until date;
  v_candidate_milk date;
  v_candidate_meat date;
  r record;
begin
  select reg_date into v_reg_date from treatments where id = p_treatment_id;
  if v_reg_date is null then
    return;
  end if;

  v_milk_until := null;
  v_meat_until := null;

  for r in
    select ui.product_id, ui.administration_route
    from usage_items ui
    where ui.treatment_id = p_treatment_id
  loop
    v_candidate_milk := v_reg_date + fn_route_withdrawal_days(r.product_id, r.administration_route, 'milk') + 1;
    v_candidate_meat := v_reg_date + fn_route_withdrawal_days(r.product_id, r.administration_route, 'meat') + 1;
    v_milk_until := greatest(coalesce(v_milk_until, v_candidate_milk), v_candidate_milk);
    v_meat_until := greatest(coalesce(v_meat_until, v_candidate_meat), v_candidate_meat);
  end loop;

  -- Course usage: karencija counts from the LAST dose of each product+route
  -- (the later of its scheduled and actual administration date).
  for r in
    select cd.product_id, cd.administration_route,
           max(greatest(cd.scheduled_date, coalesce(cd.administered_date, cd.scheduled_date))) as last_date
    from treatment_courses tc
    join course_doses cd on cd.course_id = tc.id
    where tc.treatment_id = p_treatment_id
      and tc.status <> 'cancelled'
      and cd.product_id is not null
    group by cd.product_id, cd.administration_route
  loop
    v_candidate_milk := greatest(v_reg_date, r.last_date) + fn_route_withdrawal_days(r.product_id, r.administration_route, 'milk') + 1;
    v_candidate_meat := greatest(v_reg_date, r.last_date) + fn_route_withdrawal_days(r.product_id, r.administration_route, 'meat') + 1;
    v_milk_until := greatest(coalesce(v_milk_until, v_candidate_milk), v_candidate_milk);
    v_meat_until := greatest(coalesce(v_meat_until, v_candidate_meat), v_candidate_meat);
  end loop;

  update treatments
  set withdrawal_until_milk = v_milk_until,
      withdrawal_until_meat = v_meat_until
  where id = p_treatment_id
    and (withdrawal_until_milk is distinct from v_milk_until or withdrawal_until_meat is distinct from v_meat_until);
end;
$$;

create trigger trg_course_doses_withdrawal_recalc_dates
  after update of scheduled_date, administered_date on course_doses
  for each row execute function fn_course_doses_trigger_withdrawal_recalc();

notify pgrst, 'reload schema';

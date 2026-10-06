-- 0004_functions_and_triggers.sql
-- Dovinės ŽŪB GVET PRO — core business logic:
--   1. Stock deduction + reversal on usage_items insert/delete
--   2. auto_generate_medical_waste() on batch depletion
--   3. Route-aware karencija: fn_route_withdrawal_days() +
--      calculate_withdrawal_dates() (MAX across every product on a treatment)
--   4. Vaccination withdrawal auto-fill
--   5. FEFO allocation in SQL (fn_consume_fefo) + atomic write RPCs
--      create_treatment() / create_vaccinations() / administer_course_dose()
--
-- Withdrawal formula (proven across monika/oksana/rvac/Kairaitienes):
--   single dose: reg_date + withdrawal_days + 1
--   course:      reg_date + course.days + withdrawal_days + 1
--
-- Why the write RPCs: the Žibartoniai sibling saved a treatment as several
-- separate PostgREST calls (treatment insert, then one usage_items insert
-- per FEFO batch, then course rows), so a stock shortfall halfway through
-- left a treatment with no medication attached. Here every treatment is
-- also sent to DelPro (0006) — a half-saved treatment must never exist.
-- One plpgsql function = one transaction = all-or-nothing.

-- ---------------------------------------------------------------------------
-- auto_generate_medical_waste — dedupe-guarded via batch_waste_tracking
-- ---------------------------------------------------------------------------

create or replace function auto_generate_medical_waste(p_batch_id uuid)
returns void
language plpgsql
as $$
declare
  v_batch batches%rowtype;
  v_product products%rowtype;
  v_waste_id uuid;
begin
  if exists (select 1 from batch_waste_tracking where batch_id = p_batch_id) then
    return;
  end if;

  select * into v_batch from batches where id = p_batch_id;
  if v_batch.id is null then
    return;
  end if;

  select * into v_product from products where id = v_batch.product_id;

  -- Only products with a recorded packaging weight produce trackable
  -- medical waste (empty vials/bottles).
  if v_product.package_weight_g is null then
    return;
  end if;

  insert into medical_waste (waste_code, name, waste_date, qty_generated, auto_generated, source_batch_id)
  values (
    v_product.registration_code,
    coalesce(v_product.name, 'Nežinomas produktas') || ' (partija ' || coalesce(v_batch.lot, left(v_batch.id::text, 8)) || ')',
    current_date,
    v_product.package_weight_g,
    true,
    v_batch.id
  )
  returning id into v_waste_id;

  insert into batch_waste_tracking (batch_id, medical_waste_id) values (p_batch_id, v_waste_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Stock deduction on usage_items insert — validates + deducts against
-- whichever batch_id was supplied (FEFO selection is fn_consume_fefo below).
-- ---------------------------------------------------------------------------

create or replace function fn_usage_items_deduct_stock()
returns trigger
language plpgsql
as $$
declare
  v_qty_left numeric;
  v_new_qty_left numeric;
begin
  select qty_left into v_qty_left from batches where id = new.batch_id for update;

  if v_qty_left is null then
    raise exception 'Partija % nerasta', new.batch_id;
  end if;

  if v_qty_left < new.qty then
    raise exception 'Nepakanka likučio partijoje %: turima %, prašoma %', new.batch_id, v_qty_left, new.qty;
  end if;

  v_new_qty_left := v_qty_left - new.qty;

  update batches
  set qty_left = v_new_qty_left,
      status = case when v_new_qty_left <= 0 then 'depleted' else status end
  where id = new.batch_id;

  if v_new_qty_left <= 0 then
    perform auto_generate_medical_waste(new.batch_id);
  end if;

  return new;
end;
$$;

create trigger trg_usage_items_deduct_stock
  after insert on usage_items
  for each row execute function fn_usage_items_deduct_stock();

create or replace function fn_usage_items_restore_stock()
returns trigger
language plpgsql
as $$
begin
  update batches
  set qty_left = qty_left + old.qty,
      status = case when status = 'depleted' then 'active' else status end
  where id = old.batch_id;

  return old;
end;
$$;

create trigger trg_usage_items_restore_stock
  after delete on usage_items
  for each row execute function fn_usage_items_restore_stock();

-- ---------------------------------------------------------------------------
-- fn_route_withdrawal_days — route-aware lookup with fallback to the
-- product's flat withdrawal_days_milk/meat default.
-- ---------------------------------------------------------------------------

create or replace function fn_route_withdrawal_days(p_product_id uuid, p_route administration_route, p_kind text)
returns integer
language sql
stable
as $$
  select case p_kind
    when 'milk' then coalesce(
      case p_route
        when 'iv' then withdrawal_iv_milk
        when 'im' then withdrawal_im_milk
        when 'sc' then withdrawal_sc_milk
        when 'iu' then withdrawal_iu_milk
        when 'imm' then withdrawal_imm_milk
        when 'pos' then withdrawal_pos_milk
        else null
      end,
      withdrawal_days_milk, 0)
    when 'meat' then coalesce(
      case p_route
        when 'iv' then withdrawal_iv_meat
        when 'im' then withdrawal_im_meat
        when 'sc' then withdrawal_sc_meat
        when 'iu' then withdrawal_iu_meat
        when 'imm' then withdrawal_imm_meat
        when 'pos' then withdrawal_pos_meat
        else null
      end,
      withdrawal_days_meat, 0)
  end
  from products where id = p_product_id;
$$;

-- ---------------------------------------------------------------------------
-- calculate_withdrawal_dates — recomputes treatments.withdrawal_until_* as
-- MAX() across every product used directly on the treatment and every
-- product planned across its treatment_courses. A treatment with no
-- medication at all gets NULL (no karencija), not reg_date + 1.
-- ---------------------------------------------------------------------------

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

  -- Course-based usage: karencija counts from the course's last day.
  for r in
    select distinct tc.days, cd.product_id, cd.administration_route
    from treatment_courses tc
    join course_doses cd on cd.course_id = tc.id
    where tc.treatment_id = p_treatment_id
      and tc.status <> 'cancelled'
      and cd.product_id is not null
  loop
    v_candidate_milk := v_reg_date + r.days + fn_route_withdrawal_days(r.product_id, r.administration_route, 'milk') + 1;
    v_candidate_meat := v_reg_date + r.days + fn_route_withdrawal_days(r.product_id, r.administration_route, 'meat') + 1;
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

create or replace function fn_usage_items_trigger_withdrawal_recalc()
returns trigger
language plpgsql
as $$
declare
  v_treatment_id uuid;
  v_row usage_items;
begin
  v_row := coalesce(new, old);

  if v_row.treatment_id is not null then
    v_treatment_id := v_row.treatment_id;
  elsif v_row.course_dose_id is not null then
    select tc.treatment_id into v_treatment_id
    from course_doses cd
    join treatment_courses tc on tc.id = cd.course_id
    where cd.id = v_row.course_dose_id;
  end if;

  if v_treatment_id is not null then
    perform calculate_withdrawal_dates(v_treatment_id);
  end if;

  return v_row;
end;
$$;

create trigger trg_usage_items_withdrawal_recalc
  after insert or update or delete on usage_items
  for each row execute function fn_usage_items_trigger_withdrawal_recalc();

create or replace function fn_treatment_courses_trigger_withdrawal_recalc()
returns trigger
language plpgsql
as $$
declare
  v_row treatment_courses;
begin
  v_row := coalesce(new, old);
  perform calculate_withdrawal_dates(v_row.treatment_id);
  return v_row;
end;
$$;

create trigger trg_treatment_courses_withdrawal_recalc
  after insert or update or delete on treatment_courses
  for each row execute function fn_treatment_courses_trigger_withdrawal_recalc();

create or replace function fn_course_doses_trigger_withdrawal_recalc()
returns trigger
language plpgsql
as $$
declare
  v_treatment_id uuid;
begin
  select treatment_id into v_treatment_id from treatment_courses where id = coalesce(new.course_id, old.course_id);
  if v_treatment_id is not null then
    perform calculate_withdrawal_dates(v_treatment_id);
  end if;
  return coalesce(new, old);
end;
$$;

create trigger trg_course_doses_withdrawal_recalc
  after insert or delete or update of product_id, administration_route on course_doses
  for each row execute function fn_course_doses_trigger_withdrawal_recalc();

-- ---------------------------------------------------------------------------
-- Vaccination withdrawal auto-fill (single dose, route-aware).
-- ---------------------------------------------------------------------------

create or replace function fn_vaccinations_set_withdrawal()
returns trigger
language plpgsql
as $$
begin
  new.withdrawal_until_milk := new.vaccination_date + fn_route_withdrawal_days(new.product_id, new.administration_route, 'milk') + 1;
  new.withdrawal_until_meat := new.vaccination_date + fn_route_withdrawal_days(new.product_id, new.administration_route, 'meat') + 1;
  return new;
end;
$$;

create trigger trg_vaccinations_set_withdrawal
  before insert or update of vaccination_date, product_id, administration_route on vaccinations
  for each row execute function fn_vaccinations_set_withdrawal();

-- ---------------------------------------------------------------------------
-- fn_consume_fefo — FEFO allocation (soonest-expiring active batch first,
-- spilling into the next one) that inserts the usage_items rows itself.
-- Locks candidate batches so two concurrent saves can't both take the last
-- ml. Raises (rolling back the caller's whole transaction) on shortfall.
-- Exactly one of the four source ids must be non-null.
-- ---------------------------------------------------------------------------

create or replace function fn_consume_fefo(
  p_product_id uuid,
  p_qty numeric,
  p_unit unit,
  p_route administration_route,
  p_treatment_id uuid default null,
  p_course_dose_id uuid default null,
  p_vaccination_id uuid default null,
  p_biocide_usage_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_remaining numeric := p_qty;
  v_take numeric;
  v_first_batch uuid;
  b record;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'Kiekis turi būti didesnis už 0.';
  end if;

  for b in
    select id, qty_left
    from batches
    where product_id = p_product_id
      and status = 'active'
      and qty_left > 0
      and (expiry_date is null or expiry_date >= current_date)
    order by expiry_date asc nulls last, received_at asc
    for update
  loop
    exit when v_remaining <= 0;
    v_take := least(b.qty_left, v_remaining);
    insert into usage_items (product_id, batch_id, qty, unit, administration_route,
                             treatment_id, course_dose_id, vaccination_id, biocide_usage_id)
    values (p_product_id, b.id, v_take, p_unit, p_route,
            p_treatment_id, p_course_dose_id, p_vaccination_id, p_biocide_usage_id);
    v_first_batch := coalesce(v_first_batch, b.id);
    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0.0001 then
    raise exception 'Nepakanka atsargų produktui „%“: trūksta % %.',
      (select name from products where id = p_product_id), round(v_remaining, 3), coalesce(p_unit::text, '');
  end if;

  return v_first_batch;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_treatment(jsonb) — "Naujas gydymo įrašas" (Priedas §2.3/§2.4).
--   { animal_id, disease_id, procedure_type, reg_date, diagnosis, outcome,
--     outcome_date, vet_name, notes,
--     medications: [{ product_id, qty, unit, administration_route }],
--     course_days: [{ scheduled_date, product_id, qty, unit, administration_route }] }
-- medications = day 1 (deducted now); course_days = days 2..N (deducted
-- when administered via administer_course_dose()).
-- ---------------------------------------------------------------------------

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
  m jsonb;
  d jsonb;
  i integer := 1;
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
    select case when count(distinct d2->>'administration_route') = 1
                then max(d2->>'administration_route')::administration_route end
    into v_course_route
    from jsonb_array_elements(v_days) d2
    where nullif(d2->>'administration_route', '') is not null;

    insert into treatment_courses (treatment_id, days, administration_route, start_date, status)
    values (v_treatment_id, 1 + jsonb_array_length(v_days), v_course_route, v_reg_date, 'active')
    returning id into v_course_id;

    for d in select * from jsonb_array_elements(v_days) loop
      i := i + 1;
      insert into course_doses (course_id, day_number, scheduled_date, product_id, dose_amount, unit, administration_route)
      values (
        v_course_id,
        i,
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

-- ---------------------------------------------------------------------------
-- administer_course_dose(uuid) — marks one planned course day as given and
-- deducts its stock (FEFO) in the same transaction. Idempotent: an
-- already-administered dose is left alone. Completes the course once every
-- dose is administered.
-- ---------------------------------------------------------------------------

create or replace function administer_course_dose(p_dose_id uuid, p_date date default current_date)
returns void
language plpgsql
security invoker
as $$
declare
  v_dose course_doses%rowtype;
  v_batch uuid;
begin
  select * into v_dose from course_doses where id = p_dose_id for update;
  if not found then
    raise exception 'Kurso dozė nerasta.';
  end if;
  if v_dose.administered then
    return;
  end if;

  if v_dose.product_id is not null and coalesce(v_dose.dose_amount, 0) > 0 then
    v_batch := fn_consume_fefo(v_dose.product_id, v_dose.dose_amount, v_dose.unit, v_dose.administration_route,
                               p_course_dose_id => v_dose.id);
  end if;

  update course_doses
  set administered = true,
      administered_date = coalesce(p_date, current_date),
      administered_by = auth.uid(),
      batch_id = coalesce(v_batch, batch_id)
  where id = p_dose_id;

  update treatment_courses tc
  set status = 'completed'
  where tc.id = v_dose.course_id
    and tc.status = 'active'
    and not exists (select 1 from course_doses cd where cd.course_id = tc.id and not cd.administered);
end;
$$;

grant execute on function administer_course_dose(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- create_vaccinations(jsonb) — Priedas §2.6, single animal or a whole group.
--   { animal_ids: [uuid], target_group_name, product_id, vaccination_date,
--     dose_amount, unit, administration_route, is_revaccination,
--     next_booster_date, vet_name, notes }
-- dose_amount is PER ANIMAL. Returns the number of animals vaccinated.
-- ---------------------------------------------------------------------------

create or replace function create_vaccinations(p_data jsonb)
returns integer
language plpgsql
security invoker
as $$
declare
  v_ids jsonb := coalesce(p_data->'animal_ids', '[]'::jsonb);
  v_session uuid := case when jsonb_array_length(coalesce(p_data->'animal_ids', '[]'::jsonb)) > 1
                           or nullif(p_data->>'target_group_name', '') is not null
                         then gen_random_uuid() end;
  v_product uuid := nullif(p_data->>'product_id', '')::uuid;
  v_dose numeric := nullif(p_data->>'dose_amount', '')::numeric;
  v_unit unit := nullif(p_data->>'unit', '')::unit;
  v_route administration_route := nullif(p_data->>'administration_route', '')::administration_route;
  v_vacc_id uuid;
  v_batch uuid;
  v_count integer := 0;
  a jsonb;
begin
  if v_product is null then
    raise exception 'Pasirinkite vakciną.';
  end if;
  if jsonb_array_length(v_ids) = 0 then
    raise exception 'Pasirinkite bent vieną gyvūną arba grupę.';
  end if;

  for a in select * from jsonb_array_elements(v_ids) loop
    insert into vaccinations (session_id, target_group_name, animal_id, product_id, vaccination_date, dose_amount, unit,
                              administration_route, is_revaccination, next_booster_date, administered_by, vet_name, notes)
    values (
      v_session,
      nullif(p_data->>'target_group_name', ''),
      (a #>> '{}')::uuid,
      v_product,
      coalesce(nullif(p_data->>'vaccination_date', '')::date, current_date),
      v_dose,
      v_unit,
      v_route,
      coalesce((p_data->>'is_revaccination')::boolean, false),
      nullif(p_data->>'next_booster_date', '')::date,
      auth.uid(),
      nullif(p_data->>'vet_name', ''),
      nullif(p_data->>'notes', '')
    )
    returning id into v_vacc_id;

    if coalesce(v_dose, 0) > 0 then
      v_batch := fn_consume_fefo(v_product, v_dose, v_unit, v_route, p_vaccination_id => v_vacc_id);
      update vaccinations set batch_id = v_batch where id = v_vacc_id;
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

grant execute on function create_vaccinations(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- create_biocide_usage(jsonb) — biocide log entry + FEFO deduction.
--   { product_id, use_date, purpose, work_scope, qty, unit, used_by_name }
-- ---------------------------------------------------------------------------

create or replace function create_biocide_usage(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid;
  v_batch uuid;
  v_qty numeric := nullif(p_data->>'qty', '')::numeric;
  v_unit unit := nullif(p_data->>'unit', '')::unit;
begin
  if nullif(p_data->>'product_id', '') is null then
    raise exception 'Pasirinkite biocidinį produktą.';
  end if;

  insert into biocide_usage (product_id, use_date, purpose, work_scope, qty, unit, used_by_name)
  values (
    (p_data->>'product_id')::uuid,
    coalesce(nullif(p_data->>'use_date', '')::date, current_date),
    nullif(p_data->>'purpose', ''),
    nullif(p_data->>'work_scope', ''),
    v_qty,
    v_unit,
    nullif(p_data->>'used_by_name', '')
  )
  returning id into v_id;

  if coalesce(v_qty, 0) > 0 then
    v_batch := fn_consume_fefo((p_data->>'product_id')::uuid, v_qty, v_unit, null, p_biocide_usage_id => v_id);
    update biocide_usage set batch_id = v_batch where id = v_id;
  end if;

  return v_id;
end;
$$;

grant execute on function create_biocide_usage(jsonb) to authenticated;

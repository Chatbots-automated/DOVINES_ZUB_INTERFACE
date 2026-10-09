-- 0028_withdrawal_zero_days.sql
-- Karencija fix: a product with 0 withdrawal days (e.g. Bioestrovet — milk 0)
-- must NOT put the animal under karencija. The contract formula is
-- date + withdrawal days + 1 (0004 / 0021), but it was applied even for 0 days,
-- which produced "iki date + 1" for the milk of a drug with no milk withdrawal.
-- fn_withdrawal_until() returns NULL for 0 (or NULL) days; the MAX across a
-- treatment's products then ignores that product. For N > 0 nothing changes.
-- Existing treatments / vaccinations are recomputed at the end.

create or replace function fn_withdrawal_until(p_from date, p_days integer)
returns date
language sql
immutable
as $$
  select case when coalesce(p_days, 0) > 0 then p_from + p_days + 1 end;
$$;

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
    v_candidate_milk := fn_withdrawal_until(v_reg_date, fn_route_withdrawal_days(r.product_id, r.administration_route, 'milk'));
    v_candidate_meat := fn_withdrawal_until(v_reg_date, fn_route_withdrawal_days(r.product_id, r.administration_route, 'meat'));
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
    v_candidate_milk := fn_withdrawal_until(greatest(v_reg_date, r.last_date), fn_route_withdrawal_days(r.product_id, r.administration_route, 'milk'));
    v_candidate_meat := fn_withdrawal_until(greatest(v_reg_date, r.last_date), fn_route_withdrawal_days(r.product_id, r.administration_route, 'meat'));
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

create or replace function fn_vaccinations_set_withdrawal()
returns trigger
language plpgsql
as $$
begin
  new.withdrawal_until_milk := fn_withdrawal_until(new.vaccination_date, fn_route_withdrawal_days(new.product_id, new.administration_route, 'milk'));
  new.withdrawal_until_meat := fn_withdrawal_until(new.vaccination_date, fn_route_withdrawal_days(new.product_id, new.administration_route, 'meat'));
  return new;
end;
$$;

-- Recompute what was saved with the old rule.
select calculate_withdrawal_dates(id) from treatments;
update vaccinations set product_id = product_id;

notify pgrst, 'reload schema';

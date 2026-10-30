-- 0035_course_day_visits.sql
-- Dovinės ŽŪB GVET PRO — everything shows up in Vizitai (farm's request, billed
-- separately like the rest of Vizitai, 0018).
--
--   * Every day of a treatment course (days 2..N) is a PLANNED visit
--     (course_doses.visit_id -> animal_visits). Giving the dose — from the
--     visit card or from Gydymo kursai, both call administer_course_dose() —
--     closes that day's visit. No stock is consumed by the visit itself.
--   * A treatment recorded on its own (not from a visit card) gets a finished
--     visit for day 1, so it appears in Vizitai like everything else.
--     create_treatment_with_visits() is the single entry the treatment dialog
--     uses; from a visit card it still goes through create_treatment_for_visit.
--   * Planned future course days that already exist are backfilled.
--
-- Not mirrored (yet): vaccinations, inseminations and hoof exams recorded on
-- their own; they only appear in Vizitai when done from a visit card.

alter table course_doses add column visit_id uuid references animal_visits (id) on delete set null;
create index course_doses_visit_id_idx on course_doses (visit_id) where visit_id is not null;

-- ---------------------------------------------------------------------------
-- A course dose gets (or shares, same course + same day) a planned visit.
-- BEFORE INSERT so every creator is covered (treatment dialog, hoof exams, ...).
-- ---------------------------------------------------------------------------

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

  select cd.visit_id into v_visit
  from course_doses cd
  where cd.course_id = new.course_id and cd.scheduled_date = new.scheduled_date and cd.visit_id is not null
  limit 1;

  if v_visit is null then
    insert into animal_visits (animal_id, visit_datetime, procedures, status, notes, vet_name, created_by)
    values (c.animal_id,
            (new.scheduled_date::text || ' 09:00 Europe/Vilnius')::timestamptz,
            array[c.procedure_type],
            'planuojamas',
            format('Gydymo kurso diena %s iš %s', new.day_number, c.days),
            c.vet_name,
            auth.uid())
    returning id into v_visit;
  end if;

  new.visit_id := v_visit;
  return new;
end;
$$;

create trigger trg_course_doses_plan_visit
  before insert on course_doses
  for each row execute function fn_course_dose_plan_visit();

-- A dose moved to another day moves its visit along (when the visit holds only that dose).
create or replace function fn_course_dose_move_visit()
returns trigger
language plpgsql
security invoker
as $$
begin
  if new.visit_id is not null and new.scheduled_date is distinct from old.scheduled_date
     and (select count(*) from course_doses where visit_id = new.visit_id) = 1 then
    update animal_visits
    set visit_datetime = (new.scheduled_date::text || ' 09:00 Europe/Vilnius')::timestamptz
    where id = new.visit_id and status in ('planuojamas', 'vykdomas');
  end if;
  return new;
end;
$$;

create trigger trg_course_doses_move_visit
  after update of scheduled_date on course_doses
  for each row execute function fn_course_dose_move_visit();

-- Deleting a course (its treatment was deleted) removes the planned visits that
-- only existed for it; a visit that already holds any record is kept.
create or replace function fn_course_dose_cleanup_visit()
returns trigger
language plpgsql
security invoker
as $$
begin
  if old.visit_id is not null
     and not exists (select 1 from course_doses where visit_id = old.visit_id and id <> old.id)
     and not exists (select 1 from treatments where visit_id = old.visit_id)
     and not exists (select 1 from vaccinations where visit_id = old.visit_id)
     and not exists (select 1 from insemination_records where visit_id = old.visit_id) then
    delete from animal_visits where id = old.visit_id and status = 'planuojamas';
  end if;
  return old;
end;
$$;

create trigger trg_course_doses_cleanup_visit
  after delete on course_doses
  for each row execute function fn_course_dose_cleanup_visit();

-- ---------------------------------------------------------------------------
-- administer_course_dose: same as 0004, plus closing the day's visit once all
-- of its doses are given (only if it is still open).
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

  if v_dose.visit_id is not null then
    update animal_visits v
    set status = 'baigtas'
    where v.id = v_dose.visit_id
      and v.status in ('planuojamas', 'vykdomas')
      and not exists (select 1 from course_doses cd where cd.visit_id = v.id and not cd.administered);
  end if;
end;
$$;

grant execute on function administer_course_dose(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- create_treatment_with_visits(data, visit?) — the treatment dialog's entry.
--   from a visit card (p_visit_id): create_treatment_for_visit (links + advances it)
--   on its own: create_treatment + a finished visit for the treatment itself
-- Either way the course days already have their planned visits (trigger above);
-- they are tied to the day-1 visit as follow-ups (related_visit_id).
-- ---------------------------------------------------------------------------

create or replace function create_treatment_with_visits(p_data jsonb, p_visit_id uuid default null)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid;
  v_visit uuid := p_visit_id;
  v_type text;
  v_when timestamptz;
begin
  if v_visit is not null then
    v_id := create_treatment_for_visit(v_visit, p_data);
  else
    v_id := create_treatment(p_data);
    select procedure_type,
           case when reg_date = (now() at time zone 'Europe/Vilnius')::date then now()
                else (reg_date::text || ' 09:00 Europe/Vilnius')::timestamptz end
      into v_type, v_when
    from treatments where id = v_id;

    insert into animal_visits (animal_id, visit_datetime, procedures, status, vet_name, created_by)
    select t.animal_id, v_when, array[v_type], 'baigtas', t.vet_name, auth.uid()
    from treatments t where t.id = v_id
    returning id into v_visit;

    update treatments set visit_id = v_visit where id = v_id;
  end if;

  update animal_visits
  set related_visit_id = v_visit
  where id in (
    select cd.visit_id
    from treatment_courses tc join course_doses cd on cd.course_id = tc.id
    where tc.treatment_id = v_id and cd.visit_id is not null
  ) and related_visit_id is null and id <> v_visit;

  return v_id;
end;
$$;

grant execute on function create_treatment_with_visits(jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: planned (not yet given) course days that have no visit yet.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  v_visit uuid;
begin
  for r in
    select cd.id, cd.course_id, cd.scheduled_date, cd.day_number, tc.days, t.animal_id, t.procedure_type, t.vet_name
    from course_doses cd
    join treatment_courses tc on tc.id = cd.course_id
    join treatments t on t.id = tc.treatment_id
    where cd.visit_id is null and not cd.administered and tc.status = 'active'
    order by cd.course_id, cd.scheduled_date, cd.day_number
  loop
    select cd2.visit_id into v_visit
    from course_doses cd2
    where cd2.course_id = r.course_id and cd2.scheduled_date = r.scheduled_date and cd2.visit_id is not null
    limit 1;

    if v_visit is null then
      insert into animal_visits (animal_id, visit_datetime, procedures, status, notes, vet_name)
      values (r.animal_id, (r.scheduled_date::text || ' 09:00 Europe/Vilnius')::timestamptz, array[r.procedure_type],
              'planuojamas', format('Gydymo kurso diena %s iš %s', r.day_number, r.days), r.vet_name)
      returning id into v_visit;
    end if;

    update course_doses set visit_id = v_visit where id = r.id;
  end loop;
end;
$$;

notify pgrst, 'reload schema';

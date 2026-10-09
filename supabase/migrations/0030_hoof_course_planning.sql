-- 0030_hoof_course_planning.sql
-- Nagos: kurso planavimas (farm's request, 2026-10). A hoof finding may now
-- plan a COURSE of its medicine (repeat doses on later dates), like a treatment.
--
-- Design: the course machinery hangs off `treatments` (treatment_courses ->
-- course_doses -> administer_course_dose -> FEFO, karencija from the last dose,
-- the Gydymo kursai board). So a finding that uses a DRUG (fn_is_drug_category,
-- 0027: medicines, vaccines, profilaktika, boliusai) or plans a course gets a
-- linked `treatments` row (procedure_type 'apziura' => never queued for DelPro,
-- which only takes 'gydymas'), created by create_treatment() itself, so day-1
-- stock (FEFO), course doses and karencija (0028: 0 days = none) behave exactly
-- as for any treatment. Course doses 2..N consume stock only when each dose is
-- administered (never at plan time).
-- Hoof-care materials (padukos, tvarsčiai...) stay on usage_items.hoof_finding_id
-- as before. Because drugs in a hoof finding are now treatment records, they
-- also reach the treated-animals journal and the animal's karencija (before this,
-- a medicine used in a nagų apžiūra set no karencija at all).
--
-- create_hoof_exam payload additions, per finding:
--   products[].administration_route   route of a drug line (karencija is route-aware)
--   course_days: [{ day_number?, scheduled_date, product_id, qty, unit, administration_route }]
--     (same shape as create_treatment's course_days; dates must be after exam_date)

alter table treatments
  add column hoof_finding_id uuid references hoof_findings (id) on delete cascade;
create index treatments_hoof_finding_id_idx on treatments (hoof_finding_id) where hoof_finding_id is not null;

-- Deleting an exam deletes its treatments (and so their doses / usage). Refuse
-- when any of that stock sits on a nurašymo aktas, as for the hoof usage itself.
create or replace function fn_hoof_exam_delete_guard()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from hoof_findings f
    join usage_items ui on (
      ui.hoof_finding_id = f.id
      or ui.treatment_id in (select t.id from treatments t where t.hoof_finding_id = f.id)
      or ui.course_dose_id in (
        select cd.id
        from course_doses cd
        join treatment_courses tc on tc.id = cd.course_id
        join treatments t on t.id = tc.treatment_id
        where t.hoof_finding_id = f.id
      )
    )
    join write_off_act_usage_items w on w.usage_item_id = ui.id
    where f.exam_id = old.id
  ) then
    raise exception 'Šios apžiūros produktai jau įtraukti į nurašymo aktą — pirmiau anuliuokite arba ištrinkite aktą.';
  end if;
  return old;
end;
$$;

create or replace function create_hoof_exam(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_exam_id uuid;
  v_finding_id uuid;
  v_animal uuid := nullif(p_data->>'animal_id', '')::uuid;
  v_exam_date date := coalesce(nullif(p_data->>'exam_date', '')::date, current_date);
  v_performed_by text := nullif(p_data->>'performed_by', '');
  v_f jsonb;
  v_p jsonb;
  v_leg text;
  v_zones jsonb;
  v_code text;
  v_followup boolean;
  v_followup_date date;
  v_product products%rowtype;
  v_qty numeric;
  v_unit unit;
  v_route text;
  v_z jsonb;
  v_course jsonb;
  v_meds jsonb;
  v_treatment_id uuid;
  v_desc text;
begin
  if v_animal is null or not exists (select 1 from animals where id = v_animal) then
    raise exception 'Pasirinkite gyvūną.';
  end if;
  if jsonb_typeof(p_data->'findings') is distinct from 'array' or jsonb_array_length(p_data->'findings') = 0 then
    raise exception 'Pridėkite bent vieną radinį.';
  end if;

  insert into hoof_exams (animal_id, exam_date, performed_by, notes, created_by)
  values (v_animal, v_exam_date, v_performed_by, nullif(p_data->>'notes', ''), auth.uid())
  returning id into v_exam_id;

  for v_f in select * from jsonb_array_elements(p_data->'findings')
  loop
    v_leg := nullif(v_f->>'leg', '');
    v_zones := coalesce(v_f->'zones', '[]'::jsonb);
    v_code := nullif(v_f->>'condition_code', '');
    v_followup := coalesce((v_f->>'followup_required')::boolean, false);
    v_followup_date := nullif(v_f->>'followup_date', '')::date;
    v_course := coalesce(v_f->'course_days', '[]'::jsonb);
    v_meds := '[]'::jsonb;

    if jsonb_typeof(v_zones) is distinct from 'array' then
      raise exception 'Neteisingas zonų sąrašas.';
    end if;
    if jsonb_typeof(v_course) is distinct from 'array' then
      raise exception 'Neteisingas kurso planas.';
    end if;
    for v_z in select * from jsonb_array_elements(v_zones)
    loop
      if (v_z->>'zone')::integer not between 0 and 10 or coalesce(v_z->>'claw', '') not in ('inner', 'outer') then
        raise exception 'Neteisinga nagos zona.';
      end if;
    end loop;

    if v_code is distinct from 'OK' and (v_leg is null or jsonb_array_length(v_zones) = 0) then
      raise exception 'Kiekvienam radiniui pasirinkite nagą ir bent vieną zoną (arba pažymėkite „Sveikas“).';
    end if;
    if v_followup and v_followup_date is null then
      raise exception 'Nurodykite pakartotinio patikrinimo datą.';
    end if;
    if exists (select 1 from jsonb_array_elements(v_course) d where nullif(d->>'scheduled_date', '')::date is null or (d->>'scheduled_date')::date <= v_exam_date) then
      raise exception 'Kurso dozių datos turi būti vėlesnės už apžiūros datą.';
    end if;

    insert into hoof_findings (exam_id, leg, zones, condition_code, diagnosis, severity, was_trimmed, was_treated,
                               bandage_applied, followup_required, followup_date, notes)
    values (v_exam_id, v_leg, v_zones, v_code, nullif(v_f->>'diagnosis', ''),
            coalesce(nullif(v_f->>'severity', '')::integer, 0),
            coalesce((v_f->>'was_trimmed')::boolean, false),
            coalesce((v_f->>'was_treated')::boolean, false),
            coalesce((v_f->>'bandage_applied')::boolean, false),
            v_followup, case when v_followup then v_followup_date end, nullif(v_f->>'notes', ''))
    returning id into v_finding_id;

    -- Products: drugs go to the finding's treatment (karencija, treated-animals
    -- journal, course); hoof-care materials stay on the finding itself.
    for v_p in select * from jsonb_array_elements(coalesce(v_f->'products', '[]'::jsonb))
    loop
      select * into v_product from products where id = nullif(v_p->>'product_id', '')::uuid;
      if not found then
        raise exception 'Pasirinkite produktą.';
      end if;
      v_qty := nullif(v_p->>'qty', '')::numeric;
      if v_qty is null or v_qty <= 0 then
        raise exception 'Nurodykite sunaudotą kiekį („%“).', v_product.name;
      end if;
      v_unit := coalesce(nullif(v_p->>'unit', '')::unit, v_product.unit);
      v_route := nullif(v_p->>'administration_route', '');

      if fn_is_drug_category(v_product.category) then
        v_meds := v_meds || jsonb_build_array(jsonb_build_object(
          'product_id', v_product.id, 'qty', v_qty, 'unit', v_unit, 'administration_route', v_route));
      else
        perform fn_consume_fefo_for_hoof(v_product.id, v_qty, v_unit, v_finding_id);
      end if;
    end loop;

    if jsonb_array_length(v_meds) > 0 or jsonb_array_length(v_course) > 0 then
      select coalesce(nullif(v_f->>'diagnosis', ''), c.description, 'radinys')
        into v_desc
        from (select 1) x left join hoof_condition_codes c on c.code = v_code;
      -- create_treatment: treatment row + day-1 FEFO + course (doses 2..N) in this transaction.
      v_treatment_id := create_treatment(jsonb_build_object(
        'animal_id', v_animal,
        'procedure_type', 'apziura',
        'reg_date', v_exam_date,
        'diagnosis', 'Nagos: ' || v_desc,
        'vet_name', v_performed_by,
        'notes', nullif(v_f->>'notes', ''),
        'medications', v_meds,
        'course_days', v_course));
      update treatments set hoof_finding_id = v_finding_id where id = v_treatment_id;
    end if;
  end loop;

  return v_exam_id;
end;
$$;

grant execute on function create_hoof_exam(jsonb) to authenticated;

notify pgrst, 'reload schema';

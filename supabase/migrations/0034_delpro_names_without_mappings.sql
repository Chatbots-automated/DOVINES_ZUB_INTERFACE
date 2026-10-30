-- 0034_delpro_names_without_mappings.sql
-- Follow-up to 0033 (farm's decision): DelPro uses the SAME names as GVET, so a
-- transfer no longer needs a disease/product mapping and no diagnosis code.
--
--   diagnosis_name = the disease name (diseases.name)
--   medicine_name  = the product name (products.name)
--   diagnosis_code = null, unless a mapping row with a code exists
--
-- delpro_mappings stays as an OPTIONAL override per disease/product (a non-empty
-- delpro_name / delpro_code wins). The problems check keeps what is still
-- required: a disease, exactly one medicine, a dose, an animal number, and
-- clean names (no control characters, bounded length).

create or replace function fn_build_delpro_payload(p_treatment_id uuid)
returns jsonb
language sql
stable
as $$
  with prods as (
    select ui.product_id, p.name, sum(ui.qty) as qty, ui.unit, ui.administration_route,
           pm.delpro_code, pm.delpro_name
    from usage_items ui
    join products p on p.id = ui.product_id
    left join delpro_mappings pm on pm.kind = 'product' and pm.local_id = ui.product_id
    where ui.treatment_id = p_treatment_id
    group by ui.product_id, p.name, ui.unit, ui.administration_route, pm.delpro_code, pm.delpro_name
  ),
  course as (
    select max(tc.days) as days
    from treatment_courses tc
    where tc.treatment_id = p_treatment_id and tc.status <> 'cancelled'
  )
  select jsonb_build_object(
    'payload_version', 2,
    'treatment_id', t.id,
    'animal', jsonb_build_object(
      'animal_id', a.id,
      'delpro_animal_id', a.delpro_animal_id,
      'animal_no', a.animal_no,
      'tag_no', a.tag_no
    ),
    'delpro', jsonb_build_object(
      'event_date', t.reg_date,
      'diagnosis', coalesce(dm.delpro_name, d.name, t.diagnosis),
      'diagnosis_code', dm.delpro_code,
      'diagnosis_text', t.diagnosis,
      'treatment_code', coalesce(
        (select pm.delpro_code
         from usage_items ui
         join delpro_mappings pm on pm.kind = 'product' and pm.local_id = ui.product_id
         where ui.treatment_id = t.id and pm.delpro_code is not null
         order by ui.created_at
         limit 1),
        (select setting_value from system_settings where setting_key = 'delpro_default_treatment_code')
      ),
      'products', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'product_id', x.product_id,
                 'name', x.name,
                 'qty', x.qty,
                 'unit', x.unit,
                 'administration_route', x.administration_route,
                 'delpro_code', x.delpro_code,
                 'delpro_name', x.delpro_name
               ) order by x.name)
        from prods x
      ), '[]'::jsonb),
      'course_days', (select days from course),
      'withdrawal_until_milk', t.withdrawal_until_milk,
      'withdrawal_until_meat', t.withdrawal_until_meat,
      'milk_withdrawal_days', greatest(coalesce(t.withdrawal_until_milk - t.reg_date, 0), 0),
      'meat_withdrawal_days', greatest(coalesce(t.withdrawal_until_meat - t.reg_date, 0), 0),
      'vet_name', t.vet_name,
      'ui_entry', jsonb_build_object(
        'treatment_id', t.id,
        'animal_number', a.animal_no,
        'diagnosis_name', coalesce(nullif(btrim(dm.delpro_name), ''), d.name),
        'diagnosis_code', nullif(btrim(dm.delpro_code), ''),
        'medicine_name', case when (select count(*) from prods) = 1 then (select coalesce(nullif(btrim(delpro_name), ''), name) from prods) end,
        'dose', case when (select count(*) from prods) = 1 then (select qty from prods) end,
        'dose_unit', case when (select count(*) from prods) = 1 then (select unit from prods) end,
        'course_days', coalesce((select days from course), 1)
      )
    )
  )
  from treatments t
  join animals a on a.id = t.animal_id
  left join diseases d on d.id = t.disease_id
  left join delpro_mappings dm on dm.kind = 'disease' and dm.local_id = t.disease_id
  where t.id = p_treatment_id;
$$;


-- ---------------------------------------------------------------------------
-- What blocks a transfer — mappings are no longer required.
-- ---------------------------------------------------------------------------

create or replace function fn_delpro_transfer_problems(p_treatment_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  t treatments%rowtype;
  v_animal_no text;
  v_mode text;
  v_dm delpro_mappings%rowtype;
  v_pm delpro_mappings%rowtype;
  v_disease_name text;
  v_dname text;
  v_mname text;
  v_probs jsonb := '[]'::jsonb;
  v_nprod integer;
  v_prod record;
  v_course_days integer;
  v_variants integer;
begin
  select * into t from treatments where id = p_treatment_id;
  if not found then
    return jsonb_build_array(fn_delpro_problem('treatment_missing', 'Gydymo įrašas nerastas.'));
  end if;

  if t.procedure_type <> 'gydymas' then
    return jsonb_build_array(fn_delpro_problem('not_gydymas', 'Į DelPro perduodami tik gydymai (ne profilaktika, apžiūra ar sinchronizacija).'));
  end if;

  select setting_value into v_mode from system_settings where setting_key = 'delpro_outbound_mode';
  if coalesce(v_mode, 'approval') = 'off' then
    v_probs := v_probs || fn_delpro_problem('integration_off', 'Perdavimas į DelPro išjungtas (DelPro integracija → Nustatymai).');
  end if;

  select animal_no into v_animal_no from animals where id = t.animal_id;
  if v_animal_no is null or btrim(v_animal_no) = '' then
    v_probs := v_probs || fn_delpro_problem('animal_number', 'Gyvulys neturi DelPro numerio — DelPro automatizacija ieško gyvulio pagal numerį.');
  end if;

  -- Diagnosis: the DelPro name is the GVET disease name (an optional mapping may override it).
  if t.disease_id is null then
    v_probs := v_probs || fn_delpro_problem('diagnosis_missing', 'Gydymui nepasirinkta diagnozė (liga) — DelPro diagnozė imama iš ligos pavadinimo.');
  else
    select name into v_disease_name from diseases where id = t.disease_id;
    select * into v_dm from delpro_mappings where kind = 'disease' and local_id = t.disease_id;
    v_dname := coalesce(nullif(btrim(v_dm.delpro_name), ''), v_disease_name);
    if v_dname ~ '[[:cntrl:]]' or length(v_dname) > 200 or coalesce(v_dm.delpro_code, '') ~ '[[:cntrl:]]' or length(coalesce(v_dm.delpro_code, '')) > 50 then
      v_probs := v_probs || fn_delpro_problem(
        'diagnosis_name_invalid',
        format('Diagnozės „%s“ pavadinimas turi neleistinų simbolių arba per ilgas.', coalesce(v_disease_name, '?')));
    end if;
  end if;

  -- Medicine: exactly one product line (route variants count as separate lines).
  select count(*) into v_nprod
  from (select 1 from usage_items ui where ui.treatment_id = t.id group by ui.product_id, ui.unit, ui.administration_route) x;

  if v_nprod = 0 then
    v_probs := v_probs || fn_delpro_problem('no_medicine', 'Gydymas neturi vaisto — nėra ką perduoti į DelPro.');
  elsif v_nprod > 1 then
    v_probs := v_probs || fn_delpro_problem(
      'multi_medicine',
      'Gydymas turi kelias vaistų eilutes. DelPro automatizacija kol kas įveda vieną vaistą — perdavimas užblokuotas, kad neprarastume eilučių.');
  else
    select ui.product_id, p.name as product_name, sum(ui.qty) as qty, ui.unit
      into v_prod
    from usage_items ui join products p on p.id = ui.product_id
    where ui.treatment_id = t.id
    group by ui.product_id, p.name, ui.unit;

    select * into v_pm from delpro_mappings where kind = 'product' and local_id = v_prod.product_id;
    v_mname := coalesce(nullif(btrim(v_pm.delpro_name), ''), v_prod.product_name);
    if v_mname ~ '[[:cntrl:]]' or length(v_mname) > 200 then
      v_probs := v_probs || fn_delpro_problem(
        'medicine_name_invalid',
        format('Vaisto „%s“ pavadinimas turi neleistinų simbolių arba per ilgas.', v_prod.product_name));
    end if;

    if v_prod.qty is null or v_prod.qty <= 0 then
      v_probs := v_probs || fn_delpro_problem('dose_missing', 'Nenurodyta vaisto dozė.');
    end if;

    -- The script enters ONE dose for the whole course. Later course days must
    -- therefore be the same medicine, dose and unit as day 1.
    select count(*) into v_variants
    from treatment_courses tc
    join course_doses cd on cd.course_id = tc.id
    where tc.treatment_id = t.id and tc.status <> 'cancelled'
      and (cd.product_id is distinct from v_prod.product_id
           or cd.dose_amount is distinct from v_prod.qty
           or cd.unit is distinct from v_prod.unit);
    if v_variants > 0 then
      v_probs := v_probs || fn_delpro_problem(
        'course_variants',
        'Gydymo kurso dienų vaistas ar dozė skiriasi nuo pirmos dienos. DelPro automatizacija įveda vieną dozę visam kursui — perdavimas užblokuotas.');
    end if;
  end if;

  select max(days) into v_course_days from treatment_courses where treatment_id = t.id and status <> 'cancelled';
  if v_course_days is not null and v_course_days < 1 then
    v_probs := v_probs || fn_delpro_problem('course_days', 'Neteisinga gydymo kurso trukmė.');
  end if;

  return v_probs;
end;
$$;

notify pgrst, 'reload schema';

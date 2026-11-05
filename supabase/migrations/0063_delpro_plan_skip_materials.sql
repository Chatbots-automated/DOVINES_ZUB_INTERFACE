-- 0063_delpro_plan_skip_materials.sql
-- A gydymas often also uses materials (Gydymo medžiagos: gels, bandages, syringes,
-- supplements like Provent gel). DelPro has only medicines (Drug), so the plan put
-- every usage line on the DelPro record and any material failed the whole transfer
-- with "„X“ nesusietas su DelPro vaistu." Now the plan carries only
--   * drug categories (fn_is_drug_category: medicines, vakcina, profilaktika, boliusai) — an
--     unlinked one is still a problem (never guessed), and
--   * any other product that IS linked to a DelPro Drug (the farm chose to keep it there).
-- Unlinked materials stay in GVET only (stock, journals, acts unchanged) and are listed in
-- the plan's `gvet_only` for display. Body otherwise = 0046.

create or replace function fn_delpro_treatment_plan(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  j delpro_sync_jobs%rowtype;
  t treatments%rowtype;
  a animals%rowtype;
  v_problems jsonb := '[]'::jsonb;
  v_meds jsonb;
  v_gvet_only jsonb;
  v_diag_code text;
  v_rec_treatment text;
  v_course integer;
  v_local timestamp;
  m jsonb;
begin
  select * into j from delpro_sync_jobs where id = p_job_id;
  if j.id is null then
    raise exception 'Užduotis nerasta.';
  end if;
  select * into t from treatments where id = j.treatment_id;
  select * into a from animals where id = t.animal_id;

  v_diag_code := (select l.delpro_key from delpro_catalog_links l where l.retired_at is null and l.disease_id = t.disease_id);
  v_rec_treatment := (select i.fields->>'recommended_treatment' from delpro_catalog_items i
                      where i.object_type = 'Diagnosis' and i.delpro_key = v_diag_code and i.removed_at is null);
  v_course := (select max(tc.days) from treatment_courses tc where tc.treatment_id = t.id and tc.status <> 'cancelled');
  v_local := t.reg_date + (t.created_at at time zone 'Europe/Vilnius')::time;

  -- day-1 medicine lines (what was actually given on the treatment day), per product + unit
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', x.product_id, 'product_name', p.name, 'qty', x.qty, 'unit', x.unit,
           'route', x.route,
           'gvet_milk_days', p.withdrawal_days_milk, 'gvet_meat_days', p.withdrawal_days_meat,
           'drug_code', l.delpro_key,
           'drug_params_key', di.fields->>'default_parameters',
           'delpro_uom', dp.fields->>'uom',
           'delpro_milk_days', (dp.fields->>'dump_milk_days')::int,
           'delpro_meat_days', (dp.fields->>'meat_withhold_days')::int,
           'expected_uom', fn_delpro_uom(x.unit),
           'frequency_per_day', sch.frequency_per_day,
           'course_days', sch.course_days) order by p.name), '[]'::jsonb)
  into v_meds
  from (select ui.product_id, ui.unit, sum(ui.qty) as qty, max(ui.administration_route::text) as route
        from usage_items ui where ui.treatment_id = t.id group by ui.product_id, ui.unit) x
  join products p on p.id = x.product_id
  left join delpro_catalog_links l on l.retired_at is null and l.product_id = x.product_id
  left join delpro_catalog_items di on di.object_type = 'Drug' and di.delpro_key = l.delpro_key and di.removed_at is null
  left join delpro_catalog_items dp on dp.object_type = 'DrugParameters' and dp.delpro_key = di.fields->>'default_parameters' and dp.removed_at is null
  left join treatment_medicine_schedules sch on sch.treatment_id = t.id and sch.product_id = x.product_id
  where fn_is_drug_category(p.category) or l.delpro_key is not null;

  -- 0063: materials without a DelPro Drug stay in GVET only
  select coalesce(jsonb_agg(distinct p.name), '[]'::jsonb) into v_gvet_only
  from usage_items ui join products p on p.id = ui.product_id
  where ui.treatment_id = t.id and not fn_is_drug_category(p.category)
    and not exists (select 1 from delpro_catalog_links l where l.retired_at is null and l.product_id = p.id);

  if t.procedure_type <> 'gydymas' then
    v_problems := v_problems || jsonb_build_object('code', 'not_treatment', 'message', 'Tai ne gydymas.');
  end if;
  if a.delpro_object_guid is null then
    v_problems := v_problems || jsonb_build_object('code', 'no_animal_guid',
      'message', 'Gyvulys neturi patikrinto DelPro ObjectGuid (susiejama tik per DelPro Animal sinchronizaciją; ORN ≠ DelPro Number).');
  end if;
  if v_diag_code is null then
    v_problems := v_problems || jsonb_build_object('code', 'no_diagnosis_code', 'message', 'Liga nesusieta su DelPro diagnoze.');
  end if;
  if jsonb_array_length(v_meds) = 0 then
    v_problems := v_problems || jsonb_build_object('code', 'no_medicine', 'message', 'Gydyme nėra vaistų.');
  end if;
  for m in select * from jsonb_array_elements(v_meds) loop
    if m->>'drug_code' is null then
      v_problems := v_problems || jsonb_build_object('code', 'medicine_not_linked', 'product', m->>'product_name',
        'message', format('„%s“ nesusietas su DelPro vaistu.', m->>'product_name'));
    elsif m->>'drug_params_key' is null or m->>'delpro_uom' is null then
      v_problems := v_problems || jsonb_build_object('code', 'medicine_params_missing', 'product', m->>'product_name',
        'message', format('DelPro vaisto %s parametrai (vienetas, karencija) negauti.', m->>'drug_code'));
    else
      if m->>'expected_uom' is distinct from m->>'delpro_uom' then
        v_problems := v_problems || jsonb_build_object('code', 'unit_mismatch', 'product', m->>'product_name',
          'message', format('Vienetas: GVET %s (%s), DelPro %s.', m->>'unit', coalesce(m->>'expected_uom', '?'), m->>'delpro_uom'));
      end if;
      if (m->>'gvet_milk_days')::int is distinct from (m->>'delpro_milk_days')::int
         or (m->>'gvet_meat_days')::int is distinct from (m->>'delpro_meat_days')::int then
        v_problems := v_problems || jsonb_build_object('code', 'withdrawal_mismatch', 'product', m->>'product_name',
          'message', format('Karencija: GVET pienas %s / mėsa %s d., DelPro %s / %s d.', m->>'gvet_milk_days', m->>'gvet_meat_days',
                            coalesce(m->>'delpro_milk_days', '?'), coalesce(m->>'delpro_meat_days', '?')));
      end if;
    end if;
    -- 0046: frequency + duration come from the vet, never assumed
    if (m->>'frequency_per_day') is null then
      v_problems := v_problems || jsonb_build_object('code', 'frequency_missing', 'product', m->>'product_name',
        'message', format('„%s“: nenurodytas dažnumas (kartai per dieną).', m->>'product_name'));
    end if;
    if (m->>'course_days') is null then
      v_problems := v_problems || jsonb_build_object('code', 'course_days_missing', 'product', m->>'product_name',
        'message', format('„%s“: nenurodyta gydymo trukmė (dienos).', m->>'product_name'));
    end if;
    if (m->>'qty') is null or (m->>'qty')::numeric <= 0 then
      v_problems := v_problems || jsonb_build_object('code', 'missing_dose', 'product', m->>'product_name', 'message', 'Nėra dozės.');
    end if;
  end loop;

  return jsonb_build_object(
    'job', jsonb_build_object('id', j.id, 'status', j.status, 'attempts', j.attempts, 'requires_verification', j.requires_verification),
    'treatment', jsonb_build_object('id', t.id, 'reg_date', t.reg_date, 'local_time', to_char(v_local, 'YYYY-MM-DD HH24:MI:SS'),
                                    'diagnosis', t.diagnosis, 'disease_id', t.disease_id, 'vet_name', t.vet_name,
                                    'course_days', v_course, 'route', t.administration_route,
                                    'withdrawal_until_milk', t.withdrawal_until_milk, 'withdrawal_until_meat', t.withdrawal_until_meat),
    'animal', jsonb_build_object('id', a.id, 'orn', a.tag_no, 'animal_no', a.animal_no, 'delpro_object_guid', a.delpro_object_guid),
    'diagnosis', jsonb_build_object('code', v_diag_code, 'recommended_treatment', v_rec_treatment),
    'medicines', v_meds,
    'gvet_only', v_gvet_only,
    'gateway_event', coalesce(j.gateway_entry, fn_delpro_gateway_entry(t.id, j.id)),
    'problems', v_problems);
end;
$$;

revoke all on function fn_delpro_treatment_plan(uuid) from public, anon, authenticated;
grant execute on function fn_delpro_treatment_plan(uuid) to service_role;

notify pgrst, 'reload schema';

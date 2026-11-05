-- 0067_delpro_quick_fix.sql
-- DelPro screen → "Greitas taisymas" (farm's request 2026-11-05): next to every failed or blocked
-- treatment transfer GVET proposes the fix, explains what it will do, applies it and sends the
-- record again — no hunting through tabs.
--
--   delpro_quick_fixes(job_id)          what is wrong now + one proposed fix per problem (read)
--   delpro_apply_quick_fix(jsonb)       applies the chosen fixes in ONE transaction, then:
--                                         * nothing left            → released to the PC again
--                                         * needs fresh DelPro data → catalog sync requested, the
--                                           job is re-released by itself when that sync finishes
--                                         * something left          → saved, the rest is returned
--                                       and re-releases every OTHER failed job the same fix cured.
--   trg_delpro_catalog_run_quick_retry  a finished catalog sync re-releases the waiting jobs
--
-- Fix kinds: link_drug, link_diagnosis (existing link function, admin), set_schedule
-- (treatment_medicine_schedules), take_delpro_withdrawal (products ← DelPro; 0060 recomputes karencija),
-- dose_factor (NEW products.delpro_dose_factor: 1 GVET unit = N DelPro units, e.g. Metricure 1 vnt = 19 ml;
-- the plan sends qty × factor in DelPro's unit — stock, acts, karencija stay in GVET units),
-- fix_tag (animals.tag_no, then catalog sync links the ObjectGuid), refresh_catalog, retry, reject.
-- Nothing is guessed: a link is made only to the DelPro record the admin picked; a factor only as typed.
--
-- fn_delpro_treatment_plan = 0063 body + dose factor + product_id on product problems.

alter table products add column if not exists delpro_dose_factor numeric
  check (delpro_dose_factor is null or delpro_dose_factor > 0);
comment on column products.delpro_dose_factor is
  '0067: DelPro dose per 1 GVET unit when DelPro counts the drug in another unit (null = same unit).';

alter table delpro_sync_jobs add column if not exists retry_after_catalog_at timestamptz;
alter table delpro_sync_jobs add column if not exists retry_after_catalog_by uuid references users (id) on delete set null;

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
  v_prod jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', x.product_id, 'product_name', p.name,
           -- 0067: DelPro dose = GVET qty × factor when the farm set one
           'qty', case when p.delpro_dose_factor is null then x.qty else round(x.qty * p.delpro_dose_factor, 3) end,
           'unit', x.unit, 'gvet_qty', x.qty, 'dose_factor', p.delpro_dose_factor,
           'route', x.route,
           'gvet_milk_days', p.withdrawal_days_milk, 'gvet_meat_days', p.withdrawal_days_meat,
           'drug_code', l.delpro_key,
           'drug_params_key', di.fields->>'default_parameters',
           'delpro_uom', dp.fields->>'uom',
           'delpro_milk_days', (dp.fields->>'dump_milk_days')::int,
           'delpro_meat_days', (dp.fields->>'meat_withhold_days')::int,
           'expected_uom', case when p.delpro_dose_factor is null then fn_delpro_uom(x.unit) else dp.fields->>'uom' end,
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
    v_prod := jsonb_build_object('product', m->>'product_name', 'product_id', m->>'product_id');
    if m->>'drug_code' is null then
      v_problems := v_problems || (v_prod || jsonb_build_object('code', 'medicine_not_linked',
        'message', format('„%s“ nesusietas su DelPro vaistu.', m->>'product_name')));
    elsif m->>'drug_params_key' is null or m->>'delpro_uom' is null then
      v_problems := v_problems || (v_prod || jsonb_build_object('code', 'medicine_params_missing',
        'message', format('DelPro vaisto %s parametrai (vienetas, karencija) negauti.', m->>'drug_code')));
    else
      if m->>'expected_uom' is distinct from m->>'delpro_uom' then
        v_problems := v_problems || (v_prod || jsonb_build_object('code', 'unit_mismatch',
          'message', format('Vienetas: GVET %s (%s), DelPro %s.', m->>'unit', coalesce(m->>'expected_uom', '?'), m->>'delpro_uom')));
      end if;
      if (m->>'gvet_milk_days')::int is distinct from (m->>'delpro_milk_days')::int
         or (m->>'gvet_meat_days')::int is distinct from (m->>'delpro_meat_days')::int then
        v_problems := v_problems || (v_prod || jsonb_build_object('code', 'withdrawal_mismatch',
          'message', format('Karencija: GVET pienas %s / mėsa %s d., DelPro %s / %s d.', m->>'gvet_milk_days', m->>'gvet_meat_days',
                            coalesce(m->>'delpro_milk_days', '?'), coalesce(m->>'delpro_meat_days', '?'))));
      end if;
    end if;
    if (m->>'frequency_per_day') is null then
      v_problems := v_problems || (v_prod || jsonb_build_object('code', 'frequency_missing',
        'message', format('„%s“: nenurodytas dažnumas (kartai per dieną).', m->>'product_name')));
    end if;
    if (m->>'course_days') is null then
      v_problems := v_problems || (v_prod || jsonb_build_object('code', 'course_days_missing',
        'message', format('„%s“: nenurodyta gydymo trukmė (dienos).', m->>'product_name')));
    end if;
    if (m->>'qty') is null or (m->>'qty')::numeric <= 0 then
      v_problems := v_problems || (v_prod || jsonb_build_object('code', 'missing_dose', 'message', 'Nėra dozės.'));
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

-- Everything GVET can check right now that would stop this job: the approval checks plus the
-- PC's plan checks (unit, karencija, schedule …), de-duplicated. The PC's live DelPro checks
-- (e.g. "DelPro neturi parametrų") can only be re-checked by sending again.
create or replace function fn_delpro_job_open_problems(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tid uuid := (select treatment_id from delpro_sync_jobs where id = p_job_id);
  v_tp jsonb;
  v_pp jsonb;
  v_codes text[];
begin
  if v_tid is null then
    return '[]'::jsonb;
  end if;
  v_tp := fn_delpro_transfer_problems(v_tid);
  v_pp := fn_delpro_treatment_plan(p_job_id)->'problems';
  select coalesce(array_agg(p->>'code'), '{}') into v_codes from jsonb_array_elements(v_tp) p;
  return v_tp || coalesce((
    select jsonb_agg(p) from jsonb_array_elements(v_pp) p
    where not (p->>'code' = 'no_animal_guid' and v_codes && array['animal_guid', 'animal_number'])
      and not (p->>'code' = 'no_diagnosis_code' and v_codes && array['diagnosis_link', 'diagnosis_missing'])
      and not (p->>'code' = 'no_medicine' and 'no_medicine' = any (v_codes))
      and not (p->>'code' = 'not_treatment' and 'not_gydymas' = any (v_codes))
  ), '[]'::jsonb);
end;
$$;

revoke all on function fn_delpro_job_open_problems(uuid) from public, anon, authenticated;

-- Problem codes GVET itself computes (transfer checks + plan): re-checked live, so a stored one
-- that is no longer there has been fixed.
create or replace function fn_delpro_gvet_checked_codes()
returns text[]
language sql
immutable
as $$
  select array['medicine_not_linked', 'medicine_params_missing', 'unit_mismatch', 'withdrawal_mismatch',
               'frequency_missing', 'course_days_missing', 'missing_dose', 'no_diagnosis_code', 'no_animal_guid',
               'no_medicine', 'not_treatment', 'animal_guid', 'animal_number', 'diagnosis_link', 'diagnosis_missing',
               'dose_missing', 'not_gydymas', 'course_days', 'integration_off', 'treatment_missing']::text[];
$$;

-- Release a job to the PC with fresh data (same effect as delpro_retry_job(refresh) / approval).
create or replace function fn_delpro_quick_release(p_job_id uuid, p_user uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  j delpro_sync_jobs%rowtype;
begin
  select * into j from delpro_sync_jobs where id = p_job_id for update;
  update delpro_sync_jobs
  set status = 'approved',
      approved_payload = fn_build_delpro_payload(treatment_id) || jsonb_build_object('sync_id', id),
      approved_by = coalesce(p_user, approved_by),
      approved_at = now(),
      error = null, error_details = null, actual_result = null, verified = false,
      next_attempt_at = null,
      retry_after_catalog_at = null, retry_after_catalog_by = null
  where id = p_job_id;
  insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
  values (p_user, 'delpro_transfer_quick_fix', 'delpro_sync_jobs', p_job_id,
          jsonb_build_object('status', j.status, 'error', j.error), jsonb_build_object('status', 'approved', 'reason', p_reason));
end;
$$;

revoke all on function fn_delpro_quick_release(uuid, uuid, text) from public, anon, authenticated;

-- DelPro records of one type not linked to anything yet, best name match first.
create or replace function fn_delpro_quick_candidates(p_type text, p_name text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', x.delpro_key, 'name', x.name, 'score', x.score) order by x.score desc, x.name), '[]'::jsonb)
  from (
    select i.delpro_key, i.name,
           case when fn_delpro_norm_name(i.name) = fn_delpro_norm_name(p_name) then 100
                when fn_delpro_norm_name(i.name) like '%' || fn_delpro_norm_name(p_name) || '%'
                  or fn_delpro_norm_name(p_name) like '%' || fn_delpro_norm_name(i.name) || '%' then 60
                when split_part(fn_delpro_norm_name(i.name), ' ', 1) = split_part(fn_delpro_norm_name(p_name), ' ', 1)
                  and length(split_part(fn_delpro_norm_name(p_name), ' ', 1)) >= 4 then 30
                else 0 end as score
    from delpro_catalog_items i
    where i.object_type = p_type and i.removed_at is null and coalesce(i.active, true) and i.name is not null
      and not exists (select 1 from delpro_catalog_links l where l.retired_at is null and l.object_type = p_type and l.delpro_key = i.delpro_key)
  ) x;
$$;

revoke all on function fn_delpro_quick_candidates(text, text) from public, anon, authenticated;

-- What is wrong with this job and the proposed fix for each problem.
-- { job_id, status, waiting_catalog_since, problems:[{code,message,product_id?,fix:{kind,…}}] }
create or replace function delpro_quick_fixes(p_job_id uuid)
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
  v_plan jsonb;
  v_probs jsonb;
  v_out jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
  p jsonb;
  m jsonb;
  v_fix jsonb;
  v_key text;
  v_last_run timestamptz;
begin
  if not fn_is_admin() then
    raise exception 'Greitą taisymą gali naudoti tik administratorius.';
  end if;
  select * into j from delpro_sync_jobs where id = p_job_id;
  if j.id is null then
    raise exception 'DelPro užduotis nerasta.';
  end if;
  select * into t from treatments where id = j.treatment_id;
  select * into a from animals where id = t.animal_id;
  v_plan := fn_delpro_treatment_plan(j.id);
  v_last_run := (select max(started_at) from delpro_catalog_runs where status = 'completed');

  -- what GVET sees now, plus the PC's own last answer (its live DelPro checks / write errors)
  v_probs := fn_delpro_job_open_problems(j.id);
  if j.status in ('error', 'verification_failed') then
    if jsonb_typeof(j.error_details->'problems') = 'array' then
      -- GVET-side codes are re-checked above (a fixed one is gone); keep only what the PC alone can see
      v_probs := v_probs || coalesce((select jsonb_agg(x) from jsonb_array_elements(j.error_details->'problems') x
                                      where not (x->>'code' = any (fn_delpro_gvet_checked_codes()))
                                        and not exists (select 1 from jsonb_array_elements(v_probs) y where y->>'code' = x->>'code')), '[]'::jsonb);
    elsif j.error is not null and jsonb_array_length(v_probs) = 0 then
      v_probs := jsonb_build_array(jsonb_build_object('code', case when j.status = 'verification_failed' then 'verification_failed' else 'worker_error' end,
                                                      'message', j.error));
    end if;
    if jsonb_array_length(v_probs) = 0 then
      v_probs := jsonb_build_array(jsonb_build_object('code', 'already_fixed',
        'message', 'Klaidos priežastis jau pašalinta — įrašą galima siųsti iš naujo.'));
    end if;
  end if;

  for p in select * from jsonb_array_elements(v_probs) loop
    m := null;
    -- the medicine the problem is about (by product id, name or DelPro parameters key)
    select x into m from jsonb_array_elements(v_plan->'medicines') x
    where x->>'product_id' = p->>'product_id' or x->>'product_name' = p->>'product'
       or (p->>'code' = 'params_not_in_delpro' and p->>'message' like '%' || (x->>'drug_params_key') || '%')
    limit 1;

    v_fix := case
      when p->>'code' in ('animal_guid', 'no_animal_guid', 'animal_number') then
        jsonb_build_object('kind', case when a.tag_no ~ '^LT[0-9]{12}$' then 'fix_tag' else 'reject' end,
          'tag_no', a.tag_no, 'tag_valid', a.tag_no ~ '^LT[0-9]{12}$', 'animal_id', a.id)
      when p->>'code' in ('diagnosis_link', 'no_diagnosis_code') and t.disease_id is not null then
        jsonb_build_object('kind', 'link_diagnosis', 'disease_id', t.disease_id,
          'disease_name', (select name from diseases where id = t.disease_id),
          'candidates', fn_delpro_quick_candidates('Diagnosis', (select name from diseases where id = t.disease_id)))
      when p->>'code' in ('diagnosis_missing', 'diagnosis_link', 'no_diagnosis_code') then
        jsonb_build_object('kind', 'manual', 'where', 'treatment')
      when p->>'code' = 'medicine_not_linked' and m is not null then
        jsonb_build_object('kind', 'link_drug', 'product_id', m->>'product_id', 'product_name', m->>'product_name',
          'candidates', fn_delpro_quick_candidates('Drug', m->>'product_name'))
      when p->>'code' = 'unit_mismatch' and m is not null then
        jsonb_build_object('kind', 'dose_factor', 'product_id', m->>'product_id', 'product_name', m->>'product_name',
          'gvet_unit', m->>'unit', 'delpro_uom', m->>'delpro_uom', 'factor', m->'dose_factor', 'gvet_qty', m->'gvet_qty')
      when p->>'code' = 'withdrawal_mismatch' and m is not null then
        jsonb_build_object('kind', 'take_delpro_withdrawal', 'product_id', m->>'product_id', 'product_name', m->>'product_name',
          'gvet_milk', m->'gvet_milk_days', 'gvet_meat', m->'gvet_meat_days', 'delpro_milk', m->'delpro_milk_days', 'delpro_meat', m->'delpro_meat_days')
      when p->>'code' in ('frequency_missing', 'course_days_missing') and m is not null then
        jsonb_build_object('kind', 'set_schedule', 'product_id', m->>'product_id', 'product_name', m->>'product_name',
          'frequency_per_day', coalesce(nullif(m->'frequency_per_day', 'null'::jsonb), '1'::jsonb),
          'course_days', coalesce(nullif(m->'course_days', 'null'::jsonb), to_jsonb(coalesce((v_plan->'treatment'->>'course_days')::int, 1))))
      when p->>'code' = 'params_not_in_delpro' then
        jsonb_build_object('kind', 'refresh_catalog', 'reason', 'params_lost',
          'product_name', m->>'product_name', 'drug_code', m->>'drug_code', 'params_key', m->>'drug_params_key',
          -- the last finished sync did not see this parameters record any more: DelPro lost it
          'delpro_lost', coalesce((select i.last_seen_at < v_last_run from delpro_catalog_items i
                                   where i.object_type = 'DrugParameters' and i.delpro_key = m->>'drug_params_key'), false))
      when p->>'code' in ('medicine_params_missing', 'withdrawal_changed_in_delpro', 'drug_not_in_delpro',
                          'diagnosis_not_in_delpro', 'animal_not_in_delpro', 'animal_number_mismatch') then
        jsonb_build_object('kind', 'refresh_catalog', 'reason', p->>'code', 'product_name', m->>'product_name')
      when p->>'code' in ('no_medicine', 'dose_missing', 'missing_dose', 'not_gydymas', 'not_treatment') then
        jsonb_build_object('kind', 'reject')
      when p->>'code' = 'integration_off' then
        jsonb_build_object('kind', 'manual', 'where', 'settings')
      when p->>'code' = 'no_treatment_protocol' then
        jsonb_build_object('kind', 'refresh_catalog', 'reason', 'no_treatment_protocol',
          'disease_name', (select name from diseases where id = t.disease_id))
      when p->>'code' = 'already_fixed' then
        jsonb_build_object('kind', 'resend')
      when j.status in ('error', 'verification_failed') then
        jsonb_build_object('kind', 'retry')
      else jsonb_build_object('kind', 'manual', 'where', 'unknown')
    end;

    v_key := (v_fix->>'kind') || ':' || coalesce(v_fix->>'product_id', '') || coalesce(v_fix->>'reason', '');
    p := p || jsonb_build_object('fix', v_fix, 'duplicate', v_key = any (v_seen));
    v_seen := v_seen || v_key;
    v_out := v_out || p;
  end loop;

  return jsonb_build_object(
    'job_id', j.id, 'status', j.status, 'attempts', j.attempts,
    'animal', coalesce(a.animal_no, a.tag_no), 'tag_no', a.tag_no, 'reg_date', t.reg_date, 'disease', t.diagnosis,
    'waiting_catalog_since', j.retry_after_catalog_at,
    'worker_last_seen', (select nullif(setting_value, '') from system_settings where setting_key = 'delpro_worker_last_seen_at'),
    'last_catalog_at', v_last_run,
    'problems', v_out);
end;
$$;

revoke all on function delpro_quick_fixes(uuid) from public, anon;
grant execute on function delpro_quick_fixes(uuid) to authenticated;

-- { job_id, fixes:[{kind, product_id?, delpro_key?, disease_id?, frequency_per_day?, course_days?,
--   factor?, tag_no?, reason?}] }  → { outcome, message, remaining, also_released }
create or replace function delpro_apply_quick_fix(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j delpro_sync_jobs%rowtype;
  t treatments%rowtype;
  f jsonb;
  v_kind text;
  v_pid uuid;
  v_n integer;
  v_linked boolean := false;
  v_catalog boolean := false;
  v_retry_same boolean := false;
  v_reject text;
  v_done text[] := '{}';
  v_open jsonb;
  v_also integer := 0;
  v_tag text;
  o record;
  dp record;
  v_data_codes text[] := fn_delpro_gvet_checked_codes();
begin
  if not fn_is_admin() then
    raise exception 'Greitą taisymą gali naudoti tik administratorius.';
  end if;
  select * into j from delpro_sync_jobs where id = nullif(p_data->>'job_id', '')::uuid for update;
  if j.id is null then
    raise exception 'DelPro užduotis nerasta.';
  end if;
  if j.status not in ('pending_approval', 'error', 'verification_failed') then
    raise exception 'Šis įrašas jau siunčiamas arba baigtas (%). Atnaujinkite puslapį.', j.status;
  end if;
  select * into t from treatments where id = j.treatment_id;
  if jsonb_typeof(p_data->'fixes') is distinct from 'array' or jsonb_array_length(p_data->'fixes') = 0 then
    raise exception 'Nepasirinktas nė vienas taisymas.';
  end if;

  for f in select * from jsonb_array_elements(p_data->'fixes') loop
    v_kind := f->>'kind';
    v_pid := nullif(f->>'product_id', '')::uuid;
    if v_kind = 'link_drug' then
      if v_pid is null or nullif(f->>'delpro_key', '') is null then
        raise exception 'Pasirinkite DelPro vaistą.';
      end if;
      perform fn_delpro_catalog_create_link('Drug', f->>'delpro_key', v_pid, 'manual');
      v_linked := true;
      v_done := v_done || format('„%s“ susietas su DelPro „%s“', (select name from products where id = v_pid),
                                 (select name from delpro_catalog_items where object_type = 'Drug' and delpro_key = f->>'delpro_key'));
    elsif v_kind = 'link_diagnosis' then
      if nullif(f->>'delpro_key', '') is null then
        raise exception 'Pasirinkite DelPro diagnozę.';
      end if;
      perform fn_delpro_catalog_create_link('Diagnosis', f->>'delpro_key', coalesce(nullif(f->>'disease_id', '')::uuid, t.disease_id), 'manual');
      v_linked := true;
      v_done := v_done || format('liga susieta su DelPro „%s“',
                                 (select name from delpro_catalog_items where object_type = 'Diagnosis' and delpro_key = f->>'delpro_key'));
    elsif v_kind = 'set_schedule' then
      if v_pid is null or coalesce((f->>'frequency_per_day')::int, 0) < 1 or coalesce((f->>'course_days')::int, 0) < 1 then
        raise exception 'Įveskite, kiek kartų per dieną ir kiek dienų (bent 1).';
      end if;
      insert into treatment_medicine_schedules (treatment_id, product_id, frequency_per_day, course_days)
      values (t.id, v_pid, (f->>'frequency_per_day')::int, (f->>'course_days')::int)
      on conflict (treatment_id, product_id) do update
        set frequency_per_day = excluded.frequency_per_day, course_days = excluded.course_days;
      v_done := v_done || format('„%s“: %s k. per dieną, %s dien.', (select name from products where id = v_pid), f->>'frequency_per_day', f->>'course_days');
    elsif v_kind = 'take_delpro_withdrawal' then
      select (dpi.fields->>'dump_milk_days')::int as milk, (dpi.fields->>'meat_withhold_days')::int as meat into dp
      from delpro_catalog_links l
      join delpro_catalog_items di on di.object_type = 'Drug' and di.delpro_key = l.delpro_key and di.removed_at is null
      join delpro_catalog_items dpi on dpi.object_type = 'DrugParameters' and dpi.delpro_key = di.fields->>'default_parameters' and dpi.removed_at is null
      where l.retired_at is null and l.product_id = v_pid;
      if not found then
        raise exception 'DelPro karencija šiam vaistui negauta — paleiskite katalogo sinchronizaciją.';
      end if;
      update products set withdrawal_days_milk = dp.milk, withdrawal_days_meat = dp.meat where id = v_pid;
      v_done := v_done || format('„%s“ karencija paimta iš DelPro (pienas %s, mėsa %s d.)', (select name from products where id = v_pid),
                                 coalesce(dp.milk::text, '—'), coalesce(dp.meat::text, '—'));
    elsif v_kind = 'dose_factor' then
      if v_pid is null or coalesce((f->>'factor')::numeric, 0) <= 0 then
        raise exception 'Įveskite, kiek DelPro vienetų yra 1 GVET vienete (daugiau už 0).';
      end if;
      update products set delpro_dose_factor = (f->>'factor')::numeric where id = v_pid;
      v_done := v_done || format('„%s“: į DelPro siunčiama %s × GVET kiekis', (select name from products where id = v_pid), f->>'factor');
    elsif v_kind = 'fix_tag' then
      v_tag := upper(regexp_replace(coalesce(f->>'tag_no', ''), '\s+', '', 'g'));
      if v_tag !~ '^LT[0-9]{12}$' then
        raise exception 'Ausies numeris turi būti LT ir 12 skaitmenų, pvz. LT000012345678.';
      end if;
      if v_tag <> (select tag_no from animals where id = t.animal_id) then
        if exists (select 1 from animals where tag_no = v_tag and id <> t.animal_id) then
          raise exception 'Gyvulys su numeriu % GVET jau yra — šis gydymas įvestas ne tam gyvuliui. Atmeskite šį įrašą ir įveskite gydymą tam gyvuliui.', v_tag;
        end if;
        update animals set tag_no = v_tag where id = t.animal_id;
        v_done := v_done || format('ausies numeris pakeistas į %s', v_tag);
      end if;
      v_catalog := true;
    elsif v_kind = 'refresh_catalog' then
      v_catalog := true;
    elsif v_kind = 'retry' then
      v_retry_same := true;
    elsif v_kind = 'reject' then
      v_reject := coalesce(nullif(f->>'reason', ''), 'Greitas taisymas: atmesta');
    elsif v_kind in ('manual', 'resend') then
      null;
    else
      raise exception 'Nežinomas taisymas „%“.', v_kind;
    end if;
  end loop;

  if v_linked then
    perform fn_delpro_catalog_reconcile();
  end if;

  if v_reject is not null then
    if j.status = 'verification_failed' then
      raise exception 'Nepatikrinto įrašo atmesti negalima — pirmiausia patikrinkite DelPro.';
    end if;
    perform delpro_reject_job(j.id, v_reject);
    return jsonb_build_object('outcome', 'rejected', 'message', 'Įrašas atmestas — į DelPro nebus siunčiamas. Gydymas GVET liko.',
                              'remaining', '[]'::jsonb, 'also_released', 0);
  end if;

  v_open := fn_delpro_job_open_problems(j.id);

  if v_catalog then
    update delpro_sync_jobs set retry_after_catalog_at = now(), retry_after_catalog_by = auth.uid() where id = j.id;
    update system_settings set setting_value = now()::text where setting_key = 'delpro_catalog_sync_requested_at';
    return jsonb_build_object('outcome', 'waiting_catalog',
      'message', array_to_string(v_done || 'paprašyta ūkio kompiuterio atnaujinti DelPro duomenis — kai jis baigs (paprastai per kelias minutes), įrašas bus išsiųstas iš naujo pats'::text, '; ') || '.',
      'remaining', v_open, 'also_released', 0);
  end if;

  if jsonb_array_length(v_open) > 0 then
    return jsonb_build_object('outcome', 'remaining',
      'message', case when cardinality(v_done) > 0 then array_to_string(v_done, '; ') || '. ' else '' end || 'Dar liko pataisyti: ' ||
                 (select string_agg(x->>'message', ' ') from jsonb_array_elements(v_open) x),
      'remaining', v_open, 'also_released', 0);
  end if;

  if v_retry_same and j.status in ('error', 'verification_failed') and cardinality(v_done) = 0 then
    perform delpro_retry_job(j.id, false);
  else
    perform fn_delpro_quick_release(j.id, auth.uid(), array_to_string(v_done, '; '));
  end if;

  -- the same fix often cures other failed records (same medicine / disease)
  for o in
    select s.id from delpro_sync_jobs s
    where s.status = 'error' and s.id <> j.id and s.retry_after_catalog_at is null
      and jsonb_typeof(s.error_details->'problems') = 'array'
      and jsonb_array_length(s.error_details->'problems') > 0
      and not exists (select 1 from jsonb_array_elements(s.error_details->'problems') x where not (x->>'code' = any (v_data_codes)))
    for update
  loop
    if jsonb_array_length(fn_delpro_job_open_problems(o.id)) = 0 then
      perform fn_delpro_quick_release(o.id, auth.uid(), 'Greitas taisymas kitam įrašui: ' || array_to_string(v_done, '; '));
      v_also := v_also + 1;
    end if;
  end loop;

  return jsonb_build_object('outcome', 'released',
    'message', case when cardinality(v_done) > 0 then array_to_string(v_done, '; ') || '. ' else '' end ||
               'Įrašas išsiųstas iš naujo — ūkio kompiuteris jį įrašys per minutę.' ||
               case when v_also > 0 then format(' Tas pats taisymas pataisė dar %s įraš. — jie irgi išsiųsti.', v_also) else '' end,
    'remaining', '[]'::jsonb, 'also_released', v_also);
end;
$$;

revoke all on function delpro_apply_quick_fix(jsonb) from public, anon;
grant execute on function delpro_apply_quick_fix(jsonb) to authenticated;

-- A finished catalog sync: every job waiting for it is sent again if GVET sees no problem now,
-- otherwise it shows the new reason (e.g. what to change in DelPro).
create or replace function fn_delpro_catalog_run_quick_retry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  o record;
  v_open jsonb;
begin
  for o in
    select id, status, retry_after_catalog_by from delpro_sync_jobs
    where retry_after_catalog_at is not null and retry_after_catalog_at < new.started_at
      and status in ('pending_approval', 'error', 'verification_failed')
    for update
  loop
    v_open := fn_delpro_job_open_problems(o.id);
    if jsonb_array_length(v_open) = 0 then
      perform fn_delpro_quick_release(o.id, o.retry_after_catalog_by, 'Greitas taisymas: DelPro duomenys atnaujinti');
    elsif o.status = 'pending_approval' then
      update delpro_sync_jobs set retry_after_catalog_at = null, retry_after_catalog_by = null where id = o.id;
    else
      update delpro_sync_jobs
      set error = (select string_agg(x->>'message', '; ') from jsonb_array_elements(v_open) x),
          error_details = jsonb_build_object('problems', v_open),
          retry_after_catalog_at = null, retry_after_catalog_by = null
      where id = o.id;
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_delpro_catalog_run_quick_retry on delpro_catalog_runs;
create trigger trg_delpro_catalog_run_quick_retry
  after update of status on delpro_catalog_runs
  for each row
  when (new.status = 'completed' and old.status is distinct from 'completed')
  execute function fn_delpro_catalog_run_quick_retry();

notify pgrst, 'reload schema';

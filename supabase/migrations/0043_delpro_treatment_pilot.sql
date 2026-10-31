-- 0043_delpro_treatment_pilot.sql
-- GVET -> DelPro treatment, ONE approved job at a time (pilot), on top of 0033/0037.
--
-- The Gateway channel (0037) writes only a DiagnosesAndTreatmentEvent; medicines
-- travel as Comment text. That is NOT an administered-medicine record, so a
-- pilot job is only 'success' when the medication part was written AND read
-- back as well (actual_result.medication.verified). Anything less is
-- 'verification_failed' — a person checks DelPro.
--
--   delpro_treatment_pilot_plan(jsonb)     service_role, read-only: everything the
--                                          worker would send for one job + problems
--   delpro_treatment_pilot_release(uuid)   admin: allow exactly this approved job
--   delpro_treatment_pilot_claim(jsonb)    service_role: claim ONLY the released job
--   delpro_report_job_result(jsonb)        v3: medication verification for pilot jobs
-- The global OUTBOUND_MODE / delpro_write_channel are not touched: a pilot claim
-- works with the channel still 'ui_script', and the normal claim (redefined here
-- with "and not pilot") never hands out a pilot job.

insert into system_settings (setting_key, setting_value, description) values
  ('delpro_treatment_pilot_job', '',
   'Vienas patvirtintas gydymo įrašas, kurį leidžiama siųsti į DelPro bandomuoju režimu (test-treatment.mjs --execute). Išvaloma po vykdymo.')
on conflict (setting_key) do nothing;

alter table delpro_sync_jobs add column pilot boolean not null default false;

-- Everything about one job, nothing guessed. Problems block the pilot.
create or replace function delpro_treatment_pilot_plan(jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  j delpro_sync_jobs%rowtype;
  t treatments%rowtype;
  a animals%rowtype;
  v_problems jsonb := '[]'::jsonb;
  v_meds jsonb;
  v_diag_code text;
  v_rec_treatment text;
  v_course integer;
  v_local timestamp;
  m jsonb;
begin
  select * into j from delpro_sync_jobs where id = nullif($1->>'job_id', '')::uuid;
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
           'expected_uom', fn_delpro_uom(x.unit)) order by p.name), '[]'::jsonb)
  into v_meds
  from (select ui.product_id, ui.unit, sum(ui.qty) as qty, max(ui.administration_route::text) as route
        from usage_items ui where ui.treatment_id = t.id group by ui.product_id, ui.unit) x
  join products p on p.id = x.product_id
  left join delpro_catalog_links l on l.retired_at is null and l.product_id = x.product_id
  left join delpro_catalog_items di on di.object_type = 'Drug' and di.delpro_key = l.delpro_key and di.removed_at is null
  left join delpro_catalog_items dp on dp.object_type = 'DrugParameters' and dp.delpro_key = di.fields->>'default_parameters' and dp.removed_at is null;

  if j.status <> 'approved' then
    v_problems := v_problems || jsonb_build_object('code', 'not_approved', 'message', format('Užduotis nepatvirtinta (būsena %s).', j.status));
  elsif j.approved_payload is null or fn_delpro_payload_stale(j.treatment_id, j.approved_payload) then
    v_problems := v_problems || jsonb_build_object('code', 'stale', 'message', 'Gydymas pasikeitė po patvirtinimo — patvirtinkite iš naujo.');
  end if;
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
    if (m->>'qty') is null or (m->>'qty')::numeric <= 0 then
      v_problems := v_problems || jsonb_build_object('code', 'missing_dose', 'product', m->>'product_name', 'message', 'Nėra dozės.');
    end if;
  end loop;

  return jsonb_build_object(
    'job', jsonb_build_object('id', j.id, 'status', j.status, 'approved_at', j.approved_at, 'approved_by', j.approved_by,
                              'pilot', j.pilot, 'requires_verification', j.requires_verification, 'attempts', j.attempts,
                              'released', j.id::text = (select setting_value from system_settings where setting_key = 'delpro_treatment_pilot_job')),
    'treatment', jsonb_build_object('id', t.id, 'reg_date', t.reg_date, 'local_time', to_char(v_local, 'YYYY-MM-DD HH24:MI:SS'),
                                    'diagnosis', t.diagnosis, 'disease_id', t.disease_id, 'vet_name', t.vet_name,
                                    'course_days', v_course, 'route', t.administration_route,
                                    'withdrawal_until_milk', t.withdrawal_until_milk, 'withdrawal_until_meat', t.withdrawal_until_meat),
    'animal', jsonb_build_object('id', a.id, 'orn', a.tag_no, 'animal_no', a.animal_no, 'delpro_object_guid', a.delpro_object_guid),
    'diagnosis', jsonb_build_object('code', v_diag_code, 'recommended_treatment', v_rec_treatment),
    'medicines', v_meds,
    'gateway_event', coalesce(j.gateway_entry, fn_delpro_gateway_entry(t.id, j.id)),
    'problems', v_problems);
end;
$$;

-- Admin: release exactly one approved, problem-free job for the pilot.
create or replace function delpro_treatment_pilot_release(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan jsonb;
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali leisti bandomąjį gydymo siuntimą.';
  end if;
  v_plan := delpro_treatment_pilot_plan(jsonb_build_object('job_id', p_job_id));
  if jsonb_array_length(v_plan->'problems') > 0 then
    raise exception 'Užduotis negali būti siunčiama: %', (select string_agg(x->>'message', '; ') from jsonb_array_elements(v_plan->'problems') x);
  end if;
  update system_settings set setting_value = p_job_id::text where setting_key = 'delpro_treatment_pilot_job';
  update delpro_sync_jobs set pilot = true where id = p_job_id;
  insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
  values (auth.uid(), 'delpro_treatment_pilot_released', 'delpro_sync_jobs', p_job_id, v_plan);
  return jsonb_build_object('ok', true, 'message', 'Leista siųsti tik šį gydymą (test-treatment.mjs --execute).');
end;
$$;

-- Service role: claim ONLY the released job (body { job_id, worker_id }); null otherwise.
create or replace function delpro_treatment_pilot_claim(jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid := nullif($1->>'job_id', '')::uuid;
  v_plan jsonb;
  v_entry jsonb;
  j delpro_sync_jobs%rowtype;
begin
  if v_id is null or v_id::text <> coalesce((select setting_value from system_settings where setting_key = 'delpro_treatment_pilot_job'), '') then
    return null;
  end if;
  select * into j from delpro_sync_jobs where id = v_id for update;
  if j.status <> 'approved' then
    return null;
  end if;
  v_plan := delpro_treatment_pilot_plan(jsonb_build_object('job_id', v_id));
  if jsonb_array_length(v_plan->'problems') > 0 then
    raise exception 'Užduotis negali būti siunčiama: %', (select string_agg(x->>'message', '; ') from jsonb_array_elements(v_plan->'problems') x);
  end if;
  -- the event values are frozen at the first claim (the GVET:<id> marker must never change)
  v_entry := coalesce(j.gateway_entry, v_plan->'gateway_event');
  update delpro_sync_jobs
  set status = 'processing', started_at = now(), worker_id = nullif($1->>'worker_id', ''), gateway_entry = v_entry, pilot = true
  where id = v_id;
  return v_plan || jsonb_build_object('gateway_event', v_entry, 'sync_id', v_id, 'verify_before_write', true);
end;
$$;

-- The normal claim (0037) must never hand a pilot job to the regular loop.
create or replace function delpro_claim_next_job(p_worker_id text, p_channel text default null)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_mode text;
  v_channel text := coalesce((select setting_value from system_settings where setting_key = 'delpro_write_channel'), 'ui_script');
  v_delay integer;
  v_job delpro_sync_jobs%rowtype;
  v_skip uuid[] := '{}';
  v_entry jsonb;
begin
  update system_settings set setting_value = now()::text where setting_key = 'delpro_worker_last_seen_at';

  if p_channel is not null and p_channel <> v_channel then
    return null;
  end if;

  select setting_value into v_mode from system_settings where setting_key = 'delpro_outbound_mode';
  if coalesce(v_mode, 'approval') = 'off' then
    return null;
  end if;
  select coalesce(nullif(setting_value, '')::integer, 10) into v_delay from system_settings where setting_key = 'delpro_auto_delay_minutes';

  loop
    select * into v_job
    from delpro_sync_jobs
    where (status = 'approved'
           or (v_mode = 'auto' and status = 'pending_approval' and created_at < now() - make_interval(mins => coalesce(v_delay, 10))))
      and id <> all (v_skip)
      and not pilot  -- 0043: a pilot job is only ever claimed by delpro_treatment_pilot_claim
    order by coalesce(approved_at, created_at) asc
    for update skip locked
    limit 1;

    if not found then
      return null;
    end if;

    if v_job.status = 'approved' then
      if v_job.approved_payload is null or fn_delpro_payload_stale(v_job.treatment_id, v_job.approved_payload) then
        update delpro_sync_jobs
        set status = 'pending_approval',
            approved_payload = null,
            approved_by = null,
            approved_at = null,
            error = 'Gydymo ar susiejimų duomenys pasikeitė po patvirtinimo — reikia patvirtinti iš naujo.'
        where id = v_job.id;
        insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
        values (null, 'delpro_transfer_invalidated', 'delpro_sync_jobs', v_job.id,
                jsonb_build_object('status', 'approved', 'approved_payload', v_job.approved_payload),
                jsonb_build_object('status', 'pending_approval', 'worker_id', p_worker_id));
        v_skip := v_skip || v_job.id;
        continue;
      end if;
    else
      if jsonb_array_length(fn_delpro_transfer_problems(v_job.treatment_id)) > 0 then
        v_skip := v_skip || v_job.id;
        continue;
      end if;
      v_job.approved_payload := fn_build_delpro_payload(v_job.treatment_id) || jsonb_build_object('sync_id', v_job.id);
      update delpro_sync_jobs
      set approved_payload = v_job.approved_payload, auto_approved = true, approved_at = now(), error = null
      where id = v_job.id;
    end if;

    if v_channel = 'gateway' then
      v_entry := coalesce(v_job.gateway_entry, fn_delpro_gateway_entry(v_job.treatment_id, v_job.id));
      if v_entry->>'animal_guid' is null or v_entry->>'diagnosis_code' is null then
        update delpro_sync_jobs
        set status = 'error', completed_at = now(),
            error = 'Trūksta gyvulio ObjectGuid arba DelPro diagnozės susiejimo — Gateway įrašas negalimas.'
        where id = v_job.id;
        v_skip := v_skip || v_job.id;
        continue;
      end if;
      update delpro_sync_jobs set gateway_entry = v_entry where id = v_job.id;
    end if;

    update delpro_sync_jobs
    set status = 'processing', started_at = now(), worker_id = p_worker_id
    where id = v_job.id;

    return v_job.approved_payload
      || jsonb_build_object('sync_id', v_job.id, 'channel', v_channel)
      || case when v_channel = 'gateway'
              then jsonb_build_object('gateway', v_entry, 'verify_before_write', v_job.requires_verification)
              else '{}'::jsonb end;
  end loop;
end;
$$;

-- The pilot gate closes once the released job is done (any outcome).
create or replace function fn_delpro_pilot_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status not in ('approved', 'processing')
     and new.id::text = (select setting_value from system_settings where setting_key = 'delpro_treatment_pilot_job') then
    update system_settings set setting_value = '' where setting_key = 'delpro_treatment_pilot_job';
  end if;
  return null;
end;
$$;

create trigger trg_delpro_sync_jobs_pilot_gate
  after update of status on delpro_sync_jobs
  for each row execute function fn_delpro_pilot_guard();

-- Report v3: as 0037, plus — a pilot job (or any result that says medication is
-- required) is only 'success' when the medication records were verified too.
create or replace function delpro_report_job_result(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  v_sync_id uuid;
  v_job delpro_sync_jobs%rowtype;
  v_actual jsonb;
  v_expected jsonb;
  v_verified boolean;
begin
  v_sync_id := (p_body->>'sync_id')::uuid;
  if v_sync_id is null then
    raise exception 'Trūksta sync_id.';
  end if;

  select * into v_job from delpro_sync_jobs where id = v_sync_id for update;
  if not found then
    raise exception 'Sync užduotis nerasta: %', v_sync_id;
  end if;

  if v_job.status in ('success', 'error', 'verification_failed') then
    return to_jsonb(v_job);
  end if;
  if v_job.status <> 'processing' then
    raise exception 'Sync užduotis % nėra vykdoma (status=%).', v_sync_id, v_job.status;
  end if;

  if coalesce((p_body->>'success')::boolean, false) then
    v_actual := p_body->'actual_result';
    if v_actual->>'channel' = 'gateway' then
      v_expected := v_job.gateway_entry;
      v_verified := v_actual is not null and v_expected is not null
        and lower(v_actual->>'animal_guid') = lower(v_expected->>'animal_guid')
        and (v_actual->>'diagnosis_code') = (v_expected->>'diagnosis_code')
        and (v_actual->>'comment') = (v_expected->>'comment')
        and left(v_actual->>'event_date', 10) in (left(v_expected->>'event_at', 10), v_expected->>'event_date_local');
      if v_job.pilot or coalesce((v_actual->'medication'->>'required')::boolean, false) then
        v_verified := v_verified and coalesce((v_actual->'medication'->>'verified')::boolean, false);
      end if;
    else
      v_expected := v_job.approved_payload->'delpro';
      v_verified := v_actual is not null
        and (v_actual->>'event_date') is not distinct from (v_expected->>'event_date')
        and (v_actual->>'animal_no') is not distinct from (v_job.approved_payload->'animal'->>'animal_no')
        and coalesce((v_actual->>'milk_withdrawal_days')::int, -1) = coalesce((v_expected->>'milk_withdrawal_days')::int, -1)
        and coalesce((v_actual->>'meat_withdrawal_days')::int, -1) = coalesce((v_expected->>'meat_withdrawal_days')::int, -1);
    end if;

    update delpro_sync_jobs
    set status = case when v_verified then 'success' else 'verification_failed' end,
        actual_result = v_actual,
        verified = v_verified,
        verified_at = now(),
        completed_at = now(),
        attempts = attempts + 1,
        error = case when v_verified then null else coalesce(nullif(p_body->>'error_message', ''), 'DelPro įrašas nepatvirtintas nuskaitymu — patikrinkite ranka.') end
    where id = v_sync_id
    returning * into v_job;
  else
    update delpro_sync_jobs
    set status = 'error',
        error = coalesce(nullif(p_body->>'error_message', ''), 'Nežinoma klaida'),
        error_details = p_body->'error_details',
        requires_verification = requires_verification or coalesce((p_body->>'outcome_unknown')::boolean, false),
        completed_at = now(),
        attempts = attempts + 1
    where id = v_sync_id
    returning * into v_job;
  end if;

  return to_jsonb(v_job);
end;
$$;

revoke all on function delpro_claim_next_job(text, text) from public, anon, authenticated;
grant execute on function delpro_claim_next_job(text, text) to service_role;
revoke all on function delpro_treatment_pilot_plan(jsonb) from public, anon, authenticated;
revoke all on function delpro_treatment_pilot_claim(jsonb) from public, anon, authenticated;
revoke all on function delpro_report_job_result(jsonb) from public, anon, authenticated;
revoke all on function fn_delpro_pilot_guard() from public, anon, authenticated;
revoke all on function delpro_treatment_pilot_release(uuid) from public, anon;
grant execute on function delpro_treatment_pilot_plan(jsonb) to service_role;
grant execute on function delpro_treatment_pilot_claim(jsonb) to service_role;
grant execute on function delpro_report_job_result(jsonb) to service_role;
grant execute on function delpro_treatment_pilot_release(uuid) to authenticated;

notify pgrst, 'reload schema';

-- 0044_delpro_treatment_auto_sync.sql
-- GVET -> DelPro treatments: ONE production path (replaces the 0043 pilot gate).
--
--   * saving a gydymas treatment queues it (delpro_sync_jobs, 0006); with
--     delpro_outbound_mode = 'auto' and delay 0 the worker claims it on its next
--     poll (OUTBOUND_INTERVAL_SEC, default 5 s) — no extra approval step;
--   * channel 'gateway': the claim hands out the whole treatment (fn_delpro_treatment_plan:
--     animal ObjectGuid, DelPro diagnosis / drug / parameters codes, dose, course,
--     withdrawal GVET vs DelPro). A job whose data can't be sent fails visibly and
--     the loop continues with the next one;
--   * 'success' only when the DiagnosesAndTreatmentEvent AND its medicine records
--     were read back and match (actual_result.medication.verified);
--   * transient failures / unknown outcomes are retried with backoff (up to 8
--     attempts); every attempt first looks for the event by its GVET:<id> marker,
--     so a retry never creates a second treatment.
-- The worker writes only with OUTBOUND_MODE=gateway AND a farm-verified
-- treatment-model.json (the per-animal medicine object). Until then nothing is
-- claimed: jobs stay pending, nothing is lost.

-- 1. the pilot gate goes
drop trigger if exists trg_delpro_sync_jobs_pilot_gate on delpro_sync_jobs;
drop function if exists fn_delpro_pilot_guard();
drop function if exists delpro_treatment_pilot_release(uuid);
drop function if exists delpro_treatment_pilot_claim(jsonb);
drop function if exists delpro_treatment_pilot_plan(jsonb);
delete from system_settings where setting_key = 'delpro_treatment_pilot_job';

alter table delpro_sync_jobs add column next_attempt_at timestamptz;

-- 2. saving a treatment is the trigger
update system_settings set setting_value = 'auto' where setting_key = 'delpro_outbound_mode';
update system_settings set setting_value = '0' where setting_key = 'delpro_auto_delay_minutes';
update system_settings set setting_value = 'gateway' where setting_key = 'delpro_write_channel';

-- 3. the full treatment for one job (data problems only)
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
           'expected_uom', fn_delpro_uom(x.unit)) order by p.name), '[]'::jsonb)
  into v_meds
  from (select ui.product_id, ui.unit, sum(ui.qty) as qty, max(ui.administration_route::text) as route
        from usage_items ui where ui.treatment_id = t.id group by ui.product_id, ui.unit) x
  join products p on p.id = x.product_id
  left join delpro_catalog_links l on l.retired_at is null and l.product_id = x.product_id
  left join delpro_catalog_items di on di.object_type = 'Drug' and di.delpro_key = l.delpro_key and di.removed_at is null
  left join delpro_catalog_items dp on dp.object_type = 'DrugParameters' and dp.delpro_key = di.fields->>'default_parameters' and dp.removed_at is null;

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
    'job', jsonb_build_object('id', j.id, 'status', j.status, 'attempts', j.attempts, 'requires_verification', j.requires_verification),
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
  v_plan jsonb;
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
      and (next_attempt_at is null or next_attempt_at <= now())  -- 0044: backoff after a transient failure
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
      -- 0044: the whole treatment (medicines, codes, parameters, dose, course); data problems fail
      -- THIS job visibly and the loop moves on — one bad treatment never blocks the others
      v_plan := fn_delpro_treatment_plan(v_job.id);
      if jsonb_array_length(v_plan->'problems') > 0 then
        update delpro_sync_jobs
        set status = 'error', completed_at = now(),
            error = (select string_agg(x->>'message', '; ') from jsonb_array_elements(v_plan->'problems') x),
            error_details = jsonb_build_object('problems', v_plan->'problems')
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
              then jsonb_build_object('gateway', v_entry, 'verify_before_write', true, 'treatment_plan', v_plan || jsonb_build_object('gateway_event', v_entry))
              else '{}'::jsonb end;
  end loop;
end;
$$;

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
      -- 0044: a gateway treatment is synchronized only with its medicine records verified
      v_verified := v_verified and coalesce((v_actual->'medication'->>'verified')::boolean, false);
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
    -- 0044: transient failures (and unknown outcomes — the next attempt looks the GVET:<id>
    -- marker up before writing) go back to the queue with backoff; others are Failed.
    update delpro_sync_jobs
    set status = case when (coalesce((p_body->>'retryable')::boolean, false) or coalesce((p_body->>'outcome_unknown')::boolean, false))
                           and attempts + 1 < 8 then 'approved' else 'error' end,
        next_attempt_at = case when (coalesce((p_body->>'retryable')::boolean, false) or coalesce((p_body->>'outcome_unknown')::boolean, false))
                                    and attempts + 1 < 8
                               then now() + make_interval(secs => least(15 * power(2, attempts), 3600)::int) end,
        worker_id = null,
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

alter table delpro_sync_jobs drop column pilot;

revoke all on function fn_delpro_treatment_plan(uuid) from public, anon, authenticated;
grant execute on function fn_delpro_treatment_plan(uuid) to service_role;
revoke all on function delpro_claim_next_job(text, text) from public, anon, authenticated;
grant execute on function delpro_claim_next_job(text, text) to service_role;
revoke all on function delpro_report_job_result(jsonb) from public, anon, authenticated;
grant execute on function delpro_report_job_result(jsonb) to service_role;

notify pgrst, 'reload schema';

-- 0045_delpro_admin_approval_gate.sql
-- Temporary administrator approval for GVET -> DelPro treatments (farm's decision, 2026-10).
--
--   * system_settings.delpro_admin_approval_required ('true' now): every job queued
--     while it is on is stamped delpro_sync_jobs.admin_approval_required = true;
--   * delpro_claim_next_job never auto-claims a stamped job — it goes to the worker
--     only after an administrator pressed "Siųsti į DelPro" (fn_delpro_approve_job:
--     status 'approved', approved_by, approved_at, audit; idempotent as in 0033);
--   * switching the setting to 'false' lets NEW treatments send automatically
--     (auto mode, 0044); jobs stamped earlier keep the stamp, so they are never
--     released silently;
--   * every job still waiting today is stamped here; approved / finished jobs are untouched.
-- The worker still needs OUTBOUND_MODE=gateway + a verified treatment-model.json, and
-- 'success' still requires the medicine records read back (0044). The transfer state
-- now also returns what the worker reported (outbound_mode, treatment_model_ready) so an
-- approved treatment the farm PC cannot write shows as blocked, not as sent.

insert into system_settings (setting_key, setting_value, description) values
  ('delpro_admin_approval_required', 'true',
   'Laikinai: kiekvieną gydymą į DelPro siunčia administratorius („Siųsti į DelPro“). false = nauji gydymai siunčiami automatiškai; anksčiau laukę lieka laukti administratoriaus.')
on conflict (setting_key) do nothing;

alter table delpro_sync_jobs add column admin_approval_required boolean not null default false;

-- jobs waiting right now need an administrator; nothing is approved by this migration
update delpro_sync_jobs set admin_approval_required = true where status = 'pending_approval';

create or replace function fn_delpro_admin_gate_on()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select setting_value from system_settings where setting_key = 'delpro_admin_approval_required'), 'false') = 'true';
$$;

create or replace function fn_delpro_stamp_admin_gate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.admin_approval_required := new.admin_approval_required or fn_delpro_admin_gate_on();
  return new;
end;
$$;

create trigger trg_delpro_sync_jobs_admin_gate
  before insert on delpro_sync_jobs
  for each row execute function fn_delpro_stamp_admin_gate();

-- approval: administrator only for a stamped job (rest unchanged from 0033)
create or replace function fn_delpro_approve_job(p_job_id uuid, p_reapprove boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j delpro_sync_jobs%rowtype;
  v_problems jsonb;
  v_payload jsonb;
  v_outcome text;
  v_stale boolean;
begin
  if not fn_can_approve_delpro() then
    raise exception 'Neturite teisės tvirtinti gydymo perdavimo į DelPro.';
  end if;

  select * into j from delpro_sync_jobs where id = p_job_id for update;
  if not found then
    raise exception 'DelPro užduotis nerasta.';
  end if;

  -- 0045: while the job carries the temporary gate, only an administrator releases it
  if j.admin_approval_required and not fn_is_admin() then
    raise exception 'Šį gydymą į DelPro siųsti gali tik administratorius.';
  end if;

  if j.status = 'processing' then
    return jsonb_build_object('ok', true, 'outcome', 'already_processing', 'status', j.status, 'job_id', j.id,
      'problems', '[]'::jsonb, 'message', 'Įrašas jau perduodamas į DelPro.');
  elsif j.status = 'success' then
    return jsonb_build_object('ok', true, 'outcome', 'already_success', 'status', j.status, 'job_id', j.id,
      'problems', '[]'::jsonb, 'message', 'Įrašas jau perduotas į DelPro.');
  elsif j.status in ('error', 'verification_failed') then
    return jsonb_build_object('ok', false, 'outcome', 'needs_retry', 'status', j.status, 'job_id', j.id,
      'problems', '[]'::jsonb, 'message', 'Ankstesnis perdavimas nepavyko — kartoti gali administratorius (DelPro integracija → Klaidos).');
  elsif j.status = 'rejected' then
    return jsonb_build_object('ok', false, 'outcome', 'rejected', 'status', j.status, 'job_id', j.id,
      'problems', '[]'::jsonb, 'message', 'Perdavimas buvo atmestas.');
  elsif j.status = 'approved' then
    v_stale := fn_delpro_payload_stale(j.treatment_id, j.approved_payload);
    if not v_stale then
      return jsonb_build_object('ok', true, 'outcome', 'already_approved', 'status', j.status, 'job_id', j.id,
        'problems', '[]'::jsonb, 'message', 'Perdavimas jau patvirtintas — įrašas laukia perdavimo į DelPro.');
    end if;
    if not p_reapprove then
      return jsonb_build_object('ok', false, 'outcome', 'stale', 'status', j.status, 'job_id', j.id,
        'problems', '[]'::jsonb,
        'message', 'Gydymo ar susiejimų duomenys pasikeitė po patvirtinimo. Peržiūrėkite ir patvirtinkite iš naujo.');
    end if;
  end if;

  -- pending_approval, or approved + stale + explicit re-approval
  v_problems := fn_delpro_transfer_problems(j.treatment_id);
  if jsonb_array_length(v_problems) > 0 then
    return jsonb_build_object('ok', false, 'outcome', 'blocked', 'status', j.status, 'job_id', j.id,
      'problems', v_problems, 'message', v_problems->0->>'message');
  end if;

  v_outcome := case when j.status = 'approved' then 'reapproved' else 'approved' end;
  v_payload := fn_build_delpro_payload(j.treatment_id) || jsonb_build_object('sync_id', j.id);

  update delpro_sync_jobs
  set status = 'approved',
      approved_payload = v_payload,
      approved_by = auth.uid(),
      approved_at = now(),
      auto_approved = false,
      error = null,
      error_details = null
  where id = j.id;

  insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
  values (
    auth.uid(),
    case when v_outcome = 'reapproved' then 'delpro_transfer_reapproved' else 'delpro_transfer_approved' end,
    'delpro_sync_jobs',
    j.id,
    case when j.approved_payload is not null then jsonb_build_object('status', j.status, 'approved_payload', j.approved_payload) end,
    jsonb_build_object('status', 'approved', 'treatment_id', j.treatment_id, 'approved_payload', v_payload)
  );

  return jsonb_build_object('ok', true, 'outcome', v_outcome, 'status', 'approved', 'job_id', j.id,
    'problems', '[]'::jsonb, 'message', 'Gydymo perdavimas patvirtintas. Įrašas laukia perdavimo į DelPro.');
end;
$$;

revoke all on function fn_delpro_approve_job(uuid, boolean) from public, anon, authenticated;

-- claim: a stamped job is handed out only once approved (rest unchanged from 0044)
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
           or (v_mode = 'auto' and status = 'pending_approval' and not admin_approval_required  -- 0045
               and created_at < now() - make_interval(mins => coalesce(v_delay, 10))))
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

revoke all on function delpro_claim_next_job(text, text) from public, anon, authenticated;
grant execute on function delpro_claim_next_job(text, text) to service_role;

-- read model: admin-only button while stamped; worker readiness for the blocked status
create or replace function delpro_treatment_transfer_state(p_treatment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t treatments%rowtype;
  j delpro_sync_jobs%rowtype;
  v_mode text;
  v_seen timestamptz;
  v_preview jsonb;
  v_approver text;
  v_info jsonb;
begin
  if not fn_is_authenticated_active() then
    raise exception 'Reikia prisijungti.';
  end if;

  select * into t from treatments where id = p_treatment_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  select * into j from delpro_sync_jobs where treatment_id = p_treatment_id;
  select coalesce(setting_value, 'approval') into v_mode from system_settings where setting_key = 'delpro_outbound_mode';
  select nullif(setting_value, '')::timestamptz into v_seen from system_settings where setting_key = 'delpro_worker_last_seen_at';
  begin
    select nullif(setting_value, '')::jsonb into v_info from system_settings where setting_key = 'delpro_worker_info';
  exception when others then
    v_info := null;
  end;
  v_preview := fn_build_delpro_payload(p_treatment_id);
  if j.approved_by is not null then
    select coalesce(full_name, email) into v_approver from users where id = j.approved_by;
  end if;

  return jsonb_build_object(
    'found', true,
    'procedure_type', t.procedure_type,
    'mode', coalesce(v_mode, 'approval'),
    'eligible', t.procedure_type = 'gydymas' and coalesce(v_mode, 'approval') <> 'off',
    'can_approve', fn_can_approve_delpro() and (not coalesce(j.admin_approval_required, fn_delpro_admin_gate_on()) or fn_is_admin()),
    'is_admin', fn_is_admin(),
    'job', case when j.id is null then null else jsonb_build_object(
      'id', j.id,
      'status', j.status,
      'approved_at', j.approved_at,
      'approved_by_name', v_approver,
      'auto_approved', j.auto_approved,
      'started_at', j.started_at,
      'completed_at', j.completed_at,
      'attempts', j.attempts,
      'verified', j.verified,
      'error', j.error,
      'rejection_reason', j.rejection_reason,
      'admin_approval_required', j.admin_approval_required,
      'next_attempt_at', j.next_attempt_at
    ) end,
    'payload', coalesce(j.approved_payload, v_preview),
    'frozen', j.approved_payload is not null,
    'preview', v_preview,
    'stale', fn_delpro_payload_stale(p_treatment_id, j.approved_payload),
    'problems', fn_delpro_transfer_problems(p_treatment_id),
    'worker', jsonb_build_object(
      'last_seen_at', v_seen,
      'online', v_seen is not null and v_seen > now() - interval '15 minutes',
      -- 0045: what the farm PC reported in its last heartbeat (null = not reported)
      'outbound_mode', v_info->>'outbound_mode',
      'treatment_model_ready', (v_info->>'treatment_model_ready')::boolean
    )
  );
end;
$$;

revoke all on function delpro_treatment_transfer_state(uuid) from public, anon;
grant execute on function delpro_treatment_transfer_state(uuid) to authenticated;
revoke all on function fn_delpro_stamp_admin_gate() from public, anon, authenticated;
revoke all on function fn_delpro_admin_gate_on() from public, anon;
grant execute on function fn_delpro_admin_gate_on() to authenticated;

notify pgrst, 'reload schema';

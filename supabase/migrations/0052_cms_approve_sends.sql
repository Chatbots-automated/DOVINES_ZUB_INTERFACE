-- 0052: CMS atskyrimai — "Patvirtinti" is the only step (farm's decision 2026-11-03).
--
-- Before: an admin approval (with a "Suprantu" confirmation), PLUS a verified mode, PLUS the operator's destination note, PLUS the
-- master switch on (or a single released job + a manual command on the PC). Now an admin's approval releases the job to the worker.
--
-- Still enforced (unchanged):
--   * approval is admin-only and refuses every job with a problem (fn_cms_job_problems: Sort Once, a chosen SortArea, missing
--     dates/sessions, no ObjectGuid, an existing DelPro SortCow without a decision, …) — so neither can ever be approved;
--   * the worker re-reads the animal in DelPro before writing (identity, its one milk setting, existing SortCow) and fails closed;
--   * cms_outbound_enabled remains the EMERGENCY STOP (any staff can switch it off). It is switched on here once; off = nothing is sent;
--   * worker-side CMS_OUTBOUND_MODE=gateway on the farm PC;
--   * a started-but-unverified write is needs_review and never re-sent.
-- No longer required: cms_verified_modes, cms_destination_verified, cms_approve_jobs' p_confirm. The settings and their functions stay
-- (nothing dropped); cms_single_job_id still works for `npm run cms:write-one` but is cleared so it can't hold up routine sending.

update system_settings set setting_value = 'true' where setting_key = 'cms_outbound_enabled';
update system_settings set setting_value = '' where setting_key = 'cms_single_job_id';

create or replace function cms_claim_next_job(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  v_worker text := nullif(btrim(p_body->>'worker_id'), '');
  v_want uuid := nullif(p_body->>'job_id', '')::uuid;
  v_single uuid;
  j cms_separation_jobs%rowtype;
begin
  if v_worker is null then
    raise exception 'worker_id privalomas.';
  end if;

  for j in select * from cms_separation_jobs where status = 'processing' and claimed_at < now() - interval '10 minutes' for update skip locked loop
    if j.write_started_at is not null then
      update cms_separation_jobs set status = 'needs_review',
        last_error = 'Darbininkas nutrūko po įrašymo pradžios — patikrinkite DelPro prieš kartojant.' where id = j.id;
      perform fn_cms_log(j.id, j.batch_id, 'stale_needs_review', null, v_worker);
    else
      update cms_separation_jobs set status = 'approved', claimed_by = null, claimed_at = null where id = j.id;
      perform fn_cms_log(j.id, j.batch_id, 'stale_released', null, v_worker);
    end if;
  end loop;

  -- emergency stop
  if not fn_cms_outbound_enabled() then
    return null;
  end if;

  select nullif(setting_value, '')::uuid into v_single from system_settings where setting_key = 'cms_single_job_id';
  if v_single is not null then
    if v_want is distinct from v_single then
      return null;
    end if;
    select * into j from cms_separation_jobs where id = v_single and status = 'approved' for update skip locked;
  elsif v_want is not null then
    -- a worker naming a job (cms:write-one) gets that approved job only
    select * into j from cms_separation_jobs where id = v_want and status = 'approved' for update skip locked;
  else
    -- 0052: approved = released. Only the two supported modes, never a SortArea (approval already refuses both; belt and braces).
    select * into j from cms_separation_jobs
    where status = 'approved' and (next_attempt_at is null or next_attempt_at <= now())
      and approved_snapshot->>'mode' in ('period', 'ongoing')
      and nullif(approved_snapshot->>'sort_area_key', '') is null
    order by approved_at, created_at
    limit 1
    for update skip locked;
  end if;
  if j.id is null or j.approved_snapshot is null then
    return null;
  end if;

  update cms_separation_jobs
  set status = 'processing', claimed_by = v_worker, claimed_at = now(), attempts = attempts + 1, last_error = null
  where id = j.id returning * into j;
  perform fn_cms_log(j.id, j.batch_id, 'claimed', jsonb_build_object('attempt', j.attempts), v_worker);
  return jsonb_build_object('job_id', j.id, 'attempts', j.attempts, 'adopt_key', j.adopt_key,
    'snapshot', j.approved_snapshot, 'single', v_single is not null);
end;
$$;

-- Same as 0048 without the p_confirm requirement (the parameter stays so existing callers keep working).
create or replace function cms_approve_jobs(p_job_ids uuid[], p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j cms_separation_jobs%rowtype;
  v_problems jsonb;
  v_ok integer := 0;
  v_same integer := 0;
  v_refused jsonb := '[]'::jsonb;
begin
  perform fn_cms_require_admin();
  for j in select * from cms_separation_jobs where id = any (p_job_ids) order by created_at for update loop
    if j.status in ('approved', 'processing', 'success') then
      v_same := v_same + 1;
      continue;
    end if;
    if j.status <> 'pending_approval' then
      v_refused := v_refused || jsonb_build_object('job_id', j.id, 'reason', 'Būsena ' || j.status || ' — tvirtinti negalima.');
      continue;
    end if;
    v_problems := fn_cms_job_problems(j);
    if jsonb_array_length(v_problems) > 0 then
      v_refused := v_refused || jsonb_build_object('job_id', j.id,
        'reason', (select string_agg(p->>'message', ' ') from jsonb_array_elements(v_problems) p));
      continue;
    end if;
    update cms_separation_jobs
    set status = 'approved', approved_by = auth.uid(), approved_at = now(), approved_snapshot = fn_cms_snapshot(j),
        animal_guid = (select delpro_object_guid from animals where id = j.animal_id), last_error = null, next_attempt_at = null
    where id = j.id;
    perform fn_cms_log(j.id, j.batch_id, 'approved', fn_cms_snapshot(j));
    insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
    values (auth.uid(), 'cms_approve', 'cms_separation_jobs', j.id, fn_cms_snapshot(j));
    v_ok := v_ok + 1;
  end loop;
  return jsonb_build_object('ok', true, 'approved', v_ok, 'unchanged', v_same, 'refused', v_refused);
end;
$$;

revoke all on function cms_claim_next_job(jsonb) from public, anon, authenticated;
grant execute on function cms_claim_next_job(jsonb) to service_role;
revoke all on function cms_approve_jobs(uuid[], boolean) from public, anon;
grant execute on function cms_approve_jobs(uuid[], boolean) to authenticated;

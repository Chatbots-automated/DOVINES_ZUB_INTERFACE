-- 0065_delpro_reject_many.sql
-- DelPro screen cleanup (farm's request 2026-11-05): an admin can reject a treatment transfer that
-- FAILED (status 'error', e.g. a test animal DelPro doesn't know — it can never succeed) as well as one
-- that waits, and reject many at once. 'verification_failed' is NOT rejectable: DelPro may already hold
-- that record, it has to be checked first. Rejecting never touches the treatment itself.
-- delpro_reject_job = 0033 body with the wider status filter.

create or replace function delpro_reject_job(p_job_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali atmesti DelPro siuntimą.';
  end if;

  update delpro_sync_jobs
  set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(), rejection_reason = nullif(p_reason, '')
  where id = p_job_id and status in ('pending_approval', 'error');
  get diagnostics v_n = row_count;

  if v_n > 0 then
    insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
    values (auth.uid(), 'delpro_transfer_rejected', 'delpro_sync_jobs', p_job_id, jsonb_build_object('reason', nullif(p_reason, '')));
  end if;
end;
$$;

grant execute on function delpro_reject_job(uuid, text) to authenticated;

-- many at once, one transaction; returns how many were rejected (others were in another state)
create or replace function delpro_reject_jobs(p_job_ids uuid[], p_reason text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_before text;
  v_n integer := 0;
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali atmesti DelPro siuntimą.';
  end if;
  foreach v_id in array coalesce(p_job_ids, '{}') loop
    select status into v_before from delpro_sync_jobs where id = v_id for update;
    continue when v_before is null or v_before not in ('pending_approval', 'error');
    perform delpro_reject_job(v_id, p_reason);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function delpro_reject_jobs(uuid[], text) from public, anon;
grant execute on function delpro_reject_jobs(uuid[], text) to authenticated;

notify pgrst, 'reload schema';

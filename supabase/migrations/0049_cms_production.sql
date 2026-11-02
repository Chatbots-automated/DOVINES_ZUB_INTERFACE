-- 0049: CMS atskyrimai — production readiness (after the verified single write, job 443b4846…, 2026-11-02).
--
--  * cms_outbound_enabled: GVET's master switch for CMS writes. Off = no job is handed out at all (the emergency stop; any active
--    staff member may switch it OFF, only an admin ON). Independent of treatments (delpro_* settings untouched).
--  * cms_destination_verified: the farm operator confirmed where SortCow cows physically go. Routine (non-single) sending also needs
--    it — GVET still never chooses a sort area itself.
--  * cms_live_upload explains every SortCow row it could not tie to a GVET animal (reason counts) and keeps the worker's read stats.
--  * vw_cms_separation_jobs shows the DelPro record each job created as last read (manually disabled in DelPro = visible, and
--    GVET never re-creates it: a finished job is never handed out again).
-- No data is changed; both switches start OFF.

insert into system_settings (setting_key, setting_value, description) values
  ('cms_outbound_enabled', 'false', 'GVET leidžia siųsti CMS atskyrimus į DelPro (avarinis stabdymas = false)'),
  ('cms_destination_verified', '', 'Ūkio operatorius patikrino fizinę atskyrimo vietą (JSON: kas, kada, pastaba)')
on conflict (setting_key) do nothing;

create or replace function fn_cms_outbound_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select setting_value = 'true' from system_settings where setting_key = 'cms_outbound_enabled'), false);
$$;

create or replace function fn_cms_destination_verified()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select nullif(setting_value, '') is not null from system_settings where setting_key = 'cms_destination_verified'), false);
$$;

-- Enabling: admin + explicit confirmation. Disabling (emergency stop): any active staff member, always allowed.
create or replace function cms_set_outbound_enabled(p_enabled boolean, p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_enabled then
    perform fn_cms_require_admin();
    if not coalesce(p_confirm, false) then
      raise exception 'Patvirtinkite, kad CMS atskyrimai gali būti siunčiami į DelPro.';
    end if;
  elsif not fn_is_active_staff() then
    raise exception 'Neturite teisės.';
  end if;
  update system_settings set setting_value = case when p_enabled then 'true' else 'false' end where setting_key = 'cms_outbound_enabled';
  insert into user_audit_logs (user_id, action, table_name, new_data)
  values (auth.uid(), case when p_enabled then 'cms_outbound_enable' else 'cms_outbound_stop' end, 'system_settings', jsonb_build_object('enabled', p_enabled));
  perform fn_cms_log(null, null, case when p_enabled then 'outbound_enabled' else 'outbound_stopped' end, null);
  return jsonb_build_object('ok', true, 'enabled', p_enabled,
    'message', case when p_enabled then 'CMS siuntimas įjungtas.' else 'CMS siuntimas sustabdytas. Jau DelPro sukurti atskyrimai lieka — juos išjunkite DelPro.' end);
end;
$$;

create or replace function cms_set_destination_verified(p_verified boolean, p_confirm boolean default false, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v text;
begin
  perform fn_cms_require_admin();
  if p_verified then
    if not coalesce(p_confirm, false) or nullif(btrim(coalesce(p_note, '')), '') is null then
      raise exception 'Aprašykite, kur karvė buvo nukreipta, ir patvirtinkite patikrinimą.';
    end if;
    v := jsonb_build_object('by', auth.uid(), 'by_name', (select full_name from users where id = auth.uid()), 'at', now(), 'note', btrim(p_note))::text;
  else
    v := '';
  end if;
  update system_settings set setting_value = v where setting_key = 'cms_destination_verified';
  insert into user_audit_logs (user_id, action, table_name, new_data)
  values (auth.uid(), 'cms_destination_verified', 'system_settings', jsonb_build_object('verified', p_verified, 'note', p_note));
  return jsonb_build_object('ok', true);
end;
$$;

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

  -- 0049: GVET's master switch (emergency stop) blocks every claim, the supervised single job included
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
    return null;
  else
    select * into j from cms_separation_jobs
    where status = 'approved' and (next_attempt_at is null or next_attempt_at <= now())
      and approved_snapshot->>'mode' = any (fn_cms_verified_modes())
      and fn_cms_destination_verified()
    order by approved_at, created_at
    limit 1
    for update skip locked;
  end if;
  if j.id is null then
    return null;
  end if;
  if j.approved_snapshot is null then
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


-- { complete, actions:[…], sort_areas:[…], errors:[], stats:{…}, worker_id }
-- Same upsert as 0048; additionally counts WHY a SortCow row has no GVET animal, and stores the worker's read stats.
create or replace function cms_live_upload(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  a jsonb;
  v_now timestamptz := now();
  v_n integer := 0;
  v_matched integer := 0;
  v_no_guid integer := 0;
  v_not_in_gvet integer := 0;
  v_inactive integer := 0;
  v_effective integer := 0;
  v_removed integer := 0;
  v_guid uuid;
  v_animal uuid;
  v_animal_active boolean;
  v_complete boolean := coalesce((p_body->>'complete')::boolean, false);
  v_res jsonb;
begin
  for a in select * from jsonb_array_elements(coalesce(p_body->'actions', '[]'::jsonb)) loop
    continue when nullif(a->>'key', '') is null;
    begin
      v_guid := nullif(a->>'animal_guid', '')::uuid;
    exception when invalid_text_representation then
      v_guid := null;
    end;
    v_animal := null;
    v_animal_active := null;
    if v_guid is null then
      v_no_guid := v_no_guid + 1;
    else
      select id, active into v_animal, v_animal_active from animals where delpro_object_guid = v_guid limit 1;
      if v_animal is null then
        v_not_in_gvet := v_not_in_gvet + 1;
      elsif not v_animal_active then
        v_inactive := v_inactive + 1;
      else
        v_matched := v_matched + 1;
        if (a->>'active')::boolean is true and (nullif(a->>'end_at', '') is null or (a->>'end_at')::timestamptz > v_now)
           and jsonb_array_length(coalesce(a->'sessions', '[]'::jsonb)) > 0 then
          v_effective := v_effective + 1;
        end if;
      end if;
    end if;
    insert into cms_live_action_settings (action_key, milk_setting_key, animal_guid, animal_id, action_type, active,
      start_at, end_at, sessions, last_updated_at, seen_at, removed_at)
    values (a->>'key', nullif(a->>'milk_setting_key', ''), v_guid, v_animal, coalesce(nullif(a->>'action_type', ''), '?'),
      nullif(a->>'active', '')::boolean, nullif(a->>'start_at', '')::timestamptz, nullif(a->>'end_at', '')::timestamptz,
      array(select (x)::smallint from jsonb_array_elements_text(coalesce(a->'sessions', '[]'::jsonb)) x),
      nullif(a->>'last_updated_at', '')::timestamptz, v_now, null)
    on conflict (action_key) do update set milk_setting_key = excluded.milk_setting_key, animal_guid = excluded.animal_guid,
      animal_id = excluded.animal_id, action_type = excluded.action_type, active = excluded.active, start_at = excluded.start_at,
      end_at = excluded.end_at, sessions = excluded.sessions, last_updated_at = excluded.last_updated_at,
      seen_at = v_now, removed_at = null;
    v_n := v_n + 1;
  end loop;

  -- never remove anything on an incomplete (or empty) scan
  if v_complete and v_n > 0 then
    update cms_live_action_settings set removed_at = v_now where seen_at < v_now and removed_at is null;
    get diagnostics v_removed = row_count;
  end if;

  for a in select * from jsonb_array_elements(coalesce(p_body->'sort_areas', '[]'::jsonb)) loop
    continue when nullif(a->>'key', '') is null;
    insert into cms_sort_areas (area_key, area_number, area_name, seen_at)
    values (a->>'key', nullif(a->>'number', ''), nullif(a->>'name', ''), v_now)
    on conflict (area_key) do update set area_number = excluded.area_number, area_name = excluded.area_name, seen_at = v_now;
  end loop;

  v_res := jsonb_build_object('finished_at', v_now, 'received', v_n, 'matched', v_matched, 'effective_active', v_effective,
    'unmatched_animals', v_no_guid + v_not_in_gvet + v_inactive,
    'unmatched_reasons', jsonb_build_object('milk_setting_without_animal', v_no_guid, 'animal_not_in_gvet', v_not_in_gvet,
      'animal_inactive_in_gvet', v_inactive),
    'removed', v_removed, 'complete', v_complete and v_n > 0, 'errors', coalesce(p_body->'errors', '[]'::jsonb),
    'stats', coalesce(p_body->'stats', '{}'::jsonb), 'worker_id', p_body->>'worker_id');
  update system_settings set setting_value = v_res::text where setting_key = 'cms_live_last_refresh';
  return v_res;
end;
$$;

create or replace function cms_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_info jsonb;
begin
  if not fn_is_authenticated_active() then
    raise exception 'Neprisijungta.';
  end if;
  select nullif(setting_value, '')::jsonb into v_info from system_settings where setting_key = 'delpro_worker_info';
  return jsonb_build_object(
    'verified_modes', to_jsonb(fn_cms_verified_modes()),
    'single_job_id', (select nullif(setting_value, '') from system_settings where setting_key = 'cms_single_job_id'),
    'live_last_refresh', (select nullif(setting_value, '')::jsonb from system_settings where setting_key = 'cms_live_last_refresh'),
    'live_requested_at', (select nullif(setting_value, '') from system_settings where setting_key = 'cms_live_refresh_requested_at'),
    'worker_cms_mode', v_info->>'cms_outbound_mode',
    'worker_seen_at', (select nullif(setting_value, '') from system_settings where setting_key = 'delpro_worker_last_seen_at'),
    -- 0049
    'outbound_enabled', fn_cms_outbound_enabled(),
    'destination_verified', (select nullif(setting_value, '')::jsonb from system_settings where setting_key = 'cms_destination_verified'),
    'worker', jsonb_build_object('version', v_info->>'version', 'host', v_info->>'host', 'has_cms', v_info ? 'cms_outbound_mode',
      'started_by', v_info->>'started_by', 'gateway_ok_at', v_info->>'gateway_ok_at', 'gateway_error', v_info->>'gateway_error',
      'cms_last_live', v_info->'cms_last_live', 'outbound_mode', v_info->>'outbound_mode', 'last_error', v_info->>'last_error'),
    'any_success', exists (select 1 from cms_separation_jobs where status = 'success' and verified_at is not null));
end;
$$;

create or replace view vw_cms_separation_jobs with (security_invoker = true) as
select j.id, j.batch_id, j.animal_id, j.status, j.mode, j.start_at, j.end_at, j.sessions, j.sort_area_key, j.note,
  j.existing_decision, j.is_override, j.requested_settings, j.effective_settings, j.approved_snapshot, j.animal_guid,
  j.milk_setting_key, j.action_key, j.adopt_key, j.created_by, j.created_at, j.updated_at, j.approved_by, j.approved_at,
  j.attempts, j.next_attempt_at, j.claimed_by, j.claimed_at, j.write_started_at, j.last_error, j.error_details,
  j.gateway_summary, j.readback, j.verified_at,
  a.tag_no, a.animal_no, a.name as animal_name, a.group_name, a.delpro_object_guid,
  b.status as batch_status, b.note as batch_note, b.created_at as batch_created_at,
  cu.full_name as created_by_name, au.full_name as approved_by_name,
  case when j.status in ('draft', 'pending_approval', 'approved') then fn_cms_job_problems(j) else '[]'::jsonb end as problems,
  -- 0049: the DelPro record this job created, as last read by the worker (a manual disable in DelPro shows here)
  l.active as delpro_active, l.start_at as delpro_start_at, l.end_at as delpro_end_at, l.sessions as delpro_sessions,
  l.seen_at as delpro_seen_at, l.removed_at as delpro_removed_at
from cms_separation_jobs j
join animals a on a.id = j.animal_id
join cms_separation_batches b on b.id = j.batch_id
left join users cu on cu.id = j.created_by
left join users au on au.id = j.approved_by
left join cms_live_action_settings l on l.action_key = j.action_key;

grant select on vw_cms_separation_jobs to authenticated;

revoke all on function cms_set_outbound_enabled(boolean, boolean), cms_set_destination_verified(boolean, boolean, text) from public, anon;
grant execute on function cms_set_outbound_enabled(boolean, boolean), cms_set_destination_verified(boolean, boolean, text) to authenticated;
revoke all on function cms_claim_next_job(jsonb), cms_live_upload(jsonb) from public, anon, authenticated;
grant execute on function cms_claim_next_job(jsonb), cms_live_upload(jsonb) to service_role;

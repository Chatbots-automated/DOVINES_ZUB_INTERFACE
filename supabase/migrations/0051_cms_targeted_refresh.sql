-- 0051: CMS atskyrimai — targeted DelPro state instead of the full-herd scan (worker 0.4.0).
--
-- Sending never depended on the full scan (cms_claim_next_job checks the master switch, admin approval, the mode gate and the
-- destination; the worker re-reads the ONE animal right before writing). What did depend on it was the "Aktyvūs atskyrimai"
-- mirror and the activation checklist. Now the worker reads only the animals GVET names:
--   cms_live_targets(jsonb)        -> animals in CMS batches / open jobs, GVET-written records, animals with a live SortCow in
--                                     the mirror, and animals someone asked for ("Atnaujinti iš DelPro"); never the whole herd
--                                     unless explicitly asked (all_linked).
--   cms_live_upload_animals(jsonb) -> per animal: Animal(GUID) -> its one AnimalMilkSetting -> its AnimalActionSettings. A read of
--                                     one animal is complete for that animal, so its SortCow rows that DelPro no longer has are
--                                     marked removed. A failed read changes nothing but the animal's check row (shown as stale).
-- cms_animal_live_checks = when each animal was last asked for / read, and whether that read worked. The old full scan
-- (cms_live_upload, `npm run cms:live`) still works as an optional diagnostic and blocks nothing.

create table cms_animal_live_checks (
  animal_id uuid primary key references animals (id) on delete cascade,
  requested_at timestamptz,
  checked_at timestamptz,
  ok boolean,
  error text,
  milk_setting_key text,
  sortcow_count integer,
  worker_id text
);
alter table cms_animal_live_checks enable row level security;
create policy cms_checks_select on cms_animal_live_checks for select to authenticated using (fn_is_authenticated_active());
grant select on cms_animal_live_checks to authenticated;
grant all on cms_animal_live_checks to service_role;

insert into system_settings (setting_key, setting_value, description) values
  ('cms_targeted_last_refresh', '', 'Paskutinis tikslinis CMS būsenos nuskaitymas iš DelPro (JSON)')
on conflict (setting_key) do nothing;

-- Staff: "Atnaujinti iš DelPro" for chosen animals (a row, the displayed page). Only DelPro-linked animals can be read.
create or replace function cms_request_animal_refresh(p_animal_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
  v_total integer := coalesce(array_length(p_animal_ids, 1), 0);
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės.';
  end if;
  if v_total > 500 then
    raise exception 'Per daug gyvulių vienu kartu (daugiausia 500).';
  end if;
  insert into cms_animal_live_checks (animal_id, requested_at)
  select a.id, now() from animals a where a.id = any (p_animal_ids) and a.delpro_object_guid is not null
  on conflict (animal_id) do update set requested_at = now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'requested', v_n, 'not_linked', v_total - v_n,
    'message', case when v_n = 0 then 'Nė vienas gyvulys nesusietas su DelPro — nėra ką nuskaityti.'
      else 'Paprašyta (' || v_n || ' gyv.) — ūkio kompiuteris nuskaitys per minutę.' end);
end;
$$;

-- "Atnaujinti iš DelPro" for the whole operational set (not the historical herd): same setting as 0048, new meaning.
create or replace function cms_request_live_refresh()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės.';
  end if;
  update system_settings set setting_value = now()::text where setting_key = 'cms_live_refresh_requested_at';
  return jsonb_build_object('ok', true, 'message', 'Paprašyta — ūkio kompiuteris nuskaitys GVET atskyrimų gyvulius per minutę.');
end;
$$;

-- Requested = asked after the last targeted round (or the last full scan, for an old worker).
create or replace function cms_live_requested(jsonb)
returns boolean
language sql
stable
security invoker
as $$
  select coalesce(nullif(r.setting_value, '')::timestamptz > greatest(
      coalesce(nullif(l.setting_value, '')::jsonb->>'finished_at', '-infinity')::timestamptz,
      coalesce((select nullif(setting_value, '')::jsonb->>'finished_at' from system_settings where setting_key = 'cms_targeted_last_refresh'), '-infinity')::timestamptz),
    false)
  from system_settings r, system_settings l
  where r.setting_key = 'cms_live_refresh_requested_at' and l.setting_key = 'cms_live_last_refresh';
$$;

-- { limit?: 50, due_minutes?: 60, checked_before?: ts, all_linked?: false, tags?: [orn] } -> [ { animal_id, animal_guid, orn, animal_no, reason } ]
-- Order: asked-for animals, then the operational set that is due, then (all_linked only) every linked animal.
-- checked_before (a forced round): due = not read since that moment, so a worker can page through the whole set.
-- tags: exactly these animals (`npm run cms:refresh -- --tag LT…`), due or not.
create or replace function cms_live_targets(jsonb)
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  p_body alias for $1;
  v_limit integer := least(greatest(coalesce((p_body->>'limit')::integer, 50), 1), 1000);
  v_due interval := make_interval(mins => greatest(coalesce((p_body->>'due_minutes')::integer, 60), 0));
  v_before timestamptz := nullif(p_body->>'checked_before', '')::timestamptz;
  v_all boolean := coalesce((p_body->>'all_linked')::boolean, false);
  v_tags text[] := array(select jsonb_array_elements_text(coalesce(p_body->'tags', '[]'::jsonb)));
begin
  if cardinality(v_tags) > 0 then
    return coalesce((
      select jsonb_agg(jsonb_build_object('animal_id', a.id, 'animal_guid', a.delpro_object_guid, 'orn', a.tag_no, 'animal_no', a.animal_no,
        'reason', 'tag') order by a.tag_no)
      from animals a
      where a.delpro_object_guid is not null and fn_orn_normalize(a.tag_no) = any (array(select fn_orn_normalize(t) from unnest(v_tags) t))), '[]'::jsonb);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('animal_id', t.id, 'animal_guid', t.delpro_object_guid, 'orn', t.tag_no, 'animal_no', t.animal_no,
      'reason', t.reason) order by t.prio, t.checked_at nulls first, t.tag_no)
    from (
      select a.id, a.delpro_object_guid, a.tag_no, a.animal_no, c.checked_at,
        case
          when c.requested_at is not null and c.requested_at > coalesce(c.checked_at, '-infinity') then 1
          when op.animal_id is not null then 2
          else 3
        end as prio,
        case
          when c.requested_at is not null and c.requested_at > coalesce(c.checked_at, '-infinity') then 'requested'
          when op.animal_id is not null then op.reason
          else 'linked'
        end as reason
      from animals a
      left join cms_animal_live_checks c on c.animal_id = a.id
      left join lateral (
        select x.animal_id, x.reason from (
          -- in a GVET batch (draft included: the editor shows DelPro's state) or an unfinished job
          select j.animal_id, 'gvet_job' as reason from cms_separation_jobs j
          where j.animal_id = a.id and j.status in ('draft', 'pending_approval', 'approved', 'processing', 'needs_review')
          union all
          -- written by GVET: until DelPro shows the record as finished (manually disabled, ended or gone)
          select j.animal_id, 'gvet_written' from cms_separation_jobs j
          left join cms_live_action_settings l on l.action_key = j.action_key
          where j.animal_id = a.id and j.status = 'success' and j.action_key is not null
            and (l.action_key is null or (l.removed_at is null and l.active is not false and (l.end_at is null or l.end_at > now() - interval '1 day')))
          union all
          -- DelPro's own separation already in the mirror and not finished
          select l.animal_id, 'delpro_active' from cms_live_action_settings l
          where l.animal_id = a.id and l.action_type = 'SortCow' and l.removed_at is null and l.active is not false
            and (l.end_at is null or l.end_at > now())
        ) x limit 1
      ) op on true
      where a.active and a.delpro_object_guid is not null
        and (
          (c.requested_at is not null and c.requested_at > coalesce(c.checked_at, '-infinity'))
          or ((op.animal_id is not null or v_all) and (c.checked_at is null or c.checked_at < coalesce(v_before, now() - v_due)))
        )
      order by prio, c.checked_at nulls first, a.tag_no
      limit v_limit
    ) t), '[]'::jsonb);
end;
$$;

-- { worker_id, round?: { started_at, targets, ok, failed }, results: [ { animal_id, animal_guid, ok, error?, milk_setting_key?,
--   actions: [ { key, milk_setting_key, action_type, active, start_at, end_at, sessions, last_updated_at } ] } ] }
-- ok = the worker read this animal completely (GUID verified, one or no milk setting, every action under it, none truncated).
create or replace function cms_live_upload_animals(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  r jsonb;
  a jsonb;
  v_now timestamptz := now();
  v_animal animals%rowtype;
  v_guid uuid;
  v_keys text[];
  v_ok integer := 0;
  v_failed integer := 0;
  v_mismatch integer := 0;
  v_upserted integer := 0;
  v_removed integer := 0;
  v_n integer;
  v_res jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_body->'results', '[]'::jsonb)) loop
    v_animal := null;
    begin
      v_guid := nullif(r->>'animal_guid', '')::uuid;
      select * into v_animal from animals where id = (r->>'animal_id')::uuid;
    exception when invalid_text_representation then
      v_guid := null;
    end;
    -- the answer must be for the animal GVET has under that GUID right now
    if v_animal.id is null or v_guid is null or v_animal.delpro_object_guid is distinct from v_guid then
      v_mismatch := v_mismatch + 1;
      continue;
    end if;

    if not coalesce((r->>'ok')::boolean, false) then
      v_failed := v_failed + 1;
      insert into cms_animal_live_checks (animal_id, checked_at, ok, error, worker_id)
      values (v_animal.id, v_now, false, left(coalesce(nullif(r->>'error', ''), 'Nenuskaityta.'), 500), p_body->>'worker_id')
      on conflict (animal_id) do update set checked_at = v_now, ok = false, error = excluded.error, worker_id = excluded.worker_id;
      continue;
    end if;

    v_keys := '{}';
    for a in select * from jsonb_array_elements(coalesce(r->'actions', '[]'::jsonb)) loop
      continue when nullif(a->>'key', '') is null or coalesce(a->>'action_type', '') <> 'SortCow';
      v_keys := v_keys || (a->>'key');
      insert into cms_live_action_settings (action_key, milk_setting_key, animal_guid, animal_id, action_type, active,
        start_at, end_at, sessions, last_updated_at, seen_at, removed_at)
      values (a->>'key', nullif(a->>'milk_setting_key', ''), v_guid, v_animal.id, 'SortCow',
        nullif(a->>'active', '')::boolean, nullif(a->>'start_at', '')::timestamptz, nullif(a->>'end_at', '')::timestamptz,
        array(select (x)::smallint from jsonb_array_elements_text(coalesce(a->'sessions', '[]'::jsonb)) x),
        nullif(a->>'last_updated_at', '')::timestamptz, v_now, null)
      on conflict (action_key) do update set milk_setting_key = excluded.milk_setting_key, animal_guid = excluded.animal_guid,
        animal_id = excluded.animal_id, action_type = excluded.action_type, active = excluded.active, start_at = excluded.start_at,
        end_at = excluded.end_at, sessions = excluded.sessions, last_updated_at = excluded.last_updated_at,
        seen_at = v_now, removed_at = null;
      v_upserted := v_upserted + 1;
    end loop;
    -- this animal was read completely: its SortCow rows DelPro no longer has are gone (never other animals' rows)
    update cms_live_action_settings set removed_at = v_now
    where animal_id = v_animal.id and removed_at is null and action_type = 'SortCow' and not (action_key = any (v_keys));
    get diagnostics v_n = row_count;
    v_removed := v_removed + v_n;

    insert into cms_animal_live_checks (animal_id, checked_at, ok, error, milk_setting_key, sortcow_count, worker_id)
    values (v_animal.id, v_now, true, null, nullif(r->>'milk_setting_key', ''), coalesce(array_length(v_keys, 1), 0), p_body->>'worker_id')
    on conflict (animal_id) do update set checked_at = v_now, ok = true, error = null, milk_setting_key = excluded.milk_setting_key,
      sortcow_count = excluded.sortcow_count, worker_id = excluded.worker_id;
    v_ok := v_ok + 1;
  end loop;

  v_res := jsonb_build_object('finished_at', v_now, 'ok', v_ok, 'failed', v_failed, 'mismatched', v_mismatch,
    'upserted', v_upserted, 'removed', v_removed, 'worker_id', p_body->>'worker_id');
  if p_body ? 'round' then
    update system_settings set setting_value = (v_res || jsonb_build_object('round', p_body->'round'))::text
    where setting_key = 'cms_targeted_last_refresh';
  end if;
  return v_res;
end;
$$;

-- 0049's cms_status + the targeted refresh state.
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
    'outbound_enabled', fn_cms_outbound_enabled(),
    'destination_verified', (select nullif(setting_value, '')::jsonb from system_settings where setting_key = 'cms_destination_verified'),
    'worker', jsonb_build_object('version', v_info->>'version', 'host', v_info->>'host', 'has_cms', v_info ? 'cms_outbound_mode',
      'started_by', v_info->>'started_by', 'gateway_ok_at', v_info->>'gateway_ok_at', 'gateway_error', v_info->>'gateway_error',
      'cms_last_live', v_info->'cms_last_live', 'outbound_mode', v_info->>'outbound_mode', 'last_error', v_info->>'last_error',
      'cms_targeted', v_info ? 'cms_refresh_interval_min'),
    'any_success', exists (select 1 from cms_separation_jobs where status = 'success' and verified_at is not null),
    -- 0051
    'targeted_last_refresh', (select nullif(setting_value, '')::jsonb from system_settings where setting_key = 'cms_targeted_last_refresh'),
    'pending_animal_requests', (select count(*) from cms_animal_live_checks where requested_at > coalesce(checked_at, '-infinity')));
end;
$$;

revoke all on function cms_request_animal_refresh(uuid[]) from public, anon;
grant execute on function cms_request_animal_refresh(uuid[]) to authenticated;
revoke all on function cms_live_targets(jsonb), cms_live_upload_animals(jsonb), cms_live_requested(jsonb) from public, anon, authenticated;
grant execute on function cms_live_targets(jsonb), cms_live_upload_animals(jsonb), cms_live_requested(jsonb) to service_role;

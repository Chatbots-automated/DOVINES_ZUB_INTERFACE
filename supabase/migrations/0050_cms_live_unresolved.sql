-- 0050. CMS live read (worker 0.3.0): GetData AnimalMilkSetting [Key, Animal] fails above ~1000 rows on the farm
-- (System.NullReferenceException), so the worker now reads the keys alone and resolves Key -> Animal in small reads.
-- cms_live_upload learns why a SortCow row has no animal:
--   * actions[].animal_ref = resolved | no_animal | invalid | absent  (the milk setting answered; counted per reason)
--   * actions_unresolved[]  = rows whose milk setting could NOT be read (Gateway error / ambiguous). Their DelPro state
--     (active, dates, sessions) is updated, but the animal GVET already had for the row is KEPT — an unreadable
--     reference never erases a link. A worker sends such rows only with complete=false, so nothing is removed either.
-- A 0.2.0 worker (no animal_ref, no actions_unresolved) is handled exactly as in 0049.
-- Also stored: the worker's warnings and the first unresolved keys with their Gateway error.

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
  v_absent integer := 0;
  v_invalid integer := 0;
  v_unresolved integer := 0;
  v_not_in_gvet integer := 0;
  v_inactive integer := 0;
  v_effective integer := 0;
  v_removed integer := 0;
  v_guid uuid;
  v_animal uuid;
  v_animal_active boolean;
  v_keep boolean;
  v_complete boolean := coalesce((p_body->>'complete')::boolean, false);
  v_res jsonb;
begin
  for a, v_keep in
    select x, false from jsonb_array_elements(coalesce(p_body->'actions', '[]'::jsonb)) x
    union all
    select x, true from jsonb_array_elements(coalesce(p_body->'actions_unresolved', '[]'::jsonb)) x
  loop
    continue when nullif(a->>'key', '') is null;
    v_animal := null;
    v_animal_active := null;
    v_guid := null;
    if v_keep then
      v_unresolved := v_unresolved + 1;
    else
      begin
        v_guid := nullif(a->>'animal_guid', '')::uuid;
      exception when invalid_text_representation then
        v_guid := null;
      end;
      if v_guid is null then
        case a->>'animal_ref'
          when 'absent' then v_absent := v_absent + 1;
          when 'invalid' then v_invalid := v_invalid + 1;
          else v_no_guid := v_no_guid + 1;
        end case;
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
    end if;
    insert into cms_live_action_settings as l (action_key, milk_setting_key, animal_guid, animal_id, action_type, active,
      start_at, end_at, sessions, last_updated_at, seen_at, removed_at)
    values (a->>'key', nullif(a->>'milk_setting_key', ''), v_guid, v_animal, coalesce(nullif(a->>'action_type', ''), '?'),
      nullif(a->>'active', '')::boolean, nullif(a->>'start_at', '')::timestamptz, nullif(a->>'end_at', '')::timestamptz,
      array(select (x)::smallint from jsonb_array_elements_text(coalesce(a->'sessions', '[]'::jsonb)) x),
      nullif(a->>'last_updated_at', '')::timestamptz, v_now, null)
    on conflict (action_key) do update set milk_setting_key = excluded.milk_setting_key,
      animal_guid = case when v_keep then l.animal_guid else excluded.animal_guid end,
      animal_id = case when v_keep then l.animal_id else excluded.animal_id end,
      action_type = excluded.action_type, active = excluded.active, start_at = excluded.start_at,
      end_at = excluded.end_at, sessions = excluded.sessions, last_updated_at = excluded.last_updated_at,
      seen_at = v_now, removed_at = null;
    v_n := v_n + 1;
  end loop;

  -- never remove anything on an incomplete (or empty) scan, nor while any row's animal was unreadable
  v_complete := v_complete and v_n > 0 and v_unresolved = 0;
  if v_complete then
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
    'unmatched_animals', v_no_guid + v_absent + v_invalid + v_unresolved + v_not_in_gvet + v_inactive,
    'unmatched_reasons', jsonb_build_object('milk_setting_without_animal', v_no_guid, 'milk_setting_absent', v_absent,
      'animal_reference_invalid', v_invalid, 'milk_setting_unresolved', v_unresolved,
      'animal_not_in_gvet', v_not_in_gvet, 'animal_inactive_in_gvet', v_inactive),
    'removed', v_removed, 'complete', v_complete, 'errors', coalesce(p_body->'errors', '[]'::jsonb),
    'warnings', coalesce(p_body->'warnings', '[]'::jsonb),
    'unresolved', coalesce(p_body->'unresolved', '[]'::jsonb),
    'stats', coalesce(p_body->'stats', '{}'::jsonb), 'worker_id', p_body->>'worker_id');
  update system_settings set setting_value = v_res::text where setting_key = 'cms_live_last_refresh';
  return v_res;
end;
$$;

revoke all on function cms_live_upload(jsonb) from public, anon, authenticated;
grant execute on function cms_live_upload(jsonb) to service_role;

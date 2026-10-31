-- 0047: DelPro Animal.ObjectGuid -> animals.delpro_object_guid also by ORN.
--
-- 0036 matched only on the short DelPro herd number (animals.animal_no). Animals that came
-- from VIC or the daily Excel reports have no animal_no, so they never got an ObjectGuid and
-- their treatments could not be sent ("Nėra DelPro ObjectGuid").
--
-- The worker now also sends the animal's official registration number from DelPro ("orn").
-- Matching, per DelPro animal:
--   * ORN: exact fn_orn_normalize(tag_no) = fn_orn_normalize(orn), active GVET animals only.
--   * Number: exact animal_no, as before.
--   * ORN and Number pointing at two different GVET animals -> conflict, nothing written.
--   * Two active GVET animals with the ORN, or one ORN reported with several GUIDs -> skipped.
--   * A herd number reported with several GUIDs (DelPro reuses numbers) is ignored; the ORN
--     can still match.
-- ORN and the short Number are never compared with each other. A different GUID already set
-- is never overwritten; a GUID already held by another animal is never reused.

create or replace function delpro_ingest_animal_ids(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  elem jsonb;
  v_guid uuid;
  v_no text;
  v_orn text;
  v_n integer;
  v_id uuid;
  v_id_orn uuid;
  v_id_no uuid;
  v_amb_orn boolean;
  v_amb_no boolean;
  v_by_orn boolean;
  v_current uuid;
  v_received integer := 0;
  v_matched integer := 0;
  v_matched_by_orn integer := 0;
  v_unchanged integer := 0;
  v_unmatched integer := 0;
  v_ambiguous integer := 0;
  v_conflicts jsonb := '[]'::jsonb;
  v_dup_numbers text[];
  v_dup_orns text[];
  v_result jsonb;
begin
  if jsonb_typeof(p_body->'animals') is distinct from 'array' then
    raise exception 'Laukiamas gyvulių sąrašas (animals).';
  end if;

  select coalesce(array_agg(n), '{}') into v_dup_numbers
  from (
    select fn_delpro_text(e->>'number') as n
    from jsonb_array_elements(p_body->'animals') e
    where fn_delpro_text(e->>'number') is not null
    group by 1
    having count(distinct lower(btrim(e->>'object_guid'))) > 1
  ) d;

  select coalesce(array_agg(o), '{}') into v_dup_orns
  from (
    select fn_orn_normalize(e->>'orn') as o
    from jsonb_array_elements(p_body->'animals') e
    where fn_orn_normalize(e->>'orn') is not null
    group by 1
    having count(distinct lower(btrim(e->>'object_guid'))) > 1
  ) d;

  for elem in select * from jsonb_array_elements(p_body->'animals')
  loop
    v_received := v_received + 1;
    v_no := fn_delpro_text(elem->>'number');
    v_orn := fn_orn_normalize(elem->>'orn');
    begin
      v_guid := nullif(btrim(elem->>'object_guid'), '')::uuid;
    exception when invalid_text_representation then
      v_guid := null;
    end;
    if v_guid is null or (v_no is null and v_orn is null) then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;

    v_id_orn := null; v_amb_orn := false;
    if v_orn is not null then
      if v_orn = any (v_dup_orns) then
        v_amb_orn := true;
      else
        select count(*), (array_agg(id))[1] into v_n, v_id_orn
        from animals where active and fn_orn_normalize(tag_no) = v_orn;
        if v_n > 1 then v_amb_orn := true; v_id_orn := null; end if;
      end if;
    end if;

    v_id_no := null; v_amb_no := false;
    if v_no is not null then
      if v_no = any (v_dup_numbers) then
        v_amb_no := true;
      else
        select count(*), (array_agg(id))[1] into v_n, v_id_no
        from animals where active and fn_delpro_text(animal_no) = v_no;
        if v_n > 1 then v_amb_no := true; v_id_no := null; end if;
      end if;
    end if;

    if v_amb_orn or (v_amb_no and v_id_orn is null) then
      v_ambiguous := v_ambiguous + 1;
      continue;
    end if;
    if v_id_orn is not null and v_id_no is not null and v_id_orn <> v_id_no then
      v_conflicts := v_conflicts || jsonb_build_object('number', v_no, 'orn', v_orn, 'reason', 'orn_and_number_different_animals');
      continue;
    end if;
    v_id := coalesce(v_id_orn, v_id_no);
    v_by_orn := v_id_orn is not null;
    if v_id is null then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;

    select delpro_object_guid into v_current from animals where id = v_id;
    if v_current = v_guid then
      v_unchanged := v_unchanged + 1;
    elsif v_current is not null then
      v_conflicts := v_conflicts || jsonb_build_object('number', v_no, 'orn', v_orn, 'reason', 'different_guid_already_set');
    elsif exists (select 1 from animals where delpro_object_guid = v_guid) then
      v_conflicts := v_conflicts || jsonb_build_object('number', v_no, 'orn', v_orn, 'reason', 'guid_used_by_other_animal');
    else
      update animals set delpro_object_guid = v_guid where id = v_id;
      v_matched := v_matched + 1;
      if v_by_orn then v_matched_by_orn := v_matched_by_orn + 1; end if;
    end if;
  end loop;

  v_result := jsonb_build_object('received', v_received, 'matched', v_matched, 'matched_by_orn', v_matched_by_orn,
    'unchanged', v_unchanged, 'unmatched', v_unmatched, 'ambiguous', v_ambiguous, 'conflicts', jsonb_array_length(v_conflicts),
    'conflict_samples', (select coalesce(jsonb_agg(c), '[]'::jsonb) from (select c from jsonb_array_elements(v_conflicts) c limit 20) x));

  if nullif(p_body->>'run_id', '') is not null then
    update delpro_catalog_runs
    set stats = jsonb_set(stats, '{Animal}', v_result)
    where id = (p_body->>'run_id')::uuid and status = 'running';
  end if;

  return v_result;
end;
$$;

revoke all on function delpro_ingest_animal_ids(jsonb) from public, anon, authenticated;
grant execute on function delpro_ingest_animal_ids(jsonb) to service_role;

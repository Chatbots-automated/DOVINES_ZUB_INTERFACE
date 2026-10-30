-- 0038_delpro_catalog_preview.sql
-- DelPro catalog sync, dry run (Priedas Nr. 1 §4, on top of 0036/0037).
--
-- delpro_catalog_preview(jsonb) answers "what would this catalog snapshot do
-- to GVET?" without changing anything. It runs the REAL pipeline
-- (begin_run -> upload per type -> ingest_animal_ids -> finish_run, i.e.
-- removals + reconcile incl. any auto-apply / auto-queue) inside a plpgsql
-- block that always ends by raising GVPRV, which rolls the block's
-- subtransaction back. plpgsql variables survive the rollback, so the summary
-- collected inside is returned while every row change, lock and set_config()
-- inside is undone. Any other error propagates and aborts the whole call.
--
-- Same rules as the real run, so the preview can't drift from it. The worker
-- runs it with `npm run catalog:dry-run` (no begin/upload/finish/ingest calls,
-- no heartbeat, a GetData-only Gateway client).

-- Per-row fingerprint of a table: { "<key>": md5(row) }. Used to diff GVET
-- state before/after the rolled-back run.
create or replace function fn_delpro_preview_rows(p_table text, p_key text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v jsonb;
begin
  execute format('select coalesce(jsonb_object_agg(t.%I::text, md5(to_jsonb(t)::text)), ''{}''::jsonb) from %I t', p_key, p_table)
  into v;
  return v;
end;
$$;

-- delpro_catalog_preview(jsonb):
--   { "worker_id": "...",
--     "types": { "Drug": { "complete": true, "returned": 117, "limit": 5000, "note": null,
--                          "records": [ {code, name, ...}, ... ] }, ... },
--     "animals": [ { "object_guid": uuid, "number": "337" }, ... ],   -- optional
--     "error": "optional" }
-- -> { dry_run: true, rolled_back: true, run: <finish_run result>, uploads: {type: upload result},
--      animals: <ingest result>, new_issues: {issue_type: {count, samples}}, gvet_changes: {table: {...}} }
create or replace function delpro_catalog_preview(jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  p_body alias for $1;
  -- table, key column, label column (null = no label)
  c_tables constant text[][] := array[
    array['diseases', 'id', 'name'],
    array['products', 'id', 'name'],
    array['treatment_templates', 'id', 'name'],
    array['treatment_template_items', 'id', null],
    array['animals', 'id', 'animal_no'],
    array['delpro_catalog_links', 'id', 'delpro_key'],
    array['delpro_catalog_jobs', 'id', 'label'],
    array['delpro_sync_jobs', 'id', null],
    array['system_settings', 'setting_key', null]
  ];
  v_before jsonb := '{}'::jsonb;
  v_after jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_run uuid;
  v_type text;
  v_info jsonb;
  v_uploads jsonb := '{}'::jsonb;
  v_animals jsonb;
  v_finish jsonb;
  v_issues jsonb;
  v_types jsonb;
  v_result jsonb;
  i integer;
  v_old jsonb;
  v_new jsonb;
  v_ins text[];
  v_upd text[];
  v_del text[];
  v_samples jsonb;
begin
  if jsonb_typeof(p_body->'types') is distinct from 'object' then
    raise exception 'Laukiamas tipų objektas (types).';
  end if;

  begin
    for i in 1 .. array_length(c_tables, 1) loop
      v_before := v_before || jsonb_build_object(c_tables[i][1], fn_delpro_preview_rows(c_tables[i][1], c_tables[i][2]));
    end loop;

    v_run := (delpro_catalog_begin_run(jsonb_build_object('worker_id', coalesce(p_body->>'worker_id', '') || ' (dry-run)'))->>'run_id')::uuid;

    -- same dependency order as the worker / finish_run
    foreach v_type in array array['DrugParameters', 'Drug', 'TreatmentDrugUsage', 'Treatment', 'Diagnosis']
    loop
      v_info := p_body->'types'->v_type;
      continue when v_info is null or jsonb_typeof(v_info->'records') is distinct from 'array';
      v_uploads := v_uploads || jsonb_build_object(v_type,
        delpro_catalog_upload(jsonb_build_object('run_id', v_run, 'object_type', v_type, 'records', v_info->'records')));
    end loop;

    if jsonb_typeof(p_body->'animals') = 'array' then
      v_animals := delpro_ingest_animal_ids(jsonb_build_object('run_id', v_run, 'animals', p_body->'animals'));
    end if;

    select coalesce(jsonb_object_agg(key, value - 'records'), '{}'::jsonb) into v_types from jsonb_each(p_body->'types');
    v_finish := delpro_catalog_finish_run(jsonb_build_object('run_id', v_run, 'types', v_types, 'error', p_body->'error'));

    -- issues this run would open (created_at = now() = this transaction), up to 20 samples each
    select coalesce(jsonb_object_agg(issue_type, jsonb_build_object('count', n, 'samples', s)), '{}'::jsonb) into v_issues
    from (
      select issue_type, count(*) as n,
             (select coalesce(jsonb_agg(jsonb_build_object('object_type', s.object_type, 'delpro_key', s.delpro_key, 'details', s.details)), '[]'::jsonb)
              from (select * from delpro_catalog_issues s2
                    where s2.created_at = now() and s2.status = 'open' and s2.issue_type = g.issue_type
                    order by s2.object_type, s2.delpro_key limit 20) s) as s
      from delpro_catalog_issues g
      where g.created_at = now() and g.status = 'open'
      group by issue_type
    ) x;

    for i in 1 .. array_length(c_tables, 1) loop
      v_old := v_before->c_tables[i][1];
      v_new := fn_delpro_preview_rows(c_tables[i][1], c_tables[i][2]);
      select coalesce(array_agg(k order by k), '{}') into v_ins from jsonb_object_keys(v_new) k where not v_old ? k;
      select coalesce(array_agg(k order by k), '{}') into v_del from jsonb_object_keys(v_old) k where not v_new ? k;
      select coalesce(array_agg(k order by k), '{}') into v_upd from jsonb_object_keys(v_new) k where v_old ? k and v_old->k <> v_new->k;
      continue when cardinality(v_ins) + cardinality(v_upd) + cardinality(v_del) = 0;

      v_samples := '[]'::jsonb;
      if c_tables[i][3] is not null then
        execute format('select coalesce(jsonb_agg(jsonb_build_object(''key'', t.%1$I::text, ''label'', t.%2$I::text)), ''[]''::jsonb)
                        from (select * from %3$I where %1$I::text = any ($1) order by %1$I limit 20) t',
                       c_tables[i][2], c_tables[i][3], c_tables[i][1])
        into v_samples using v_ins || v_upd;
      end if;
      v_changes := v_changes || jsonb_build_object(c_tables[i][1], jsonb_build_object(
        'inserted', cardinality(v_ins), 'updated', cardinality(v_upd), 'deleted', cardinality(v_del),
        'samples', v_samples));
    end loop;

    v_result := jsonb_build_object(
      'dry_run', true,
      'rolled_back', true,
      'run', v_finish - 'run_id',
      'uploads', v_uploads,
      'animals', v_animals,
      'new_issues', v_issues,
      'gvet_changes', v_changes);

    raise exception using errcode = 'GVPRV', message = 'delpro_catalog_preview: rollback';
  exception when sqlstate 'GVPRV' then
    null; -- everything above is undone; v_result survives
  end;

  return v_result;
end;
$$;

revoke all on function fn_delpro_preview_rows(text, text) from public, anon, authenticated;
revoke all on function delpro_catalog_preview(jsonb) from public, anon, authenticated;
grant execute on function fn_delpro_preview_rows(text, text) to service_role;
grant execute on function delpro_catalog_preview(jsonb) to service_role;

comment on function delpro_catalog_preview(jsonb) is
  'Worker (service_role): dry run of a DelPro catalog snapshot. Runs begin/upload/ingest/finish (+ reconcile) and rolls everything back; returns what would change.';

-- 0054: Sėklinimas ← DelPro — readable semen names (worker 0.5.1).
--
-- Verified read-only on the farm Gateway: Semen [Key, SemenName, Comment] (Key 2111 = "Heavenly" / "Karvėms",
-- 2104 = "Mcclain Sex" / "Telyčioms"). The worker resolves InseminationEvent.Semen by Key (cached) and sends
-- semen_label = SemenName and semen_comment = Comment.
--   * delpro_semen_label = SemenName (catalog name — NOT an official bull KK number; reproduktoriaus_id is untouched);
--     delpro_semen_comment = Comment (supporting text only); delpro_semen_key stays for traceability.
--   * bull_name ("Bulius / sperma", search, animal card) = DelPro Bull, else SemenName — only while nobody changed it in GVET.
--   * A lookup that failed (the worker leaves semen_label out) keeps the stored name for the same key — a hiccup never wipes it.
--   * The round summary (delpro_insemination_last_round) stores the worker's totals for the whole round, not one chunk's.
--   * Existing imported rows are enriched by the next read of their cow (every 6 h, or `npm run insemination:sync-all`):
--     same row (event GUID), dates, pregnancy, certificate fields untouched.

alter table insemination_records add column delpro_semen_comment text;

-- the new label / comment for one event: sent -> that value; not sent and the key unchanged -> keep; key changed -> null
create or replace function fn_ins_semen_value(e jsonb, p_field text, p_old_key text, p_old_value text)
returns text
language sql
immutable
as $$
  select case
    when e ? p_field then nullif(btrim(e->>p_field), '')
    when nullif(e->>'semen_key', '') is not distinct from p_old_key then p_old_value
    else null end;
$$;

-- allow the import to set the new column (guard of 0053 lists DelPro fields explicitly)
create or replace function fn_insemination_delpro_guard_0054()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('gvet.delpro_import', true), '') <> 'on' and tg_op = 'UPDATE'
    and new.delpro_semen_comment is distinct from old.delpro_semen_comment then
    raise exception 'DelPro laukų GVET keisti negalima — juos atnaujina sinchronizacija.';
  end if;
  return new;
end;
$$;
create trigger trg_insemination_delpro_guard_0054
  before update on insemination_records
  for each row execute function fn_insemination_delpro_guard_0054();

create or replace function delpro_insemination_upload(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  v_worker text := nullif(btrim(p_body->>'worker_id'), '');
  r jsonb;
  e jsonb;
  v_animal animals%rowtype;
  v_old insemination_records%rowtype;
  v_at timestamptz;
  v_date date;
  v_guid uuid;
  v_dup uuid;
  v_seen uuid[];
  v_n integer;
  v_label text;
  v_scomment text;
  v_bull text;
  c jsonb := jsonb_build_object('animals', 0, 'ok', 0, 'failed', 0, 'mismatched', 0, 'inserted', 0, 'updated', 0, 'unchanged', 0,
                                'conflicts', 0, 'flagged_duplicates', 0, 'missing', 0, 'invalid', 0);
  v_conflicts jsonb := '[]'::jsonb;
begin
  if v_worker is null then
    raise exception 'worker_id privalomas.';
  end if;
  perform set_config('gvet.delpro_import', 'on', true);

  for r in select * from jsonb_array_elements(coalesce(p_body->'results', '[]'::jsonb)) loop
    c := jsonb_set(c, '{animals}', to_jsonb((c->>'animals')::int + 1));
    select * into v_animal from animals where id = nullif(r->>'animal_id', '')::uuid;
    if v_animal.id is null or v_animal.delpro_object_guid is null
      or lower(v_animal.delpro_object_guid::text) <> lower(coalesce(r->>'animal_guid', '')) then
      c := jsonb_set(c, '{mismatched}', to_jsonb((c->>'mismatched')::int + 1));
      continue;
    end if;

    if not coalesce((r->>'ok')::boolean, false) then
      insert into delpro_insemination_scans as s (animal_id, checked_at, ok, complete, error, worker_id)
      values (v_animal.id, now(), false, false, left(coalesce(r->>'error', 'nežinoma klaida'), 500), v_worker)
      on conflict (animal_id) do update set checked_at = now(), ok = false, complete = false, error = excluded.error, worker_id = v_worker,
        requested_at = case when s.requested_at <= coalesce(nullif(r->>'started_at', '')::timestamptz, now()) then null else s.requested_at end;
      c := jsonb_set(c, '{failed}', to_jsonb((c->>'failed')::int + 1));
      continue;
    end if;

    v_seen := '{}';
    for e in select * from jsonb_array_elements(coalesce(r->'events', '[]'::jsonb)) loop
      v_guid := (e->>'guid')::uuid;
      v_at := (e->>'event_at')::timestamptz;
      v_date := (v_at at time zone 'Europe/Vilnius')::date;
      v_seen := v_seen || v_guid;
      select * into v_old from insemination_records where delpro_event_guid = v_guid for update;
      if v_old.id is not null and v_old.animal_id <> v_animal.id then
        -- the same DelPro event under another GVET animal: never moved silently
        c := jsonb_set(c, '{conflicts}', to_jsonb((c->>'conflicts')::int + 1));
        v_conflicts := v_conflicts || jsonb_build_object('guid', v_guid, 'animal_id', v_animal.id, 'held_by', v_old.animal_id);
        v_old := null;
        continue;
      end if;
      if v_old.id is null then
        select id into v_dup from insemination_records
        where animal_id = v_animal.id and source = 'gvet' and insemination_date = v_date order by created_at limit 1;
        insert into insemination_records (animal_id, insemination_date, karves_id, bull_name, inseminator_name, notes, source,
          delpro_event_guid, delpro_event_at, delpro_event_time, delpro_semen_key, delpro_semen_label, delpro_semen_comment, delpro_bull, delpro_breeder,
          delpro_insemination_number, delpro_method_code, delpro_heat_event_guid, delpro_comment, delpro_record_hash, delpro_synced_at,
          delpro_possible_duplicate_of)
        values (v_animal.id, v_date, v_animal.tag_no, coalesce(nullif(e->>'bull', ''), nullif(e->>'semen_label', '')), nullif(e->>'breeder', ''),
          nullif(e->>'comment', ''), 'delpro',
          v_guid, v_at, nullif(e->>'event_time', ''), nullif(e->>'semen_key', ''), nullif(e->>'semen_label', ''), nullif(e->>'semen_comment', ''), nullif(e->>'bull', ''),
          nullif(e->>'breeder', ''), nullif(e->>'insemination_number', '')::integer, nullif(e->>'method_code', ''),
          nullif(e->>'heat_event_guid', '')::uuid, nullif(e->>'comment', ''), e->>'hash', now(), v_dup);
        c := jsonb_set(c, '{inserted}', to_jsonb((c->>'inserted')::int + 1));
        if v_dup is not null then
          c := jsonb_set(c, '{flagged_duplicates}', to_jsonb((c->>'flagged_duplicates')::int + 1));
        end if;
      end if;
      if v_old.id is not null then
        v_label := fn_ins_semen_value(e, 'semen_label', v_old.delpro_semen_key, v_old.delpro_semen_label);
        v_scomment := fn_ins_semen_value(e, 'semen_comment', v_old.delpro_semen_key, v_old.delpro_semen_comment);
        -- "Bulius" follows DelPro (Bull, else the Semen name) only while nobody changed it in GVET
        v_bull := v_old.bull_name;
        if v_old.bull_name is not distinct from coalesce(v_old.delpro_bull, v_old.delpro_semen_label) then
          v_bull := coalesce(nullif(e->>'bull', ''), v_label);
        end if;
      end if;
      if v_old.id is null then
        null; -- inserted above
      elsif v_old.delpro_record_hash is distinct from e->>'hash' or v_old.delpro_event_at is distinct from v_at
        or v_old.delpro_semen_label is distinct from v_label or v_old.delpro_semen_comment is distinct from v_scomment
        or v_old.bull_name is distinct from v_bull then
        update insemination_records set
          insemination_date = v_date,
          bull_name = v_bull,
          inseminator_name = case when inseminator_name is not distinct from delpro_breeder then nullif(e->>'breeder', '') else inseminator_name end,
          notes = case when notes is not distinct from delpro_comment then nullif(e->>'comment', '') else notes end,
          delpro_event_at = v_at, delpro_event_time = nullif(e->>'event_time', ''), delpro_semen_key = nullif(e->>'semen_key', ''),
          delpro_semen_label = v_label, delpro_semen_comment = v_scomment,
          delpro_bull = nullif(e->>'bull', ''), delpro_breeder = nullif(e->>'breeder', ''),
          delpro_insemination_number = nullif(e->>'insemination_number', '')::integer, delpro_method_code = nullif(e->>'method_code', ''),
          delpro_heat_event_guid = nullif(e->>'heat_event_guid', '')::uuid, delpro_comment = nullif(e->>'comment', ''),
          delpro_record_hash = e->>'hash', delpro_synced_at = now(), delpro_missing_at = null
        where id = v_old.id;
        c := jsonb_set(c, '{updated}', to_jsonb((c->>'updated')::int + 1));
      else
        update insemination_records set delpro_synced_at = now(), delpro_missing_at = null where id = v_old.id;
        c := jsonb_set(c, '{unchanged}', to_jsonb((c->>'unchanged')::int + 1));
      end if;
      v_old := null;
    end loop;

    -- a complete read: events GVET imported earlier that DelPro no longer returns are flagged, never deleted
    -- (events skipped as outside the backfill window or invalid this time are still "seen")
    if coalesce((r->>'complete')::boolean, false) then
      v_seen := v_seen || coalesce((select array_agg((x->>'guid')::uuid) from jsonb_array_elements(coalesce(r->'skipped', '[]'::jsonb)) x), '{}')
                       || coalesce((select array_agg((x->>'guid')::uuid) from jsonb_array_elements(coalesce(r->'invalid', '[]'::jsonb)) x
                                    where x->>'guid' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}');
      update insemination_records set delpro_missing_at = now()
      where animal_id = v_animal.id and source = 'delpro' and delpro_missing_at is null and not (delpro_event_guid = any (v_seen));
      get diagnostics v_n = row_count;
      c := jsonb_set(c, '{missing}', to_jsonb((c->>'missing')::int + v_n));
    end if;

    c := jsonb_set(c, '{invalid}', to_jsonb((c->>'invalid')::int + jsonb_array_length(coalesce(r->'invalid', '[]'::jsonb))));
    insert into delpro_insemination_scans as s (animal_id, checked_at, complete_at, ok, complete, error, event_count, invalid, skipped, worker_id)
    values (v_animal.id, now(), case when coalesce((r->>'complete')::boolean, false) then now() end, true, coalesce((r->>'complete')::boolean, false),
      nullif(left(coalesce(r->>'error', ''), 500), ''), jsonb_array_length(coalesce(r->'events', '[]'::jsonb)),
      coalesce(r->'invalid', '[]'::jsonb), coalesce(r->'skipped', '[]'::jsonb), v_worker)
    on conflict (animal_id) do update set checked_at = now(),
      complete_at = case when excluded.complete then now() else s.complete_at end,
      ok = true, complete = excluded.complete, error = excluded.error, event_count = excluded.event_count,
      invalid = excluded.invalid, skipped = excluded.skipped, worker_id = v_worker,
      requested_at = case when s.requested_at <= coalesce(nullif(r->>'started_at', '')::timestamptz, now()) then null else s.requested_at end;
    c := jsonb_set(c, '{ok}', to_jsonb((c->>'ok')::int + 1));
  end loop;

  if p_body ? 'round' then
    -- 0054: the worker sends the whole round's totals (all chunks) in round.counts; this call's own counts otherwise
    update system_settings set setting_value = (p_body->'round' || jsonb_build_object('finished_at', now(), 'worker_id', v_worker,
      'counts', coalesce(p_body->'round'->'counts', c)))::text
    where setting_key = 'delpro_insemination_last_round';
  end if;
  return c || jsonb_build_object('conflict_list', v_conflicts);
end;
$$;

revoke all on function delpro_insemination_upload(jsonb) from public, anon, authenticated;
grant execute on function delpro_insemination_upload(jsonb) to service_role;

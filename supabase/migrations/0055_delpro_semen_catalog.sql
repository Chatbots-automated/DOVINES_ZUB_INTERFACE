-- 0055: Sėklinimas ← DelPro — one shared name per semen (Semen.Key).
--
-- delpro_semen = GVET's semen catalog, one row per DelPro Semen.Key: the name / comment the worker read from DelPro
-- (Semen.SemenName / Comment) and an optional name staff set (name_override, e.g. for a key DelPro returns no name for).
-- Display name = coalesce(name_override, delpro_name). Every DelPro insemination with that key shows it:
--   * the import stores a resolved name per key (a failed lookup never erases it) and gives each row the catalog's name;
--   * a change in the catalog (new DelPro name, staff name) is copied at once to every row with that key
--     (delpro_semen_label / delpro_semen_comment, and bull_name while nobody typed another bull in GVET).
-- Semen.Key / the name are still never the bull's KK number (reproduktoriaus_id untouched).

create table delpro_semen (
  semen_key text primary key,
  delpro_name text,
  delpro_comment text,
  name_override text,
  synced_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id)
);
alter table delpro_semen enable row level security;
create policy delpro_semen_select on delpro_semen for select to authenticated using (fn_is_authenticated_active());
grant select on delpro_semen to authenticated;
grant all on delpro_semen to service_role;

-- every key already imported, with the newest name / comment seen for it
insert into delpro_semen (semen_key, delpro_name, delpro_comment, synced_at)
select distinct on (delpro_semen_key) delpro_semen_key, delpro_semen_label, delpro_semen_comment, delpro_synced_at
from insemination_records
where source = 'delpro' and delpro_semen_key is not null
order by delpro_semen_key, (delpro_semen_label is null), delpro_synced_at desc nulls last;

-- catalog change -> every insemination with that key
create or replace function fn_delpro_semen_propagate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := coalesce(new.name_override, new.delpro_name);
  v_old text := case when tg_op = 'UPDATE' then coalesce(old.name_override, old.delpro_name) end;
begin
  if tg_op = 'UPDATE' and v_name is not distinct from v_old and new.delpro_comment is not distinct from old.delpro_comment then
    return new;
  end if;
  perform set_config('gvet.delpro_import', 'on', true);
  update insemination_records set
    bull_name = case when bull_name is not distinct from coalesce(delpro_bull, delpro_semen_label) then coalesce(delpro_bull, v_name) else bull_name end,
    delpro_semen_label = v_name,
    delpro_semen_comment = new.delpro_comment
  where source = 'delpro' and delpro_semen_key = new.semen_key
    and (delpro_semen_label is distinct from v_name or delpro_semen_comment is distinct from new.delpro_comment);
  return new;
end;
$$;

create trigger trg_delpro_semen_propagate
  after insert or update on delpro_semen
  for each row execute function fn_delpro_semen_propagate();

-- the backfill above may have found a name for a key whose other rows have none: give them all the name
do $$ begin
  perform set_config('gvet.delpro_import', 'on', true);
  update insemination_records r set
    bull_name = case when r.bull_name is not distinct from coalesce(r.delpro_bull, r.delpro_semen_label) then coalesce(r.delpro_bull, d.delpro_name) else r.bull_name end,
    delpro_semen_label = d.delpro_name,
    delpro_semen_comment = d.delpro_comment
  from delpro_semen d
  where r.source = 'delpro' and r.delpro_semen_key = d.semen_key and d.delpro_name is not null
    and (r.delpro_semen_label is distinct from d.delpro_name or r.delpro_semen_comment is distinct from d.delpro_comment);
  perform set_config('gvet.delpro_import', '', true);
end $$;

-- Staff: "Spermos pavadinimas" — name a semen key for every insemination that uses it ('' = back to the DelPro name).
create or replace function delpro_semen_set_name(p_semen_key text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės.';
  end if;
  update delpro_semen set name_override = nullif(btrim(left(coalesce(p_name, ''), 120)), ''), updated_at = now(), updated_by = auth.uid()
  where semen_key = p_semen_key;
  if not found then
    raise exception 'Spermos raktas % nerastas.', p_semen_key;
  end if;
  select count(*) into v_n from insemination_records where delpro_semen_key = p_semen_key;
  insert into user_audit_logs (user_id, action, table_name, new_data)
  values (auth.uid(), 'delpro_semen_set_name', 'delpro_semen', jsonb_build_object('semen_key', p_semen_key, 'name', p_name));
  return jsonb_build_object('ok', true, 'inseminations', v_n,
    'message', 'Pavadinimas pritaikytas ' || v_n || ' sėklinim.');
end;
$$;

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
  v_cat jsonb;
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
      -- 0055: the shared semen catalog. A name the worker resolved is stored per key; every row then takes the catalog's
      -- display name (a staff name wins) and comment, so all inseminations with one Semen key show one name.
      if nullif(e->>'semen_key', '') is not null then
        if e ? 'semen_label' then
          insert into delpro_semen as d (semen_key, delpro_name, delpro_comment, synced_at)
          values (e->>'semen_key', nullif(btrim(e->>'semen_label'), ''), nullif(btrim(e->>'semen_comment'), ''), now())
          on conflict (semen_key) do update set synced_at = now(),
            delpro_name = coalesce(excluded.delpro_name, d.delpro_name),
            delpro_comment = case when excluded.delpro_name is null then d.delpro_comment else excluded.delpro_comment end;
        else
          insert into delpro_semen (semen_key) values (e->>'semen_key') on conflict (semen_key) do nothing;
        end if;
        select jsonb_build_object('semen_label', coalesce(name_override, delpro_name), 'semen_comment', delpro_comment)
        into v_cat from delpro_semen where semen_key = e->>'semen_key';
        e := e || v_cat;
      end if;
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
revoke all on function delpro_semen_set_name(text, text), fn_delpro_semen_propagate() from public, anon;
grant execute on function delpro_semen_set_name(text, text) to authenticated;

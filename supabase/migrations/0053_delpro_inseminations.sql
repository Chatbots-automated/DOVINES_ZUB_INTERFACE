-- 0053: DelPro -> GVET inseminations (Sėklinimas), read-only towards DelPro (worker 0.5.0, INSEMINATION_SOURCE=gateway).
--
-- Verified on the farm Gateway (read-only tests): InseminationEvent [ObjectGuid, Animal, Semen, Bull, Breeder, Comment, EventTime,
-- InseminationNumber, InseminationMethod, HeatEvent] filtered by Animal; its date lives in AnimalEvent with the SAME ObjectGuid
-- (EventDate, UTC). HeatEvent is a separate object — never the insemination's identity.
--
-- Imported events go into the existing journal (insemination_records), source = 'delpro', one row per DelPro event GUID
-- (unique index — re-reads update, never duplicate). insemination_date = the Europe/Vilnius date of EventDate (2014-06-08T21:00Z
-- -> 2014-06-09); the full instant is kept in delpro_event_at, EventTime raw only. GVET-side fields (pregnancy check, notes) stay
-- editable; DelPro fields can only be written by the import (guard trigger), and an imported row can't be deleted from GVET
-- (the next read would bring it back). Nothing is ever deleted by the import: an event a complete read no longer returns is
-- flagged delpro_missing_at. A manual GVET insemination of the same animal on the same Vilnius day is flagged
-- (delpro_possible_duplicate_of) for a person to resolve — never merged or deleted.
--
-- delpro_insemination_scans = per-animal progress (last attempt, last complete read, error, invalid events, events outside the
-- backfill window). Worker RPCs (unnamed jsonb, service_role): delpro_insemination_targets, delpro_insemination_upload.
-- Staff: delpro_insemination_request (refresh animals), delpro_insemination_dismiss_duplicate, delpro_insemination_status.

alter table insemination_records
  add column source text not null default 'gvet' check (source in ('gvet', 'delpro')),
  add column delpro_event_guid uuid,
  add column delpro_event_at timestamptz,
  add column delpro_event_time text,
  add column delpro_semen_key text,
  add column delpro_semen_label text,
  add column delpro_bull text,
  add column delpro_breeder text,
  add column delpro_insemination_number integer,
  add column delpro_method_code text,
  add column delpro_heat_event_guid uuid,
  add column delpro_comment text,
  add column delpro_record_hash text,
  add column delpro_synced_at timestamptz,
  add column delpro_missing_at timestamptz,
  add column delpro_possible_duplicate_of uuid references insemination_records (id) on delete set null,
  add constraint insemination_delpro_has_guid check (source <> 'delpro' or (delpro_event_guid is not null and delpro_event_at is not null));

create unique index insemination_records_delpro_event_guid_key on insemination_records (delpro_event_guid) where delpro_event_guid is not null;
create index insemination_records_source_idx on insemination_records (source);

comment on column insemination_records.delpro_event_at is 'DelPro AnimalEvent.EventDate (UTC instant). insemination_date = its Europe/Vilnius date.';
comment on column insemination_records.delpro_method_code is 'DelPro InseminationMethod enum value, raw (meaning not verified — never decoded by guess).';

-- Only the import (delpro_insemination_upload sets gvet.delpro_import) may create / change / delete DelPro rows' DelPro fields.
create or replace function fn_insemination_delpro_guard()
returns trigger
language plpgsql
as $$
declare
  v_import boolean := coalesce(current_setting('gvet.delpro_import', true), '') = 'on';
begin
  if v_import then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if new.source = 'delpro' or new.delpro_event_guid is not null then
      raise exception 'DelPro sėklinimus įrašo tik sinchronizacija.';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.source = 'delpro' then
      raise exception 'DelPro sėklinimo GVET ištrinti negalima — jis būtų vėl importuotas. Pataisykite ar ištrinkite jį DelPro.';
    end if;
    return old;
  end if;
  if new.source is distinct from old.source or new.delpro_event_guid is distinct from old.delpro_event_guid
    or new.delpro_event_at is distinct from old.delpro_event_at or new.delpro_event_time is distinct from old.delpro_event_time
    or new.delpro_semen_key is distinct from old.delpro_semen_key or new.delpro_semen_label is distinct from old.delpro_semen_label
    or new.delpro_bull is distinct from old.delpro_bull or new.delpro_breeder is distinct from old.delpro_breeder
    or new.delpro_insemination_number is distinct from old.delpro_insemination_number or new.delpro_method_code is distinct from old.delpro_method_code
    or new.delpro_heat_event_guid is distinct from old.delpro_heat_event_guid or new.delpro_comment is distinct from old.delpro_comment
    or new.delpro_record_hash is distinct from old.delpro_record_hash or new.delpro_synced_at is distinct from old.delpro_synced_at
    or new.delpro_missing_at is distinct from old.delpro_missing_at
    or (old.source = 'delpro' and (new.animal_id is distinct from old.animal_id or new.insemination_date is distinct from old.insemination_date)) then
    raise exception 'DelPro laukų GVET keisti negalima — juos atnaujina sinchronizacija.';
  end if;
  return new;
end;
$$;

create trigger trg_insemination_delpro_guard
  before insert or update or delete on insemination_records
  for each row execute function fn_insemination_delpro_guard();

create table delpro_insemination_scans (
  animal_id uuid primary key references animals (id) on delete cascade,
  requested_at timestamptz,
  checked_at timestamptz,           -- last attempt
  complete_at timestamptz,          -- last read that was complete (the progress marker)
  ok boolean,
  complete boolean,
  error text,
  event_count integer,
  invalid jsonb not null default '[]'::jsonb,   -- [{guid, error}] — not imported
  skipped jsonb not null default '[]'::jsonb,   -- [{guid, event_at}] — outside the backfill window, not imported
  worker_id text
);
alter table delpro_insemination_scans enable row level security;
create policy delpro_insemination_scans_select on delpro_insemination_scans for select to authenticated using (fn_is_authenticated_active());
grant select on delpro_insemination_scans to authenticated;
grant all on delpro_insemination_scans to service_role;

insert into system_settings (setting_key, setting_value, description) values
  ('delpro_insemination_last_round', '', 'Paskutinis DelPro sėklinimų nuskaitymas (JSON)')
on conflict (setting_key) do nothing;

-- { limit, due_minutes, retry_minutes, checked_before, tags } -> [{ animal_id, animal_guid, orn, animal_no, reason, known, skipped }]
-- Order: requested, never read, failed/incomplete (after retry_minutes), complete read older than due_minutes.
-- checked_before (sync-all): every linked animal not attempted since then. tags: exactly those (any linked animal).
create or replace function delpro_insemination_targets(jsonb)
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  p_body alias for $1;
  v_limit integer := least(greatest(coalesce((p_body->>'limit')::integer, 20), 1), 1000);
  v_due interval := make_interval(mins => greatest(coalesce((p_body->>'due_minutes')::integer, 360), 1));
  v_retry interval := make_interval(mins => greatest(coalesce((p_body->>'retry_minutes')::integer, 30), 1));
  v_before timestamptz := nullif(p_body->>'checked_before', '')::timestamptz;
  v_tags text[] := (select array_agg(fn_orn_normalize(t)) from jsonb_array_elements_text(coalesce(p_body->'tags', '[]'::jsonb)) t);
begin
  return coalesce((
    select jsonb_agg(x.j order by x.prio, x.at nulls first, x.tag_no)
    from (
      select a.tag_no,
        case
          when s.requested_at is not null and (s.checked_at is null or s.requested_at > s.checked_at) then 0
          when s.checked_at is null then 1
          when not coalesce(s.ok and s.complete, false) then 2
          else 3
        end as prio,
        s.checked_at as at,
        jsonb_build_object(
          'animal_id', a.id, 'animal_guid', a.delpro_object_guid, 'orn', a.tag_no, 'animal_no', a.animal_no,
          'reason', case
            when v_tags is not null then 'tag'
            when s.requested_at is not null and (s.checked_at is null or s.requested_at > s.checked_at) then 'requested'
            when s.checked_at is null then 'never'
            when not coalesce(s.ok and s.complete, false) then 'retry'
            else 'due' end,
          'known', coalesce((select jsonb_agg(jsonb_build_object('guid', r.delpro_event_guid, 'hash', r.delpro_record_hash, 'event_at', r.delpro_event_at))
                             from insemination_records r where r.animal_id = a.id and r.delpro_event_guid is not null), '[]'::jsonb),
          'skipped', coalesce(s.skipped, '[]'::jsonb)) as j
      from animals a
      left join delpro_insemination_scans s on s.animal_id = a.id
      where a.delpro_object_guid is not null
        and (
          (v_tags is not null and fn_orn_normalize(a.tag_no) = any (v_tags))
          or (v_tags is null and v_before is not null and (s.checked_at is null or s.checked_at < v_before) and a.active)
          or (v_tags is null and v_before is null and a.active and (
                (s.requested_at is not null and (s.checked_at is null or s.requested_at > s.checked_at))
                or s.checked_at is null
                or (not coalesce(s.ok and s.complete, false) and s.checked_at < now() - v_retry)
                or (coalesce(s.ok and s.complete, false) and s.complete_at < now() - v_due)))
        )
      order by 2, 3 nulls first, a.tag_no
      limit v_limit
    ) x
  ), '[]'::jsonb);
end;
$$;

-- { worker_id, round?, results: [{ animal_id, animal_guid, started_at, ok, complete, error,
--     events: [{ guid, event_at, event_time, semen_key, semen_label, bull, breeder, comment, insemination_number, method_code,
--                heat_event_guid, hash }],
--     invalid: [{ guid, error }], skipped: [{ guid, event_at }] }] }
-- ok=false: only the scan row changes (old imported events stay as they are).
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
          delpro_event_guid, delpro_event_at, delpro_event_time, delpro_semen_key, delpro_semen_label, delpro_bull, delpro_breeder,
          delpro_insemination_number, delpro_method_code, delpro_heat_event_guid, delpro_comment, delpro_record_hash, delpro_synced_at,
          delpro_possible_duplicate_of)
        values (v_animal.id, v_date, v_animal.tag_no, nullif(e->>'bull', ''), nullif(e->>'breeder', ''), nullif(e->>'comment', ''), 'delpro',
          v_guid, v_at, nullif(e->>'event_time', ''), nullif(e->>'semen_key', ''), nullif(e->>'semen_label', ''), nullif(e->>'bull', ''),
          nullif(e->>'breeder', ''), nullif(e->>'insemination_number', '')::integer, nullif(e->>'method_code', ''),
          nullif(e->>'heat_event_guid', '')::uuid, nullif(e->>'comment', ''), e->>'hash', now(), v_dup);
        c := jsonb_set(c, '{inserted}', to_jsonb((c->>'inserted')::int + 1));
        if v_dup is not null then
          c := jsonb_set(c, '{flagged_duplicates}', to_jsonb((c->>'flagged_duplicates')::int + 1));
        end if;
      elsif v_old.delpro_record_hash is distinct from e->>'hash' or v_old.delpro_event_at is distinct from v_at
        or v_old.delpro_semen_label is distinct from nullif(e->>'semen_label', '') then
        update insemination_records set
          insemination_date = v_date,
          -- journal fields follow DelPro only while nobody changed them in GVET
          bull_name = case when bull_name is not distinct from delpro_bull then nullif(e->>'bull', '') else bull_name end,
          inseminator_name = case when inseminator_name is not distinct from delpro_breeder then nullif(e->>'breeder', '') else inseminator_name end,
          notes = case when notes is not distinct from delpro_comment then nullif(e->>'comment', '') else notes end,
          delpro_event_at = v_at, delpro_event_time = nullif(e->>'event_time', ''), delpro_semen_key = nullif(e->>'semen_key', ''),
          delpro_semen_label = nullif(e->>'semen_label', ''), delpro_bull = nullif(e->>'bull', ''), delpro_breeder = nullif(e->>'breeder', ''),
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
    update system_settings set setting_value = (p_body->'round' || jsonb_build_object('finished_at', now(), 'worker_id', v_worker, 'counts', c))::text
    where setting_key = 'delpro_insemination_last_round';
  end if;
  return c || jsonb_build_object('conflict_list', v_conflicts);
end;
$$;

-- Staff: "Atnaujinti iš DelPro" — { animal_ids?: uuid[], tags?: text[] }. Only DelPro-linked animals can be read.
create or replace function delpro_insemination_request(p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_tags text[] := (select array_agg(fn_orn_normalize(t)) from jsonb_array_elements_text(coalesce(p_body->'tags', '[]'::jsonb)) t);
  v_asked integer;
  v_n integer;
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės.';
  end if;
  select array_agg(distinct a.id) into v_ids from animals a
  where a.id in (select (x)::uuid from jsonb_array_elements_text(coalesce(p_body->'animal_ids', '[]'::jsonb)) x)
     or (v_tags is not null and fn_orn_normalize(a.tag_no) = any (v_tags));
  v_asked := coalesce(array_length(v_ids, 1), 0);
  if v_asked > 500 then
    raise exception 'Per daug gyvulių vienu kartu (daugiausia 500).';
  end if;
  insert into delpro_insemination_scans (animal_id, requested_at)
  select a.id, now() from animals a where a.id = any (coalesce(v_ids, '{}')) and a.delpro_object_guid is not null
  on conflict (animal_id) do update set requested_at = now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'requested', v_n, 'not_linked', v_asked - v_n,
    'message', case
      when v_asked = 0 then 'Gyvulys nerastas.'
      when v_n = 0 then 'Gyvulys nesusietas su DelPro — nėra ką nuskaityti.'
      else 'Paprašyta (' || v_n || ' gyv.) — ūkio kompiuteris nuskaitys per minutę.' end);
end;
$$;

-- Staff: "Palikti abu" — the DelPro event and the manual GVET record are two different inseminations.
create or replace function delpro_insemination_dismiss_duplicate(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės.';
  end if;
  perform set_config('gvet.delpro_import', 'on', true);
  update insemination_records set delpro_possible_duplicate_of = null where id = p_id and source = 'delpro';
  insert into user_audit_logs (user_id, action, table_name, record_id) values (auth.uid(), 'insemination_dismiss_duplicate', 'insemination_records', p_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function delpro_insemination_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_info jsonb := (select nullif(setting_value, '')::jsonb from system_settings where setting_key = 'delpro_worker_info');
begin
  if not fn_is_authenticated_active() then
    raise exception 'Neturite teisės.';
  end if;
  return jsonb_build_object(
    'source', v_info->>'insemination_source',
    'worker_version', v_info->>'version',
    'worker_seen_at', (select nullif(setting_value, '') from system_settings where setting_key = 'delpro_worker_last_seen_at'),
    'last_round', (select nullif(setting_value, '')::jsonb from system_settings where setting_key = 'delpro_insemination_last_round'),
    'linked_animals', (select count(*) from animals where active and delpro_object_guid is not null),
    'read_animals', (select count(*) from delpro_insemination_scans s join animals a on a.id = s.animal_id where a.active and s.complete_at is not null),
    'problem_animals', (select count(*) from delpro_insemination_scans where checked_at is not null and not coalesce(ok and complete, false)),
    'pending_requests', (select count(*) from delpro_insemination_scans where requested_at is not null and (checked_at is null or requested_at > checked_at)),
    'imported', (select count(*) from insemination_records where source = 'delpro'),
    'possible_duplicates', (select count(*) from insemination_records where delpro_possible_duplicate_of is not null),
    'invalid_events', (select coalesce(sum(jsonb_array_length(invalid)), 0) from delpro_insemination_scans));
end;
$$;

revoke all on function delpro_insemination_targets(jsonb), delpro_insemination_upload(jsonb) from public, anon, authenticated;
grant execute on function delpro_insemination_targets(jsonb), delpro_insemination_upload(jsonb) to service_role;
revoke all on function delpro_insemination_request(jsonb), delpro_insemination_dismiss_duplicate(uuid), delpro_insemination_status() from public, anon;
grant execute on function delpro_insemination_request(jsonb), delpro_insemination_dismiss_duplicate(uuid), delpro_insemination_status() to authenticated;

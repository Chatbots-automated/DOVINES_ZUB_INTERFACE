-- 0042_delpro_report_ingest.sql
-- DelPro daily Excel reports -> GVET PRO (Priedas §4, farm's request 2026-10).
--
-- The farm PC's uploader posts each new / modified XLSX from
-- C:\GVET\Ataskaitos\Dienine to the Netlify function delpro-report-upload,
-- which parses it and calls delpro_report_ingest(jsonb) (service_role) ONCE:
-- one transaction per file, idempotent per (farm, SHA-256).
--
-- Observational only: nothing here creates treatments, karencija, DelPro jobs
-- or touches clinical data. The report is shown on the animal card as
-- "DelPro ataskaita"; it never feeds the GVET <-> DelPro treatment sync.
--
-- Model
--   delpro_report_upload_tokens  per-farm upload tokens (only the SHA-256 is stored)
--   delpro_report_imports        one row per processed file (+ columns, counts, errors)
--   delpro_report_rows           one snapshot per report row (history; raw + typed values)
--   delpro_report_animal_state   current values per animal, PER FIELD with the report
--                                time each value came from (latest-wins per field)
--   delpro_report_fields         field registry: known fields + every column ever seen
--                                (aliases, label, type, visibility, order)
--   delpro_report_reviews        conflicts for a person (ambiguous animal, birth-date
--                                conflict, duplicate / invalid ORN)
--   delpro_report_failures       uploads that failed after authentication
--
-- Dynamic columns: a column whose header matches no alias becomes a new field
-- (key x_<header slug>) automatically; values live in JSONB, so a new column is
-- stored, registered and shown without a migration or code change.
--
-- Field semantics (per animal)
--   column present, cell filled  -> value updated (if the report is not older than the stored one)
--   column present, cell empty   -> value CLEARED (null), stamped with the report time
--   column missing in the report -> value kept, but it keeps its older report time, so
--                                   it is shown as historical, not as current
--   older report arriving late   -> stored in history; a field is only overwritten when
--                                   the incoming report time >= that field's report time
-- Animals are matched on the exact normalized ORN (official registration number =
-- animals.tag_no), never on DelPro's short Number. Unknown ORNs become provisional
-- animals (source 'delpro_report'). Animals missing from a report are never touched.
--
-- Farm scope: GVET is single-farm (one Supabase project per farm, AGENTS.md). The
-- farm id is system_settings.vic_farm_id (0041); every import row carries it and a
-- token of any other farm is refused.

insert into system_settings (setting_key, setting_value, description) values
  ('vic_farm_id', gen_random_uuid()::text, 'Šio ūkio ID (GVET Supabase).')
on conflict (setting_key) do nothing;

create or replace function fn_gvet_farm_id()
returns uuid language sql stable as $$
  select nullif(setting_value, '')::uuid from system_settings where setting_key = 'vic_farm_id';
$$;

-- Provisional animals created from a report.
alter table animals drop constraint animals_source_check;
alter table animals add constraint animals_source_check check (source in ('manual', 'delpro', 'vic', 'delpro_report'));

-- ORN / ear tag in one comparable form: upper case, no spaces, dots or dashes.
create or replace function fn_orn_normalize(p text)
returns text language sql immutable as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '[[:space:].\-]', '', 'g')), '');
$$;

create index animals_tag_no_norm_idx on animals (fn_orn_normalize(tag_no));

-- Header text in one comparable form: lower case, Lithuanian letters folded, punctuation -> space.
create or replace function fn_report_header_norm(p text)
returns text language sql immutable as $$
  select nullif(btrim(regexp_replace(
           translate(lower(coalesce(p, '')), 'ąčęėįšųūžäöüõ', 'aceeisuuzaouo'),
           '[^a-z0-9]+', ' ', 'g')), '');
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table delpro_report_upload_tokens (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null,
  label text not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'), -- SHA-256 hex of the token
  token_hint text not null,                                               -- last 4 characters, for recognising it
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references users (id) on delete set null
);

create table delpro_report_imports (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null,
  token_id uuid references delpro_report_upload_tokens (id) on delete set null,
  report_type text not null,
  filename text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer,
  report_at timestamptz not null,
  report_at_source text not null check (report_at_source in ('filename', 'workbook', 'received')),
  report_at_local text,
  sheets jsonb not null default '[]'::jsonb,      -- [{name, header_row, rows}]
  columns jsonb not null default '[]'::jsonb,     -- [{header, key, known, data_type}]
  rows_received integer not null default 0,
  rows_imported integer not null default 0,
  footer_rows integer not null default 0,
  matched integer not null default 0,
  created integer not null default 0,
  updated integer not null default 0,
  stale integer not null default 0,
  conflicts integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  supersedes_import_id uuid references delpro_report_imports (id) on delete set null,
  received_at timestamptz not null default now(),
  unique (farm_id, sha256)
);

create index delpro_report_imports_farm_time_idx on delpro_report_imports (farm_id, report_at desc);
create index delpro_report_imports_filename_idx on delpro_report_imports (farm_id, filename);

create table delpro_report_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references delpro_report_imports (id) on delete cascade,
  farm_id uuid not null,
  animal_id uuid references animals (id) on delete set null,
  orn text not null,
  sheet_name text,
  row_number integer not null,
  report_at timestamptz not null,
  -- key -> {value, type, local?, raw, header}; only the columns present in this report
  fields jsonb not null,
  -- original header -> original cell text, for auditing
  raw jsonb not null,
  outcome text not null check (outcome in ('created', 'updated', 'unchanged', 'stale', 'conflict', 'duplicate', 'invalid')),
  unique (import_id, sheet_name, row_number)
);

create index delpro_report_rows_farm_orn_idx on delpro_report_rows (farm_id, orn);
create index delpro_report_rows_animal_idx on delpro_report_rows (animal_id, report_at desc);

create table delpro_report_animal_state (
  animal_id uuid primary key references animals (id) on delete cascade,
  farm_id uuid not null,
  orn text not null,
  latest_report_at timestamptz not null,
  latest_import_id uuid references delpro_report_imports (id) on delete set null,
  latest_row_id uuid references delpro_report_rows (id) on delete set null,
  -- key -> {value, type, local?, raw, header, report_at, import_id, row_id}
  fields jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index delpro_report_animal_state_farm_orn_idx on delpro_report_animal_state (farm_id, orn);

create table delpro_report_fields (
  key text primary key,
  label text not null,
  aliases text[] not null default '{}',        -- normalized headers (fn_report_header_norm)
  headers_seen text[] not null default '{}',   -- original headers as they appeared
  data_type text not null default 'text' check (data_type in ('text', 'number', 'date', 'timestamp', 'boolean', 'orn')),
  known boolean not null default false,
  visible boolean not null default true,
  sort_order integer not null default 1000,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  last_import_id uuid references delpro_report_imports (id) on delete set null,
  seen_count integer not null default 0
);

insert into delpro_report_fields (key, label, aliases, data_type, known, sort_order) values
  ('orn', 'Oficialus reg. Nr. (ORN)',
   array['oficialus reg nr orn', 'oficialus reg nr', 'oficialus registracijos nr', 'oficialus registracijos numeris', 'orn'], 'orn', true, 10),
  ('health_event_date', 'Paskutiniojo sveikatos įvykio data',
   array['paskutiniojo sveikatos ivykio data', 'paskutinio sveikatos ivykio data', 'sveikatos ivykio data'], 'date', true, 20),
  ('animal_type', 'Gyvulio tipas', array['gyvulio tipas'], 'text', true, 30),
  ('birth_date', 'Gimimo data', array['gimimo data'], 'date', true, 40),
  ('latest_diagnosis', 'Naujausia diagnozė', array['naujausia diagnoze', 'diagnoze'], 'text', true, 50),
  ('latest_medicines', 'Naujausi vaistai ir jų dozės',
   array['naujausi vaistai ir ju dozes', 'naujausi vaistai', 'vaistai ir dozes'], 'text', true, 60),
  ('milk_withdrawal_until', 'Pieno išpylimo laikotarpio pabaigos data',
   array['pieno ispylimo laikotarpio pabaigos data', 'pieno ispylimo laikotarpio pabaiga', 'pieno ispylimo pabaigos data'], 'timestamp', true, 70),
  ('meat_withdrawal_until', 'Mėsos sulaikymo pabaigos data',
   array['mesos sulaikymo pabaigos data', 'mesos sulaikymo laikotarpio pabaigos data', 'mesos sulaikymo pabaiga'], 'timestamp', true, 80),
  ('latest_comment', 'Naujausias komentaras', array['naujausias komentaras', 'komentaras'], 'text', true, 90),
  ('country', 'Šalis', array['salis'], 'text', true, 100);

create table delpro_report_reviews (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null,
  import_id uuid references delpro_report_imports (id) on delete cascade,
  row_id uuid references delpro_report_rows (id) on delete cascade,
  animal_id uuid references animals (id) on delete set null,
  orn text,
  kind text not null check (kind in ('ambiguous_animal', 'birth_date_conflict', 'duplicate_orn_row', 'invalid_orn')),
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_by uuid references users (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index delpro_report_reviews_open_idx on delpro_report_reviews (farm_id, status, created_at desc);

create table delpro_report_failures (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null,
  token_id uuid references delpro_report_upload_tokens (id) on delete set null,
  filename text,
  sha256 text,
  stage text not null,
  error text not null,
  created_at timestamptz not null default now()
);

create index delpro_report_failures_time_idx on delpro_report_failures (farm_id, created_at desc);

-- Read access for signed-in users (tokens: admins only); writes only through the RPCs below.
alter table delpro_report_upload_tokens enable row level security;
alter table delpro_report_imports enable row level security;
alter table delpro_report_rows enable row level security;
alter table delpro_report_animal_state enable row level security;
alter table delpro_report_fields enable row level security;
alter table delpro_report_reviews enable row level security;
alter table delpro_report_failures enable row level security;
create policy delpro_report_upload_tokens_select on delpro_report_upload_tokens for select using (fn_is_admin());
create policy delpro_report_imports_select on delpro_report_imports for select using (fn_is_authenticated_active());
create policy delpro_report_rows_select on delpro_report_rows for select using (fn_is_authenticated_active());
create policy delpro_report_animal_state_select on delpro_report_animal_state for select using (fn_is_authenticated_active());
create policy delpro_report_fields_select on delpro_report_fields for select using (fn_is_authenticated_active());
create policy delpro_report_reviews_select on delpro_report_reviews for select using (fn_is_authenticated_active());
create policy delpro_report_failures_select on delpro_report_failures for select using (fn_is_admin());
revoke insert, update, delete on delpro_report_upload_tokens, delpro_report_imports, delpro_report_rows,
  delpro_report_animal_state, delpro_report_fields, delpro_report_reviews, delpro_report_failures from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Worker-facing RPCs (service_role only; unnamed jsonb body, see AGENTS.md)
-- ---------------------------------------------------------------------------

-- The token's farm, or SQLSTATE GV401 (unknown / revoked) / GV403 (another farm's token).
create or replace function fn_delpro_report_token(p_hash text)
returns delpro_report_upload_tokens
language plpgsql
stable
as $$
declare
  t delpro_report_upload_tokens%rowtype;
begin
  select * into t from delpro_report_upload_tokens where token_hash = lower(coalesce(p_hash, '')) and revoked_at is null;
  if t.id is null then
    raise exception using errcode = 'GV401', message = 'Neteisingas arba atšauktas ataskaitų įkėlimo raktas.';
  end if;
  if t.farm_id is distinct from fn_gvet_farm_id() then
    raise exception using errcode = 'GV403', message = 'Raktas priklauso kitam ūkiui.';
  end if;
  return t;
end;
$$;

-- delpro_report_auth(jsonb): { token_hash } -> { farm_id, token_id } (checked before the file is parsed)
create or replace function delpro_report_auth(jsonb)
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  t delpro_report_upload_tokens%rowtype := fn_delpro_report_token($1->>'token_hash');
begin
  return jsonb_build_object('farm_id', t.farm_id, 'token_id', t.id);
end;
$$;

-- delpro_report_log_failure(jsonb): { token_hash, filename, sha256, stage, error } — only for a valid token.
create or replace function delpro_report_log_failure(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  t delpro_report_upload_tokens%rowtype := fn_delpro_report_token($1->>'token_hash');
  v_id uuid;
begin
  insert into delpro_report_failures (farm_id, token_id, filename, sha256, stage, error)
  values (t.farm_id, t.id, left($1->>'filename', 255), left($1->>'sha256', 64), coalesce(left($1->>'stage', 40), 'unknown'),
          left(coalesce($1->>'error', '?'), 2000))
  returning id into v_id;
  return jsonb_build_object('failure_id', v_id);
end;
$$;

-- One parsed cell {t, v, raw} -> stored value {value, type, local?, raw}. timestamp_local is
-- Europe/Vilnius wall-clock time unless the cell carried an explicit offset.
create or replace function fn_delpro_report_value(c jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v_t text := coalesce(c->>'t', 'empty');
  v_raw text := c->>'raw';
begin
  if v_t = 'empty' or c is null then
    return jsonb_build_object('value', null, 'type', 'empty', 'raw', v_raw);
  elsif v_t = 'timestamp_local' then
    return jsonb_build_object('value', to_jsonb(((c->>'v')::timestamp at time zone 'Europe/Vilnius')), 'type', 'timestamp',
                              'local', c->>'v', 'raw', v_raw);
  elsif v_t = 'timestamp' then
    return jsonb_build_object('value', to_jsonb((c->>'v')::timestamptz), 'type', 'timestamp', 'raw', v_raw);
  elsif v_t = 'date' then
    return jsonb_build_object('value', to_jsonb((c->>'v')::date), 'type', 'date', 'raw', v_raw);
  elsif v_t = 'number' then
    return jsonb_build_object('value', to_jsonb((c->>'v')::numeric), 'type', 'number', 'raw', v_raw);
  elsif v_t = 'boolean' then
    return jsonb_build_object('value', to_jsonb((c->>'v')::boolean), 'type', 'boolean', 'raw', v_raw);
  end if;
  return jsonb_build_object('value', to_jsonb(nullif(btrim(c->>'v'), '')), 'type', 'text', 'raw', v_raw);
end;
$$;

-- delpro_report_ingest(jsonb):
--   { token_hash, report_type, filename, sha256, size_bytes,
--     report_at_local "YYYY-MM-DD HH:MM:SS", report_at_source,
--     sheets: [{ name, header_row, rows }],
--     columns: [{ header }],                       -- global list; cells reference its index
--     rows: [{ sheet, row, cells: [{ c, t, v, raw }] }], -- a listed cell with t='empty' is an
--                                                  -- explicitly empty cell; an unlisted column is missing
--     footer_rows, errors: [{ sheet, row, error }] }
-- -> { status: 'processed', import_id, rows_received, matched, created, updated, conflicts }
--  | { status: 'duplicate', import_id }
-- One transaction: a failure leaves nothing behind.
create or replace function delpro_report_ingest(jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  p_body alias for $1;
  t delpro_report_upload_tokens%rowtype := fn_delpro_report_token(p_body->>'token_hash');
  v_farm uuid := t.farm_id;
  v_sha text := lower(coalesce(p_body->>'sha256', ''));
  v_filename text := btrim(coalesce(p_body->>'filename', ''));
  v_type text := coalesce(p_body->>'report_type', '');
  v_report_at timestamptz;
  v_import uuid;
  v_existing uuid;
  v_prev uuid;
  v_cols jsonb := coalesce(p_body->'columns', '[]'::jsonb);
  v_keys text[] := '{}';
  v_known boolean[] := '{}';
  v_col jsonb;
  v_i integer;
  v_norm text;
  v_key text;
  v_field delpro_report_fields%rowtype;
  v_orn_col integer;
  v_col_meta jsonb := '[]'::jsonb;
  r jsonb;
  c jsonb;
  v_fields jsonb;
  v_raw jsonb;
  v_orn text;
  v_orn_sigs jsonb := '{}'::jsonb;   -- ORN -> [content signature per copy]
  v_seen jsonb := '{}'::jsonb;       -- ORNs already handled in this file
  v_sig text;
  v_n integer;
  v_animal uuid;
  v_animal_row animals%rowtype;
  v_row_id uuid;
  v_outcome text;
  v_state delpro_report_animal_state%rowtype;
  v_new_fields jsonb;
  v_changed boolean;
  k text;
  v_val jsonb;
  v_old jsonb;
  v_birth date;
  v_atype text;
  v_errors jsonb := coalesce(p_body->'errors', '[]'::jsonb);
  v_received integer := 0;
  v_imported integer := 0;
  v_matched integer := 0;
  v_created integer := 0;
  v_updated integer := 0;
  v_stale integer := 0;
  v_conflicts integer := 0;
  v_touched uuid[] := '{}';
begin
  -- one import at a time per farm: ordering + dedup without races
  perform pg_advisory_xact_lock(hashtext('delpro_report:' || v_farm::text));

  if v_type not in ('daily-health') then
    raise exception using errcode = 'GV422', message = format('Nežinomas ataskaitos tipas „%s“.', v_type);
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'GV422', message = 'Neteisingas SHA-256.';
  end if;
  if v_filename = '' or v_filename !~* '\.xlsx$' or v_filename ~ '[/\\[:cntrl:]]' or length(v_filename) > 255 then
    raise exception using errcode = 'GV422', message = 'Neteisingas failo pavadinimas.';
  end if;

  select id into v_existing from delpro_report_imports where farm_id = v_farm and sha256 = v_sha;
  if v_existing is not null then
    update delpro_report_upload_tokens set last_used_at = now() where id = t.id;
    return jsonb_build_object('status', 'duplicate', 'import_id', v_existing);
  end if;

  begin
    v_report_at := (p_body->>'report_at_local')::timestamp at time zone 'Europe/Vilnius';
  exception when others then
    v_report_at := null;
  end;
  if v_report_at is null then
    raise exception using errcode = 'GV422', message = 'Nežinomas ataskaitos laikas.';
  end if;

  -- an earlier version of the same file name (regenerated report)
  select id into v_prev from delpro_report_imports where farm_id = v_farm and filename = v_filename order by received_at desc limit 1;

  insert into delpro_report_imports (farm_id, token_id, report_type, filename, sha256, size_bytes, report_at, report_at_source,
                                     report_at_local, sheets, footer_rows, supersedes_import_id)
  values (v_farm, t.id, v_type, v_filename, v_sha, nullif(p_body->>'size_bytes', '')::integer, v_report_at,
          coalesce(nullif(p_body->>'report_at_source', ''), 'received'), p_body->>'report_at_local',
          coalesce(p_body->'sheets', '[]'::jsonb), coalesce(nullif(p_body->>'footer_rows', '')::integer, 0), v_prev)
  returning id into v_import;

  -- 1. columns -> field keys (aliases; unknown headers become new fields)
  for v_i in 0 .. jsonb_array_length(v_cols) - 1 loop
    v_col := v_cols->v_i;
    v_norm := fn_report_header_norm(v_col->>'header');
    select * into v_field from delpro_report_fields where v_norm = any (aliases) order by known desc, sort_order limit 1;
    if v_field.key is null then
      v_key := 'x_' || left(coalesce(replace(v_norm, ' ', '_'), 'stulpelis_' || v_i), 60);
      select * into v_field from delpro_report_fields where key = v_key;
      if v_field.key is null then
        insert into delpro_report_fields (key, label, aliases, data_type, known, first_seen_at)
        values (v_key, btrim(v_col->>'header'), array_remove(array[v_norm], null),
                coalesce((select case x->>'t' when 'timestamp_local' then 'timestamp' when 'empty' then null else x->>'t' end
                          from jsonb_array_elements(p_body->'rows') rr, jsonb_array_elements(rr->'cells') x
                          where (x->>'c')::int = v_i and x->>'t' <> 'empty' limit 1), 'text'),
                false, now())
        returning * into v_field;
      end if;
    end if;
    v_key := v_field.key;
    -- the same field twice in one file (two headers with one meaning): keep both, second one suffixed
    if v_key = any (v_keys) then
      v_key := v_key || '__' || v_i;
    end if;
    v_keys := v_keys || v_key;
    v_known := v_known || v_field.known;
    if v_field.key = 'orn' and v_orn_col is null then
      v_orn_col := v_i;
    end if;
    update delpro_report_fields
    set headers_seen = case when btrim(v_col->>'header') = any (headers_seen) then headers_seen else headers_seen || btrim(v_col->>'header') end,
        aliases = case when v_norm is null or v_norm = any (aliases) then aliases else aliases || v_norm end,
        last_seen_at = now(), last_import_id = v_import, seen_count = seen_count + 1,
        first_seen_at = coalesce(first_seen_at, now())
    where key = v_field.key;
    v_col_meta := v_col_meta || jsonb_build_object('header', v_col->>'header', 'key', v_key, 'known', v_field.known,
                                                   'data_type', v_field.data_type);
  end loop;

  if v_orn_col is null then
    raise exception using errcode = 'GV422', message = 'Ataskaitoje nėra stulpelio „Oficialus reg. Nr. (ORN)“.';
  end if;
  update delpro_report_imports set columns = v_col_meta where id = v_import;

  -- 2. ORNs repeated within this file: a content signature per copy (everything but the ORN cell)
  for r in select * from jsonb_array_elements(coalesce(p_body->'rows', '[]'::jsonb)) loop
    select fn_orn_normalize(x->>'v') into v_orn from jsonb_array_elements(r->'cells') x where (x->>'c')::int = v_orn_col;
    continue when v_orn is null;
    select md5(coalesce(jsonb_object_agg(cc->>'c', jsonb_build_object('t', cc->>'t', 'v', cc->>'v')), '{}'::jsonb)::text) into v_sig
    from jsonb_array_elements(r->'cells') cc where (cc->>'c')::int <> v_orn_col;
    v_orn_sigs := jsonb_set(v_orn_sigs, array[v_orn], coalesce(v_orn_sigs->v_orn, '[]'::jsonb) || to_jsonb(v_sig));
  end loop;

  -- 3. rows
  for r in select * from jsonb_array_elements(coalesce(p_body->'rows', '[]'::jsonb)) loop
    v_received := v_received + 1;
    v_fields := '{}'::jsonb;
    v_raw := '{}'::jsonb;
    for c in select * from jsonb_array_elements(r->'cells') loop
      v_i := (c->>'c')::int;
      continue when v_i is null or v_i >= cardinality(v_keys);
      v_fields := v_fields || jsonb_build_object(v_keys[v_i + 1], fn_delpro_report_value(c) || jsonb_build_object('header', v_cols->v_i->>'header'));
      v_raw := v_raw || jsonb_build_object(coalesce(v_cols->v_i->>'header', '#' || v_i), c->'raw');
    end loop;
    v_orn := fn_orn_normalize(v_fields->'orn'->>'value');
    v_animal := null;
    v_outcome := null;

    if v_orn is null or v_orn !~ '^[A-Z]{2}[0-9A-Z]{6,20}$' then
      insert into delpro_report_rows (import_id, farm_id, orn, sheet_name, row_number, report_at, fields, raw, outcome)
      values (v_import, v_farm, coalesce(v_orn, ''), r->>'sheet', (r->>'row')::int, v_report_at, v_fields, v_raw, 'invalid')
      returning id into v_row_id;
      insert into delpro_report_reviews (farm_id, import_id, row_id, orn, kind, details)
      values (v_farm, v_import, v_row_id, v_orn, 'invalid_orn',
              jsonb_build_object('value', v_fields->'orn'->>'raw', 'sheet', r->>'sheet', 'row', r->>'row'));
      v_conflicts := v_conflicts + 1;
      continue;
    end if;

    -- repeated ORN: identical copies -> the first counts, the rest are 'duplicate';
    -- differing copies -> none is applied, one review for the ORN
    if jsonb_array_length(v_orn_sigs->v_orn) > 1 then
      if (select count(distinct x) from jsonb_array_elements_text(v_orn_sigs->v_orn) x) > 1 then
        v_outcome := 'conflict';
      elsif v_seen ? v_orn then
        v_outcome := 'duplicate';
      end if;
      if v_outcome is not null then
        insert into delpro_report_rows (import_id, farm_id, orn, sheet_name, row_number, report_at, fields, raw, outcome)
        values (v_import, v_farm, v_orn, r->>'sheet', (r->>'row')::int, v_report_at, v_fields, v_raw, v_outcome)
        returning id into v_row_id;
        if v_outcome = 'conflict' and not (v_seen ? v_orn) then
          insert into delpro_report_reviews (farm_id, import_id, row_id, orn, kind, details)
          values (v_farm, v_import, v_row_id, v_orn, 'duplicate_orn_row',
                  jsonb_build_object('copies', jsonb_array_length(v_orn_sigs->v_orn), 'sheet', r->>'sheet', 'row', r->>'row'));
          v_conflicts := v_conflicts + 1;
        end if;
        v_seen := v_seen || jsonb_build_object(v_orn, true);
        continue;
      end if;
      v_seen := v_seen || jsonb_build_object(v_orn, true);
    end if;

    -- match: exact normalized ORN against the ear tag; never DelPro's short Number
    select count(*), (array_agg(id))[1] into v_n, v_animal from animals where fn_orn_normalize(tag_no) = v_orn;
    if v_n > 1 then
      insert into delpro_report_rows (import_id, farm_id, orn, sheet_name, row_number, report_at, fields, raw, outcome)
      values (v_import, v_farm, v_orn, r->>'sheet', (r->>'row')::int, v_report_at, v_fields, v_raw, 'conflict')
      returning id into v_row_id;
      insert into delpro_report_reviews (farm_id, import_id, row_id, orn, kind, details)
      values (v_farm, v_import, v_row_id, v_orn, 'ambiguous_animal',
              jsonb_build_object('animals', (select jsonb_agg(jsonb_build_object('id', id, 'tag_no', tag_no, 'animal_no', animal_no))
                                             from animals where fn_orn_normalize(tag_no) = v_orn)));
      v_conflicts := v_conflicts + 1;
      continue;
    end if;

    v_birth := case when v_fields->'birth_date'->>'type' = 'date' then (v_fields->'birth_date'->>'value')::date end;
    v_atype := nullif(btrim(v_fields->'animal_type'->>'value'), '');

    if v_n = 0 then
      insert into animals (tag_no, species, sex, birth_date, active, source)
      values (v_orn, 'galvijas', v_atype, v_birth, true, 'delpro_report')
      returning id into v_animal;
      v_created := v_created + 1;
      v_outcome := 'created';
    else
      select * into v_animal_row from animals where id = v_animal;
      if not (v_animal = any (v_touched)) then
        v_matched := v_matched + 1;
      end if;
      -- fill what GVET doesn't know; never overwrite curated / DelPro / VIC values
      update animals
      set birth_date = coalesce(birth_date, v_birth), sex = coalesce(sex, v_atype)
      where id = v_animal and ((birth_date is null and v_birth is not null) or (sex is null and v_atype is not null));
    end if;

    insert into delpro_report_rows (import_id, farm_id, animal_id, orn, sheet_name, row_number, report_at, fields, raw, outcome)
    values (v_import, v_farm, v_animal, v_orn, r->>'sheet', (r->>'row')::int, v_report_at, v_fields, v_raw, 'unchanged')
    returning id into v_row_id;
    v_imported := v_imported + 1;

    if v_n = 1 and v_animal_row.birth_date is not null and v_birth is not null and v_animal_row.birth_date <> v_birth then
      insert into delpro_report_reviews (farm_id, import_id, row_id, animal_id, orn, kind, details)
      values (v_farm, v_import, v_row_id, v_animal, v_orn, 'birth_date_conflict',
              jsonb_build_object('gvet', v_animal_row.birth_date, 'report', v_birth));
      v_conflicts := v_conflicts + 1;
    end if;

    -- current state: per field, newest report time wins (ties: the later upload)
    select * into v_state from delpro_report_animal_state where animal_id = v_animal for update;
    v_new_fields := coalesce(v_state.fields, '{}'::jsonb);
    v_changed := false;
    for k, v_val in select * from jsonb_each(v_fields) loop
      v_old := v_new_fields->k;
      if v_old is null or (v_old->>'report_at')::timestamptz <= v_report_at then
        if v_old is null or v_old->'value' is distinct from v_val->'value' or v_old->>'type' is distinct from v_val->>'type' then
          v_changed := true;
        end if;
        v_new_fields := v_new_fields || jsonb_build_object(k, v_val || jsonb_build_object(
          'report_at', v_report_at, 'import_id', v_import, 'row_id', v_row_id));
      end if;
    end loop;

    if v_state.animal_id is null then
      insert into delpro_report_animal_state (animal_id, farm_id, orn, latest_report_at, latest_import_id, latest_row_id, fields)
      values (v_animal, v_farm, v_orn, v_report_at, v_import, v_row_id, v_new_fields);
      v_changed := true;
    else
      if v_report_at < v_state.latest_report_at and not v_changed then
        v_outcome := coalesce(v_outcome, 'stale');
      end if;
      update delpro_report_animal_state
      set fields = v_new_fields,
          orn = v_orn,
          latest_report_at = greatest(latest_report_at, v_report_at),
          latest_import_id = case when v_report_at >= latest_report_at then v_import else latest_import_id end,
          latest_row_id = case when v_report_at >= latest_report_at then v_row_id else latest_row_id end,
          updated_at = now()
      where animal_id = v_animal;
    end if;

    if v_outcome is null then
      v_outcome := case when v_changed then 'updated' else 'unchanged' end;
    end if;
    if v_outcome = 'updated' and not (v_animal = any (v_touched)) then
      v_updated := v_updated + 1;
    elsif v_outcome = 'stale' then
      v_stale := v_stale + 1;
    end if;
    update delpro_report_rows set outcome = v_outcome where id = v_row_id;
    v_touched := v_touched || v_animal;
  end loop;

  update delpro_report_imports
  set rows_received = v_received, rows_imported = v_imported, matched = v_matched, created = v_created,
      updated = v_updated, stale = v_stale, conflicts = v_conflicts, errors = v_errors
  where id = v_import;
  update delpro_report_upload_tokens set last_used_at = now() where id = t.id;

  return jsonb_build_object('status', 'processed', 'import_id', v_import, 'rows_received', v_received,
                            'matched', v_matched, 'created', v_created, 'updated', v_updated, 'conflicts', v_conflicts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------------

-- New upload token for this farm. The token is returned ONCE; only its SHA-256 is stored.
create or replace function delpro_report_create_token(p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := 'gvr_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_id uuid;
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali kurti ataskaitų įkėlimo raktus.';
  end if;
  if nullif(btrim(p_label), '') is null then
    raise exception 'Nurodykite rakto pavadinimą (pvz. kompiuterio vardą).';
  end if;
  if fn_gvet_farm_id() is null then
    raise exception 'Ūkio ID nenustatytas (system_settings.vic_farm_id).';
  end if;
  insert into delpro_report_upload_tokens (farm_id, label, token_hash, token_hint, created_by)
  values (fn_gvet_farm_id(), btrim(p_label), encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), right(v_token, 4), auth.uid())
  returning id into v_id;
  insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
  values (auth.uid(), 'delpro_report_token_created', 'delpro_report_upload_tokens', v_id, jsonb_build_object('label', btrim(p_label)));
  return jsonb_build_object('ok', true, 'id', v_id, 'token', v_token,
    'message', 'Raktas sukurtas. Nukopijuokite jį dabar — daugiau jis nebus rodomas.');
end;
$$;

create or replace function delpro_report_revoke_token(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali atšaukti raktus.';
  end if;
  update delpro_report_upload_tokens set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null;
  insert into user_audit_logs (user_id, action, table_name, record_id) values (auth.uid(), 'delpro_report_token_revoked', 'delpro_report_upload_tokens', p_id);
  return jsonb_build_object('ok', true, 'message', 'Raktas atšauktas.');
end;
$$;

create or replace function delpro_report_resolve_review(p_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali spręsti importo konfliktus.';
  end if;
  if p_status not in ('resolved', 'dismissed') then
    raise exception 'Netinkama būsena.';
  end if;
  update delpro_report_reviews set status = p_status, resolved_by = auth.uid(), resolved_at = now() where id = p_id and status = 'open';
  return jsonb_build_object('ok', true, 'message', case when p_status = 'resolved' then 'Pažymėta išspręsta.' else 'Atmesta.' end);
end;
$$;

-- Field configuration: label, visibility, order (keys and aliases are kept).
create or replace function delpro_report_update_field(p_key text, p_label text, p_visible boolean, p_sort_order integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali keisti ataskaitos laukus.';
  end if;
  update delpro_report_fields
  set label = coalesce(nullif(btrim(p_label), ''), label), visible = coalesce(p_visible, visible), sort_order = coalesce(p_sort_order, sort_order)
  where key = p_key;
  if not found then
    raise exception 'Laukas nerastas.';
  end if;
  return jsonb_build_object('ok', true, 'message', 'Išsaugota.');
end;
$$;

revoke all on function fn_delpro_report_token(text) from public, anon, authenticated;
revoke all on function delpro_report_auth(jsonb) from public, anon, authenticated;
revoke all on function delpro_report_log_failure(jsonb) from public, anon, authenticated;
revoke all on function delpro_report_ingest(jsonb) from public, anon, authenticated;
grant execute on function fn_delpro_report_token(text) to service_role;
grant execute on function delpro_report_auth(jsonb) to service_role;
grant execute on function delpro_report_log_failure(jsonb) to service_role;
grant execute on function delpro_report_ingest(jsonb) to service_role;
revoke all on function delpro_report_create_token(text) from public, anon;
revoke all on function delpro_report_revoke_token(uuid) from public, anon;
revoke all on function delpro_report_resolve_review(uuid, text) from public, anon;
revoke all on function delpro_report_update_field(text, text, boolean, integer) from public, anon;
grant execute on function delpro_report_create_token(text) to authenticated;
grant execute on function delpro_report_revoke_token(uuid) to authenticated;
grant execute on function delpro_report_resolve_review(uuid, text) to authenticated;
grant execute on function delpro_report_update_field(text, text, boolean, integer) to authenticated;

notify pgrst, 'reload schema';

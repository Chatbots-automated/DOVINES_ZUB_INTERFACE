-- 0014_vic_animal_sync.sql
-- Dovinės ŽŪB GVET PRO — daily VIC animal import (requested by the farm
-- 2026-10; NOT in Priedas Nr. 1, billed separately per Sutartis §2.5).
--
-- Same contract as ZUB_ZIBARTONIAI_INTERFACE's upsert_animals_from_vic():
-- an external n8n workflow (schedule trigger, once a day) reads the VIC
-- login with the service role, logs into VIC, and POSTs the herd to
-- /rest/v1/rpc/upsert_animals_from_vic. The database never does network
-- I/O; the Next.js app never talks to VIC.
--
-- How it coexists with DelPro (the primary animal source, §3):
--   * VIC knows official ear tags, birth date, breed, sex — not DelPro
--     groups. Tag match is the join key.
--   * A tag that already exists is only *enriched* (null fields filled);
--     DelPro-owned values, group and active flag are never touched.
--   * A tag that does not exist is inserted with source = 'vic'.
--     upsert_animals_from_delpro() later adopts it (tag fallback) and flips
--     source to 'delpro'.
--   * A full snapshot deactivates only source = 'vic' animals that vanished
--     from VIC. Empty snapshots are refused.

alter table animals drop constraint animals_source_check;
alter table animals add constraint animals_source_check check (source in ('manual', 'delpro', 'vic'));
alter table animals add column updated_from_vic_at timestamptz;

alter table vic_credentials add column vic_farm_code text;

create table vic_sync_runs (
  id uuid primary key default gen_random_uuid(),
  received_rows integer not null default 0,
  inserted integer not null default 0,
  enriched integer not null default 0,
  unchanged integer not null default 0,
  deactivated integer not null default 0,
  skipped integer not null default 0,
  created_at timestamptz not null default now()
);

alter table vic_sync_runs enable row level security;
create policy vic_sync_runs_select on vic_sync_runs for select using (fn_is_admin());

insert into system_settings (setting_key, setting_value, description) values
  ('vic_last_sync_at', null, 'Paskutinė sėkminga VIC sinchronizacija'),
  ('vic_last_error', null, 'Paskutinė VIC sinchronizacijos klaida (n8n)')
on conflict (setting_key) do nothing;

-- Unnamed jsonb parameter on purpose (PostgREST raw-body passthrough, see
-- AGENTS.md). Body: bare array of rows, or { animals: [...], full_snapshot }.
-- Row keys: tag_no (also "karves nr" / "ženklo_nr"), sex, breed,
-- birth_date (YYYY-MM-DD), species is ignored (farm is cattle-only).
create or replace function upsert_animals_from_vic(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  v_rows jsonb;
  v_full boolean;
  v_received integer := 0;
  v_inserted integer := 0;
  v_enriched integer := 0;
  v_unchanged integer := 0;
  v_skipped integer := 0;
  v_deactivated integer := 0;
  v_seen_ids uuid[] := '{}';
  elem jsonb;
  v_tag text;
  v_sex text;
  v_breed text;
  v_birth date;
  v_id uuid;
  v_changed integer;
begin
  if jsonb_typeof(p_body) = 'array' then
    v_rows := p_body;
    v_full := true;
  else
    v_rows := coalesce(p_body->'animals', p_body->'rows', p_body->'data', '[]'::jsonb);
    v_full := coalesce((p_body->>'full_snapshot')::boolean, true);
  end if;

  if jsonb_typeof(v_rows) <> 'array' then
    raise exception 'Laukiamas gyvulių sąrašas (JSON masyvas).';
  end if;

  v_received := jsonb_array_length(v_rows);
  if v_received = 0 then
    raise exception 'Tuščias VIC sąrašas — sinchronizacija atmesta, kad nebūtų išjungti visi gyvuliai.';
  end if;

  for elem in select * from jsonb_array_elements(v_rows) loop
    v_tag := upper(regexp_replace(coalesce(elem->>'tag_no', elem->>'karves nr', elem->>'ženklo_nr', ''), '\s+', '', 'g'));
    if v_tag = '' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_sex := nullif(trim(elem->>'sex'), '');
    v_breed := nullif(trim(elem->>'breed'), '');
    v_birth := case when (elem->>'birth_date') ~ '^\d{4}-\d{2}-\d{2}' then left(elem->>'birth_date', 10)::date end;

    select id into v_id from animals where tag_no = v_tag;

    if v_id is null then
      insert into animals (tag_no, species, sex, breed, birth_date, active, source, updated_from_vic_at)
      values (v_tag, 'galvijas', v_sex, v_breed, v_birth, true, 'vic', now())
      returning id into v_id;
      v_inserted := v_inserted + 1;
    else
      -- Enrich only: fill what is empty, never overwrite DelPro/manual data.
      update animals set
        sex = coalesce(sex, v_sex),
        breed = coalesce(breed, v_breed),
        birth_date = coalesce(birth_date, v_birth),
        updated_from_vic_at = now()
      where id = v_id
        and (
          (sex is null and v_sex is not null) or
          (breed is null and v_breed is not null) or
          (birth_date is null and v_birth is not null)
        );
      get diagnostics v_changed = row_count;
      if v_changed > 0 then
        v_enriched := v_enriched + 1;
      else
        update animals set updated_from_vic_at = now() where id = v_id;
        v_unchanged := v_unchanged + 1;
      end if;
    end if;

    v_seen_ids := array_append(v_seen_ids, v_id);
  end loop;

  -- A snapshot where every row was unusable must not wipe the herd either.
  if v_full and array_length(v_seen_ids, 1) > 0 then
    with gone as (
      update animals
      set active = false, updated_from_vic_at = now()
      where source = 'vic' and active and not (id = any (v_seen_ids))
      returning 1
    )
    select count(*) into v_deactivated from gone;
  end if;

  insert into vic_sync_runs (received_rows, inserted, enriched, unchanged, deactivated, skipped)
  values (v_received, v_inserted, v_enriched, v_unchanged, v_deactivated, v_skipped);

  update system_settings set setting_value = now()::text where setting_key = 'vic_last_sync_at';
  update system_settings set setting_value = null where setting_key = 'vic_last_error';

  return jsonb_build_object(
    'received_rows', v_received, 'inserted', v_inserted, 'enriched', v_enriched,
    'unchanged', v_unchanged, 'deactivated', v_deactivated, 'skipped', v_skipped);
end;
$$;

-- n8n reports a failed run (login refused, VIC down...) so the VIC screen can show it.
create or replace function vic_report_error(p_error text)
returns void
language sql
security invoker
as $$
  update system_settings set setting_value = left(p_error, 500) where setting_key = 'vic_last_error';
$$;

revoke all on function upsert_animals_from_vic(jsonb) from public, anon, authenticated;
revoke all on function vic_report_error(text) from public, anon, authenticated;
grant execute on function upsert_animals_from_vic(jsonb) to service_role;
grant execute on function vic_report_error(text) to service_role;

-- Settings screen: farm code in, last-run info out. Signatures change, so
-- drop + recreate (0013 functions).
drop function vic_get_settings();
drop function vic_save_credentials(text, text, boolean);

create function vic_get_settings()
returns table (
  vic_username text, vic_farm_code text, password_set boolean, is_active boolean,
  updated_at timestamptz, updated_by_name text, last_sync_at timestamptz, last_error text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali matyti VIC nustatymus.';
  end if;
  return query
  select c.vic_username, c.vic_farm_code, c.vic_password <> '', c.is_active, c.updated_at,
         coalesce(u.full_name, u.email),
         nullif((select setting_value from system_settings where setting_key = 'vic_last_sync_at'), '')::timestamptz,
         nullif((select setting_value from system_settings where setting_key = 'vic_last_error'), '')
  from vic_credentials c
  left join users u on u.id = c.updated_by;
end;
$$;

create function vic_save_credentials(p_username text, p_password text, p_is_active boolean, p_farm_code text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali keisti VIC nustatymus.';
  end if;
  if nullif(trim(p_username), '') is null then
    raise exception 'Įveskite VIC prisijungimo vardą.';
  end if;

  if exists (select 1 from vic_credentials) then
    update vic_credentials
    set vic_username = trim(p_username),
        vic_password = coalesce(nullif(p_password, ''), vic_password),
        vic_farm_code = nullif(trim(p_farm_code), ''),
        is_active = coalesce(p_is_active, true),
        updated_by = auth.uid();
  else
    if nullif(p_password, '') is null then
      raise exception 'Įveskite VIC slaptažodį.';
    end if;
    insert into vic_credentials (vic_username, vic_password, vic_farm_code, is_active, updated_by)
    values (trim(p_username), p_password, nullif(trim(p_farm_code), ''), coalesce(p_is_active, true), auth.uid());
  end if;
end;
$$;

revoke all on function vic_get_settings() from public, anon;
revoke all on function vic_save_credentials(text, text, boolean, text) from public, anon;
grant execute on function vic_get_settings() to authenticated;
grant execute on function vic_save_credentials(text, text, boolean, text) to authenticated;

notify pgrst, 'reload schema';

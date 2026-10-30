-- 0041_vic_upsert_animals_for_client.sql
-- Dovinės ŽŪB GVET PRO — VIC animals from the shared VIC scraper (farm's
-- request, 2026-10; VIC import is billed separately, see AGENTS.md).
--
-- The scraper (same one Kairaitienės / Vaida use) gets the request from
-- vic_import_request (0040) and posts the animals back to
--   POST https://<project-ref>.supabase.co/rest/v1/rpc/upsert_animals_for_client
-- with the service-role key. Its body shape varies, so the function takes a
-- single UNNAMED jsonb (PostgREST whole-body pass-through, see AGENTS.md):
--   [ {row}, ... ]  |  { "rows" | "animals" | "data": [ ... ], "full_snapshot"?: bool }  |  {row}
-- row: { tag_no, farm_id?, client_id?, client_personal_code?, sex?, breed?, birth_date?, ... }
--
-- The farm id is GVET's own: system_settings.vic_farm_id, a uuid generated
-- here once. vic_import_request sends it as farm.id; rows that come back with
-- a different farm_id belong to another farm and are skipped, never stored.
-- Storage reuses upsert_animals_from_vic (0014): VIC only enriches existing
-- animals (fills nulls) and inserts unknown tags as source='vic'. A post is NOT
-- a full snapshot unless it says "full_snapshot": true (the scraper may post
-- one row per call), so nothing is deactivated by a partial post.

insert into system_settings (setting_key, setting_value, description) values
  ('vic_farm_id', gen_random_uuid()::text,
   'Šio ūkio ID VIC importui (GVET Supabase). Siunčiamas VIC skaitytuvui kaip farm.id; grąžinti gyvuliai su kitu farm_id atmetami.')
on conflict (setting_key) do nothing;

-- the per-login column mirrors the farm id (it is no longer typed in)
update vic_credentials set vic_farm_id = (select setting_value from system_settings where setting_key = 'vic_farm_id');

create or replace function vic_get_settings(p_kind text)
returns table (
  vic_username text, vic_farm_code text, vic_farm_id text, vic_farm_name text, vic_client_personal_code text,
  password_set boolean, is_active boolean, updated_at timestamptz, updated_by_name text, last_sync_at timestamptz, last_error text
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
  select c.vic_username, c.vic_farm_code, (select setting_value from system_settings where setting_key = 'vic_farm_id'),
         c.vic_farm_name, c.vic_client_personal_code,
         c.vic_password <> '', c.is_active, c.updated_at,
         coalesce(u.full_name, u.email),
         nullif((select setting_value from system_settings where setting_key = 'vic_last_sync_at'), '')::timestamptz,
         nullif((select setting_value from system_settings where setting_key = 'vic_last_error'), '')
  from vic_credentials c
  left join users u on u.id = c.updated_by
  where c.kind = p_kind;
end;
$$;

-- p_farm_id is kept for the signature but ignored: the farm id is GVET's own.
create or replace function vic_save_credentials(
  p_kind text, p_username text, p_password text, p_is_active boolean, p_farm_code text default null,
  p_farm_id text default null, p_farm_name text default null, p_client_personal_code text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_farm_id text := (select setting_value from system_settings where setting_key = 'vic_farm_id');
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali keisti VIC nustatymus.';
  end if;
  if p_kind not in ('seklinimas', 'veterinaras') then
    raise exception 'Nežinomas VIC prisijungimo tipas.';
  end if;
  if nullif(trim(p_username), '') is null then
    raise exception 'Įveskite VIC prisijungimo vardą.';
  end if;

  if exists (select 1 from vic_credentials where kind = p_kind) then
    update vic_credentials
    set vic_username = trim(p_username),
        vic_password = coalesce(nullif(p_password, ''), vic_password),
        vic_farm_code = nullif(trim(p_farm_code), ''),
        vic_farm_id = v_farm_id,
        vic_farm_name = nullif(trim(p_farm_name), ''),
        vic_client_personal_code = nullif(trim(p_client_personal_code), ''),
        is_active = coalesce(p_is_active, true),
        updated_by = auth.uid()
    where kind = p_kind;
  else
    if nullif(p_password, '') is null then
      raise exception 'Įveskite VIC slaptažodį.';
    end if;
    insert into vic_credentials (kind, vic_username, vic_password, vic_farm_code, vic_farm_id, vic_farm_name,
                                 vic_client_personal_code, is_active, updated_by)
    values (p_kind, trim(p_username), p_password, nullif(trim(p_farm_code), ''), v_farm_id,
            nullif(trim(p_farm_name), ''), nullif(trim(p_client_personal_code), ''), coalesce(p_is_active, true), auth.uid());
  end if;
end;
$$;

create or replace function vic_import_request(jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  c vic_credentials%rowtype;
  v_farm_id text := nullif((select setting_value from system_settings where setting_key = 'vic_farm_id'), '');
  v_date date := coalesce(nullif($1->>'search_date', '')::date, (now() at time zone 'Europe/Vilnius')::date);
  v_missing text[] := '{}';
begin
  select * into c from vic_credentials where kind = 'veterinaras' and is_active;
  if c.kind is null then
    raise exception 'Nėra aktyvių VIC veterinaro prisijungimo duomenų (Integracija → VIC).';
  end if;
  if v_farm_id is null then v_missing := v_missing || 'ūkio ID'::text; end if;
  if nullif(c.vic_farm_name, '') is null then v_missing := v_missing || 'ūkio pavadinimas'::text; end if;
  if nullif(c.vic_client_personal_code, '') is null then v_missing := v_missing || 'kliento asmens / įmonės kodas'::text; end if;
  if cardinality(v_missing) > 0 then
    raise exception 'VIC veterinaro prisijungime trūksta: % (Integracija → VIC).', array_to_string(v_missing, ', ');
  end if;
  return jsonb_build_object(
    'vet', jsonb_build_object('vic_username', c.vic_username, 'vic_password', c.vic_password),
    'search_date', to_char(v_date, 'YYYY-MM-DD'),
    'farm', jsonb_build_object('id', v_farm_id, 'name', c.vic_farm_name, 'client_personal_code', c.vic_client_personal_code));
end;
$$;

-- upsert_animals_for_client(jsonb) -> { received, other_farm_skipped, inserted, enriched, unchanged, skipped, deactivated }
create or replace function upsert_animals_for_client(jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_in jsonb := $1;
  v_farm_id text := nullif((select setting_value from system_settings where setting_key = 'vic_farm_id'), '');
  v_rows jsonb;
  v_full boolean := false;
  v_keep jsonb := '[]'::jsonb;
  v_other integer := 0;
  r jsonb;
  v_result jsonb;
begin
  if jsonb_typeof(v_in) = 'array' then
    v_rows := v_in;
  elsif jsonb_typeof(v_in) = 'object' then
    if v_in ? 'rows' or v_in ? 'animals' or v_in ? 'data' then
      v_rows := coalesce(v_in->'rows', v_in->'animals', v_in->'data');
      v_full := coalesce((v_in->>'full_snapshot')::boolean, false);
    else
      v_rows := jsonb_build_array(v_in); -- one row posted on its own
    end if;
  end if;
  if v_rows is null or jsonb_typeof(v_rows) <> 'array' then
    raise exception 'Laukiamas gyvulių sąrašas (JSON masyvas arba {"rows": [...]}).';
  end if;

  for r in select * from jsonb_array_elements(v_rows)
  loop
    if jsonb_typeof(r) <> 'object' then
      continue;
    end if;
    if nullif(btrim(r->>'farm_id'), '') is not null and lower(btrim(r->>'farm_id')) is distinct from lower(v_farm_id) then
      v_other := v_other + 1; -- another farm's animal
      continue;
    end if;
    v_keep := v_keep || r;
  end loop;

  if jsonb_array_length(v_keep) = 0 then
    if v_full then
      raise exception 'Tuščias VIC sąrašas — sinchronizacija atmesta, kad nebūtų išjungti visi gyvuliai.';
    end if;
    return jsonb_build_object('received', jsonb_array_length(v_rows), 'other_farm_skipped', v_other,
                              'inserted', 0, 'enriched', 0, 'unchanged', 0, 'skipped', 0, 'deactivated', 0);
  end if;

  v_result := upsert_animals_from_vic(jsonb_build_object('animals', v_keep, 'full_snapshot', v_full));
  return v_result || jsonb_build_object('received', jsonb_array_length(v_rows), 'other_farm_skipped', v_other);
end;
$$;

revoke all on function upsert_animals_for_client(jsonb) from public, anon, authenticated;
grant execute on function upsert_animals_for_client(jsonb) to service_role;

notify pgrst, 'reload schema';

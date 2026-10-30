-- 0040_vic_farm_identity.sql
-- Dovinės ŽŪB GVET PRO — VIC farm identity next to each VIC login (farm's
-- request, 2026-10; VIC import is billed separately, see AGENTS.md).
--
-- The VIC veterinarian login sees several farms; the daily animal import (n8n)
-- must pick this farm explicitly. Stored per login (kind):
--   vic_farm_id                VIC's own farm id
--   vic_farm_name              farm name as VIC shows it
--   vic_client_personal_code   the VIC client's personal / company code
-- vic_import_request(jsonb) hands n8n exactly the request it sends to VIC:
--   { "vet": { "vic_username", "vic_password" }, "search_date": "YYYY-MM-DD",
--     "farm": { "id", "name", "client_personal_code" } }
-- service_role only; the app still never reads the password back.

alter table vic_credentials
  add column vic_farm_id text,
  add column vic_farm_name text,
  add column vic_client_personal_code text;

drop function vic_get_settings(text);
drop function vic_save_credentials(text, text, text, boolean, text);

create function vic_get_settings(p_kind text)
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
  select c.vic_username, c.vic_farm_code, c.vic_farm_id, c.vic_farm_name, c.vic_client_personal_code,
         c.vic_password <> '', c.is_active, c.updated_at,
         coalesce(u.full_name, u.email),
         nullif((select setting_value from system_settings where setting_key = 'vic_last_sync_at'), '')::timestamptz,
         nullif((select setting_value from system_settings where setting_key = 'vic_last_error'), '')
  from vic_credentials c
  left join users u on u.id = c.updated_by
  where c.kind = p_kind;
end;
$$;

create function vic_save_credentials(
  p_kind text, p_username text, p_password text, p_is_active boolean, p_farm_code text default null,
  p_farm_id text default null, p_farm_name text default null, p_client_personal_code text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
        vic_farm_id = nullif(trim(p_farm_id), ''),
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
    values (p_kind, trim(p_username), p_password, nullif(trim(p_farm_code), ''), nullif(trim(p_farm_id), ''),
            nullif(trim(p_farm_name), ''), nullif(trim(p_client_personal_code), ''), coalesce(p_is_active, true), auth.uid());
  end if;
end;
$$;

-- vic_import_request(jsonb): { "search_date"?: "YYYY-MM-DD" } -> the request n8n sends to VIC
-- (veterinarian login + this farm). Default date: today in Europe/Vilnius.
-- Refuses rather than sending "[undefined]" fields to VIC.
create function vic_import_request(jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  c vic_credentials%rowtype;
  v_date date := coalesce(nullif($1->>'search_date', '')::date, (now() at time zone 'Europe/Vilnius')::date);
  v_missing text[] := '{}';
begin
  select * into c from vic_credentials where kind = 'veterinaras' and is_active;
  if c.kind is null then
    raise exception 'Nėra aktyvių VIC veterinaro prisijungimo duomenų (Integracija → VIC).';
  end if;
  if nullif(c.vic_farm_id, '') is null then v_missing := v_missing || 'ūkio ID'::text; end if;
  if nullif(c.vic_farm_name, '') is null then v_missing := v_missing || 'ūkio pavadinimas'::text; end if;
  if nullif(c.vic_client_personal_code, '') is null then v_missing := v_missing || 'kliento asmens / įmonės kodas'::text; end if;
  if cardinality(v_missing) > 0 then
    raise exception 'VIC veterinaro prisijungime trūksta: % (Integracija → VIC).', array_to_string(v_missing, ', ');
  end if;
  return jsonb_build_object(
    'vet', jsonb_build_object('vic_username', c.vic_username, 'vic_password', c.vic_password),
    'search_date', to_char(v_date, 'YYYY-MM-DD'),
    'farm', jsonb_build_object('id', c.vic_farm_id, 'name', c.vic_farm_name, 'client_personal_code', c.vic_client_personal_code));
end;
$$;

revoke all on function vic_get_settings(text) from public, anon;
revoke all on function vic_save_credentials(text, text, text, boolean, text, text, text, text) from public, anon;
revoke all on function vic_import_request(jsonb) from public, anon, authenticated;
grant execute on function vic_get_settings(text) to authenticated;
grant execute on function vic_save_credentials(text, text, text, boolean, text, text, text, text) to authenticated;
grant execute on function vic_import_request(jsonb) to service_role;

notify pgrst, 'reload schema';

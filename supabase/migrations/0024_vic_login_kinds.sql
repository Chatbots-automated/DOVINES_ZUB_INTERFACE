-- 0024_vic_login_kinds.sql
-- Dovinės ŽŪB GVET PRO — two VIC logins instead of one (farm's request, 2026-10):
--   'seklinimas'  = Sėklinimo prisijungimai — the login that was already stored
--                   under Integracija → VIC (0013). The existing row is kept as is.
--   'veterinaras' = Veterinaro prisijungimai — the veterinarian's login the
--                   daily animal import (0014, n8n) uses to read animals from VIC.
-- Still storage only; password stays write-only from the app.

alter table vic_credentials add column kind text not null default 'seklinimas'
  check (kind in ('seklinimas', 'veterinaras'));
alter table vic_credentials alter column kind drop default;

-- One row per kind instead of one row overall.
alter table vic_credentials drop constraint vic_credentials_pkey;
alter table vic_credentials drop column id;
alter table vic_credentials add primary key (kind);

drop function vic_get_settings();
drop function vic_save_credentials(text, text, boolean, text);

create function vic_get_settings(p_kind text)
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
  left join users u on u.id = c.updated_by
  where c.kind = p_kind;
end;
$$;

create function vic_save_credentials(p_kind text, p_username text, p_password text, p_is_active boolean, p_farm_code text default null)
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
        is_active = coalesce(p_is_active, true),
        updated_by = auth.uid()
    where kind = p_kind;
  else
    if nullif(p_password, '') is null then
      raise exception 'Įveskite VIC slaptažodį.';
    end if;
    insert into vic_credentials (kind, vic_username, vic_password, vic_farm_code, is_active, updated_by)
    values (p_kind, trim(p_username), p_password, nullif(trim(p_farm_code), ''), coalesce(p_is_active, true), auth.uid());
  end if;
end;
$$;

revoke all on function vic_get_settings(text) from public, anon;
revoke all on function vic_save_credentials(text, text, text, boolean, text) from public, anon;
grant execute on function vic_get_settings(text) to authenticated;
grant execute on function vic_save_credentials(text, text, text, boolean, text) to authenticated;

notify pgrst, 'reload schema';

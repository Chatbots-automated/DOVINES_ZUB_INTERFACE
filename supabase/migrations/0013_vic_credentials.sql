-- 0013_vic_credentials.sql
-- Dovinės ŽŪB GVET PRO — VIC (ŪKIS) prisijungimo duomenys, entered under
-- Integracija → VIC. Same shape as VAIDA_VET_INTERFACE's vic_credentials
-- (one shared login, admin-managed), with one change: the password is
-- write-only from the app. The browser never gets it back — authenticated
-- has no table grants; the two RPCs below expose only "is a password set".
-- Whatever later consumes it (n8n / worker) reads it with the service role.
--
-- Scope note: storing the credentials only. An actual VIC sync is not in
-- Priedas Nr. 1 (animals come from DelPro) — billed separately if wanted.

create table vic_credentials (
  id boolean primary key default true check (id), -- single row
  vic_username text not null,
  vic_password text not null,
  is_active boolean not null default true,
  updated_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_vic_credentials_updated_at
  before update on vic_credentials
  for each row execute function set_updated_at();

alter table vic_credentials enable row level security;
-- No policies: only security-definer RPCs and the service role get in.
revoke all on vic_credentials from anon, authenticated;

create or replace function vic_get_settings()
returns table (vic_username text, password_set boolean, is_active boolean, updated_at timestamptz, updated_by_name text)
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
  select c.vic_username, c.vic_password <> '', c.is_active, c.updated_at, coalesce(u.full_name, u.email)
  from vic_credentials c
  left join users u on u.id = c.updated_by;
end;
$$;

-- p_password null/empty keeps the stored one (the form never shows it).
create or replace function vic_save_credentials(p_username text, p_password text, p_is_active boolean)
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
        is_active = coalesce(p_is_active, true),
        updated_by = auth.uid();
  else
    if nullif(p_password, '') is null then
      raise exception 'Įveskite VIC slaptažodį.';
    end if;
    insert into vic_credentials (vic_username, vic_password, is_active, updated_by)
    values (trim(p_username), p_password, coalesce(p_is_active, true), auth.uid());
  end if;
end;
$$;

revoke all on function vic_get_settings() from public, anon;
revoke all on function vic_save_credentials(text, text, boolean) from public, anon;
grant execute on function vic_get_settings() to authenticated;
grant execute on function vic_save_credentials(text, text, boolean) to authenticated;

notify pgrst, 'reload schema';

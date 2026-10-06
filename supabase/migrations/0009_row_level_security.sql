-- 0009_row_level_security.sql
-- Dovinės ŽŪB GVET PRO — RLS policies.
--
-- Single-farm, single-tenant: no tenant isolation to enforce. Role-based:
--   viewer             -> read-only across all domain data
--   tech / vet / admin -> read + write domain data ("active staff")
--   admin only         -> users, system_settings, DelPro integration
--                          settings/queue, audit log
--   is_frozen = true   -> locked out regardless of role
-- The DelPro worker uses the service-role key, which bypasses RLS.

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so they can read `users` regardless
-- of the caller's own row-level visibility into that table).
-- ---------------------------------------------------------------------------

create or replace function fn_is_authenticated_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from users where id = auth.uid() and is_frozen = false
  );
$$;

create or replace function fn_is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from users
    where id = auth.uid() and is_frozen = false and role in ('admin', 'vet', 'tech')
  );
$$;

create or replace function fn_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from users where id = auth.uid() and is_frozen = false and role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

alter table users enable row level security;

create policy users_select on users
  for select using (id = auth.uid() or fn_is_admin());

create policy users_insert_admin on users
  for insert with check (fn_is_admin());

create policy users_update_self_or_admin on users
  for update using (id = auth.uid() or fn_is_admin());

create policy users_delete_admin on users
  for delete using (fn_is_admin());

-- ---------------------------------------------------------------------------
-- Active staff read/write, every active user reads.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  staff_write_tables text[] := array[
    'diseases', 'delpro_groups', 'animals', 'suppliers', 'products',
    'invoices', 'invoice_items', 'batches',
    'treatments', 'treatment_courses', 'course_doses',
    'vaccinations', 'biocide_usage',
    'usage_items', 'medical_waste', 'batch_waste_tracking',
    'write_off_purposes', 'write_off_acts', 'write_off_act_items',
    'write_off_act_allocations', 'write_off_act_usage_items'
  ];
begin
  foreach t in array staff_write_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (fn_is_authenticated_active())', t || '_select', t);
    execute format('create policy %I on %I for insert with check (fn_is_active_staff())', t || '_insert', t);
    execute format('create policy %I on %I for update using (fn_is_active_staff())', t || '_update', t);
    execute format('create policy %I on %I for delete using (fn_is_active_staff())', t || '_delete', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin-write, everyone active reads: settings + DelPro integration.
-- (Read access lets the dashboard show "N gydymų laukia DelPro" to vets.)
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  admin_only_tables text[] := array[
    'system_settings', 'delpro_mappings', 'delpro_sync_jobs', 'delpro_sync_runs'
  ];
begin
  foreach t in array admin_only_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (fn_is_authenticated_active())', t || '_select', t);
    execute format('create policy %I on %I for all using (fn_is_admin()) with check (fn_is_admin())', t || '_admin_write', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit log — active staff insert (self-logging), admin reads/deletes.
-- ---------------------------------------------------------------------------

alter table user_audit_logs enable row level security;

create policy user_audit_logs_select_admin on user_audit_logs
  for select using (fn_is_admin());

create policy user_audit_logs_insert_staff on user_audit_logs
  for insert with check (fn_is_active_staff());

create policy user_audit_logs_delete_admin on user_audit_logs
  for delete using (fn_is_admin());

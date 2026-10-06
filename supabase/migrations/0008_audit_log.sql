-- 0008_audit_log.sql
-- Dovinės ŽŪB GVET PRO — generic audit log for the Vartotojai admin screen.
-- (system_settings lives in 0001.)

create table user_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users (id),
  action text not null,
  table_name text,
  record_id uuid,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create index user_audit_logs_user_id_idx on user_audit_logs (user_id);
create index user_audit_logs_table_name_idx on user_audit_logs (table_name);

-- Convenience RPC server actions can call to self-log without hand-writing
-- an insert every time (mirrors the monika/oksana log_user_action pattern,
-- simplified — no localStorage session here, auth.uid() is real).
create or replace function log_user_action(
  p_action text,
  p_table_name text default null,
  p_record_id uuid default null,
  p_old_data jsonb default null,
  p_new_data jsonb default null
)
returns void
language sql
security invoker
as $$
  insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), p_action, p_table_name, p_record_id, p_old_data, p_new_data);
$$;

grant execute on function log_user_action(text, text, uuid, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';

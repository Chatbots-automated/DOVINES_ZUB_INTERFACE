-- First admin user. Create the user in Supabase Auth (Dashboard -> Authentication
-- -> Users -> Add user) first, then run this in the SQL editor with its id/email.
insert into public.users (id, email, full_name, role)
values ('<auth-user-uuid>', '<email>', '<Vardas Pavardė>', 'admin')
on conflict (id) do update set role = 'admin', is_frozen = false;

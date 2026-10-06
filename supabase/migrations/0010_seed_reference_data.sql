-- 0010_seed_reference_data.sql
-- Dovinės ŽŪB GVET PRO — minimal starter reference data so the app is not
-- empty on first login. The real product/disease catalogue is entered (or
-- imported) by the farm during the testing window (Sutartis §4).

insert into diseases (name) values
  ('Mastitas'),
  ('Endometritas'),
  ('Kojų/nagų liga'),
  ('Kvėpavimo takų liga'),
  ('Ketozė'),
  ('Kita')
on conflict do nothing;

-- PostgREST caps responses at 1000 rows by default; the journals and a
-- full herd list exceed that (see Kairaitienes' 0023).
alter role authenticator set pgrst.db_max_rows = '10000';

notify pgrst, 'reload config';
notify pgrst, 'reload schema';

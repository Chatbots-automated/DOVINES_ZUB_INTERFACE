-- 0048: CMS atskyrimai (farm's request 2026-11, NOT in Priedas Nr. 1 — billed separately per Sutartis §2.5/§4.6).
--
-- GVET prepares per-animal CMS sorting instructions (DelPro AnimalActionSetting, ActionType SortCow), an admin
-- approves them, and the farm-PC worker writes them through the Gateway and reads them back.
--
-- What is VERIFIED on the farm (read-only discovery, DelPro 10.9):
--   Animal.ObjectGuid -> AnimalMilkSetting (Key, Animal) -> AnimalActionSetting (Key, AnimalMilkSetting, ActionType,
--   Active, StartDate, EndDate, IsValidForSession1..10, LastUpdatedTime); SortArea (Key, SortAreaNumber, SortAreaName).
-- What is NOT verified: CreateData of AnimalActionSetting, which properties it accepts, how SortCow relates to a
-- physical SortArea, and whether any of it behaves like "Sort Once". Therefore:
--   * mode 'once' (Sort Once) can be prepared but never approved or sent;
--   * a specific sort area can be recorded but blocks sending (destination_unverified);
--   * an existing active SortCow in DelPro is never modified — the job is skipped or held for review;
--   * the worker claims a job only for a mode an admin marked verified (cms_verified_modes) after a
--     supervised single-job write (cms_single_job_id), exactly like the catalog pilot (0039).
-- A write that may have reached DelPro but was not verified goes to 'needs_review' and is never re-sent blindly.
--
-- Single-farm, single-tenant like the rest of the schema (no farm_id; one Supabase project per farm).

insert into system_settings (setting_key, setting_value, description) values
  ('cms_verified_modes', '[]', 'CMS atskyrimų režimai, kuriuos darbininkas gali siųsti (JSON masyvas; tik po prižiūrimo bandymo)'),
  ('cms_single_job_id', '', 'Vienintelė CMS užduotis, kurią darbininkas gali paimti (prižiūrimas bandymas)'),
  ('cms_live_refresh_requested_at', '', 'Kada paprašyta atnaujinti DelPro atskyrimų būseną'),
  ('cms_live_last_refresh', '', 'Paskutinis DelPro atskyrimų būsenos nuskaitymas (JSON)')
on conflict (setting_key) do nothing;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table cms_separation_batches (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'cancelled')),
  note text,
  common_settings jsonb not null default '{}'::jsonb,
  created_by uuid references users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_by uuid references users (id),
  submitted_at timestamptz
);

create table cms_separation_jobs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references cms_separation_batches (id) on delete cascade,
  animal_id uuid not null references animals (id),
  status text not null default 'draft' check (status in
    ('draft', 'pending_approval', 'approved', 'processing', 'success', 'error', 'needs_review', 'cancelled', 'skipped')),
  mode text not null check (mode in ('period', 'ongoing', 'once')),
  start_at timestamptz,
  end_at timestamptz,
  sessions smallint[] not null default '{}',
  sort_area_key text,
  note text,
  existing_decision text check (existing_decision in ('skip', 'modify')),
  is_override boolean not null default false,
  requested_settings jsonb not null default '{}'::jsonb,
  effective_settings jsonb not null default '{}'::jsonb,
  approved_snapshot jsonb,
  animal_guid uuid,
  milk_setting_key text,
  action_key text,
  adopt_key text,
  created_by uuid references users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_by uuid references users (id),
  approved_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  claimed_by text,
  claimed_at timestamptz,
  write_started_at timestamptz,
  last_error text,
  error_details jsonb,
  gateway_summary jsonb,
  readback jsonb,
  verified_at timestamptz,
  unique (batch_id, animal_id)
);

-- One open instruction per animal across all batches (drafts don't count).
create unique index cms_separation_jobs_open_animal on cms_separation_jobs (animal_id)
  where status in ('pending_approval', 'approved', 'processing', 'needs_review');
create index cms_separation_jobs_status_idx on cms_separation_jobs (status, created_at);
create index cms_separation_jobs_batch_idx on cms_separation_jobs (batch_id);

create table cms_separation_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references cms_separation_jobs (id) on delete cascade,
  batch_id uuid references cms_separation_batches (id) on delete cascade,
  event text not null,
  actor uuid references users (id),
  worker_id text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index cms_separation_events_job_idx on cms_separation_events (job_id, created_at);

-- DelPro's own SortCow settings as last read by the worker (live state, never written by GVET users).
create table cms_live_action_settings (
  action_key text primary key,
  milk_setting_key text,
  animal_guid uuid,
  animal_id uuid references animals (id) on delete set null,
  action_type text not null,
  active boolean,
  start_at timestamptz,
  end_at timestamptz,
  sessions smallint[] not null default '{}',
  last_updated_at timestamptz,
  seen_at timestamptz not null default now(),
  removed_at timestamptz
);
create index cms_live_action_settings_animal_idx on cms_live_action_settings (animal_id);

create table cms_sort_areas (
  area_key text primary key,
  area_number text,
  area_name text,
  seen_at timestamptz not null default now()
);

create trigger trg_cms_separation_batches_updated_at before update on cms_separation_batches
  for each row execute function set_updated_at();
create trigger trg_cms_separation_jobs_updated_at before update on cms_separation_jobs
  for each row execute function set_updated_at();

alter table cms_separation_batches enable row level security;
alter table cms_separation_jobs enable row level security;
alter table cms_separation_events enable row level security;
alter table cms_live_action_settings enable row level security;
alter table cms_sort_areas enable row level security;

-- Read for active users; every write goes through the definer RPCs below.
create policy cms_batches_select on cms_separation_batches for select to authenticated using (fn_is_authenticated_active());
create policy cms_jobs_select on cms_separation_jobs for select to authenticated using (fn_is_authenticated_active());
create policy cms_events_select on cms_separation_events for select to authenticated using (fn_is_authenticated_active());
create policy cms_live_select on cms_live_action_settings for select to authenticated using (fn_is_authenticated_active());
create policy cms_areas_select on cms_sort_areas for select to authenticated using (fn_is_authenticated_active());
grant select on cms_separation_batches, cms_separation_jobs, cms_separation_events, cms_live_action_settings, cms_sort_areas to authenticated;
grant all on cms_separation_batches, cms_separation_jobs, cms_separation_events, cms_live_action_settings, cms_sort_areas to service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function fn_cms_verified_modes()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array(select jsonb_array_elements_text(nullif(setting_value, '')::jsonb)), '{}')
  from system_settings where setting_key = 'cms_verified_modes';
$$;

-- Active SortCow in DelPro (last live read) for an animal.
create or replace function fn_cms_live_active(p_animal_id uuid)
returns cms_live_action_settings
language sql
stable
security definer
set search_path = public
as $$
  select * from cms_live_action_settings
  where animal_id = p_animal_id and action_type = 'SortCow' and removed_at is null
    and active is true and (end_at is null or end_at > now())
  order by start_at desc nulls last
  limit 1;
$$;

-- Everything that stops a job from being submitted / approved / sent. [] = sendable (subject to the mode gate).
create or replace function fn_cms_job_problems(j cms_separation_jobs)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a animals%rowtype;
  v jsonb := '[]'::jsonb;
  v_live cms_live_action_settings;
  s smallint;
begin
  select * into a from animals where id = j.animal_id;
  if not found or not a.active then
    v := v || jsonb_build_object('code', 'animal_inactive', 'message', 'Gyvulys neaktyvus arba nerastas.');
  elsif a.delpro_object_guid is null then
    v := v || jsonb_build_object('code', 'no_guid', 'message', 'Gyvulys nesusietas su DelPro (nėra ObjectGuid).');
  end if;

  if j.mode = 'once' then
    v := v || jsonb_build_object('code', 'mode_unsupported',
      'message', 'Vienkartinis atskyrimas (Sort Once) per DelPro Gateway nepatikrintas — siųsti negalima.');
  end if;
  if j.start_at is null then
    v := v || jsonb_build_object('code', 'start_missing', 'message', 'Nenurodyta pradžia.');
  end if;
  if j.mode = 'period' then
    if j.end_at is null then
      v := v || jsonb_build_object('code', 'end_missing', 'message', 'Nenurodyta pabaiga.');
    elsif j.start_at is not null and j.end_at <= j.start_at then
      v := v || jsonb_build_object('code', 'end_before_start', 'message', 'Pabaiga turi būti vėliau nei pradžia.');
    end if;
  elsif j.mode = 'ongoing' and j.end_at is not null then
    v := v || jsonb_build_object('code', 'end_not_allowed', 'message', 'Neterminuotas atskyrimas neturi pabaigos.');
  end if;
  if j.end_at is not null and j.end_at <= now() then
    v := v || jsonb_build_object('code', 'end_in_past', 'message', 'Pabaiga jau praėjo.');
  end if;

  if coalesce(array_length(j.sessions, 1), 0) = 0 then
    v := v || jsonb_build_object('code', 'sessions_missing', 'message', 'Nepasirinkta nė viena melžimo sesija.');
  else
    foreach s in array j.sessions loop
      if s is null or s < 1 or s > 10 then
        v := v || jsonb_build_object('code', 'sessions_invalid', 'message', 'Melžimo sesijos turi būti 1–10.');
        exit;
      end if;
    end loop;
    if (select count(distinct x) from unnest(j.sessions) x) <> array_length(j.sessions, 1) then
      v := v || jsonb_build_object('code', 'sessions_invalid', 'message', 'Sesija pasirinkta kelis kartus.');
    end if;
  end if;

  if j.sort_area_key is not null then
    v := v || jsonb_build_object('code', 'destination_unverified',
      'message', 'Konkrečios rūšiavimo vietos parinkimas per Gateway nepatikrintas — tokio nustatymo siųsti negalima.');
  end if;

  v_live := fn_cms_live_active(j.animal_id);
  if v_live.action_key is not null then
    if j.existing_decision is null then
      v := v || jsonb_build_object('code', 'existing_active', 'action_key', v_live.action_key,
        'message', 'DelPro jau turi aktyvų atskyrimą (' || v_live.action_key || ') — pasirinkite: praleisti arba prašyti pakeitimo.');
    elsif j.existing_decision = 'modify' then
      v := v || jsonb_build_object('code', 'modification_unsupported', 'action_key', v_live.action_key,
        'message', 'Esamo DelPro atskyrimo keitimas nepatikrintas — GVET jo nekeičia.');
    end if;
  end if;

  if exists (select 1 from cms_separation_jobs o
             where o.animal_id = j.animal_id and o.id <> j.id
               and o.status in ('pending_approval', 'approved', 'processing', 'needs_review')) then
    v := v || jsonb_build_object('code', 'open_job_exists', 'message', 'Šiam gyvuliui jau yra neužbaigtas GVET atskyrimas.');
  end if;
  return v;
end;
$$;

-- What the worker gets and what the approval freezes.
create or replace function fn_cms_snapshot(j cms_separation_jobs)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'job_id', j.id, 'batch_id', j.batch_id, 'animal_id', a.id, 'orn', a.tag_no, 'animal_no', a.animal_no,
    'animal_guid', a.delpro_object_guid, 'mode', j.mode, 'action_type', 'SortCow',
    'start_at', to_char(j.start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'end_at', to_char(j.end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'sessions', to_jsonb(array(select x from unnest(j.sessions) x order by x)),
    'sort_area_key', j.sort_area_key)
  from animals a where a.id = j.animal_id;
$$;

create or replace function fn_cms_log(p_job uuid, p_batch uuid, p_event text, p_details jsonb, p_worker text default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into cms_separation_events (job_id, batch_id, event, actor, worker_id, details)
  values (p_job, p_batch, p_event, auth.uid(), p_worker, p_details);
$$;

create or replace function fn_cms_require_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not fn_is_admin() then
    raise exception 'CMS atskyrimus tvirtinti ir siųsti gali tik administratorius.';
  end if;
end;
$$;

-- Europe/Vilnius wall-clock text ("2026-11-03T08:00") -> timestamptz; empty -> null.
create or replace function fn_cms_local_ts(p text)
returns timestamptz
language plpgsql
immutable
as $$
begin
  if nullif(btrim(coalesce(p, '')), '') is null then
    return null;
  end if;
  return (replace(btrim(p), 'T', ' ')::timestamp) at time zone 'Europe/Vilnius';
exception when others then
  raise exception 'Netinkama data/laikas: %', p;
end;
$$;

-- ---------------------------------------------------------------------------
-- User RPCs
-- ---------------------------------------------------------------------------

-- cms_save_batch(jsonb): { batch_id?, note?, common_settings?, submit?, items: [ { animal_id, mode, start_local,
--   end_local, sessions:[1,2], sort_area_key?, note?, existing_decision?, is_override?, requested? } ] }
-- A draft is replaced as a whole on every save. submit=true refuses while any included animal has a problem;
-- existing_decision 'skip' -> skipped, 'modify' -> needs_review (held, never sent).
create or replace function cms_save_batch(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b cms_separation_batches%rowtype;
  it jsonb;
  j cms_separation_jobs%rowtype;
  v_problems jsonb;
  v_blocking jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_submit boolean := coalesce((p_data->>'submit')::boolean, false);
  v_sessions smallint[];
  v_counts jsonb;
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės kurti CMS atskyrimų.';
  end if;
  if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') = 0 then
    raise exception 'Pasirinkite bent vieną gyvulį.';
  end if;
  if jsonb_array_length(p_data->'items') > 2000 then
    raise exception 'Per daug gyvulių vienoje partijoje (daugiausia 2000).';
  end if;

  if nullif(p_data->>'batch_id', '') is not null then
    select * into b from cms_separation_batches where id = (p_data->>'batch_id')::uuid for update;
    if not found then
      raise exception 'Partija nerasta.';
    end if;
    if b.status <> 'draft' then
      raise exception 'Pateiktos partijos keisti negalima — atšaukite ir sukurkite naują.';
    end if;
    if b.created_by is distinct from auth.uid() and not fn_is_admin() then
      raise exception 'Šį juodraštį gali keisti tik jo autorius arba administratorius.';
    end if;
    update cms_separation_batches set note = nullif(btrim(p_data->>'note'), ''),
      common_settings = coalesce(p_data->'common_settings', '{}'::jsonb)
    where id = b.id returning * into b;
    delete from cms_separation_jobs where batch_id = b.id;
  else
    insert into cms_separation_batches (note, common_settings)
    values (nullif(btrim(p_data->>'note'), ''), coalesce(p_data->'common_settings', '{}'::jsonb))
    returning * into b;
  end if;

  for it in select * from jsonb_array_elements(p_data->'items') loop
    begin
      v_sessions := array(select (x)::smallint from jsonb_array_elements_text(coalesce(it->'sessions', '[]'::jsonb)) x);
    exception when others then
      raise exception 'Netinkamos melžimo sesijos.';
    end;
    insert into cms_separation_jobs (batch_id, animal_id, mode, start_at, end_at, sessions, sort_area_key, note,
      existing_decision, is_override, requested_settings)
    values (b.id, (it->>'animal_id')::uuid, coalesce(nullif(it->>'mode', ''), 'period'),
      fn_cms_local_ts(it->>'start_local'), fn_cms_local_ts(it->>'end_local'), v_sessions,
      nullif(btrim(it->>'sort_area_key'), ''), nullif(btrim(it->>'note'), ''),
      nullif(it->>'existing_decision', ''), coalesce((it->>'is_override')::boolean, false), it)
    returning * into j;
    update cms_separation_jobs set effective_settings = fn_cms_snapshot(j) where id = j.id;
  end loop;

  if v_submit then
    for j in select * from cms_separation_jobs where batch_id = b.id order by created_at loop
      v_problems := fn_cms_job_problems(j);
      -- skip: excluded on purpose, whatever else is wrong
      if j.existing_decision = 'skip' and (fn_cms_live_active(j.animal_id)).action_key is not null then
        update cms_separation_jobs set status = 'skipped', last_error = 'Praleista: DelPro jau turi aktyvų atskyrimą.' where id = j.id;
        continue;
      end if;
      v_blocking := coalesce((select jsonb_agg(p) from jsonb_array_elements(v_problems) p
                              where p->>'code' <> 'modification_unsupported'), '[]'::jsonb);
      if jsonb_array_length(v_blocking) > 0 then
        v_errors := v_errors || jsonb_build_object('animal_id', j.animal_id, 'problems', v_blocking);
      elsif j.existing_decision = 'modify' and (fn_cms_live_active(j.animal_id)).action_key is not null then
        update cms_separation_jobs set status = 'needs_review',
          last_error = 'Prašoma pakeisti esamą DelPro atskyrimą — GVET jo nekeičia (atnaujinimas nepatikrintas).' where id = j.id;
      else
        update cms_separation_jobs set status = 'pending_approval' where id = j.id;
      end if;
    end loop;
    if jsonb_array_length(v_errors) > 0 then
      raise exception 'Partijos pateikti negalima: % gyvul. turi klaidų. Pataisykite arba pašalinkite juos.', jsonb_array_length(v_errors)
        using detail = v_errors::text;
    end if;
    update cms_separation_batches set status = 'submitted', submitted_by = auth.uid(), submitted_at = now() where id = b.id;
    perform fn_cms_log(null, b.id, 'submitted', jsonb_build_object('items', jsonb_array_length(p_data->'items')));
  else
    update cms_separation_jobs set status = 'draft' where batch_id = b.id;
    perform fn_cms_log(null, b.id, 'draft_saved', jsonb_build_object('items', jsonb_array_length(p_data->'items')));
  end if;

  select jsonb_object_agg(status, n) into v_counts from (select status, count(*) n from cms_separation_jobs where batch_id = b.id group by status) c;
  return jsonb_build_object('ok', true, 'batch_id', b.id, 'submitted', v_submit, 'counts', coalesce(v_counts, '{}'::jsonb));
end;
$$;

-- Problems for a set of items WITHOUT saving (pre-send preview). Same rules as submit.
create or replace function cms_check_items(p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  it jsonb;
  j cms_separation_jobs;
  v_out jsonb := '[]'::jsonb;
  v_live cms_live_action_settings;
begin
  if not fn_is_authenticated_active() then
    raise exception 'Neprisijungta.';
  end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    j := null;
    j.id := coalesce(nullif(it->>'job_id', '')::uuid, '00000000-0000-0000-0000-000000000000'::uuid);
    j.animal_id := (it->>'animal_id')::uuid;
    j.mode := coalesce(nullif(it->>'mode', ''), 'period');
    j.start_at := fn_cms_local_ts(it->>'start_local');
    j.end_at := fn_cms_local_ts(it->>'end_local');
    begin
      j.sessions := array(select (x)::smallint from jsonb_array_elements_text(coalesce(it->'sessions', '[]'::jsonb)) x);
    exception when others then
      j.sessions := array[0::smallint];
    end;
    j.sort_area_key := nullif(btrim(it->>'sort_area_key'), '');
    j.existing_decision := nullif(it->>'existing_decision', '');
    v_live := fn_cms_live_active(j.animal_id);
    v_out := v_out || jsonb_build_object('animal_id', j.animal_id, 'problems', fn_cms_job_problems(j),
      'start_at', j.start_at, 'end_at', j.end_at,
      'live', case when v_live.action_key is null then null else to_jsonb(v_live) end);
  end loop;
  return v_out;
end;
$$;

create or replace function cms_delete_draft(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b cms_separation_batches%rowtype;
begin
  select * into b from cms_separation_batches where id = p_batch_id for update;
  if not found or b.status <> 'draft' then
    raise exception 'Juodraštis nerastas.';
  end if;
  if b.created_by is distinct from auth.uid() and not fn_is_admin() then
    raise exception 'Šį juodraštį gali ištrinti tik jo autorius arba administratorius.';
  end if;
  delete from cms_separation_batches where id = b.id;
  return jsonb_build_object('ok', true);
end;
$$;

-- Admin: approve several jobs. Each is re-validated and frozen; already approved ones are left as they are.
create or replace function cms_approve_jobs(p_job_ids uuid[], p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j cms_separation_jobs%rowtype;
  v_problems jsonb;
  v_ok integer := 0;
  v_same integer := 0;
  v_refused jsonb := '[]'::jsonb;
begin
  perform fn_cms_require_admin();
  if not coalesce(p_confirm, false) then
    raise exception 'Patvirtinkite, kad šie nustatymai gali valdyti fizinį gyvulių atskyrimą per DelPro CMS.';
  end if;
  for j in select * from cms_separation_jobs where id = any (p_job_ids) order by created_at for update loop
    if j.status in ('approved', 'processing', 'success') then
      v_same := v_same + 1;
      continue;
    end if;
    if j.status <> 'pending_approval' then
      v_refused := v_refused || jsonb_build_object('job_id', j.id, 'reason', 'Būsena ' || j.status || ' — tvirtinti negalima.');
      continue;
    end if;
    v_problems := fn_cms_job_problems(j);
    if jsonb_array_length(v_problems) > 0 then
      v_refused := v_refused || jsonb_build_object('job_id', j.id,
        'reason', (select string_agg(p->>'message', ' ') from jsonb_array_elements(v_problems) p));
      continue;
    end if;
    update cms_separation_jobs
    set status = 'approved', approved_by = auth.uid(), approved_at = now(), approved_snapshot = fn_cms_snapshot(j),
        animal_guid = (select delpro_object_guid from animals where id = j.animal_id), last_error = null, next_attempt_at = null
    where id = j.id;
    perform fn_cms_log(j.id, j.batch_id, 'approved', fn_cms_snapshot(j));
    insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
    values (auth.uid(), 'cms_approve', 'cms_separation_jobs', j.id, fn_cms_snapshot(j));
    v_ok := v_ok + 1;
  end loop;
  return jsonb_build_object('ok', true, 'approved', v_ok, 'unchanged', v_same, 'refused', v_refused);
end;
$$;

-- Cancel: the author (or any active staff) while pending; an admin also approved / error / needs_review.
-- A job being processed can't be cancelled (the worker may be writing it).
create or replace function cms_cancel_jobs(p_job_ids uuid[], p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j cms_separation_jobs%rowtype;
  v_ok integer := 0;
  v_refused jsonb := '[]'::jsonb;
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės.';
  end if;
  for j in select * from cms_separation_jobs where id = any (p_job_ids) for update loop
    if j.status = 'pending_approval' or (fn_is_admin() and j.status in ('approved', 'error', 'needs_review')) then
      update cms_separation_jobs set status = 'cancelled', last_error = coalesce(nullif(btrim(p_reason), ''), last_error) where id = j.id;
      perform fn_cms_log(j.id, j.batch_id, 'cancelled', jsonb_build_object('reason', p_reason, 'from', j.status));
      v_ok := v_ok + 1;
    else
      v_refused := v_refused || jsonb_build_object('job_id', j.id, 'reason', 'Būsena ' || j.status || ' — atšaukti negalima.');
    end if;
  end loop;
  update cms_separation_batches b set status = 'cancelled'
  where b.status = 'submitted' and b.id in (select batch_id from cms_separation_jobs where id = any (p_job_ids))
    and not exists (select 1 from cms_separation_jobs x where x.batch_id = b.id and x.status not in ('cancelled', 'skipped'));
  return jsonb_build_object('ok', true, 'cancelled', v_ok, 'refused', v_refused);
end;
$$;

-- Admin decisions on a failed / unclear job:
--   retry          error -> approved (only when nothing may have reached DelPro)
--   confirm_absent needs_review -> approved (admin checked DelPro: the record is NOT there)
--   adopt          needs_review -> approved with adopt_key (admin found the record; the worker reads it back and compares)
create or replace function cms_job_action(p_job_id uuid, p_action text, p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j cms_separation_jobs%rowtype;
begin
  perform fn_cms_require_admin();
  select * into j from cms_separation_jobs where id = p_job_id for update;
  if not found then
    raise exception 'Užduotis nerasta.';
  end if;
  if p_action = 'retry' then
    if j.status <> 'error' then
      raise exception 'Kartoti galima tik klaidos būsenos užduotį.';
    end if;
    if j.write_started_at is not null then
      raise exception 'Įrašymas galėjo pasiekti DelPro — pirmiau patikrinkite DelPro (Reikia peržiūros).';
    end if;
    if jsonb_array_length(fn_cms_job_problems(j)) > 0 then
      raise exception 'Užduotis turi klaidų: %', (select string_agg(p->>'message', ' ') from jsonb_array_elements(fn_cms_job_problems(j)) p);
    end if;
  elsif p_action = 'confirm_absent' then
    if j.status <> 'needs_review' or j.approved_snapshot is null then
      raise exception 'Netinka šiai užduočiai.';
    end if;
  elsif p_action = 'adopt' then
    if j.status <> 'needs_review' or j.approved_snapshot is null then
      raise exception 'Netinka šiai užduočiai.';
    end if;
    if nullif(btrim(p_key), '') is null or btrim(p_key) !~ '^[0-9]+$' then
      raise exception 'Nurodykite DelPro AnimalActionSetting raktą (skaičius).';
    end if;
  else
    raise exception 'Nežinomas veiksmas.';
  end if;
  update cms_separation_jobs
  set status = 'approved', write_started_at = null, next_attempt_at = null, claimed_by = null, claimed_at = null,
      adopt_key = case when p_action = 'adopt' then btrim(p_key) else null end
  where id = j.id;
  perform fn_cms_log(j.id, j.batch_id, p_action, jsonb_build_object('key', p_key, 'from', j.status));
  insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), 'cms_' || p_action, 'cms_separation_jobs', j.id, to_jsonb(j), jsonb_build_object('key', p_key));
  return jsonb_build_object('ok', true);
end;
$$;

-- Admin: let the worker take exactly ONE approved job (supervised single-animal test). null clears it.
create or replace function cms_release_single_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j cms_separation_jobs%rowtype;
begin
  perform fn_cms_require_admin();
  if p_job_id is not null then
    select * into j from cms_separation_jobs where id = p_job_id;
    if not found or j.status <> 'approved' then
      raise exception 'Išleisti galima tik patvirtintą užduotį.';
    end if;
  end if;
  update system_settings set setting_value = coalesce(p_job_id::text, '') where setting_key = 'cms_single_job_id';
  perform fn_cms_log(p_job_id, j.batch_id, case when p_job_id is null then 'single_cleared' else 'single_released' end, null);
  return jsonb_build_object('ok', true);
end;
$$;

-- Admin: a mode becomes routinely sendable only after one job of that mode was written AND read back
-- (success) and the admin confirms the cow was physically sorted. Removing it stops routine sending.
create or replace function cms_set_mode_verified(p_mode text, p_verified boolean, p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v text[] := fn_cms_verified_modes();
begin
  perform fn_cms_require_admin();
  if p_mode not in ('period', 'ongoing') then
    raise exception 'Šio režimo patvirtinti negalima.';
  end if;
  if p_verified then
    if not coalesce(p_confirm, false) then
      raise exception 'Patvirtinkite, kad karvė DelPro sistemoje buvo realiai atskirta.';
    end if;
    if not exists (select 1 from cms_separation_jobs where status = 'success' and mode = p_mode and verified_at is not null) then
      raise exception 'Pirmiau turi būti sėkmingai perduotas ir patikrintas bent vienas šio režimo atskyrimas.';
    end if;
    v := array(select distinct x from unnest(v || p_mode) x order by x);
  else
    v := array_remove(v, p_mode);
  end if;
  update system_settings set setting_value = to_jsonb(v)::text where setting_key = 'cms_verified_modes';
  insert into user_audit_logs (user_id, action, table_name, new_data)
  values (auth.uid(), 'cms_set_mode_verified', 'system_settings', jsonb_build_object('mode', p_mode, 'verified', p_verified));
  return jsonb_build_object('ok', true, 'verified_modes', to_jsonb(v));
end;
$$;

create or replace function cms_request_live_refresh()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės.';
  end if;
  update system_settings set setting_value = now()::text where setting_key = 'cms_live_refresh_requested_at';
  return jsonb_build_object('ok', true, 'message', 'Paprašyta — ūkio kompiuteris nuskaitys per kelias minutes.');
end;
$$;

-- Gate + live-read state for every active user (system_settings itself is admin-only).
create or replace function cms_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_info jsonb;
begin
  if not fn_is_authenticated_active() then
    raise exception 'Neprisijungta.';
  end if;
  select nullif(setting_value, '')::jsonb into v_info from system_settings where setting_key = 'delpro_worker_info';
  return jsonb_build_object(
    'verified_modes', to_jsonb(fn_cms_verified_modes()),
    'single_job_id', (select nullif(setting_value, '') from system_settings where setting_key = 'cms_single_job_id'),
    'live_last_refresh', (select nullif(setting_value, '')::jsonb from system_settings where setting_key = 'cms_live_last_refresh'),
    'live_requested_at', (select nullif(setting_value, '') from system_settings where setting_key = 'cms_live_refresh_requested_at'),
    'worker_cms_mode', v_info->>'cms_outbound_mode',
    'worker_seen_at', (select nullif(setting_value, '') from system_settings where setting_key = 'delpro_worker_last_seen_at'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker RPCs (service_role only; single unnamed jsonb body)
-- ---------------------------------------------------------------------------

-- { worker_id, job_id? } -> one job (processing) or null.
-- Stale processing jobs (lease 10 min) go back to approved, or to needs_review once the write had started.
create or replace function cms_claim_next_job(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  v_worker text := nullif(btrim(p_body->>'worker_id'), '');
  v_want uuid := nullif(p_body->>'job_id', '')::uuid;
  v_single uuid;
  j cms_separation_jobs%rowtype;
begin
  if v_worker is null then
    raise exception 'worker_id privalomas.';
  end if;

  for j in select * from cms_separation_jobs where status = 'processing' and claimed_at < now() - interval '10 minutes' for update skip locked loop
    if j.write_started_at is not null then
      update cms_separation_jobs set status = 'needs_review',
        last_error = 'Darbininkas nutrūko po įrašymo pradžios — patikrinkite DelPro prieš kartojant.' where id = j.id;
      perform fn_cms_log(j.id, j.batch_id, 'stale_needs_review', null, v_worker);
    else
      update cms_separation_jobs set status = 'approved', claimed_by = null, claimed_at = null where id = j.id;
      perform fn_cms_log(j.id, j.batch_id, 'stale_released', null, v_worker);
    end if;
  end loop;

  select nullif(setting_value, '')::uuid into v_single from system_settings where setting_key = 'cms_single_job_id';
  if v_single is not null then
    if v_want is distinct from v_single then
      return null;
    end if;
    select * into j from cms_separation_jobs where id = v_single and status = 'approved' for update skip locked;
  elsif v_want is not null then
    return null;
  else
    select * into j from cms_separation_jobs
    where status = 'approved' and (next_attempt_at is null or next_attempt_at <= now())
      and approved_snapshot->>'mode' = any (fn_cms_verified_modes())
    order by approved_at, created_at
    limit 1
    for update skip locked;
  end if;
  if j.id is null then
    return null;
  end if;
  if j.approved_snapshot is null then
    return null;
  end if;

  update cms_separation_jobs
  set status = 'processing', claimed_by = v_worker, claimed_at = now(), attempts = attempts + 1, last_error = null
  where id = j.id returning * into j;
  perform fn_cms_log(j.id, j.batch_id, 'claimed', jsonb_build_object('attempt', j.attempts), v_worker);
  return jsonb_build_object('job_id', j.id, 'attempts', j.attempts, 'adopt_key', j.adopt_key,
    'snapshot', j.approved_snapshot, 'single', v_single is not null);
end;
$$;

-- { job_id, worker_id, phase: 'start', milk_setting_key }  — right before CreateData
-- { job_id, worker_id, phase: 'result', outcome: success|error|retry|unknown, action_key?, milk_setting_key?,
--   readback?: { verified, diffs, record }, gateway_summary?, error_message?, error_details? }
create or replace function cms_report_job(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  j cms_separation_jobs%rowtype;
  v_outcome text := p_body->>'outcome';
  v_status text;
  v_err text := nullif(btrim(p_body->>'error_message'), '');
begin
  select * into j from cms_separation_jobs where id = (p_body->>'job_id')::uuid for update;
  if not found then
    raise exception 'Užduotis nerasta.';
  end if;
  if j.status <> 'processing' or j.claimed_by is distinct from p_body->>'worker_id' then
    raise exception 'Užduotis nėra šio darbininko vykdoma (būsena %).', j.status;
  end if;

  if p_body->>'phase' = 'start' then
    update cms_separation_jobs set write_started_at = now(), milk_setting_key = nullif(p_body->>'milk_setting_key', '') where id = j.id;
    perform fn_cms_log(j.id, j.batch_id, 'write_started', p_body - 'worker_id', p_body->>'worker_id');
    return jsonb_build_object('ok', true);
  end if;

  if v_outcome = 'success' then
    if coalesce((p_body#>>'{readback,verified}')::boolean, false) and nullif(p_body->>'action_key', '') is not null then
      v_status := 'success';
      v_err := null;
    else
      v_status := 'needs_review';
      v_err := coalesce(v_err, 'DelPro įrašas nepatvirtintas nuskaitymu — patikrinkite ranka.');
    end if;
  elsif v_outcome = 'error' then
    v_status := 'error';
  elsif v_outcome = 'retry' and j.write_started_at is null then
    v_status := case when j.attempts >= 5 then 'error' else 'approved' end;
  else
    v_status := 'needs_review';
    v_err := coalesce(v_err, 'Įrašymo rezultatas nežinomas — patikrinkite DelPro.');
  end if;
  -- an error after the write started may have reached DelPro: never a plain, retryable error
  if v_status = 'error' and j.write_started_at is not null then
    v_status := 'needs_review';
  end if;

  update cms_separation_jobs
  set status = v_status,
      action_key = coalesce(nullif(p_body->>'action_key', ''), action_key),
      milk_setting_key = coalesce(nullif(p_body->>'milk_setting_key', ''), milk_setting_key),
      readback = coalesce(p_body->'readback', readback),
      gateway_summary = coalesce(p_body->'gateway_summary', gateway_summary),
      last_error = v_err,
      error_details = p_body->'error_details',
      verified_at = case when v_status = 'success' then now() else verified_at end,
      next_attempt_at = case when v_status = 'approved' then now() + make_interval(mins => least(60, (2 ^ j.attempts)::integer)) else null end,
      claimed_by = case when v_status = 'approved' then null else claimed_by end,
      adopt_key = case when v_status = 'success' then null else adopt_key end
  where id = j.id;
  perform fn_cms_log(j.id, j.batch_id, 'result_' || v_status, p_body - 'worker_id', p_body->>'worker_id');
  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;

-- The single-job gate closes by itself once that job is finished (any end state).
create or replace function fn_cms_close_single_gate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status not in ('approved', 'processing') then
    update system_settings set setting_value = '' where setting_key = 'cms_single_job_id' and setting_value = new.id::text;
  end if;
  return new;
end;
$$;
create trigger trg_cms_close_single_gate after update of status on cms_separation_jobs
  for each row execute function fn_cms_close_single_gate();

create or replace function cms_get_job(jsonb)
returns jsonb
language sql
stable
security invoker
as $$
  select jsonb_build_object('job_id', j.id, 'status', j.status, 'snapshot', coalesce(j.approved_snapshot, fn_cms_snapshot(j)),
    'approved', j.approved_snapshot is not null, 'adopt_key', j.adopt_key, 'problems', fn_cms_job_problems(j),
    'single_released', (select setting_value from system_settings where setting_key = 'cms_single_job_id') = j.id::text,
    'verified_modes', to_jsonb(fn_cms_verified_modes()))
  from cms_separation_jobs j where j.id = ($1->>'job_id')::uuid;
$$;

create or replace function cms_live_requested(jsonb)
returns boolean
language sql
stable
security invoker
as $$
  select coalesce(nullif(r.setting_value, '')::timestamptz
    > coalesce(nullif(l.setting_value, '')::jsonb->>'finished_at', '-infinity')::timestamptz, false)
  from system_settings r, system_settings l
  where r.setting_key = 'cms_live_refresh_requested_at' and l.setting_key = 'cms_live_last_refresh';
$$;

-- { complete: bool, actions: [ { key, milk_setting_key, animal_guid, action_type, active, start_at, end_at,
--   sessions:[..], last_updated_at } ], sort_areas: [ { key, number, name } ], errors: [] }
-- Only a complete read marks records missing from it as removed.
create or replace function cms_live_upload(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  a jsonb;
  v_now timestamptz := now();
  v_n integer := 0;
  v_unmatched integer := 0;
  v_removed integer := 0;
  v_guid uuid;
  v_animal uuid;
  v_res jsonb;
begin
  for a in select * from jsonb_array_elements(coalesce(p_body->'actions', '[]'::jsonb)) loop
    continue when nullif(a->>'key', '') is null;
    begin
      v_guid := nullif(a->>'animal_guid', '')::uuid;
    exception when invalid_text_representation then
      v_guid := null;
    end;
    select id into v_animal from animals where delpro_object_guid = v_guid limit 1;
    if v_animal is null then
      v_unmatched := v_unmatched + 1;
    end if;
    insert into cms_live_action_settings (action_key, milk_setting_key, animal_guid, animal_id, action_type, active,
      start_at, end_at, sessions, last_updated_at, seen_at, removed_at)
    values (a->>'key', nullif(a->>'milk_setting_key', ''), v_guid, v_animal, coalesce(nullif(a->>'action_type', ''), '?'),
      nullif(a->>'active', '')::boolean, nullif(a->>'start_at', '')::timestamptz, nullif(a->>'end_at', '')::timestamptz,
      array(select (x)::smallint from jsonb_array_elements_text(coalesce(a->'sessions', '[]'::jsonb)) x),
      nullif(a->>'last_updated_at', '')::timestamptz, v_now, null)
    on conflict (action_key) do update set milk_setting_key = excluded.milk_setting_key, animal_guid = excluded.animal_guid,
      animal_id = excluded.animal_id, action_type = excluded.action_type, active = excluded.active, start_at = excluded.start_at,
      end_at = excluded.end_at, sessions = excluded.sessions, last_updated_at = excluded.last_updated_at,
      seen_at = v_now, removed_at = null;
    v_n := v_n + 1;
  end loop;

  if coalesce((p_body->>'complete')::boolean, false) then
    update cms_live_action_settings set removed_at = v_now where seen_at < v_now and removed_at is null;
    get diagnostics v_removed = row_count;
  end if;

  for a in select * from jsonb_array_elements(coalesce(p_body->'sort_areas', '[]'::jsonb)) loop
    continue when nullif(a->>'key', '') is null;
    insert into cms_sort_areas (area_key, area_number, area_name, seen_at)
    values (a->>'key', nullif(a->>'number', ''), nullif(a->>'name', ''), v_now)
    on conflict (area_key) do update set area_number = excluded.area_number, area_name = excluded.area_name, seen_at = v_now;
  end loop;

  v_res := jsonb_build_object('finished_at', v_now, 'received', v_n, 'unmatched_animals', v_unmatched, 'removed', v_removed,
    'complete', coalesce((p_body->>'complete')::boolean, false), 'errors', coalesce(p_body->'errors', '[]'::jsonb),
    'worker_id', p_body->>'worker_id');
  update system_settings set setting_value = v_res::text where setting_key = 'cms_live_last_refresh';
  return v_res;
end;
$$;

-- ---------------------------------------------------------------------------
-- View for the screens
-- ---------------------------------------------------------------------------

create view vw_cms_separation_jobs with (security_invoker = true) as
select j.id, j.batch_id, j.animal_id, j.status, j.mode, j.start_at, j.end_at, j.sessions, j.sort_area_key, j.note,
  j.existing_decision, j.is_override, j.requested_settings, j.effective_settings, j.approved_snapshot, j.animal_guid,
  j.milk_setting_key, j.action_key, j.adopt_key, j.created_by, j.created_at, j.updated_at, j.approved_by, j.approved_at,
  j.attempts, j.next_attempt_at, j.claimed_by, j.claimed_at, j.write_started_at, j.last_error, j.error_details,
  j.gateway_summary, j.readback, j.verified_at,
  a.tag_no, a.animal_no, a.name as animal_name, a.group_name, a.delpro_object_guid,
  b.status as batch_status, b.note as batch_note, b.created_at as batch_created_at,
  cu.full_name as created_by_name, au.full_name as approved_by_name,
  case when j.status in ('draft', 'pending_approval', 'approved') then fn_cms_job_problems(j) else '[]'::jsonb end as problems
from cms_separation_jobs j
join animals a on a.id = j.animal_id
join cms_separation_batches b on b.id = j.batch_id
left join users cu on cu.id = j.created_by
left join users au on au.id = j.approved_by;

grant select on vw_cms_separation_jobs to authenticated;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function cms_save_batch(jsonb), cms_check_items(jsonb), cms_delete_draft(uuid), cms_approve_jobs(uuid[], boolean),
  cms_cancel_jobs(uuid[], text), cms_job_action(uuid, text, text), cms_release_single_job(uuid),
  cms_set_mode_verified(text, boolean, boolean), cms_request_live_refresh(), cms_status() from public, anon;
grant execute on function cms_save_batch(jsonb), cms_check_items(jsonb), cms_delete_draft(uuid), cms_approve_jobs(uuid[], boolean),
  cms_cancel_jobs(uuid[], text), cms_job_action(uuid, text, text), cms_release_single_job(uuid),
  cms_set_mode_verified(text, boolean, boolean), cms_request_live_refresh(), cms_status() to authenticated;

revoke all on function cms_claim_next_job(jsonb), cms_report_job(jsonb), cms_get_job(jsonb), cms_live_requested(jsonb),
  cms_live_upload(jsonb) from public, anon, authenticated;
grant execute on function cms_claim_next_job(jsonb), cms_report_job(jsonb), cms_get_job(jsonb), cms_live_requested(jsonb),
  cms_live_upload(jsonb) to service_role;

revoke all on function fn_cms_log(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function fn_cms_log(uuid, uuid, text, jsonb, text) to service_role;

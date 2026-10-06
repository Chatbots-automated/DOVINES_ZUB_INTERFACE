-- 0006_delpro_integration.sql
-- Dovinės ŽŪB GVET PRO — DelPro (DeLaval) integration, Priedas Nr. 1 §3-§4.
--
-- DelPro Farm Manager is a Windows desktop application with no public API;
-- it keeps its data in a local MS SQL Server database on the farm PC. The
-- integration is therefore a small Windows worker (`delpro-worker/` in this
-- repo) running on that PC, making OUTBOUND-ONLY calls to these Postgres
-- RPCs via PostgREST with the service-role key. The database itself never
-- performs network I/O.
--
--   DelPro -> GVET (§3):  worker reads DelPro read-only, POSTs a full herd
--                         snapshot to upsert_animals_from_delpro(jsonb).
--   GVET -> DelPro (§4):  every new treatment enqueues a delpro_sync_jobs
--                         row. Approval mode (default): an admin approves
--                         it in the app; auto mode: it becomes claimable
--                         after a settle delay. The worker claims it
--                         (delpro_claim_next_job), writes it into DelPro,
--                         reads it back, and reports
--                         (delpro_report_job_result) — mismatches become
--                         verification_failed, not success.
--
-- Queue/approval/claim/report shape ported from ZUB_ZIBARTONIAI_INTERFACE's
-- 0021_uniform_approval_workflow.sql. Key difference: there, `payload` was
-- frozen at treatment-insert time — before any usage_items existed, so
-- withdrawal dates were always null in it. Here the pending payload is
-- never stored; vw_delpro_sync_jobs builds it live, and it is only frozen
-- (approved_payload) at approval / auto-claim time.
--
-- PostgREST passthrough: worker-facing functions that take a request body
-- use a single UNNAMED jsonb parameter (see Žibartoniai AGENTS.md — a named
-- one 404s with PGRST202).

insert into system_settings (setting_key, setting_value, description) values
  ('delpro_outbound_mode', 'approval', 'GVET -> DelPro gydymų siuntimas: approval (administratorius tvirtina) | auto (automatiškai po delsos) | off'),
  ('delpro_auto_delay_minutes', '10', 'Auto režimu: kiek minučių po gydymo įrašo sukūrimo jis tampa siunčiamas (laikas pataisymams).'),
  ('delpro_default_treatment_code', null, 'Sutartas DelPro gydymo įrašas, naudojamas kai produktui nėra atskiro susiejimo (Priedas §4.3).'),
  ('delpro_worker_last_seen_at', null, 'Paskutinis DelPro darbininko (ūkio kompiuteryje) signalas.'),
  ('delpro_worker_info', null, 'DelPro darbininko versija / kompiuterio informacija (JSON).'),
  ('delpro_last_inbound_at', null, 'Paskutinis sėkmingas gyvulių duomenų gavimas iš DelPro.');

-- ---------------------------------------------------------------------------
-- delpro_sync_runs — inbound (and heartbeat-level) run log for the admin
-- screen: "when did DelPro data last arrive, and how much".
-- ---------------------------------------------------------------------------

create table delpro_sync_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'animals' check (kind in ('animals')),
  worker_id text,
  received_rows integer not null default 0,
  inserted integer not null default 0,
  updated integer not null default 0,
  deactivated integer not null default 0,
  groups_received integer not null default 0,
  skipped integer not null default 0,
  error text,
  created_at timestamptz not null default now()
);

create index delpro_sync_runs_created_at_idx on delpro_sync_runs (created_at desc);

-- ---------------------------------------------------------------------------
-- upsert_animals_from_delpro(jsonb) — DelPro -> GVET (§3).
--
-- Body shape (either form):
--   { "worker_id": "farm-pc",
--     "full_snapshot": true,
--     "groups":  [ { "delpro_group_id": "3", "name": "Melžiamos 1" }, ... ],
--     "animals": [ { "delpro_animal_id": "1234", "animal_no": "512",
--                    "tag_no": "LT000012345678", "name": "Rūta",
--                    "sex": "Karvė", "breed": "HOL", "birth_date": "2021-03-14",
--                    "group_id": "3", "group_name": "Melžiamos 1",
--                    "lactation_no": 3, "active": true }, ... ] }
--   or a bare array of animal objects.
--
-- Match order: delpro_animal_id, then tag_no (adopts a manually-created
-- animal the first time DelPro reports it). Patch semantics — a missing
-- field never blanks existing data. With full_snapshot (default true), any
-- source='delpro' animal absent from this run is marked inactive (left the
-- herd). Never deletes: treatment history references animals.id.
-- ---------------------------------------------------------------------------

create or replace function upsert_animals_from_delpro(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  v_animals jsonb;
  v_groups jsonb;
  v_full boolean;
  v_worker text;
  v_received integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_deactivated integer := 0;
  v_groups_received integer := 0;
  v_seen_ids uuid[] := '{}';
  elem jsonb;
  v_id uuid;
  v_dp_id text;
  v_animal_no text;
  v_tag text;
  v_group_id uuid;
  v_group_name text;
  v_birth date;
  v_lact integer;
  v_active boolean;
begin
  if jsonb_typeof(p_body) = 'array' then
    v_animals := p_body;
    v_groups := '[]'::jsonb;
    v_full := true;
  else
    v_animals := coalesce(p_body->'animals', '[]'::jsonb);
    v_groups := coalesce(p_body->'groups', '[]'::jsonb);
    v_full := coalesce((p_body->>'full_snapshot')::boolean, true);
    v_worker := p_body->>'worker_id';
  end if;

  if jsonb_typeof(v_animals) <> 'array' then
    raise exception 'Laukiamas gyvulių sąrašas (JSON masyvas).';
  end if;

  -- Groups first, so animals can reference them. Matched by DelPro group
  -- id, else by name (a group first seen only by name on an animal row
  -- gets its DelPro id attached once the group list reports it).
  for elem in select * from jsonb_array_elements(v_groups) loop
    v_group_name := nullif(trim(elem->>'name'), '');
    continue when v_group_name is null;
    v_groups_received := v_groups_received + 1;
    v_group_id := null;
    if nullif(elem->>'delpro_group_id', '') is not null then
      select id into v_group_id from delpro_groups where delpro_group_id = elem->>'delpro_group_id';
    end if;
    if v_group_id is null then
      select id into v_group_id from delpro_groups where lower(name) = lower(v_group_name);
    end if;
    if v_group_id is null then
      insert into delpro_groups (delpro_group_id, name, active, updated_from_delpro_at)
      values (nullif(elem->>'delpro_group_id', ''), v_group_name, coalesce((elem->>'active')::boolean, true), now());
    else
      update delpro_groups
      set delpro_group_id = coalesce(nullif(elem->>'delpro_group_id', ''), delpro_group_id),
          name = v_group_name,
          active = coalesce((elem->>'active')::boolean, true),
          updated_from_delpro_at = now()
      where id = v_group_id;
    end if;
  end loop;

  v_received := jsonb_array_length(v_animals);

  for elem in select * from jsonb_array_elements(v_animals) loop
    v_dp_id := nullif(trim(elem->>'delpro_animal_id'), '');
    v_animal_no := nullif(trim(elem->>'animal_no'), '');
    v_tag := nullif(trim(elem->>'tag_no'), '');
    -- DelPro can hold animals (young calves) without an official ear tag
    -- yet; tag_no is NOT NULL + unique, so fall back to a stable surrogate.
    if v_tag is null and v_animal_no is not null then
      v_tag := 'DP-' || v_animal_no;
    end if;

    if v_dp_id is null and v_tag is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Resolve group: by DelPro group id, else by name (auto-creating it).
    v_group_id := null;
    v_group_name := nullif(trim(elem->>'group_name'), '');
    if nullif(elem->>'group_id', '') is not null then
      select id, name into v_group_id, v_group_name from delpro_groups where delpro_group_id = elem->>'group_id';
    end if;
    if v_group_id is null and v_group_name is not null then
      select id, name into v_group_id, v_group_name from delpro_groups where lower(name) = lower(v_group_name);
      if v_group_id is null then
        insert into delpro_groups (name, updated_from_delpro_at) values (trim(elem->>'group_name'), now())
        returning id, name into v_group_id, v_group_name;
      end if;
    end if;

    v_birth := case when (elem->>'birth_date') ~ '^\d{4}-\d{2}-\d{2}' then left(elem->>'birth_date', 10)::date end;
    v_lact := case when (elem->>'lactation_no') ~ '^[0-9]+$' then (elem->>'lactation_no')::integer end;
    v_active := coalesce((elem->>'active')::boolean, true);

    -- One bad row (e.g. an ear tag already used by a different animal)
    -- must not abort the whole herd sync: skip it and count it.
    begin
      v_id := null;
      if v_dp_id is not null then
        select id into v_id from animals where delpro_animal_id = v_dp_id;
      end if;
      -- Tag fallback only adopts an animal DelPro doesn't own yet (manual
      -- entry). A tag held by a DIFFERENT DelPro animal is a data conflict
      -- in DelPro itself — skip the row rather than hijack that animal.
      if v_id is null and v_tag is not null then
        select id into v_id from animals where tag_no = v_tag and (delpro_animal_id is null or v_dp_id is null);
        if v_id is null and exists (select 1 from animals where tag_no = v_tag) then
          v_skipped := v_skipped + 1;
          continue;
        end if;
      end if;

      if v_id is null then
        insert into animals (tag_no, animal_no, delpro_animal_id, name, sex, breed, birth_date, group_id, group_name,
                             lactation_no, active, source, updated_from_delpro_at)
        values (v_tag, v_animal_no, v_dp_id, nullif(elem->>'name', ''), nullif(elem->>'sex', ''), nullif(elem->>'breed', ''),
                v_birth, v_group_id, v_group_name, v_lact, v_active, 'delpro', now())
        returning id into v_id;
        v_inserted := v_inserted + 1;
      else
        update animals set
          tag_no = coalesce(v_tag, tag_no),
          animal_no = coalesce(v_animal_no, animal_no),
          delpro_animal_id = coalesce(v_dp_id, delpro_animal_id),
          name = coalesce(nullif(elem->>'name', ''), name),
          sex = coalesce(nullif(elem->>'sex', ''), sex),
          breed = coalesce(nullif(elem->>'breed', ''), breed),
          birth_date = coalesce(v_birth, birth_date),
          group_id = coalesce(v_group_id, group_id),
          group_name = coalesce(v_group_name, group_name),
          lactation_no = coalesce(v_lact, lactation_no),
          active = v_active,
          source = 'delpro',
          updated_from_delpro_at = now()
        where id = v_id;
        v_updated := v_updated + 1;
      end if;

      v_seen_ids := array_append(v_seen_ids, v_id);
    exception when unique_violation then
      v_skipped := v_skipped + 1;
      -- An existing animal whose update failed is still in the herd —
      -- don't let the snapshot deactivation below mark it as gone.
      if v_id is not null then
        v_seen_ids := array_append(v_seen_ids, v_id);
      end if;
    end;
  end loop;

  if v_full and array_length(v_seen_ids, 1) > 0 then
    with deactivated as (
      update animals
      set active = false, updated_from_delpro_at = now()
      where source = 'delpro'
        and active
        and not (id = any (v_seen_ids))
      returning 1
    )
    select count(*) into v_deactivated from deactivated;
  end if;

  insert into delpro_sync_runs (kind, worker_id, received_rows, inserted, updated, deactivated, groups_received, skipped)
  values ('animals', v_worker, v_received, v_inserted, v_updated, v_deactivated, v_groups_received, v_skipped);

  update system_settings set setting_value = now()::text where setting_key in ('delpro_last_inbound_at', 'delpro_worker_last_seen_at');

  return jsonb_build_object(
    'received_rows', v_received,
    'inserted', v_inserted,
    'updated', v_updated,
    'deactivated', v_deactivated,
    'groups_received', v_groups_received,
    'skipped', v_skipped
  );
end;
$$;

revoke all on function upsert_animals_from_delpro(jsonb) from public, authenticated;
grant execute on function upsert_animals_from_delpro(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- delpro_mappings — GVET diagnosis/product -> agreed DelPro record
-- (Priedas §4.3 "naudojamą produktą ar sutartą DelPro gydymo įrašą").
-- Unmapped products fall back to system_settings.delpro_default_treatment_code.
-- ---------------------------------------------------------------------------

create table delpro_mappings (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('disease', 'product')),
  local_id uuid not null,
  delpro_code text,
  delpro_name text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, local_id)
);

create trigger trg_delpro_mappings_updated_at
  before update on delpro_mappings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- fn_build_delpro_payload — the exact contract the worker consumes.
-- Sends both withdrawal end dates and day counts from event_date; which one
-- DelPro's treatment form actually wants is settled during discovery.
-- ---------------------------------------------------------------------------

create or replace function fn_build_delpro_payload(p_treatment_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'treatment_id', t.id,
    'animal', jsonb_build_object(
      'animal_id', a.id,
      'delpro_animal_id', a.delpro_animal_id,
      'animal_no', a.animal_no,
      'tag_no', a.tag_no
    ),
    'delpro', jsonb_build_object(
      'event_date', t.reg_date,
      'diagnosis', coalesce(dm.delpro_name, d.name, t.diagnosis),
      'diagnosis_code', dm.delpro_code,
      'diagnosis_text', t.diagnosis,
      'treatment_code', coalesce(
        (select pm.delpro_code
         from usage_items ui
         join delpro_mappings pm on pm.kind = 'product' and pm.local_id = ui.product_id
         where ui.treatment_id = t.id and pm.delpro_code is not null
         order by ui.created_at
         limit 1),
        (select setting_value from system_settings where setting_key = 'delpro_default_treatment_code')
      ),
      'products', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'product_id', x.product_id,
                 'name', x.name,
                 'qty', x.qty,
                 'unit', x.unit,
                 'administration_route', x.administration_route,
                 'delpro_code', x.delpro_code
               ) order by x.name)
        from (
          select ui.product_id, p.name, sum(ui.qty) as qty, ui.unit, ui.administration_route, pm.delpro_code
          from usage_items ui
          join products p on p.id = ui.product_id
          left join delpro_mappings pm on pm.kind = 'product' and pm.local_id = ui.product_id
          where ui.treatment_id = t.id
          group by ui.product_id, p.name, ui.unit, ui.administration_route, pm.delpro_code
        ) x
      ), '[]'::jsonb),
      'course_days', (select max(tc.days) from treatment_courses tc where tc.treatment_id = t.id and tc.status <> 'cancelled'),
      'withdrawal_until_milk', t.withdrawal_until_milk,
      'withdrawal_until_meat', t.withdrawal_until_meat,
      'milk_withdrawal_days', greatest(coalesce(t.withdrawal_until_milk - t.reg_date, 0), 0),
      'meat_withdrawal_days', greatest(coalesce(t.withdrawal_until_meat - t.reg_date, 0), 0),
      'vet_name', t.vet_name
    )
  )
  from treatments t
  join animals a on a.id = t.animal_id
  left join diseases d on d.id = t.disease_id
  left join delpro_mappings dm on dm.kind = 'disease' and dm.local_id = t.disease_id
  where t.id = p_treatment_id;
$$;

-- ---------------------------------------------------------------------------
-- delpro_sync_jobs — GVET -> DelPro outbound queue (§4).
-- Status flow:
--   pending_approval -> approved -> processing -> success | error | verification_failed
--   pending_approval -> rejected (terminal)
--   error | verification_failed -> approved (retry, same row)
--   pending_approval -> processing directly when auto mode claims it
-- ---------------------------------------------------------------------------

create table delpro_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  treatment_id uuid not null references treatments (id) on delete cascade,
  status text not null default 'pending_approval' check (
    status in ('pending_approval', 'approved', 'rejected', 'processing', 'success', 'error', 'verification_failed')
  ),
  approved_payload jsonb,
  auto_approved boolean not null default false,
  approved_by uuid references users (id) on delete set null,
  approved_at timestamptz,
  rejected_by uuid references users (id) on delete set null,
  rejected_at timestamptz,
  rejection_reason text,
  worker_id text,
  started_at timestamptz,
  completed_at timestamptz,
  attempts integer not null default 0,
  actual_result jsonb,
  verified boolean not null default false,
  verified_at timestamptz,
  error text,
  error_details jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (treatment_id)
);

create index delpro_sync_jobs_status_idx on delpro_sync_jobs (status);

create trigger trg_delpro_sync_jobs_updated_at
  before update on delpro_sync_jobs
  for each row execute function set_updated_at();

comment on column delpro_sync_jobs.approved_payload is 'Frozen at approval / auto-claim. The worker sends ONLY this, so a later treatment edit can never change what was approved.';

-- Only real treatments ("gydymas") go to DelPro — an apžiūra/profilaktika
-- entry is not a DelPro treatment record. SECURITY DEFINER: any active
-- staff member can create a treatment, but the queue is admin-write by RLS.
create or replace function fn_treatments_enqueue_delpro_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.procedure_type = 'gydymas'
     and coalesce((select setting_value from system_settings where setting_key = 'delpro_outbound_mode'), 'approval') <> 'off' then
    insert into delpro_sync_jobs (treatment_id) values (new.id) on conflict (treatment_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger trg_treatments_enqueue_delpro_sync
  after insert on treatments
  for each row execute function fn_treatments_enqueue_delpro_sync();

-- Admin screen view: live preview payload for jobs not yet frozen.
create view vw_delpro_sync_jobs
with (security_invoker = true) as
select
  j.*,
  case when j.approved_payload is null then fn_build_delpro_payload(j.treatment_id) end as preview_payload,
  a.tag_no,
  a.animal_no,
  t.reg_date,
  t.diagnosis
from delpro_sync_jobs j
join treatments t on t.id = j.treatment_id
join animals a on a.id = t.animal_id;

-- ---------------------------------------------------------------------------
-- Admin actions (called from the app as the logged-in admin).
-- ---------------------------------------------------------------------------

create or replace function delpro_approve_jobs(p_job_ids uuid[])
returns integer
language plpgsql
security invoker
as $$
declare
  v_count integer;
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali tvirtinti DelPro siuntimą.';
  end if;

  update delpro_sync_jobs
  set status = 'approved',
      approved_payload = fn_build_delpro_payload(treatment_id) || jsonb_build_object('sync_id', id),
      approved_by = auth.uid(),
      approved_at = now()
  where id = any (p_job_ids)
    and status = 'pending_approval';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function delpro_reject_job(p_job_id uuid, p_reason text default null)
returns void
language plpgsql
security invoker
as $$
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali atmesti DelPro siuntimą.';
  end if;

  update delpro_sync_jobs
  set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(), rejection_reason = nullif(p_reason, '')
  where id = p_job_id and status = 'pending_approval';
end;
$$;

-- Retry keeps the frozen approved_payload unless p_refresh (the admin fixed
-- the treatment and wants the corrected data sent).
create or replace function delpro_retry_job(p_job_id uuid, p_refresh boolean default false)
returns void
language plpgsql
security invoker
as $$
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali kartoti DelPro siuntimą.';
  end if;

  update delpro_sync_jobs
  set status = 'approved',
      approved_payload = case when p_refresh or approved_payload is null
                              then fn_build_delpro_payload(treatment_id) || jsonb_build_object('sync_id', id)
                              else approved_payload end,
      approved_by = auth.uid(),
      approved_at = now(),
      error = null,
      error_details = null,
      actual_result = null,
      verified = false
  where id = p_job_id and status in ('error', 'verification_failed', 'rejected');
end;
$$;

grant execute on function delpro_approve_jobs(uuid[]) to authenticated;
grant execute on function delpro_reject_job(uuid, text) to authenticated;
grant execute on function delpro_retry_job(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Worker-facing RPCs (service_role only).
-- ---------------------------------------------------------------------------

-- delpro_worker_heartbeat(jsonb): { "worker_id": "...", "version": "...", ... }
create or replace function delpro_worker_heartbeat(jsonb)
returns void
language sql
security invoker
as $$
  update system_settings set setting_value = now()::text where setting_key = 'delpro_worker_last_seen_at';
  update system_settings set setting_value = $1::text where setting_key = 'delpro_worker_info';
$$;

-- delpro_claim_next_job(text): atomically claims the oldest sendable job.
-- In auto mode a pending_approval job older than the settle delay is
-- claimable too, and its payload is frozen at claim time.
create or replace function delpro_claim_next_job(p_worker_id text)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_mode text;
  v_delay integer;
  v_job delpro_sync_jobs%rowtype;
begin
  update system_settings set setting_value = now()::text where setting_key = 'delpro_worker_last_seen_at';

  select setting_value into v_mode from system_settings where setting_key = 'delpro_outbound_mode';
  if coalesce(v_mode, 'approval') = 'off' then
    return null;
  end if;
  select coalesce(nullif(setting_value, '')::integer, 10) into v_delay from system_settings where setting_key = 'delpro_auto_delay_minutes';

  select * into v_job
  from delpro_sync_jobs
  where status = 'approved'
     or (v_mode = 'auto' and status = 'pending_approval' and created_at < now() - make_interval(mins => coalesce(v_delay, 10)))
  order by coalesce(approved_at, created_at) asc
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  if v_job.status = 'pending_approval' then
    v_job.approved_payload := fn_build_delpro_payload(v_job.treatment_id) || jsonb_build_object('sync_id', v_job.id);
    update delpro_sync_jobs
    set approved_payload = v_job.approved_payload, auto_approved = true, approved_at = now()
    where id = v_job.id;
  end if;

  update delpro_sync_jobs
  set status = 'processing', started_at = now(), worker_id = p_worker_id
  where id = v_job.id;

  return v_job.approved_payload || jsonb_build_object('sync_id', v_job.id);
end;
$$;

-- delpro_report_job_result(jsonb):
--   { "sync_id": uuid, "worker_id": text, "success": bool,
--     "actual_result": { "animal_no", "event_date", "diagnosis",
--                        "treatment_code", "milk_withdrawal_days",
--                        "meat_withdrawal_days" },   -- read back from DelPro
--     "error_message": text, "error_details": {...} }
-- Idempotent against a terminal job.
create or replace function delpro_report_job_result(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  v_sync_id uuid;
  v_job delpro_sync_jobs%rowtype;
  v_actual jsonb;
  v_expected jsonb;
  v_verified boolean;
begin
  v_sync_id := (p_body->>'sync_id')::uuid;
  if v_sync_id is null then
    raise exception 'Trūksta sync_id.';
  end if;

  select * into v_job from delpro_sync_jobs where id = v_sync_id for update;
  if not found then
    raise exception 'Sync užduotis nerasta: %', v_sync_id;
  end if;

  if v_job.status in ('success', 'error', 'verification_failed') then
    return to_jsonb(v_job);
  end if;
  if v_job.status <> 'processing' then
    raise exception 'Sync užduotis % nėra vykdoma (status=%).', v_sync_id, v_job.status;
  end if;

  if coalesce((p_body->>'success')::boolean, false) then
    v_actual := p_body->'actual_result';
    v_expected := v_job.approved_payload->'delpro';
    v_verified := v_actual is not null
      and (v_actual->>'event_date') is not distinct from (v_expected->>'event_date')
      and (v_actual->>'animal_no') is not distinct from (v_job.approved_payload->'animal'->>'animal_no')
      and coalesce((v_actual->>'milk_withdrawal_days')::int, -1) = coalesce((v_expected->>'milk_withdrawal_days')::int, -1)
      and coalesce((v_actual->>'meat_withdrawal_days')::int, -1) = coalesce((v_expected->>'meat_withdrawal_days')::int, -1);

    update delpro_sync_jobs
    set status = case when v_verified then 'success' else 'verification_failed' end,
        actual_result = v_actual,
        verified = v_verified,
        verified_at = now(),
        completed_at = now(),
        attempts = attempts + 1
    where id = v_sync_id
    returning * into v_job;
  else
    update delpro_sync_jobs
    set status = 'error',
        error = coalesce(nullif(p_body->>'error_message', ''), 'Nežinoma klaida'),
        error_details = p_body->'error_details',
        completed_at = now(),
        attempts = attempts + 1
    where id = v_sync_id
    returning * into v_job;
  end if;

  return to_jsonb(v_job);
end;
$$;

revoke all on function delpro_worker_heartbeat(jsonb) from public, authenticated;
revoke all on function delpro_claim_next_job(text) from public, authenticated;
revoke all on function delpro_report_job_result(jsonb) from public, authenticated;
grant execute on function delpro_worker_heartbeat(jsonb) to service_role;
grant execute on function delpro_claim_next_job(text) to service_role;
grant execute on function delpro_report_job_result(jsonb) to service_role;

-- A job stuck in 'processing' (worker crashed / PC switched off mid-run,
-- contract §7.5) is released back after 30 minutes so it isn't lost.
create or replace function delpro_release_stale_jobs()
returns integer
language sql
security invoker
as $$
  with released as (
    update delpro_sync_jobs
    set status = 'approved', worker_id = null, error = 'Darbininkas neatsakė — užduotis grąžinta į eilę.'
    where status = 'processing' and started_at < now() - interval '30 minutes'
    returning 1
  )
  select count(*)::integer from released;
$$;

revoke all on function delpro_release_stale_jobs() from public, authenticated;
grant execute on function delpro_release_stale_jobs() to service_role;

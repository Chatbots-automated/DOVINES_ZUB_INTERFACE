-- 0033_delpro_treatment_confirmation.sql
-- Dovinės ŽŪB GVET PRO — treatment-level "Patvirtinti perdavimą į DelPro".
--
-- The queue (delpro_sync_jobs, 0006) already holds one job per gydymas. This
-- migration adds the pieces needed so a vet can approve ONE treatment from its
-- own screen, without a second queue or a second approval implementation:
--
--   1. fn_can_approve_delpro()      admin + vet may approve (was admin only).
--   2. fn_build_delpro_payload()    payload v2: adds delpro.ui_entry — exactly
--                                   the values the farm-PC UI automation
--                                   (delpro.ps1) understands — and the mapped
--                                   DelPro medicine name per product line.
--   3. fn_delpro_transfer_problems() what blocks a transfer (missing mapping,
--                                   several medicines, no dose, ...).
--   4. fn_delpro_approve_job()      THE approval path. Idempotent, row-locked,
--                                   validates, freezes approved_payload, audits.
--                                   delpro_approve_jobs() (queue, bulk) and
--                                   delpro_approve_treatment() (treatment
--                                   screen) both call it.
--   5. delpro_treatment_transfer_state()  read model for the confirmation dialog.
--   6. delpro_claim_next_job()      never hands the worker a stale payload: if
--                                   the treatment/mappings changed after
--                                   approval the job goes back to
--                                   pending_approval; auto mode also validates.
--   7. vw_delpro_sync_jobs          appends preview_problems, payload_stale,
--                                   approved_by_name (existing columns untouched).
--
-- No new tables or columns. Approval = "released to the worker", never "done in
-- DelPro": only delpro_report_job_result (service_role) can set success.

-- ---------------------------------------------------------------------------
-- 1. Who may approve a transfer
-- ---------------------------------------------------------------------------

create or replace function fn_can_approve_delpro()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from users
    where id = auth.uid() and is_frozen = false and role in ('admin', 'vet')
  );
$$;

grant execute on function fn_can_approve_delpro() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Payload v2
-- ---------------------------------------------------------------------------
-- Every key of the v1 payload is kept (the sql-mode worker and the queue UI
-- read them). New:
--   payload_version                  2
--   delpro.products[].delpro_name    mapped DelPro medicine name
--   delpro.ui_entry                  the UI-automation parameter set:
--       treatment_id    -> TreatmentId
--       animal_number   -> AnimalNumber    (animals.animal_no, DelPro number)
--       diagnosis_name  -> DiagnosisName   (delpro_mappings disease.delpro_name)
--       diagnosis_code  -> DiagnosisCode   (delpro_mappings disease.delpro_code)
--       medicine_name   -> MedicineName    (delpro_mappings product.delpro_name;
--                                           null unless exactly ONE medicine)
--       dose            -> Dose            (day-1 quantity of that medicine)
--       dose_unit                          informational (GVET stock unit)
--       course_days     -> CourseDays      (treatment_courses.days; 1 = no course)
-- The worker builds an argument ARRAY from these after validating them; the
-- database never produces a shell command.

create or replace function fn_build_delpro_payload(p_treatment_id uuid)
returns jsonb
language sql
stable
as $$
  with prods as (
    select ui.product_id, p.name, sum(ui.qty) as qty, ui.unit, ui.administration_route,
           pm.delpro_code, pm.delpro_name
    from usage_items ui
    join products p on p.id = ui.product_id
    left join delpro_mappings pm on pm.kind = 'product' and pm.local_id = ui.product_id
    where ui.treatment_id = p_treatment_id
    group by ui.product_id, p.name, ui.unit, ui.administration_route, pm.delpro_code, pm.delpro_name
  ),
  course as (
    select max(tc.days) as days
    from treatment_courses tc
    where tc.treatment_id = p_treatment_id and tc.status <> 'cancelled'
  )
  select jsonb_build_object(
    'payload_version', 2,
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
                 'delpro_code', x.delpro_code,
                 'delpro_name', x.delpro_name
               ) order by x.name)
        from prods x
      ), '[]'::jsonb),
      'course_days', (select days from course),
      'withdrawal_until_milk', t.withdrawal_until_milk,
      'withdrawal_until_meat', t.withdrawal_until_meat,
      'milk_withdrawal_days', greatest(coalesce(t.withdrawal_until_milk - t.reg_date, 0), 0),
      'meat_withdrawal_days', greatest(coalesce(t.withdrawal_until_meat - t.reg_date, 0), 0),
      'vet_name', t.vet_name,
      'ui_entry', jsonb_build_object(
        'treatment_id', t.id,
        'animal_number', a.animal_no,
        'diagnosis_name', dm.delpro_name,
        'diagnosis_code', dm.delpro_code,
        'medicine_name', case when (select count(*) from prods) = 1 then (select delpro_name from prods) end,
        'dose', case when (select count(*) from prods) = 1 then (select qty from prods) end,
        'dose_unit', case when (select count(*) from prods) = 1 then (select unit from prods) end,
        'course_days', coalesce((select days from course), 1)
      )
    )
  )
  from treatments t
  join animals a on a.id = t.animal_id
  left join diseases d on d.id = t.disease_id
  left join delpro_mappings dm on dm.kind = 'disease' and dm.local_id = t.disease_id
  where t.id = p_treatment_id;
$$;

-- ---------------------------------------------------------------------------
-- 3. What blocks a transfer. Returns a jsonb array of
--    { code, message, fix } — empty = ready to approve. `fix` points at the
--    mapping that has to be created ({kind, local_id, name}) when relevant.
--    Nothing is guessed or defaulted: a missing value is a problem.
-- ---------------------------------------------------------------------------

create or replace function fn_delpro_problem(p_code text, p_message text, p_fix jsonb default null)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('code', p_code, 'message', p_message, 'fix', p_fix);
$$;

create or replace function fn_delpro_transfer_problems(p_treatment_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  t treatments%rowtype;
  v_animal_no text;
  v_mode text;
  v_dm delpro_mappings%rowtype;
  v_pm delpro_mappings%rowtype;
  v_disease_name text;
  v_probs jsonb := '[]'::jsonb;
  v_nprod integer;
  v_prod record;
  v_course_days integer;
  v_variants integer;
begin
  select * into t from treatments where id = p_treatment_id;
  if not found then
    return jsonb_build_array(fn_delpro_problem('treatment_missing', 'Gydymo įrašas nerastas.'));
  end if;

  if t.procedure_type <> 'gydymas' then
    return jsonb_build_array(fn_delpro_problem('not_gydymas', 'Į DelPro perduodami tik gydymai (ne profilaktika, apžiūra ar sinchronizacija).'));
  end if;

  select setting_value into v_mode from system_settings where setting_key = 'delpro_outbound_mode';
  if coalesce(v_mode, 'approval') = 'off' then
    v_probs := v_probs || fn_delpro_problem('integration_off', 'Perdavimas į DelPro išjungtas (DelPro integracija → Nustatymai).');
  end if;

  select animal_no into v_animal_no from animals where id = t.animal_id;
  if v_animal_no is null or btrim(v_animal_no) = '' then
    v_probs := v_probs || fn_delpro_problem('animal_number', 'Gyvulys neturi DelPro numerio — DelPro automatizacija ieško gyvulio pagal numerį.');
  end if;

  -- Diagnosis: the DelPro script needs BOTH name and code, taken from the mapping.
  if t.disease_id is null then
    v_probs := v_probs || fn_delpro_problem('diagnosis_missing', 'Gydymui nepasirinkta diagnozė (liga), todėl nėra ką susieti su DelPro diagnoze.');
  else
    select name into v_disease_name from diseases where id = t.disease_id;
    select * into v_dm from delpro_mappings where kind = 'disease' and local_id = t.disease_id;
    if not found or coalesce(btrim(v_dm.delpro_name), '') = '' or coalesce(btrim(v_dm.delpro_code), '') = '' then
      v_probs := v_probs || fn_delpro_problem(
        'diagnosis_mapping',
        format('Diagnozė „%s“ nesusieta su DelPro diagnoze (reikia pavadinimo ir kodo).', coalesce(v_disease_name, '?')),
        jsonb_build_object('kind', 'disease', 'local_id', t.disease_id, 'name', v_disease_name));
    elsif v_dm.delpro_name ~ '[[:cntrl:]]' or v_dm.delpro_code ~ '[[:cntrl:]]' or length(v_dm.delpro_name) > 200 or length(v_dm.delpro_code) > 50 then
      v_probs := v_probs || fn_delpro_problem(
        'diagnosis_mapping_invalid',
        format('Diagnozės „%s“ DelPro susiejimas turi neleistinų simbolių arba per ilgas.', coalesce(v_disease_name, '?')),
        jsonb_build_object('kind', 'disease', 'local_id', t.disease_id, 'name', v_disease_name));
    end if;
  end if;

  -- Medicine: exactly one product line (route variants count as separate lines).
  select count(*) into v_nprod
  from (select 1 from usage_items ui where ui.treatment_id = t.id group by ui.product_id, ui.unit, ui.administration_route) x;

  if v_nprod = 0 then
    v_probs := v_probs || fn_delpro_problem('no_medicine', 'Gydymas neturi vaisto — nėra ką perduoti į DelPro.');
  elsif v_nprod > 1 then
    v_probs := v_probs || fn_delpro_problem(
      'multi_medicine',
      'Gydymas turi kelias vaistų eilutes. DelPro automatizacija kol kas įveda vieną vaistą — perdavimas užblokuotas, kad neprarastume eilučių.');
  else
    select ui.product_id, p.name as product_name, sum(ui.qty) as qty, ui.unit
      into v_prod
    from usage_items ui join products p on p.id = ui.product_id
    where ui.treatment_id = t.id
    group by ui.product_id, p.name, ui.unit;

    select * into v_pm from delpro_mappings where kind = 'product' and local_id = v_prod.product_id;
    if not found or coalesce(btrim(v_pm.delpro_name), '') = '' then
      v_probs := v_probs || fn_delpro_problem(
        'medicine_mapping',
        format('Vaistas „%s“ nesusietas su DelPro vaistu (reikia DelPro pavadinimo).', v_prod.product_name),
        jsonb_build_object('kind', 'product', 'local_id', v_prod.product_id, 'name', v_prod.product_name));
    elsif v_pm.delpro_name ~ '[[:cntrl:]]' or length(v_pm.delpro_name) > 200 then
      v_probs := v_probs || fn_delpro_problem(
        'medicine_mapping_invalid',
        format('Vaisto „%s“ DelPro pavadinimas turi neleistinų simbolių arba per ilgas.', v_prod.product_name),
        jsonb_build_object('kind', 'product', 'local_id', v_prod.product_id, 'name', v_prod.product_name));
    end if;

    if v_prod.qty is null or v_prod.qty <= 0 then
      v_probs := v_probs || fn_delpro_problem('dose_missing', 'Nenurodyta vaisto dozė.');
    end if;

    -- The script enters ONE dose for the whole course. Later course days must
    -- therefore be the same medicine, dose and unit as day 1.
    select count(*) into v_variants
    from treatment_courses tc
    join course_doses cd on cd.course_id = tc.id
    where tc.treatment_id = t.id and tc.status <> 'cancelled'
      and (cd.product_id is distinct from v_prod.product_id
           or cd.dose_amount is distinct from v_prod.qty
           or cd.unit is distinct from v_prod.unit);
    if v_variants > 0 then
      v_probs := v_probs || fn_delpro_problem(
        'course_variants',
        'Gydymo kurso dienų vaistas ar dozė skiriasi nuo pirmos dienos. DelPro automatizacija įveda vieną dozę visam kursui — perdavimas užblokuotas.');
    end if;
  end if;

  select max(days) into v_course_days from treatment_courses where treatment_id = t.id and status <> 'cancelled';
  if v_course_days is not null and v_course_days < 1 then
    v_probs := v_probs || fn_delpro_problem('course_days', 'Neteisinga gydymo kurso trukmė.');
  end if;

  return v_probs;
end;
$$;

-- A frozen payload is stale when rebuilding it from the live treatment and
-- mappings would now give something different (sync_id is added at freeze).
create or replace function fn_delpro_payload_stale(p_treatment_id uuid, p_approved jsonb)
returns boolean
language sql
stable
as $$
  select case
    when p_approved is null then false
    else (p_approved - 'sync_id') is distinct from fn_build_delpro_payload(p_treatment_id)
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The one approval path
-- ---------------------------------------------------------------------------
-- Returns { ok, outcome, status, job_id, problems, message }.
--   ok = the job is (now) released to the worker or already past that point.
--   outcome: approved | reapproved | already_approved | already_processing |
--            already_success | stale | blocked | needs_retry | rejected
-- Concurrency: the job row is locked FOR UPDATE, so two simultaneous approvals
-- serialize and the second one sees status='approved' and returns
-- already_approved without touching the frozen payload.
-- Internal: not granted to any API role; the two public RPCs below are
-- SECURITY DEFINER and call it.

create or replace function fn_delpro_approve_job(p_job_id uuid, p_reapprove boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j delpro_sync_jobs%rowtype;
  v_problems jsonb;
  v_payload jsonb;
  v_outcome text;
  v_stale boolean;
begin
  if not fn_can_approve_delpro() then
    raise exception 'Neturite teisės tvirtinti gydymo perdavimo į DelPro.';
  end if;

  select * into j from delpro_sync_jobs where id = p_job_id for update;
  if not found then
    raise exception 'DelPro užduotis nerasta.';
  end if;

  if j.status = 'processing' then
    return jsonb_build_object('ok', true, 'outcome', 'already_processing', 'status', j.status, 'job_id', j.id,
      'problems', '[]'::jsonb, 'message', 'Įrašas jau perduodamas į DelPro.');
  elsif j.status = 'success' then
    return jsonb_build_object('ok', true, 'outcome', 'already_success', 'status', j.status, 'job_id', j.id,
      'problems', '[]'::jsonb, 'message', 'Įrašas jau perduotas į DelPro.');
  elsif j.status in ('error', 'verification_failed') then
    return jsonb_build_object('ok', false, 'outcome', 'needs_retry', 'status', j.status, 'job_id', j.id,
      'problems', '[]'::jsonb, 'message', 'Ankstesnis perdavimas nepavyko — kartoti gali administratorius (DelPro integracija → Klaidos).');
  elsif j.status = 'rejected' then
    return jsonb_build_object('ok', false, 'outcome', 'rejected', 'status', j.status, 'job_id', j.id,
      'problems', '[]'::jsonb, 'message', 'Perdavimas buvo atmestas.');
  elsif j.status = 'approved' then
    v_stale := fn_delpro_payload_stale(j.treatment_id, j.approved_payload);
    if not v_stale then
      return jsonb_build_object('ok', true, 'outcome', 'already_approved', 'status', j.status, 'job_id', j.id,
        'problems', '[]'::jsonb, 'message', 'Perdavimas jau patvirtintas — įrašas laukia perdavimo į DelPro.');
    end if;
    if not p_reapprove then
      return jsonb_build_object('ok', false, 'outcome', 'stale', 'status', j.status, 'job_id', j.id,
        'problems', '[]'::jsonb,
        'message', 'Gydymo ar susiejimų duomenys pasikeitė po patvirtinimo. Peržiūrėkite ir patvirtinkite iš naujo.');
    end if;
  end if;

  -- pending_approval, or approved + stale + explicit re-approval
  v_problems := fn_delpro_transfer_problems(j.treatment_id);
  if jsonb_array_length(v_problems) > 0 then
    return jsonb_build_object('ok', false, 'outcome', 'blocked', 'status', j.status, 'job_id', j.id,
      'problems', v_problems, 'message', v_problems->0->>'message');
  end if;

  v_outcome := case when j.status = 'approved' then 'reapproved' else 'approved' end;
  v_payload := fn_build_delpro_payload(j.treatment_id) || jsonb_build_object('sync_id', j.id);

  update delpro_sync_jobs
  set status = 'approved',
      approved_payload = v_payload,
      approved_by = auth.uid(),
      approved_at = now(),
      auto_approved = false,
      error = null,
      error_details = null
  where id = j.id;

  insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
  values (
    auth.uid(),
    case when v_outcome = 'reapproved' then 'delpro_transfer_reapproved' else 'delpro_transfer_approved' end,
    'delpro_sync_jobs',
    j.id,
    case when j.approved_payload is not null then jsonb_build_object('status', j.status, 'approved_payload', j.approved_payload) end,
    jsonb_build_object('status', 'approved', 'treatment_id', j.treatment_id, 'approved_payload', v_payload)
  );

  return jsonb_build_object('ok', true, 'outcome', v_outcome, 'status', 'approved', 'job_id', j.id,
    'problems', '[]'::jsonb, 'message', 'Gydymo perdavimas patvirtintas. Įrašas laukia perdavimo į DelPro.');
end;
$$;

revoke all on function fn_delpro_approve_job(uuid, boolean) from public, anon, authenticated;

-- Treatment screen entry point. Finds (or, if the trigger skipped it because
-- the integration was switched off at the time, creates) the treatment's one
-- job — unique(treatment_id) makes repeat clicks / races collapse onto it.
create or replace function delpro_approve_treatment(p_treatment_id uuid, p_reapprove boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_problems jsonb;
begin
  if not fn_can_approve_delpro() then
    raise exception 'Neturite teisės tvirtinti gydymo perdavimo į DelPro.';
  end if;

  select id into v_job_id from delpro_sync_jobs where treatment_id = p_treatment_id;
  if v_job_id is null then
    -- Eligibility (gydymas, integration on, mappings...) is judged by the same
    -- function the approval uses, so a job is only ever created for a treatment
    -- that is allowed to have one.
    v_problems := fn_delpro_transfer_problems(p_treatment_id);
    if exists (select 1 from jsonb_array_elements(v_problems) p where p->>'code' in ('treatment_missing', 'not_gydymas', 'integration_off')) then
      return jsonb_build_object('ok', false, 'outcome', 'blocked', 'status', null, 'job_id', null,
        'problems', v_problems, 'message', v_problems->0->>'message');
    end if;
    insert into delpro_sync_jobs (treatment_id) values (p_treatment_id) on conflict (treatment_id) do nothing;
    select id into v_job_id from delpro_sync_jobs where treatment_id = p_treatment_id;
  end if;

  return fn_delpro_approve_job(v_job_id, p_reapprove);
end;
$$;

-- Queue entry point (bulk). Same core; returns how many jobs were newly
-- released. Jobs that are blocked/stale/already approved are simply not counted
-- (the queue shows their problems per row).
create or replace function delpro_approve_jobs(p_job_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_res jsonb;
  v_count integer := 0;
begin
  if not fn_can_approve_delpro() then
    raise exception 'Neturite teisės tvirtinti gydymo perdavimo į DelPro.';
  end if;

  for v_id in select distinct x from unnest(p_job_ids) x order by x loop
    v_res := fn_delpro_approve_job(v_id, false);
    if v_res->>'outcome' = 'approved' then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function delpro_approve_treatment(uuid, boolean) from public, anon;
revoke all on function delpro_approve_jobs(uuid[]) from public, anon;
grant execute on function delpro_approve_treatment(uuid, boolean) to authenticated;
grant execute on function delpro_approve_jobs(uuid[]) to authenticated;

-- Retry with fresh data must pass the same validation (and is audited).
create or replace function delpro_retry_job(p_job_id uuid, p_refresh boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job delpro_sync_jobs%rowtype;
  v_problems jsonb;
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali kartoti DelPro siuntimą.';
  end if;

  select * into v_job from delpro_sync_jobs where id = p_job_id and status in ('error', 'verification_failed', 'rejected') for update;
  if not found then
    return;
  end if;

  if p_refresh or v_job.approved_payload is null then
    v_problems := fn_delpro_transfer_problems(v_job.treatment_id);
    if jsonb_array_length(v_problems) > 0 then
      raise exception '%', v_problems->0->>'message';
    end if;
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
  where id = p_job_id;

  insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), 'delpro_transfer_retried', 'delpro_sync_jobs', p_job_id,
          jsonb_build_object('status', v_job.status), jsonb_build_object('status', 'approved', 'refresh', p_refresh));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Read model for the confirmation dialog / treatment status
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so a vet can read the preview without widening RLS on the
-- admin-write tables; it returns no secrets (no VIC passwords, no settings
-- other than the outbound mode and worker heartbeat).

create or replace function delpro_treatment_transfer_state(p_treatment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t treatments%rowtype;
  j delpro_sync_jobs%rowtype;
  v_mode text;
  v_seen timestamptz;
  v_preview jsonb;
  v_approver text;
begin
  if not fn_is_authenticated_active() then
    raise exception 'Reikia prisijungti.';
  end if;

  select * into t from treatments where id = p_treatment_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  select * into j from delpro_sync_jobs where treatment_id = p_treatment_id;
  select coalesce(setting_value, 'approval') into v_mode from system_settings where setting_key = 'delpro_outbound_mode';
  select nullif(setting_value, '')::timestamptz into v_seen from system_settings where setting_key = 'delpro_worker_last_seen_at';
  v_preview := fn_build_delpro_payload(p_treatment_id);
  if j.approved_by is not null then
    select coalesce(full_name, email) into v_approver from users where id = j.approved_by;
  end if;

  return jsonb_build_object(
    'found', true,
    'procedure_type', t.procedure_type,
    'mode', coalesce(v_mode, 'approval'),
    'eligible', t.procedure_type = 'gydymas' and coalesce(v_mode, 'approval') <> 'off',
    'can_approve', fn_can_approve_delpro(),
    'is_admin', fn_is_admin(),
    'job', case when j.id is null then null else jsonb_build_object(
      'id', j.id,
      'status', j.status,
      'approved_at', j.approved_at,
      'approved_by_name', v_approver,
      'auto_approved', j.auto_approved,
      'started_at', j.started_at,
      'completed_at', j.completed_at,
      'attempts', j.attempts,
      'verified', j.verified,
      'error', j.error,
      'rejection_reason', j.rejection_reason
    ) end,
    'payload', coalesce(j.approved_payload, v_preview),
    'frozen', j.approved_payload is not null,
    'preview', v_preview,
    'stale', fn_delpro_payload_stale(p_treatment_id, j.approved_payload),
    'problems', fn_delpro_transfer_problems(p_treatment_id),
    'worker', jsonb_build_object(
      'last_seen_at', v_seen,
      'online', v_seen is not null and v_seen > now() - interval '15 minutes'
    )
  );
end;
$$;

revoke all on function delpro_treatment_transfer_state(uuid) from public, anon;
grant execute on function delpro_treatment_transfer_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Worker claim: never release a stale or invalid payload
-- ---------------------------------------------------------------------------
-- Same contract as 0006 (named p_worker_id, service_role only), plus:
--  * an 'approved' job whose treatment/mappings changed since approval is NOT
--    handed out — it returns to pending_approval (frozen payload dropped) and
--    must be approved again by a person;
--  * in auto mode a pending job is only auto-claimed if it passes validation
--    (missing mappings etc. leave it waiting instead of guessing).

create or replace function delpro_claim_next_job(p_worker_id text)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_mode text;
  v_delay integer;
  v_job delpro_sync_jobs%rowtype;
  v_skip uuid[] := '{}';
begin
  update system_settings set setting_value = now()::text where setting_key = 'delpro_worker_last_seen_at';

  select setting_value into v_mode from system_settings where setting_key = 'delpro_outbound_mode';
  if coalesce(v_mode, 'approval') = 'off' then
    return null;
  end if;
  select coalesce(nullif(setting_value, '')::integer, 10) into v_delay from system_settings where setting_key = 'delpro_auto_delay_minutes';

  loop
    select * into v_job
    from delpro_sync_jobs
    where (status = 'approved'
           or (v_mode = 'auto' and status = 'pending_approval' and created_at < now() - make_interval(mins => coalesce(v_delay, 10))))
      and id <> all (v_skip)
    order by coalesce(approved_at, created_at) asc
    for update skip locked
    limit 1;

    if not found then
      return null;
    end if;

    if v_job.status = 'approved' then
      if v_job.approved_payload is null or fn_delpro_payload_stale(v_job.treatment_id, v_job.approved_payload) then
        update delpro_sync_jobs
        set status = 'pending_approval',
            approved_payload = null,
            approved_by = null,
            approved_at = null,
            error = 'Gydymo ar susiejimų duomenys pasikeitė po patvirtinimo — reikia patvirtinti iš naujo.'
        where id = v_job.id;
        insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
        values (null, 'delpro_transfer_invalidated', 'delpro_sync_jobs', v_job.id,
                jsonb_build_object('status', 'approved', 'approved_payload', v_job.approved_payload),
                jsonb_build_object('status', 'pending_approval', 'worker_id', p_worker_id));
        v_skip := v_skip || v_job.id;
        continue;
      end if;
    else
      -- auto mode: validate before freezing
      if jsonb_array_length(fn_delpro_transfer_problems(v_job.treatment_id)) > 0 then
        v_skip := v_skip || v_job.id;
        continue;
      end if;
      v_job.approved_payload := fn_build_delpro_payload(v_job.treatment_id) || jsonb_build_object('sync_id', v_job.id);
      update delpro_sync_jobs
      set approved_payload = v_job.approved_payload, auto_approved = true, approved_at = now(), error = null
      where id = v_job.id;
    end if;

    update delpro_sync_jobs
    set status = 'processing', started_at = now(), worker_id = p_worker_id
    where id = v_job.id;

    return v_job.approved_payload || jsonb_build_object('sync_id', v_job.id);
  end loop;
end;
$$;

revoke all on function delpro_claim_next_job(text) from public, authenticated;
grant execute on function delpro_claim_next_job(text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Queue view: problems / staleness / approver. Columns are APPENDED.
-- ---------------------------------------------------------------------------

create or replace view vw_delpro_sync_jobs
with (security_invoker = true) as
select
  j.*,
  case when j.approved_payload is null then fn_build_delpro_payload(j.treatment_id) end as preview_payload,
  a.tag_no,
  a.animal_no,
  t.reg_date,
  t.diagnosis,
  case when j.status = 'pending_approval' then fn_delpro_transfer_problems(j.treatment_id) end as preview_problems,
  case when j.approved_payload is not null then fn_delpro_payload_stale(j.treatment_id, j.approved_payload) else false end as payload_stale,
  (select coalesce(u.full_name, u.email) from users u where u.id = j.approved_by) as approved_by_name
from delpro_sync_jobs j
join treatments t on t.id = j.treatment_id
join animals a on a.id = t.animal_id;

-- ---------------------------------------------------------------------------
-- 8. Lock the queue table against direct client writes
-- ---------------------------------------------------------------------------
-- 0006 gave admins `for all` on delpro_sync_jobs, so a browser session with an
-- admin JWT could PATCH status='success' or rewrite approved_payload. Every
-- legitimate write now goes through a definer RPC that checks the role and the
-- state machine (approve/reject/retry) or through service_role (the worker).
-- Reads stay open to active staff (the dashboard / treatment screen).

drop policy if exists delpro_sync_jobs_admin_write on delpro_sync_jobs;
revoke insert, update, delete on delpro_sync_jobs from authenticated, anon;

create or replace function delpro_reject_job(p_job_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if not fn_is_admin() then
    raise exception 'Tik administratorius gali atmesti DelPro siuntimą.';
  end if;

  update delpro_sync_jobs
  set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(), rejection_reason = nullif(p_reason, '')
  where id = p_job_id and status = 'pending_approval';
  get diagnostics v_n = row_count;

  if v_n > 0 then
    insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
    values (auth.uid(), 'delpro_transfer_rejected', 'delpro_sync_jobs', p_job_id, jsonb_build_object('reason', nullif(p_reason, '')));
  end if;
end;
$$;

grant execute on function delpro_reject_job(uuid, text) to authenticated;
grant execute on function delpro_retry_job(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';

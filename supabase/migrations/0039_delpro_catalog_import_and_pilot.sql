-- 0039_delpro_catalog_import_and_pilot.sql
-- DelPro catalog (Priedas Nr. 1 §4), on top of 0036-0038:
--
--   A. DelPro -> GVET import with preview + explicit approval.
--      fn_delpro_catalog_import_plan() decides, per unlinked DelPro diagnosis /
--      drug, exactly one of:
--        link     an existing GVET record — via a farm mapping (delpro_mappings,
--                 by DelPro code, or by DelPro name override) or a UNIQUE exact
--                 normalized-name match on both sides. Existing GVET values are
--                 never overwritten: the link starts without a base, so every
--                 differing field shows as "Skiriasi" for an admin to decide.
--        create   a new GVET disease / medicine (DelPro unit + withdrawal days;
--                 drugs then get a clinical_review issue).
--        review   ambiguous: several candidates on either side, a candidate
--                 already linked elsewhere, or two DelPro records pointing at one
--                 GVET record. Never applied by the import.
--        blocked  not importable as is (drug parameters not received — the
--                 DrugParameters snapshot may be incomplete —, unknown unit,
--                 no withdrawal days, no name).
--        linked   already linked (repeat imports skip it: idempotent).
--      delpro_catalog_import_preview() shows the plan; delpro_catalog_import_apply()
--      takes the admin's chosen rows WITH the fingerprint they saw and refuses
--      any row whose decision changed since (stale preview).
--      Every link made by the import keeps its provenance in
--      delpro_catalog_links.import_snapshot (DelPro record, parameters key +
--      values, match source, run).
--
--   B. First real GVET -> DelPro medicine write (pilot).
--      delpro_catalog_create_pilot_drug() creates ONE inactive GVET medicine
--      "GVET TEST vaistas …" and queues its normal Drug.create job (pilot = true).
--      delpro_catalog_release_single_job(job) opens the write gate for exactly
--      that job: delpro_catalog_write_enabled = true AND
--      delpro_catalog_write_only_job = <job id>. While only_job is set the
--      claim hands out nothing else, and only to a worker that asks for that
--      job id by name (npm run catalog:write-one -- <id>). The gate closes by
--      itself as soon as the job leaves queued/processing (success, failure,
--      review, cancel). On success the link is saved like any create job.

-- ===========================================================================
-- A. Import
-- ===========================================================================

alter table delpro_catalog_links add column import_snapshot jsonb;

comment on column delpro_catalog_links.import_snapshot is
  'Provenance of a link made by the DelPro import (0039): DelPro record fields, parameters key + values, match source, run id, time.';

-- Every unlinked DelPro Diagnosis / Drug with its import decision.
create or replace function fn_delpro_catalog_import_plan(p_object_type text default null)
returns table (
  object_type text,
  delpro_key text,
  delpro_name text,
  delpro_active boolean,
  action text,
  reason text,
  match_source text,
  gvet_id uuid,
  gvet_name text,
  candidates jsonb,
  delpro_values jsonb,
  gvet_values jsonb,
  fingerprint text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record;
  v_params jsonb;
  v_params_key text;
  v_unit unit;
  v_values jsonb;
  v_action text;
  v_reason text;
  v_source text;
  v_gvet uuid;
  v_gvet_name text;
  v_gvet_values jsonb;
  v_cands jsonb;
  v_link_counts jsonb := '{}'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  x jsonb;
begin
  for r in
    with base as (
      select i.*, fn_delpro_norm_name(i.name) as norm
      from delpro_catalog_items i
      where i.object_type in ('Diagnosis', 'Drug') and i.removed_at is null
    ), counted as (
      select b.*, count(*) over (partition by b.object_type, b.norm) as same_name_in_delpro from base b
    )
    select c.*,
           exists (select 1 from delpro_catalog_links l
                   where l.retired_at is null and l.object_type = c.object_type and l.delpro_key = c.delpro_key) as is_linked
    from counted c
    where p_object_type is null or c.object_type = p_object_type
    order by c.object_type, c.name, c.delpro_key
  loop
    v_action := null; v_reason := null; v_source := null; v_gvet := null; v_gvet_name := null; v_gvet_values := null;
    v_params := null; v_params_key := null; v_unit := null;

    -- DelPro values the import would use
    if r.object_type = 'Drug' then
      v_params_key := r.fields->>'default_parameters';
      select dp.fields into v_params from delpro_catalog_items dp
      where dp.object_type = 'DrugParameters' and dp.delpro_key = v_params_key and dp.removed_at is null;
      v_unit := fn_delpro_unit_from_uom(v_params->>'uom');
      v_values := jsonb_build_object('name', fn_delpro_text(r.name), 'active', r.active,
        'active_substance', r.fields->>'active_substance', 'params_key', v_params_key,
        'uom', v_params->>'uom', 'unit', v_unit, 'milk_days', v_params->'dump_milk_days',
        'meat_days', v_params->'meat_withhold_days', 'application_method', v_params->>'application_method');
    else
      v_values := jsonb_build_object('name', fn_delpro_text(r.name), 'active', r.active,
        'recommended_treatment', r.fields->>'recommended_treatment');
    end if;

    -- candidates: farm mappings first (by DelPro code, then a DelPro-name override), then exact name
    if r.object_type = 'Diagnosis' then
      select coalesce(jsonb_agg(distinct jsonb_build_object('gvet_id', d.id, 'name', d.name, 'source', 'mapping',
               'linked', exists (select 1 from delpro_catalog_links x where x.retired_at is null and x.disease_id = d.id))), '[]'::jsonb)
      into v_cands
      from delpro_mappings m join diseases d on d.id = m.local_id
      where m.kind = 'disease'
        and (fn_delpro_text(m.delpro_code) = r.delpro_key
             or (fn_delpro_text(m.delpro_code) is null and fn_delpro_norm_name(m.delpro_name) = r.norm));
      if jsonb_array_length(v_cands) = 0 then
        select coalesce(jsonb_agg(jsonb_build_object('gvet_id', d.id, 'name', d.name, 'source', 'name',
                 'linked', exists (select 1 from delpro_catalog_links x where x.retired_at is null and x.disease_id = d.id)) order by d.name), '[]'::jsonb)
        into v_cands
        from diseases d where fn_delpro_norm_name(d.name) = r.norm;
      end if;
    else
      select coalesce(jsonb_agg(distinct jsonb_build_object('gvet_id', p.id, 'name', p.name, 'source', 'mapping',
               'linked', exists (select 1 from delpro_catalog_links x where x.retired_at is null and x.product_id = p.id))), '[]'::jsonb)
      into v_cands
      from delpro_mappings m join products p on p.id = m.local_id
      where m.kind = 'product' and fn_is_drug_category(p.category)
        and (fn_delpro_text(m.delpro_code) = r.delpro_key
             or (fn_delpro_text(m.delpro_code) is null and fn_delpro_norm_name(m.delpro_name) = r.norm));
      if jsonb_array_length(v_cands) = 0 then
        -- inactive GVET medicines count too: creating a second one with the same name would be a duplicate
        select coalesce(jsonb_agg(jsonb_build_object('gvet_id', p.id, 'name', p.name, 'source', 'name',
                 'linked', exists (select 1 from delpro_catalog_links x where x.retired_at is null and x.product_id = p.id)) order by p.name), '[]'::jsonb)
        into v_cands
        from products p where fn_is_drug_category(p.category) and fn_delpro_norm_name(p.name) = r.norm;
      end if;
    end if;

    if r.is_linked then
      v_action := 'linked';
    elsif r.norm is null then
      v_action := 'blocked'; v_reason := 'DelPro įrašas be pavadinimo';
    elsif jsonb_array_length(v_cands) > 1 then
      v_action := 'review'; v_reason := format('GVET turi %s galimus atitikmenis', jsonb_array_length(v_cands));
    elsif jsonb_array_length(v_cands) = 1 then
      if (v_cands->0->>'linked')::boolean then
        v_action := 'review'; v_reason := 'GVET atitikmuo jau susietas su kitu DelPro įrašu';
      elsif v_cands->0->>'source' = 'name' and r.same_name_in_delpro > 1 then
        v_action := 'review'; v_reason := format('DelPro turi %s įrašus tokiu pavadinimu', r.same_name_in_delpro);
      else
        v_action := 'link';
        v_source := v_cands->0->>'source';
        v_gvet := (v_cands->0->>'gvet_id')::uuid;
        v_gvet_name := v_cands->0->>'name';
        v_gvet_values := case when r.object_type = 'Drug' then fn_delpro_link_gvet_projection(null, v_gvet, null)
                              else fn_delpro_link_gvet_projection(v_gvet, null, null) end;
      end if;
    elsif r.same_name_in_delpro > 1 then
      v_action := 'review'; v_reason := format('DelPro turi %s įrašus tokiu pavadinimu — kuris tikrasis?', r.same_name_in_delpro);
    elsif r.object_type = 'Drug' and v_params is null then
      v_action := 'blocked';
      v_reason := case when v_params_key is null then 'DelPro vaistas neturi numatytų parametrų (vienetas, karencija)'
                       else format('DelPro parametrai %s dar negauti (DrugParameters sąrašas nepilnas) — vienetas ir karencija nežinomi', v_params_key) end;
    elsif r.object_type = 'Drug' and v_unit is null then
      v_action := 'blocked'; v_reason := format('DelPro matavimo vienetas „%s“ neatpažintas', coalesce(v_params->>'uom', ''));
    elsif r.object_type = 'Drug' and (fn_delpro_int(v_params->'dump_milk_days') is null or fn_delpro_int(v_params->'meat_withhold_days') is null) then
      v_action := 'blocked'; v_reason := 'DelPro neturi karencijos dienų (pienui / mėsai)';
    else
      v_action := 'create';
      if r.active is false then
        v_reason := 'DelPro įrašas neaktyvus';
      end if;
    end if;

    v_rows := v_rows || jsonb_build_object(
      'object_type', r.object_type, 'delpro_key', r.delpro_key, 'delpro_name', r.name, 'delpro_active', r.active,
      'action', v_action, 'reason', v_reason, 'match_source', v_source, 'gvet_id', v_gvet, 'gvet_name', v_gvet_name,
      'candidates', v_cands, 'delpro_values', v_values, 'gvet_values', v_gvet_values, 'record_hash', r.record_hash);
  end loop;

  -- two DelPro records may not be linked to one GVET record in the same import
  select coalesce(jsonb_object_agg(g, n), '{}'::jsonb) into v_link_counts
  from (select e->>'gvet_id' as g, count(*) as n from jsonb_array_elements(v_rows) e
        where e->>'action' = 'link' group by 1) c;

  for x in select * from jsonb_array_elements(v_rows)
  loop
    if x->>'action' = 'link' and coalesce((v_link_counts->>(x->>'gvet_id'))::int, 0) > 1 then
      x := x || jsonb_build_object('action', 'review', 'reason', 'Keli DelPro įrašai rodo į tą patį GVET įrašą',
                                   'gvet_id', null, 'gvet_name', null, 'match_source', null, 'gvet_values', null);
    end if;
    object_type := x->>'object_type';
    delpro_key := x->>'delpro_key';
    delpro_name := x->>'delpro_name';
    delpro_active := (x->>'delpro_active')::boolean;
    action := x->>'action';
    reason := x->>'reason';
    match_source := x->>'match_source';
    gvet_id := (x->>'gvet_id')::uuid;
    gvet_name := x->>'gvet_name';
    candidates := x->'candidates';
    delpro_values := x->'delpro_values';
    gvet_values := x->'gvet_values';
    -- what the admin approves: the decision + the DelPro record as it was
    fingerprint := md5(concat_ws('|', action, x->>'gvet_id', x->>'record_hash', (x->'delpro_values')::text));
    return next;
  end loop;
end;
$$;

-- delpro_catalog_import_preview(type?) -> { rows: [...], counts: {action: n} } (admin)
create or replace function delpro_catalog_import_preview(p_object_type text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_counts jsonb;
begin
  perform fn_delpro_catalog_require_admin();
  select coalesce(jsonb_agg(to_jsonb(p) order by p.object_type, p.action, p.delpro_name), '[]'::jsonb)
  into v_rows from fn_delpro_catalog_import_plan(p_object_type) p;
  select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into v_counts
  from (select e->>'object_type' || '.' || (e->>'action') as k, count(*) as n from jsonb_array_elements(v_rows) e group by 1) c;
  return jsonb_build_object('rows', v_rows, 'counts', v_counts,
    'drug_parameters_complete', fn_delpro_catalog_type_complete('DrugParameters'));
end;
$$;

-- delpro_catalog_import_apply(items): [{ object_type, delpro_key, action: 'create'|'link', fingerprint }]
-- Re-plans every chosen row; applies it only if the decision is still exactly
-- what the admin saw. Already-linked rows are skipped (idempotent).
create or replace function delpro_catalog_import_apply(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  it jsonb;
  p jsonb;
  v_plan jsonb;
  v_type text;
  v_key text;
  v_id uuid;
  v_link uuid;
  v_snapshot jsonb;
  v_run uuid := (select id from delpro_catalog_runs where status = 'completed' order by started_at desc limit 1);
  v_created integer := 0;
  v_linked integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_done jsonb := '[]'::jsonb;
begin
  perform fn_delpro_catalog_require_admin();
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Nepasirinktas nė vienas įrašas.';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Per daug įrašų vienu kartu (daugiausia 1000).';
  end if;

  -- one reconcile at the end instead of one per inserted disease / product (statement triggers)
  perform set_config('delpro.reconciling', '1', true);

  -- planned once: the plan's own rules (unique candidates, one DelPro record per
  -- GVET record, unique DelPro names) keep the chosen rows independent of each other
  select coalesce(jsonb_object_agg(x.object_type || '|' || x.delpro_key, to_jsonb(x)), '{}'::jsonb)
  into v_plan from fn_delpro_catalog_import_plan(null) x;

  for it in select * from jsonb_array_elements(p_items)
  loop
    v_type := it->>'object_type';
    v_key := it->>'delpro_key';
    p := v_plan->(v_type || '|' || v_key);

    if p is null then
      v_skipped := v_skipped || jsonb_build_object('key', v_key, 'reason', 'DelPro įrašas nerastas arba pašalintas');
      continue;
    elsif p->>'action' = 'linked' then
      v_skipped := v_skipped || jsonb_build_object('key', v_key, 'name', p->>'delpro_name', 'reason', 'jau susietas');
      continue;
    elsif p->>'action' is distinct from it->>'action' or p->>'fingerprint' is distinct from it->>'fingerprint' then
      v_skipped := v_skipped || jsonb_build_object('key', v_key, 'name', p->>'delpro_name',
        'reason', 'pasikeitė nuo peržiūros — atnaujinkite peržiūrą');
      continue;
    elsif p->>'action' not in ('create', 'link') then
      v_skipped := v_skipped || jsonb_build_object('key', v_key, 'name', p->>'delpro_name', 'reason', coalesce(p->>'reason', p->>'action'));
      continue;
    end if;

    v_snapshot := jsonb_build_object('source', case when p->>'action' = 'create' then 'import' else p->>'match_source' end,
      'delpro', p->'delpro_values', 'record', (select fields from delpro_catalog_items i where i.object_type = v_type and i.delpro_key = v_key),
      'params', case when v_type = 'Drug' then (select fields from delpro_catalog_items i
                 where i.object_type = 'DrugParameters' and i.delpro_key = p->'delpro_values'->>'params_key') end,
      'run_id', v_run, 'imported_at', now(), 'imported_by', auth.uid());

    begin
      if p->>'action' = 'link' then
        -- no base: GVET keeps its values; differences surface as field_difference for a decision
        v_link := fn_delpro_catalog_create_link(v_type, v_key, (p->>'gvet_id')::uuid, 'matched', null);
        v_linked := v_linked + 1;
      elsif v_type = 'Diagnosis' then
        insert into diseases (name) values (p->'delpro_values'->>'name') returning id into v_id;
        v_link := fn_delpro_catalog_create_link('Diagnosis', v_key, v_id, 'imported', fn_delpro_catalog_projection('Diagnosis', v_key));
        v_created := v_created + 1;
      else
        insert into products (name, category, unit, active_substance, withdrawal_days_milk, withdrawal_days_meat, is_active)
        values (p->'delpro_values'->>'name', 'medicines', (p->'delpro_values'->>'unit')::unit,
                fn_delpro_text(p->'delpro_values'->>'active_substance'),
                fn_delpro_int(p->'delpro_values'->'milk_days'), fn_delpro_int(p->'delpro_values'->'meat_days'),
                coalesce((p->'delpro_values'->>'active')::boolean, true))
        returning id into v_id;
        v_link := fn_delpro_catalog_create_link('Drug', v_key, v_id, 'imported', fn_delpro_catalog_projection('Drug', v_key));
        insert into delpro_catalog_issues (issue_type, object_type, delpro_key, link_id, gvet_table, gvet_id, fingerprint, details)
        values ('clinical_review', 'Drug', v_key, v_link, 'products', v_id, 'clinical:' || v_link,
                jsonb_build_object('gvet_name', p->'delpro_values'->>'name', 'delpro_name', p->>'delpro_name',
                                   'uom', p->'delpro_values'->>'uom', 'milk_days', p->'delpro_values'->'milk_days',
                                   'meat_days', p->'delpro_values'->'meat_days',
                                   'application_method', p->'delpro_values'->>'application_method'));
        v_created := v_created + 1;
      end if;
      update delpro_catalog_links set import_snapshot = v_snapshot where id = v_link;
      v_done := v_done || jsonb_build_object('key', v_key, 'action', p->>'action', 'link_id', v_link);
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('key', v_key, 'name', p->>'delpro_name', 'reason', sqlerrm);
    end;
  end loop;

  insert into user_audit_logs (user_id, action, table_name, new_data)
  values (auth.uid(), 'delpro_catalog_import', 'delpro_catalog_links',
          jsonb_build_object('created', v_created, 'linked', v_linked, 'done', v_done, 'skipped', v_skipped));

  perform fn_delpro_catalog_reconcile();
  return jsonb_build_object('ok', true, 'created', v_created, 'linked', v_linked, 'skipped', v_skipped,
    'message', format('Sukurta: %s, susieta: %s.', v_created, v_linked)
               || case when jsonb_array_length(v_skipped) > 0 then format(' Praleista: %s.', jsonb_array_length(v_skipped)) else '' end);
end;
$$;

-- ===========================================================================
-- B. Pilot write: one test medicine, one job, a gate for exactly that job
-- ===========================================================================

alter table delpro_catalog_jobs add column pilot boolean not null default false;

insert into system_settings (setting_key, setting_value, description) values
  ('delpro_catalog_write_only_job', '',
   'Kai nurodyta: rašymas į DelPro leidžiamas TIK šiai katalogo užduočiai (bandomasis vaistas). Išvaloma automatiškai, kai užduotis baigiasi.')
on conflict (setting_key) do nothing;

create or replace function delpro_catalog_create_pilot_drug()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := 'GVET TEST vaistas ' || to_char(now() at time zone 'Europe/Vilnius', 'YYYY-MM-DD HH24:MI');
  v_prev delpro_catalog_jobs%rowtype;
  v_product uuid;
  v_job uuid;
begin
  perform fn_delpro_catalog_require_admin();
  select * into v_prev from delpro_catalog_jobs where pilot and status <> 'cancelled' order by created_at desc limit 1;
  if v_prev.id is not null then
    raise exception 'Bandomasis vaistas jau sukurtas (užduotis %, būsena %). Atšaukite ją, jei norite pradėti iš naujo.', v_prev.id, v_prev.status;
  end if;

  insert into products (name, category, unit, withdrawal_days_milk, withdrawal_days_meat, is_active, dosage_notes)
  values (v_name, 'medicines', 'ml', 0, 0, false,
          'Bandomasis įrašas GVET → DelPro rašymui patikrinti. Nenaudoti gydymui. DelPro jis kuriamas neaktyvus.')
  returning id into v_product;

  v_job := fn_delpro_catalog_enqueue('Drug', 'create', null, v_product, fn_delpro_catalog_plan_create('Drug', v_product));
  update delpro_catalog_jobs set pilot = true, label = 'Bandymas: ' || v_name where id = v_job;

  insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
  values (auth.uid(), 'delpro_catalog_pilot_created', 'delpro_catalog_jobs', v_job, jsonb_build_object('product_id', v_product, 'name', v_name));
  return jsonb_build_object('ok', true, 'job_id', v_job, 'product_id', v_product,
    'message', format('Sukurtas „%s“ ir užduotis %s. Ji nevykdoma, kol neleisite rašyti tik jai.', v_name, v_job));
end;
$$;

-- Opens the write gate for exactly one queued pilot / test job.
create or replace function delpro_catalog_release_single_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j delpro_catalog_jobs%rowtype;
begin
  perform fn_delpro_catalog_require_admin();
  select * into j from delpro_catalog_jobs where id = p_job_id;
  if j.id is null or not (j.pilot or j.is_test) then
    raise exception 'Vienkartinis leidimas galimas tik bandomajai užduočiai.';
  end if;
  if j.status <> 'queued' then
    raise exception 'Užduotis ne eilėje (būsena %).', j.status;
  end if;
  update system_settings set setting_value = j.id::text where setting_key = 'delpro_catalog_write_only_job';
  update system_settings set setting_value = 'true' where setting_key = 'delpro_catalog_write_enabled';
  insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
  values (auth.uid(), 'delpro_catalog_single_job_released', 'delpro_catalog_jobs', j.id,
          jsonb_build_object('label', j.label, 'steps', j.steps));
  return jsonb_build_object('ok', true, 'message', 'Leista įrašyti tik šią užduotį. Paleiskite ją ūkio kompiuteryje (npm.cmd run catalog:write-one).');
end;
$$;

-- The gate closes itself once the released job is no longer queued / processing.
create or replace function fn_delpro_catalog_close_single_gate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status not in ('queued', 'processing')
     and new.id::text = (select setting_value from system_settings where setting_key = 'delpro_catalog_write_only_job') then
    update system_settings set setting_value = '' where setting_key = 'delpro_catalog_write_only_job';
    update system_settings set setting_value = 'false' where setting_key = 'delpro_catalog_write_enabled';
  end if;
  return null;
end;
$$;

create trigger trg_delpro_catalog_close_single_gate
  after update of status on delpro_catalog_jobs
  for each row execute function fn_delpro_catalog_close_single_gate();

-- Switching writing off also withdraws a single-job release.
create or replace function delpro_catalog_set_write_enabled(p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform fn_delpro_catalog_require_admin();
  update system_settings set setting_value = case when p_enabled then 'true' else 'false' end
  where setting_key = 'delpro_catalog_write_enabled';
  if not p_enabled then
    update system_settings set setting_value = '' where setting_key = 'delpro_catalog_write_only_job';
  end if;
  insert into user_audit_logs (user_id, action, table_name, new_data)
  values (auth.uid(), case when p_enabled then 'delpro_catalog_write_enabled' else 'delpro_catalog_write_disabled' end,
          'system_settings', jsonb_build_object('enabled', p_enabled));
  return jsonb_build_object('ok', true, 'message', case when p_enabled then 'Rašymas į DelPro įjungtas.' else 'Rašymas į DelPro išjungtas.' end);
end;
$$;

-- A pilot job proves Drug.create like a test job does.
create or replace function delpro_catalog_mark_validated(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j delpro_catalog_jobs%rowtype;
  v_op text;
  v_list text[];
begin
  perform fn_delpro_catalog_require_admin();
  select * into j from delpro_catalog_jobs where id = p_job_id for update;
  if j.id is null or not (j.is_test or j.pilot) then
    raise exception 'Tai ne bandomoji užduotis.';
  end if;
  if j.status <> 'success' then
    raise exception 'Bandomoji užduotis dar neįvykdyta sėkmingai.';
  end if;
  v_op := j.object_type || '.' || j.operation;
  select coalesce(array_remove(string_to_array(setting_value, ','), ''), '{}') into v_list
  from system_settings where setting_key = 'delpro_catalog_validated_operations';
  if not (v_op = any (v_list)) then
    v_list := v_list || v_op;
  end if;
  update system_settings set setting_value = array_to_string(v_list, ',') where setting_key = 'delpro_catalog_validated_operations';
  update delpro_catalog_jobs set validated_at = now(), validated_by = auth.uid() where id = j.id;
  insert into user_audit_logs (user_id, action, table_name, record_id, new_data)
  values (auth.uid(), 'delpro_catalog_operation_validated', 'delpro_catalog_jobs', j.id, jsonb_build_object('operation', v_op, 'readback', j.readback));
  return jsonb_build_object('ok', true, 'message', format('Operacija %s pažymėta kaip patikrinta.', v_op));
end;
$$;

-- delpro_catalog_claim_job(jsonb): { worker_id, lease_seconds?, job_id? }
-- As 0037, plus: while delpro_catalog_write_only_job is set, ONLY that job is
-- handed out, and only to a worker that names it (job_id). A named job_id
-- never returns any other job.
create or replace function delpro_catalog_claim_job(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_worker text := nullif($1->>'worker_id', '');
  v_lease integer := coalesce(nullif($1->>'lease_seconds', '')::integer, 300);
  v_req text := nullif($1->>'job_id', '');
  v_only text := coalesce((select nullif(setting_value, '') from system_settings where setting_key = 'delpro_catalog_write_only_job'), '');
  v_validated text[];
  j delpro_catalog_jobs%rowtype;
begin
  update system_settings set setting_value = now()::text where setting_key = 'delpro_worker_last_seen_at';

  update delpro_catalog_jobs
  set status = case when attempts >= max_attempts then 'needs_review' else 'queued' end,
      lease_expires_at = null,
      error = 'Darbininkas neatsakė — užduotis grąžinta (nebaigti žingsniai bus patikrinti prieš kartojant).'
  where status = 'processing' and lease_expires_at < now();

  if coalesce((select setting_value from system_settings where setting_key = 'delpro_catalog_write_enabled'), 'false') <> 'true' then
    return null;
  end if;
  if v_only <> '' and v_req is distinct from v_only then
    return null;
  end if;
  select coalesce(array_remove(string_to_array(setting_value, ','), ''), '{}') into v_validated
  from system_settings where setting_key = 'delpro_catalog_validated_operations';

  select * into j from delpro_catalog_jobs
  where status = 'queued'
    and coalesce(next_attempt_at, created_at) <= now()
    and (v_req is null or id::text = v_req)
    and (id::text = v_only or (v_only = '' and (is_test or (object_type || '.' || operation) = any (v_validated))))
  order by created_at
  for update skip locked
  limit 1;
  if j.id is null then
    return null;
  end if;

  update delpro_catalog_jobs
  set status = 'processing', attempts = attempts + 1, worker_id = v_worker, started_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease)
  where id = j.id
  returning * into j;

  return jsonb_build_object('job_id', j.id, 'object_type', j.object_type, 'operation', j.operation, 'is_test', j.is_test,
                            'pilot', j.pilot, 'attempt', j.attempts, 'steps', j.steps, 'progress', j.progress);
end;
$$;

-- delpro_catalog_get_job(jsonb): { job_id } -> the job as stored (read-only; for the worker's write check).
create or replace function delpro_catalog_get_job(jsonb)
returns jsonb
language sql
stable
security invoker
as $$
  select jsonb_build_object('job_id', j.id, 'object_type', j.object_type, 'operation', j.operation, 'is_test', j.is_test,
                            'pilot', j.pilot, 'status', j.status, 'label', j.label, 'steps', j.steps, 'progress', j.progress,
                            'delpro_key', j.delpro_key, 'link_id', j.link_id,
                            'released', j.id::text = (select setting_value from system_settings where setting_key = 'delpro_catalog_write_only_job'),
                            'write_enabled', (select setting_value from system_settings where setting_key = 'delpro_catalog_write_enabled') = 'true')
  from delpro_catalog_jobs j where j.id = nullif($1->>'job_id', '')::uuid;
$$;

revoke all on function fn_delpro_catalog_import_plan(text) from public, anon, authenticated;
revoke all on function delpro_catalog_import_preview(text) from public, anon;
revoke all on function delpro_catalog_import_apply(jsonb) from public, anon;
revoke all on function delpro_catalog_create_pilot_drug() from public, anon;
revoke all on function delpro_catalog_release_single_job(uuid) from public, anon;
revoke all on function fn_delpro_catalog_close_single_gate() from public, anon, authenticated;
revoke all on function delpro_catalog_claim_job(jsonb) from public, anon, authenticated;
revoke all on function delpro_catalog_get_job(jsonb) from public, anon, authenticated;
grant execute on function delpro_catalog_import_preview(text) to authenticated;
grant execute on function delpro_catalog_import_apply(jsonb) to authenticated;
grant execute on function delpro_catalog_create_pilot_drug() to authenticated;
grant execute on function delpro_catalog_release_single_job(uuid) to authenticated;
grant execute on function delpro_catalog_claim_job(jsonb) to service_role;
grant execute on function delpro_catalog_get_job(jsonb) to service_role;

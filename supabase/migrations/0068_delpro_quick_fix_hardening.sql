-- 0068_delpro_quick_fix_hardening.sql
-- Review of 0067 on live data (2026-11-05):
--   * the catalog-run trigger runs inside delpro_catalog_finish_run (the farm PC's sync): an error in one waiting
--     job must never fail that sync → per-job exception block, the reason goes onto the job instead
--   * delpro_apply_quick_fix's "also cured" sweep: one record that can't be released must not roll back the fix
--   * delpro_quick_fixes warns up front when a medicine's DelPro settings (DrugParameters) were not found by the
--     last full read (live: Bioestrovet 34134, Glucose 23629 — DelPro's Drug still points at a record it no longer
--     has); "last run" = the last completed run that actually read DrugParameters. Hint only, never blocks.
-- Bodies = 0067 + these changes.

create or replace function delpro_quick_fixes(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  j delpro_sync_jobs%rowtype;
  t treatments%rowtype;
  a animals%rowtype;
  v_plan jsonb;
  v_probs jsonb;
  v_out jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
  p jsonb;
  m jsonb;
  v_fix jsonb;
  v_key text;
  v_last_run timestamptz;
begin
  if not fn_is_admin() then
    raise exception 'Greitą taisymą gali naudoti tik administratorius.';
  end if;
  select * into j from delpro_sync_jobs where id = p_job_id;
  if j.id is null then
    raise exception 'DelPro užduotis nerasta.';
  end if;
  select * into t from treatments where id = j.treatment_id;
  select * into a from animals where id = t.animal_id;
  v_plan := fn_delpro_treatment_plan(j.id);
  v_last_run := (select max(started_at) from delpro_catalog_runs
                 where status = 'completed' and coalesce((stats->'DrugParameters'->>'seen')::int, 0) > 0);

  -- what GVET sees now, plus the PC's own last answer (its live DelPro checks / write errors)
  v_probs := fn_delpro_job_open_problems(j.id);
  if j.status in ('error', 'verification_failed') then
    if jsonb_typeof(j.error_details->'problems') = 'array' then
      -- GVET-side codes are re-checked above (a fixed one is gone); keep only what the PC alone can see
      v_probs := v_probs || coalesce((select jsonb_agg(x) from jsonb_array_elements(j.error_details->'problems') x
                                      where not (x->>'code' = any (fn_delpro_gvet_checked_codes()))
                                        and not exists (select 1 from jsonb_array_elements(v_probs) y where y->>'code' = x->>'code')), '[]'::jsonb);
    elsif j.error is not null and jsonb_array_length(v_probs) = 0 then
      v_probs := jsonb_build_array(jsonb_build_object('code', case when j.status = 'verification_failed' then 'verification_failed' else 'worker_error' end,
                                                      'message', j.error));
    end if;
    if jsonb_array_length(v_probs) = 0 then
      v_probs := jsonb_build_array(jsonb_build_object('code', 'already_fixed',
        'message', 'Klaidos priežastis jau pašalinta — įrašą galima siųsti iš naujo.'));
    end if;
  end if;

  -- 0068: a medicine whose DelPro settings the last full read did not find any more will fail on the PC —
  -- say so now (hint only, never blocks sending: the PC's live check decides)
  if v_last_run is not null then
    for m in select x from jsonb_array_elements(v_plan->'medicines') x loop
      if m->>'drug_params_key' is not null
         and exists (select 1 from delpro_catalog_items i where i.object_type = 'DrugParameters' and i.delpro_key = m->>'drug_params_key'
                     and i.last_seen_at < v_last_run)
         and not exists (select 1 from jsonb_array_elements(v_probs) y where y->>'code' = 'params_not_in_delpro'
                         and y->>'message' like '%' || (m->>'drug_params_key') || '%') then
        v_probs := v_probs || jsonb_build_object('code', 'params_not_in_delpro', 'product', m->>'product_name', 'product_id', m->>'product_id',
          'message', format('DelPro vaisto „%s“ nustatymų (įrašas %s) DelPro nebėra — ūkio kompiuteris šio vaisto neįrašys.',
                            m->>'product_name', m->>'drug_params_key'));
      end if;
    end loop;
  end if;

  for p in select * from jsonb_array_elements(v_probs) loop
    m := null;
    -- the medicine the problem is about (by product id, name or DelPro parameters key)
    select x into m from jsonb_array_elements(v_plan->'medicines') x
    where x->>'product_id' = p->>'product_id' or x->>'product_name' = p->>'product'
       or (p->>'code' = 'params_not_in_delpro' and p->>'message' like '%' || (x->>'drug_params_key') || '%')
    limit 1;

    v_fix := case
      when p->>'code' in ('animal_guid', 'no_animal_guid', 'animal_number') then
        jsonb_build_object('kind', case when a.tag_no ~ '^LT[0-9]{12}$' then 'fix_tag' else 'reject' end,
          'tag_no', a.tag_no, 'tag_valid', a.tag_no ~ '^LT[0-9]{12}$', 'animal_id', a.id)
      when p->>'code' in ('diagnosis_link', 'no_diagnosis_code') and t.disease_id is not null then
        jsonb_build_object('kind', 'link_diagnosis', 'disease_id', t.disease_id,
          'disease_name', (select name from diseases where id = t.disease_id),
          'candidates', fn_delpro_quick_candidates('Diagnosis', (select name from diseases where id = t.disease_id)))
      when p->>'code' in ('diagnosis_missing', 'diagnosis_link', 'no_diagnosis_code') then
        jsonb_build_object('kind', 'manual', 'where', 'treatment')
      when p->>'code' = 'medicine_not_linked' and m is not null then
        jsonb_build_object('kind', 'link_drug', 'product_id', m->>'product_id', 'product_name', m->>'product_name',
          'candidates', fn_delpro_quick_candidates('Drug', m->>'product_name'))
      when p->>'code' = 'unit_mismatch' and m is not null then
        jsonb_build_object('kind', 'dose_factor', 'product_id', m->>'product_id', 'product_name', m->>'product_name',
          'gvet_unit', m->>'unit', 'delpro_uom', m->>'delpro_uom', 'factor', m->'dose_factor', 'gvet_qty', m->'gvet_qty')
      when p->>'code' = 'withdrawal_mismatch' and m is not null then
        jsonb_build_object('kind', 'take_delpro_withdrawal', 'product_id', m->>'product_id', 'product_name', m->>'product_name',
          'gvet_milk', m->'gvet_milk_days', 'gvet_meat', m->'gvet_meat_days', 'delpro_milk', m->'delpro_milk_days', 'delpro_meat', m->'delpro_meat_days')
      when p->>'code' in ('frequency_missing', 'course_days_missing') and m is not null then
        jsonb_build_object('kind', 'set_schedule', 'product_id', m->>'product_id', 'product_name', m->>'product_name',
          'frequency_per_day', coalesce(nullif(m->'frequency_per_day', 'null'::jsonb), '1'::jsonb),
          'course_days', coalesce(nullif(m->'course_days', 'null'::jsonb), to_jsonb(coalesce((v_plan->'treatment'->>'course_days')::int, 1))))
      when p->>'code' = 'params_not_in_delpro' then
        jsonb_build_object('kind', 'refresh_catalog', 'reason', 'params_lost',
          'product_name', m->>'product_name', 'drug_code', m->>'drug_code', 'params_key', m->>'drug_params_key',
          -- the last finished sync did not see this parameters record any more: DelPro lost it
          'delpro_lost', coalesce((select i.last_seen_at < v_last_run from delpro_catalog_items i
                                   where i.object_type = 'DrugParameters' and i.delpro_key = m->>'drug_params_key'), false))
      when p->>'code' in ('medicine_params_missing', 'withdrawal_changed_in_delpro', 'drug_not_in_delpro',
                          'diagnosis_not_in_delpro', 'animal_not_in_delpro', 'animal_number_mismatch') then
        jsonb_build_object('kind', 'refresh_catalog', 'reason', p->>'code', 'product_name', m->>'product_name')
      when p->>'code' in ('no_medicine', 'dose_missing', 'missing_dose', 'not_gydymas', 'not_treatment') then
        jsonb_build_object('kind', 'reject')
      when p->>'code' = 'integration_off' then
        jsonb_build_object('kind', 'manual', 'where', 'settings')
      when p->>'code' = 'no_treatment_protocol' then
        jsonb_build_object('kind', 'refresh_catalog', 'reason', 'no_treatment_protocol',
          'disease_name', (select name from diseases where id = t.disease_id))
      when p->>'code' = 'already_fixed' then
        jsonb_build_object('kind', 'resend')
      when j.status in ('error', 'verification_failed') then
        jsonb_build_object('kind', 'retry')
      else jsonb_build_object('kind', 'manual', 'where', 'unknown')
    end;

    v_key := (v_fix->>'kind') || ':' || coalesce(v_fix->>'product_id', '') || coalesce(v_fix->>'reason', '');
    p := p || jsonb_build_object('fix', v_fix, 'duplicate', v_key = any (v_seen));
    v_seen := v_seen || v_key;
    v_out := v_out || p;
  end loop;

  return jsonb_build_object(
    'job_id', j.id, 'status', j.status, 'attempts', j.attempts,
    'animal', coalesce(a.animal_no, a.tag_no), 'tag_no', a.tag_no, 'reg_date', t.reg_date, 'disease', t.diagnosis,
    'waiting_catalog_since', j.retry_after_catalog_at,
    'worker_last_seen', (select nullif(setting_value, '') from system_settings where setting_key = 'delpro_worker_last_seen_at'),
    'last_catalog_at', v_last_run,
    'problems', v_out);
end;
$$;


create or replace function delpro_apply_quick_fix(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j delpro_sync_jobs%rowtype;
  t treatments%rowtype;
  f jsonb;
  v_kind text;
  v_pid uuid;
  v_n integer;
  v_linked boolean := false;
  v_catalog boolean := false;
  v_retry_same boolean := false;
  v_reject text;
  v_done text[] := '{}';
  v_open jsonb;
  v_also integer := 0;
  v_tag text;
  o record;
  dp record;
  v_data_codes text[] := fn_delpro_gvet_checked_codes();
begin
  if not fn_is_admin() then
    raise exception 'Greitą taisymą gali naudoti tik administratorius.';
  end if;
  select * into j from delpro_sync_jobs where id = nullif(p_data->>'job_id', '')::uuid for update;
  if j.id is null then
    raise exception 'DelPro užduotis nerasta.';
  end if;
  if j.status not in ('pending_approval', 'error', 'verification_failed') then
    raise exception 'Šis įrašas jau siunčiamas arba baigtas (%). Atnaujinkite puslapį.', j.status;
  end if;
  select * into t from treatments where id = j.treatment_id;
  if jsonb_typeof(p_data->'fixes') is distinct from 'array' or jsonb_array_length(p_data->'fixes') = 0 then
    raise exception 'Nepasirinktas nė vienas taisymas.';
  end if;

  for f in select * from jsonb_array_elements(p_data->'fixes') loop
    v_kind := f->>'kind';
    v_pid := nullif(f->>'product_id', '')::uuid;
    if v_kind = 'link_drug' then
      if v_pid is null or nullif(f->>'delpro_key', '') is null then
        raise exception 'Pasirinkite DelPro vaistą.';
      end if;
      perform fn_delpro_catalog_create_link('Drug', f->>'delpro_key', v_pid, 'manual');
      v_linked := true;
      v_done := v_done || format('„%s“ susietas su DelPro „%s“', (select name from products where id = v_pid),
                                 (select name from delpro_catalog_items where object_type = 'Drug' and delpro_key = f->>'delpro_key'));
    elsif v_kind = 'link_diagnosis' then
      if nullif(f->>'delpro_key', '') is null then
        raise exception 'Pasirinkite DelPro diagnozę.';
      end if;
      perform fn_delpro_catalog_create_link('Diagnosis', f->>'delpro_key', coalesce(nullif(f->>'disease_id', '')::uuid, t.disease_id), 'manual');
      v_linked := true;
      v_done := v_done || format('liga susieta su DelPro „%s“',
                                 (select name from delpro_catalog_items where object_type = 'Diagnosis' and delpro_key = f->>'delpro_key'));
    elsif v_kind = 'set_schedule' then
      if v_pid is null or coalesce((f->>'frequency_per_day')::int, 0) < 1 or coalesce((f->>'course_days')::int, 0) < 1 then
        raise exception 'Įveskite, kiek kartų per dieną ir kiek dienų (bent 1).';
      end if;
      insert into treatment_medicine_schedules (treatment_id, product_id, frequency_per_day, course_days)
      values (t.id, v_pid, (f->>'frequency_per_day')::int, (f->>'course_days')::int)
      on conflict (treatment_id, product_id) do update
        set frequency_per_day = excluded.frequency_per_day, course_days = excluded.course_days;
      v_done := v_done || format('„%s“: %s k. per dieną, %s dien.', (select name from products where id = v_pid), f->>'frequency_per_day', f->>'course_days');
    elsif v_kind = 'take_delpro_withdrawal' then
      select (dpi.fields->>'dump_milk_days')::int as milk, (dpi.fields->>'meat_withhold_days')::int as meat into dp
      from delpro_catalog_links l
      join delpro_catalog_items di on di.object_type = 'Drug' and di.delpro_key = l.delpro_key and di.removed_at is null
      join delpro_catalog_items dpi on dpi.object_type = 'DrugParameters' and dpi.delpro_key = di.fields->>'default_parameters' and dpi.removed_at is null
      where l.retired_at is null and l.product_id = v_pid;
      if not found then
        raise exception 'DelPro karencija šiam vaistui negauta — paleiskite katalogo sinchronizaciją.';
      end if;
      update products set withdrawal_days_milk = dp.milk, withdrawal_days_meat = dp.meat where id = v_pid;
      v_done := v_done || format('„%s“ karencija paimta iš DelPro (pienas %s, mėsa %s d.)', (select name from products where id = v_pid),
                                 coalesce(dp.milk::text, '—'), coalesce(dp.meat::text, '—'));
    elsif v_kind = 'dose_factor' then
      if v_pid is null or coalesce((f->>'factor')::numeric, 0) <= 0 then
        raise exception 'Įveskite, kiek DelPro vienetų yra 1 GVET vienete (daugiau už 0).';
      end if;
      update products set delpro_dose_factor = (f->>'factor')::numeric where id = v_pid;
      v_done := v_done || format('„%s“: į DelPro siunčiama %s × GVET kiekis', (select name from products where id = v_pid), f->>'factor');
    elsif v_kind = 'fix_tag' then
      v_tag := upper(regexp_replace(coalesce(f->>'tag_no', ''), '\s+', '', 'g'));
      if v_tag !~ '^LT[0-9]{12}$' then
        raise exception 'Ausies numeris turi būti LT ir 12 skaitmenų, pvz. LT000012345678.';
      end if;
      if v_tag <> (select tag_no from animals where id = t.animal_id) then
        if exists (select 1 from animals where tag_no = v_tag and id <> t.animal_id) then
          raise exception 'Gyvulys su numeriu % GVET jau yra — šis gydymas įvestas ne tam gyvuliui. Atmeskite šį įrašą ir įveskite gydymą tam gyvuliui.', v_tag;
        end if;
        update animals set tag_no = v_tag where id = t.animal_id;
        v_done := v_done || format('ausies numeris pakeistas į %s', v_tag);
      end if;
      v_catalog := true;
    elsif v_kind = 'refresh_catalog' then
      v_catalog := true;
    elsif v_kind = 'retry' then
      v_retry_same := true;
    elsif v_kind = 'reject' then
      v_reject := coalesce(nullif(f->>'reason', ''), 'Greitas taisymas: atmesta');
    elsif v_kind in ('manual', 'resend') then
      null;
    else
      raise exception 'Nežinomas taisymas „%“.', v_kind;
    end if;
  end loop;

  if v_linked then
    perform fn_delpro_catalog_reconcile();
  end if;

  if v_reject is not null then
    if j.status = 'verification_failed' then
      raise exception 'Nepatikrinto įrašo atmesti negalima — pirmiausia patikrinkite DelPro.';
    end if;
    perform delpro_reject_job(j.id, v_reject);
    return jsonb_build_object('outcome', 'rejected', 'message', 'Įrašas atmestas — į DelPro nebus siunčiamas. Gydymas GVET liko.',
                              'remaining', '[]'::jsonb, 'also_released', 0);
  end if;

  v_open := fn_delpro_job_open_problems(j.id);

  if v_catalog then
    update delpro_sync_jobs set retry_after_catalog_at = now(), retry_after_catalog_by = auth.uid() where id = j.id;
    update system_settings set setting_value = now()::text where setting_key = 'delpro_catalog_sync_requested_at';
    return jsonb_build_object('outcome', 'waiting_catalog',
      'message', array_to_string(v_done || 'paprašyta ūkio kompiuterio atnaujinti DelPro duomenis — kai jis baigs (paprastai per kelias minutes), įrašas bus išsiųstas iš naujo pats'::text, '; ') || '.',
      'remaining', v_open, 'also_released', 0);
  end if;

  if jsonb_array_length(v_open) > 0 then
    return jsonb_build_object('outcome', 'remaining',
      'message', case when cardinality(v_done) > 0 then array_to_string(v_done, '; ') || '. ' else '' end || 'Dar liko pataisyti: ' ||
                 (select string_agg(x->>'message', ' ') from jsonb_array_elements(v_open) x),
      'remaining', v_open, 'also_released', 0);
  end if;

  if v_retry_same and j.status in ('error', 'verification_failed') and cardinality(v_done) = 0 then
    perform delpro_retry_job(j.id, false);
  else
    perform fn_delpro_quick_release(j.id, auth.uid(), array_to_string(v_done, '; '));
  end if;

  -- the same fix often cures other failed records (same medicine / disease)
  for o in
    select s.id from delpro_sync_jobs s
    where s.status = 'error' and s.id <> j.id and s.retry_after_catalog_at is null
      and jsonb_typeof(s.error_details->'problems') = 'array'
      and jsonb_array_length(s.error_details->'problems') > 0
      and not exists (select 1 from jsonb_array_elements(s.error_details->'problems') x where not (x->>'code' = any (v_data_codes)))
    for update
  loop
    begin
      if jsonb_array_length(fn_delpro_job_open_problems(o.id)) = 0 then
        perform fn_delpro_quick_release(o.id, auth.uid(), 'Greitas taisymas kitam įrašui: ' || array_to_string(v_done, '; '));
        v_also := v_also + 1;
      end if;
    exception when others then
      null; -- that record stays as it was; the fix itself is kept
    end;
  end loop;

  return jsonb_build_object('outcome', 'released',
    'message', case when cardinality(v_done) > 0 then array_to_string(v_done, '; ') || '. ' else '' end ||
               'Įrašas išsiųstas iš naujo — ūkio kompiuteris jį įrašys per minutę.' ||
               case when v_also > 0 then format(' Tas pats taisymas pataisė dar %s įraš. — jie irgi išsiųsti.', v_also) else '' end,
    'remaining', '[]'::jsonb, 'also_released', v_also);
end;
$$;


create or replace function fn_delpro_catalog_run_quick_retry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  o record;
  v_open jsonb;
begin
  for o in
    select id, status, retry_after_catalog_by from delpro_sync_jobs
    where retry_after_catalog_at is not null and retry_after_catalog_at < new.started_at
      and status in ('pending_approval', 'error', 'verification_failed')
    for update
  loop
   begin
    v_open := fn_delpro_job_open_problems(o.id);
    if jsonb_array_length(v_open) = 0 then
      perform fn_delpro_quick_release(o.id, o.retry_after_catalog_by, 'Greitas taisymas: DelPro duomenys atnaujinti');
    elsif o.status = 'pending_approval' then
      update delpro_sync_jobs set retry_after_catalog_at = null, retry_after_catalog_by = null where id = o.id;
    else
      update delpro_sync_jobs
      set error = (select string_agg(x->>'message', '; ') from jsonb_array_elements(v_open) x),
          error_details = jsonb_build_object('problems', v_open),
          retry_after_catalog_at = null, retry_after_catalog_by = null
      where id = o.id;
    end if;
   exception when others then
    -- never fail delpro_catalog_finish_run (the PC's sync): show it on the record instead
    update delpro_sync_jobs
    set retry_after_catalog_at = null, retry_after_catalog_by = null,
        error = coalesce(error, '') || ' (automatinis pakartojimas nepavyko: ' || sqlerrm || ')'
    where id = o.id;
   end;
  end loop;
  return null;
end;
$$;


notify pgrst, 'reload schema';

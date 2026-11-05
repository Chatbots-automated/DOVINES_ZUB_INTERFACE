-- 0060_live_karencija_delpro_master.sql
-- Dovinės ŽŪB GVET PRO — farm's decisions (2026-11-05):
--
-- A. Karencija follows the medicine's CURRENT withdrawal days.
--    treatments / vaccinations store withdrawal_until_* when they are saved
--    (0004/0021/0028). Until now a later change of a product's days only
--    affected new records. Now any change of a product's withdrawal days (flat
--    or per route) recomputes every treatment (single dose + course doses) and
--    vaccination that used it — with the same calculate_withdrawal_dates() /
--    fn_vaccinations_set_withdrawal() rules, so 0 days = no karencija and course
--    karencija still counts from the last dose. Works the same whether the days
--    were edited in Produktai or arrived from DelPro (B).
--
-- B. DelPro is the master of the shared catalog, applied without confirmations.
--    New delpro_catalog_inbound_mode value 'delpro' (the farm's setting from now):
--      * every DelPro value that differs from GVET on a linked record is applied
--        to GVET automatically after each reconcile — name, active substance,
--        active, unit, withdrawal days, template lines, recommended treatment —
--        whether it changed in DelPro (inbound_change), the link has no agreed
--        base yet (field_difference, e.g. links made by the import) or both
--        sides changed (conflict: DelPro wins);
--      * a field changed ONLY in GVET since the last agreed value
--        (outbound_pending) is left alone — a deliberate GVET edit is never
--        reverted; it is sent to DelPro (outbound) or overwritten by the next
--        DelPro change;
--      * every unlinked DelPro diagnosis / drug the import plan (0039) can
--        create or link is imported automatically (review / blocked rows stay
--        as issues — nothing is guessed), without clinical_review issues; open
--        clinical_review issues are closed;
--      * a value GVET can't take (e.g. a unit change on a product that has
--        stock, a name already used) stays an open issue as before.
--    'review' / 'auto' keep their 0036 meaning. The reconcile itself (0037) is
--    unchanged and wrapped: fn_delpro_catalog_reconcile() first does the import
--    and the DelPro-wins pass, then runs the 0037 compare (renamed
--    fn_delpro_catalog_reconcile_0037), so callers and triggers are unchanged.

-- ===========================================================================
-- A. Live karencija
-- ===========================================================================

create or replace function fn_products_withdrawal_recalc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t uuid;
begin
  for t in
    select distinct x.treatment_id from (
      select ui.treatment_id from usage_items ui where ui.product_id = new.id and ui.treatment_id is not null
      union
      select tc.treatment_id from course_doses cd join treatment_courses tc on tc.id = cd.course_id where cd.product_id = new.id
    ) x
  loop
    perform calculate_withdrawal_dates(t);
  end loop;

  -- fn_vaccinations_set_withdrawal() recomputes on an update of product_id.
  update vaccinations set product_id = product_id where product_id = new.id;
  return null;
end;
$$;

revoke all on function fn_products_withdrawal_recalc() from public, anon, authenticated;

create trigger trg_products_withdrawal_recalc
  after update of withdrawal_days_milk, withdrawal_days_meat,
                  withdrawal_iv_milk, withdrawal_iv_meat, withdrawal_im_milk, withdrawal_im_meat,
                  withdrawal_sc_milk, withdrawal_sc_meat, withdrawal_iu_milk, withdrawal_iu_meat,
                  withdrawal_imm_milk, withdrawal_imm_meat, withdrawal_pos_milk, withdrawal_pos_meat
  on products
  for each row
  when ((old.withdrawal_days_milk, old.withdrawal_days_meat,
         old.withdrawal_iv_milk, old.withdrawal_iv_meat, old.withdrawal_im_milk, old.withdrawal_im_meat,
         old.withdrawal_sc_milk, old.withdrawal_sc_meat, old.withdrawal_iu_milk, old.withdrawal_iu_meat,
         old.withdrawal_imm_milk, old.withdrawal_imm_meat, old.withdrawal_pos_milk, old.withdrawal_pos_meat)
        is distinct from
        (new.withdrawal_days_milk, new.withdrawal_days_meat,
         new.withdrawal_iv_milk, new.withdrawal_iv_meat, new.withdrawal_im_milk, new.withdrawal_im_meat,
         new.withdrawal_sc_milk, new.withdrawal_sc_meat, new.withdrawal_iu_milk, new.withdrawal_iu_meat,
         new.withdrawal_imm_milk, new.withdrawal_imm_meat, new.withdrawal_pos_milk, new.withdrawal_pos_meat))
  execute function fn_products_withdrawal_recalc();

-- Bring every stored date in line with the current days once.
select calculate_withdrawal_dates(id) from treatments;
update vaccinations set product_id = product_id;

-- ===========================================================================
-- B. DelPro master
-- ===========================================================================

update system_settings
   set setting_value = 'delpro',
       description = 'DelPro -> GVET: delpro (DelPro pagrindinis — visi skirtumai, įskaitant karenciją ir vienetus, bei nauji įrašai taikomi automatiškai) | auto (tik pavadinimas, veiklioji medžiaga, aktyvumas) | review (viskas tvirtinama ranka).'
 where setting_key = 'delpro_catalog_inbound_mode';

-- The import apply (0039) minus the admin check, for the automatic import.
-- p_auto: no clinical_review issue, no reconcile at the end (the caller is the reconcile).
create or replace function fn_delpro_catalog_import_apply_items(p_items jsonb, p_auto boolean)
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
  perform set_config('delpro.reconciling', '1', true);

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
      'run_id', v_run, 'imported_at', now(), 'imported_by', auth.uid(), 'automatic', p_auto);

    begin
      if p->>'action' = 'link' then
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
        if not p_auto then
          insert into delpro_catalog_issues (issue_type, object_type, delpro_key, link_id, gvet_table, gvet_id, fingerprint, details)
          values ('clinical_review', 'Drug', v_key, v_link, 'products', v_id, 'clinical:' || v_link,
                  jsonb_build_object('gvet_name', p->'delpro_values'->>'name', 'delpro_name', p->>'delpro_name',
                                     'uom', p->'delpro_values'->>'uom', 'milk_days', p->'delpro_values'->'milk_days',
                                     'meat_days', p->'delpro_values'->'meat_days',
                                     'application_method', p->'delpro_values'->>'application_method'));
        end if;
        v_created := v_created + 1;
      end if;
      update delpro_catalog_links set import_snapshot = v_snapshot where id = v_link;
      v_done := v_done || jsonb_build_object('key', v_key, 'action', p->>'action', 'link_id', v_link);
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('key', v_key, 'name', p->>'delpro_name', 'reason', sqlerrm);
    end;
  end loop;

  if v_created + v_linked > 0 or not p_auto then
    insert into user_audit_logs (user_id, action, table_name, new_data)
    values (auth.uid(), case when p_auto then 'delpro_catalog_import_auto' else 'delpro_catalog_import' end, 'delpro_catalog_links',
            jsonb_build_object('created', v_created, 'linked', v_linked, 'done', v_done, 'skipped', v_skipped));
  end if;

  if not p_auto then
    perform fn_delpro_catalog_reconcile();
  end if;
  return jsonb_build_object('ok', true, 'created', v_created, 'linked', v_linked, 'skipped', v_skipped,
    'message', format('Sukurta: %s, susieta: %s.', v_created, v_linked)
               || case when jsonb_array_length(v_skipped) > 0 then format(' Praleista: %s.', jsonb_array_length(v_skipped)) else '' end);
end;
$$;

revoke all on function fn_delpro_catalog_import_apply_items(jsonb, boolean) from public, anon, authenticated;

-- The admin's manual import (DelPro screen) is unchanged in behaviour.
create or replace function delpro_catalog_import_apply(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform fn_delpro_catalog_require_admin();
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Nepasirinktas nė vienas įrašas.';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'Per daug įrašų vienu kartu (daugiausia 1000).';
  end if;
  return fn_delpro_catalog_import_apply_items(p_items, false);
end;
$$;

alter function fn_delpro_catalog_reconcile() rename to fn_delpro_catalog_reconcile_0037;
revoke all on function fn_delpro_catalog_reconcile_0037() from public, anon, authenticated;

create or replace function fn_delpro_catalog_reconcile()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text := coalesce((select setting_value from system_settings where setting_key = 'delpro_catalog_inbound_mode'), 'review');
  v_items jsonb;
  v_import jsonb;
  v_result jsonb;
  l delpro_catalog_links%rowtype;
  k text;
  v_d jsonb;
  v_g jsonb;
  v_b jsonb;
  v_base jsonb;
  v_dv jsonb;
  v_bv jsonb;
  v_taken integer := 0;
  v_reviewed integer := 0;
begin
  if v_mode <> 'delpro' then
    return fn_delpro_catalog_reconcile_0037();
  end if;

  perform set_config('delpro.reconciling', '1', true);

  -- 1. Automatic import (not re-entered: the import's own inserts don't reconcile).
  if coalesce(current_setting('delpro.auto_importing', true), '') <> '1' then
    perform set_config('delpro.auto_importing', '1', true);
    select jsonb_agg(jsonb_build_object('object_type', x.object_type, 'delpro_key', x.delpro_key,
                                        'action', x.action, 'fingerprint', x.fingerprint))
      into v_items
      from fn_delpro_catalog_import_plan(null) x
     where x.action in ('create', 'link');
    if v_items is not null then
      v_import := fn_delpro_catalog_import_apply_items(v_items, true);
    end if;
    perform set_config('delpro.auto_importing', '', true);
  end if;

  -- 2. DelPro wins: drugs first (templates reference them), then templates
  --    (diagnoses reference those), then diagnoses.
  for l in
    select * from delpro_catalog_links where retired_at is null
    order by case object_type when 'Drug' then 1 when 'Treatment' then 2 else 3 end, linked_at, id
  loop
    v_d := fn_delpro_catalog_projection(l.object_type, l.delpro_key);
    continue when v_d is null;
    v_g := coalesce(fn_delpro_link_gvet_projection(l.disease_id, l.product_id, l.template_id), '{}'::jsonb);
    v_b := l.synced_fields;
    v_base := coalesce(v_b, '{}'::jsonb);

    for k in select jsonb_object_keys(v_d)
    loop
      v_dv := coalesce(v_d->k, 'null'::jsonb);
      continue when v_dv = coalesce(v_g->k, 'null'::jsonb);
      continue when v_dv = 'null'::jsonb;              -- DelPro has no value: nothing to take
      v_bv := v_b->k;
      continue when v_bv is not null and v_dv = v_bv;  -- only GVET changed (outbound_pending): never reverted
      begin
        perform fn_delpro_apply_link_field(l.id, k, v_dv);
        v_base := v_base || jsonb_build_object(k, v_dv);
        v_taken := v_taken + 1;
      exception when others then
        null; -- GVET can't take it (stock in another unit, duplicate name…): stays an issue below
      end;
    end loop;

    if v_base is distinct from coalesce(v_b, '{}'::jsonb) then
      update delpro_catalog_links set synced_fields = v_base, synced_at = now() where id = l.id;
    end if;
  end loop;

  -- 3. No confirmations: the import's clinical reviews are closed.
  update delpro_catalog_issues
     set status = 'resolved', resolution = 'auto', resolved_at = now()
   where status = 'open' and issue_type = 'clinical_review';
  get diagnostics v_reviewed = row_count;

  -- 4. The usual compare: issues for whatever could not be applied, outbound, etc.
  v_result := fn_delpro_catalog_reconcile_0037();
  return v_result || jsonb_build_object(
    'delpro_taken', v_taken,
    'imported', coalesce((v_import->>'created')::integer, 0),
    'import_linked', coalesce((v_import->>'linked')::integer, 0),
    'clinical_reviews_closed', v_reviewed);
end;
$$;

revoke all on function fn_delpro_catalog_reconcile() from public, anon, authenticated;
grant execute on function fn_delpro_catalog_reconcile() to service_role; -- delpro_catalog_finish_run (invoker)

-- Admin: switch the inbound mode and apply it at once (no waiting for the next catalog read).
create or replace function delpro_catalog_set_inbound_mode(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  perform fn_delpro_catalog_require_admin();
  if p_mode not in ('review', 'auto', 'delpro') then
    raise exception 'Neteisingas režimas.';
  end if;
  update system_settings set setting_value = p_mode where setting_key = 'delpro_catalog_inbound_mode';
  insert into user_audit_logs (user_id, action, table_name, new_data)
  values (auth.uid(), 'delpro_catalog_inbound_mode', 'system_settings', jsonb_build_object('mode', p_mode));
  if exists (select 1 from delpro_catalog_items limit 1) then
    v_result := fn_delpro_catalog_reconcile();
  end if;
  return jsonb_build_object('ok', true, 'result', v_result,
    'message', case when p_mode = 'delpro'
      then format('Išsaugota. Iš DelPro pritaikyta reikšmių: %s, importuota: %s, susieta: %s.',
                  coalesce(v_result->>'delpro_taken', '0'), coalesce(v_result->>'imported', '0'), coalesce(v_result->>'import_linked', '0'))
      else 'Išsaugota.' end);
end;
$$;

revoke all on function delpro_catalog_set_inbound_mode(text) from public, anon;
grant execute on function delpro_catalog_set_inbound_mode(text) to authenticated;

notify pgrst, 'reload schema';

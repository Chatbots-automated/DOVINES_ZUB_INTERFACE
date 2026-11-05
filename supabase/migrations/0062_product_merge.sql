-- 0062_product_merge.sql
-- Dovinės ŽŪB GVET PRO — Produktai → Sujungti dublikatus (2026-11-05).
--
-- Found on the live project: two active "Bioestrovet" products. The original
-- (used in treatments, linked to DelPro drug 100, used by the G7G protocol) had
-- 8 ml left; invoice SL061008 (360 ml) had been received onto the second one —
-- a leftover of the DelPro import, kept active after the DelPro link was moved
-- back to the original. complete_sync_steps() then refused the 10 due G7G steps
-- ("trūksta 2 ml") although the farm had 368 ml. Same names in every product
-- picker make this easy to repeat, so:
--
--   vw_product_duplicates  — products sharing a normalized name (fn_delpro_norm_name),
--                            with stock / usage / DelPro link, for the Produktai page.
--   merge_products(keep, remove) — admin only, ONE transaction: every foreign key
--     to products (found in pg_constraint, so tables added later are covered),
--     the product ids inside sync_protocol_steps.medications /
--     animal_visits.planned_medications, delpro_mappings.local_id and open
--     catalog issues are moved to `keep`; empty fields of `keep` are filled from
--     `remove` (keep's own values — incl. karencija — win); karencija of every
--     moved treatment is recomputed with keep's days (vaccinations recompute in
--     their own trigger); `remove` is deleted. Refused when the units differ
--     (stock and doses would be wrong) or both are linked to DelPro.
--   complete_sync_steps() (0059) now checks the selection's total need first and
--   says how much is missing per product, and when a same-name product holds the stock.
--   Frozen DelPro payloads (approved_payload) keep the old id: the payload_stale
--   check then asks for an explicit re-approval, never a silent change.

create or replace view vw_product_duplicates with (security_invoker = true) as
with p as (
  select pr.*, fn_delpro_norm_name(pr.name) as norm from products pr
),
d as (
  select norm from p where norm is not null group by norm having count(*) > 1
)
select
  p.norm as group_key,
  p.id,
  p.name,
  p.category,
  p.unit,
  p.is_active,
  p.created_at,
  p.registration_code,
  p.withdrawal_days_milk,
  p.withdrawal_days_meat,
  coalesce((select sum(b.qty_left) from batches b where b.product_id = p.id), 0) as stock_qty,
  (select count(*) from batches b where b.product_id = p.id)::integer as batch_count,
  (select count(*) from usage_items u where u.product_id = p.id)::integer as usage_count,
  (select l.delpro_key from delpro_catalog_links l where l.product_id = p.id and l.retired_at is null limit 1) as delpro_key
from p join d on d.norm = p.norm;

grant select on vw_product_duplicates to authenticated;

create or replace function merge_products(p_keep uuid, p_remove uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k products%rowtype;
  r products%rowtype;
  fk record;
  n integer;
  v_moved jsonb := '{}'::jsonb;
  v_treatments uuid[];
  t uuid;
begin
  if not fn_is_admin() then
    raise exception 'Produktus sujungti gali tik administratorius.' using errcode = 'insufficient_privilege';
  end if;
  if p_keep is null or p_remove is null or p_keep = p_remove then
    raise exception 'Pasirinkite du skirtingus produktus.';
  end if;
  select * into k from products where id = p_keep for update;
  if not found then raise exception 'Paliekamas produktas nerastas.'; end if;
  select * into r from products where id = p_remove for update;
  if not found then raise exception 'Šalinamas produktas nerastas.'; end if;
  if k.unit <> r.unit then
    raise exception 'Skirtingi matavimo vienetai (% ir %) — tokių produktų sujungti negalima.', k.unit, r.unit;
  end if;
  if exists (select 1 from delpro_catalog_links where product_id = p_keep and retired_at is null)
     and exists (select 1 from delpro_catalog_links where product_id = p_remove and retired_at is null) then
    raise exception 'Abu produktai susieti su DelPro — pirmiausia atsiekite vieną (DelPro → Katalogas).';
  end if;

  -- treatments whose karencija may change (their medicine becomes `keep`)
  select array_agg(distinct x) into v_treatments from (
    select treatment_id as x from usage_items where product_id = p_remove and treatment_id is not null
    union
    select tc.treatment_id from course_doses cd join treatment_courses tc on tc.id = cd.course_id where cd.product_id = p_remove
  ) s;

  perform set_config('delpro.reconciling', '1', true);

  -- every single-column foreign key to products
  for fk in
    select c.conrelid::regclass::text as tbl, a.attname::text as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'products'::regclass and array_length(c.conkey, 1) = 1
      and c.conrelid <> 'products'::regclass
    order by 1, 2
  loop
    begin
      execute format('update %s set %I = $1 where %I = $2', fk.tbl, fk.col, fk.col) using p_keep, p_remove;
    exception when unique_violation then
      raise exception 'Nepavyko sujungti: lentelėje % abu produktai naudojami tame pačiame įraše (%).', fk.tbl, sqlerrm;
    end;
    get diagnostics n = row_count;
    if n > 0 then
      v_moved := v_moved || jsonb_build_object(fk.tbl || '.' || fk.col, n);
    end if;
  end loop;

  -- product ids kept inside JSON (protocol templates + the visits planned from them)
  update sync_protocol_steps
     set medications = (select jsonb_agg(case when e->>'product_id' = p_remove::text
                                              then jsonb_set(e, '{product_id}', to_jsonb(p_keep::text)) else e end)
                        from jsonb_array_elements(medications) e)
   where medications @> jsonb_build_array(jsonb_build_object('product_id', p_remove::text));
  get diagnostics n = row_count;
  if n > 0 then v_moved := v_moved || jsonb_build_object('sync_protocol_steps.medications', n); end if;

  update animal_visits
     set planned_medications = (select jsonb_agg(case when e->>'product_id' = p_remove::text
                                                      then jsonb_set(e, '{product_id}', to_jsonb(p_keep::text)) else e end)
                                from jsonb_array_elements(planned_medications) e)
   where planned_medications @> jsonb_build_array(jsonb_build_object('product_id', p_remove::text));
  get diagnostics n = row_count;
  if n > 0 then v_moved := v_moved || jsonb_build_object('animal_visits.planned_medications', n); end if;

  update delpro_mappings set local_id = p_keep where kind = 'product' and local_id = p_remove;
  update delpro_catalog_issues set gvet_id = p_keep where gvet_table = 'products' and gvet_id = p_remove;

  -- fill what `keep` lacks; keep's own values (name, category, karencija, unit) win
  update products set
    registration_code = coalesce(k.registration_code, r.registration_code),
    active_substance = coalesce(k.active_substance, r.active_substance),
    dosage_notes = coalesce(k.dosage_notes, r.dosage_notes),
    package_weight_g = coalesce(k.package_weight_g, r.package_weight_g),
    min_stock_alert = coalesce(k.min_stock_alert, r.min_stock_alert),
    pack_size = coalesce(k.pack_size, r.pack_size),
    nomenclature_no = coalesce(k.nomenclature_no, r.nomenclature_no),
    subcategory_id = coalesce(k.subcategory_id, r.subcategory_id),
    write_off_kind = coalesce(k.write_off_kind, r.write_off_kind),
    act_unit = coalesce(k.act_unit, r.act_unit),
    act_unit_size = coalesce(k.act_unit_size, r.act_unit_size),
    default_write_off_group_id = coalesce(k.default_write_off_group_id, r.default_write_off_group_id),
    standard_amount = coalesce(k.standard_amount, r.standard_amount),
    is_active = k.is_active or r.is_active
  where id = p_keep;

  if v_treatments is not null then
    foreach t in array v_treatments loop
      perform calculate_withdrawal_dates(t);
    end loop;
  end if;

  delete from products where id = p_remove;

  insert into user_audit_logs (user_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), 'merge_products', 'products', p_keep, to_jsonb(r), jsonb_build_object('kept', p_keep, 'moved', v_moved));

  perform set_config('delpro.reconciling', '0', true);
  if exists (select 1 from delpro_catalog_items limit 1) then
    begin
      perform fn_delpro_catalog_reconcile();
    exception when others then
      raise warning 'DelPro katalogo palyginimas nepavyko: %', sqlerrm;
    end;
  end if;

  return jsonb_build_object('ok', true, 'kept', p_keep, 'removed', p_remove, 'moved', v_moved,
    'stock_qty', (select coalesce(sum(qty_left), 0) from batches where product_id = p_keep));
end;
$$;

revoke all on function merge_products(uuid, uuid) from public, anon;
grant execute on function merge_products(uuid, uuid) to authenticated;

-- complete_sync_steps (0059) + a clear stock message up front.
create or replace function complete_sync_steps(p_data jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_vet text := nullif(btrim(p_data->>'vet_name'), '');
  v_today date := (now() at time zone 'Europe/Vilnius')::date;
  v_ids uuid[];
  v animal_visits%rowtype;
  v_day date;
  v_steps integer := 0;
  v_treat integer := 0;
  v_short text;
begin
  if jsonb_typeof(p_data->'visit_ids') is distinct from 'array' then
    raise exception 'Pasirinkite bent vieną žingsnį.';
  end if;
  select array_agg(distinct (x #>> '{}')::uuid) into v_ids
  from jsonb_array_elements(p_data->'visit_ids') x where nullif(x #>> '{}', '') is not null;
  if v_ids is null then
    raise exception 'Pasirinkite bent vieną žingsnį.';
  end if;
  if (select count(*) from animal_visits where id = any (v_ids)) <> array_length(v_ids, 1) then
    raise exception 'Kai kurie žingsniai nerasti — atnaujinkite puslapį.';
  end if;

  -- 0062: the whole selection's need vs usable stock (same rule as FEFO), named per
  -- product — FEFO's own message only shows the shortfall of the one animal where it ran out.
  select string_agg(format('„%s“ — reikia %s %s (%s žingsn.), turima %s %s%s', p.name, n.need, p.unit, n.cnt,
                           coalesce(h.have, 0), p.unit,
                           case when exists (
                             select 1 from products d join batches b on b.product_id = d.id
                             where d.id <> p.id and fn_delpro_norm_name(d.name) = fn_delpro_norm_name(p.name)
                               and b.status = 'active' and b.qty_left > 0 and (b.expiry_date is null or b.expiry_date >= current_date))
                           then ' (likutis yra kitame produkte tuo pačiu pavadinimu — sujunkite juos: Produktai)' else '' end), '; ')
    into v_short
    from (
      select (m->>'product_id')::uuid as pid, sum((m->>'qty')::numeric) as need, count(*) as cnt
      from animal_visits av, jsonb_array_elements(av.planned_medications) m
      where av.id = any (v_ids) and not ('sekinimas' = any (av.procedures))
      group by 1
    ) n
    join products p on p.id = n.pid
    left join lateral (
      select sum(b.qty_left) as have from batches b
      where b.product_id = n.pid and b.status = 'active' and b.qty_left > 0 and (b.expiry_date is null or b.expiry_date >= current_date)
    ) h on true
   where coalesce(h.have, 0) < n.need;
  if v_short is not null then
    raise exception 'Nepakanka atsargų: %. Neįrašytas nė vienas žingsnis.', v_short;
  end if;

  for v in
    select * from animal_visits where id = any (v_ids) order by visit_datetime, animal_id for update
  loop
    v_day := (v.visit_datetime at time zone 'Europe/Vilnius')::date;
    if v.sync_application_id is null then
      raise exception 'Vizitas nėra sinchronizacijos protokolo žingsnis.';
    end if;
    if v.status not in ('planuojamas', 'vykdomas') then
      raise exception 'Žingsnis „%“ (%) jau uždarytas.', v.sync_step_title, v_day;
    end if;
    if v_day > v_today then
      raise exception 'Žingsnis „%“ suplanuotas %, jo dar negalima įrašyti.', v.sync_step_title, v_day;
    end if;
    if 'sekinimas' = any (v.procedures) then
      raise exception 'Sėklinimo žingsnį („%“) įrašykite atskirai — reikia pasirinkti spermą.', v.sync_step_title;
    end if;

    if jsonb_array_length(v.planned_medications) > 0 then
      perform create_treatment_with_visits(
        jsonb_build_object(
          'procedure_type', 'sinchronizacija',
          'reg_date', v_day,
          'vet_name', coalesce(v_vet, v.vet_name),
          'notes', v.sync_step_title,
          'medications', v.planned_medications
        ),
        v.id
      );
      v_treat := v_treat + 1;
    else
      update animal_visits set status = 'baigtas', vet_name = coalesce(v_vet, vet_name) where id = v.id;
    end if;
    v_steps := v_steps + 1;
  end loop;

  return jsonb_build_object('steps', v_steps, 'treatments', v_treat);
end;
$$;

grant execute on function complete_sync_steps(jsonb) to authenticated;

notify pgrst, 'reload schema';

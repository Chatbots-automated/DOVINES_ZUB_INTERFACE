-- 0016_write_off_by_pack.sql
-- Nurašymo aktai count drugs and vaccines in packages (the farm's Excel:
-- Bioestrovet 25.8 vnt), while treatments are recorded in ml. Instead of a
-- separate "act unit" setting per product, the product's pack size
-- (products.pack_size, filled on pajamavimas) is the conversion: a drug or
-- vaccine with a pack size appears on the act as vnt = ml / pack size.
-- Everything else (feed additives, materials, biocides) keeps its stock unit.
-- products.act_unit / act_unit_size from 0012 still win when set (old data),
-- but the product form no longer shows them.

create or replace function generate_write_off_act(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_kind text := coalesce(nullif(p_data->>'act_kind', ''), 'vaistai');
  v_start date := (p_data->>'period_start')::date;
  v_end date := (p_data->>'period_end')::date;
  v_act_date date := coalesce(nullif(p_data->>'act_date', '')::date, (p_data->>'period_end')::date, current_date);
  v_number text := nullif(trim(p_data->>'act_number'), '');
  v_prefix text;
  v_seq integer;
  v_act_id uuid;
  v_item_id uuid;
  v_line integer := 0;
  v_ids uuid[];
  v_settings jsonb;
  r record;
begin
  if v_kind not in ('vaistai', 'priedai', 'medziagos') then
    raise exception 'Nežinomas akto tipas: %', v_kind;
  end if;
  if v_start is null or v_end is null then
    raise exception 'Nurodykite laikotarpį.';
  end if;

  select array_agg(u.usage_item_id) into v_ids
  from vw_usage_items_detailed u
  join products p on p.id = u.product_id
  where u.used_on between v_start and v_end
    and fn_product_write_off_kind(p.category, p.write_off_kind) = v_kind
    and not exists (select 1 from write_off_act_usage_items w where w.usage_item_id = u.usage_item_id);

  if v_ids is null then
    raise exception 'Šiuo laikotarpiu nėra nenurašytų šio tipo produktų.';
  end if;

  select jsonb_object_agg(setting_key, setting_value) into v_settings
  from system_settings where setting_key like 'write_off_%';

  -- YYYYMMNN, next free NN for the act month across all templates;
  -- serialized so two users can't collide.
  perform pg_advisory_xact_lock(hashtext('write_off_act_number'));
  if v_number is null then
    v_prefix := to_char(v_act_date, 'YYYYMM');
    select coalesce(max(substr(act_number, 7)::integer), 0) + 1 into v_seq
    from write_off_acts where act_number ~ ('^' || v_prefix || '[0-9]{2}$');
    v_number := v_prefix || lpad(v_seq::text, 2, '0');
  end if;

  insert into write_off_acts (act_number, act_kind, act_date, period_start, period_end, notes, created_by,
                              account_no, expense_object, approver_title, approver_name, signatories)
  values (v_number, v_kind, v_act_date, v_start, v_end, nullif(p_data->>'notes', ''), auth.uid(),
          case when v_kind = 'medziagos' then v_settings->>'write_off_medziagos_account' end,
          case when v_kind = 'medziagos' then v_settings->>'write_off_medziagos_expense_object' end,
          v_settings->>'write_off_approver_title',
          v_settings->>'write_off_approver_name',
          coalesce((v_settings->>('write_off_signatories_' || v_kind))::jsonb, '[]'::jsonb))
  returning id into v_act_id;

  for r in
    select u.product_id, p.name as product_name, p.category, p.registration_code, p.nomenclature_no,
           case
             when nullif(p.act_unit, '') is not null then p.act_unit
             when p.category in ('medicines', 'vakcina') and p.pack_size is not null
                  and p.unit not in ('vnt', 'pcs') then 'vnt'
             else coalesce(max(u.unit::text), p.unit::text)
           end as unit,
           case
             when p.act_unit_size is not null then p.act_unit_size
             when p.category in ('medicines', 'vakcina') and p.pack_size is not null
                  and p.unit not in ('vnt', 'pcs') then p.pack_size
             else 1
           end as factor,
           sum(u.qty) as qty,
           sum(u.qty * coalesce(u.purchase_price, 0)) as cost,
           string_agg(distinct u.lot, ', ') as lots
    from vw_usage_items_detailed u
    join products p on p.id = u.product_id
    where u.usage_item_id = any (v_ids)
    group by u.product_id, p.name, p.category, p.registration_code, p.nomenclature_no, p.act_unit, p.act_unit_size, p.unit, p.pack_size
    order by lower(p.name)
  loop
    v_line := v_line + 1;
    insert into write_off_act_items (act_id, line_no, product_id, product_name, product_category, registration_code,
                                     nomenclature_no, lots, unit, unit_label, quantity, unit_price, total_price)
    values (v_act_id, v_line, r.product_id, r.product_name, r.category, r.registration_code, r.nomenclature_no, r.lots,
            case when r.unit in ('ml', 'l', 'g', 'kg', 'pcs', 'vnt', 'tablet', 'dose') then r.unit::unit end,
            r.unit,
            round(r.qty / r.factor, 4),
            round(r.cost / nullif(r.qty / r.factor, 0), 4),
            round(r.cost, 2))
    returning id into v_item_id;

    insert into write_off_act_allocations (item_id, write_off_group_id, label, quantity, animal_count, suggested)
    select v_item_id, s.group_id, coalesce(g.name, 'Nepriskirta grupei'), round(s.qty / r.factor, 4), s.animals, true
    from (
      select fn_resolve_write_off_group(v_kind, u.general_write_off_group_id, u.animal_group, u.animal_sex,
                                        p.default_write_off_group_id) as group_id,
             sum(u.qty) as qty,
             nullif(count(distinct u.animal_id), 0)::integer as animals
      from vw_usage_items_detailed u
      join products p on p.id = u.product_id
      where u.usage_item_id = any (v_ids) and u.product_id = r.product_id
      group by 1
    ) s
    left join write_off_groups g on g.id = s.group_id
    order by g.sort_order nulls last;
  end loop;

  insert into write_off_act_usage_items (act_id, usage_item_id)
  select v_act_id, unnest(v_ids);

  return v_act_id;
end;
$$;

notify pgrst, 'reload schema';

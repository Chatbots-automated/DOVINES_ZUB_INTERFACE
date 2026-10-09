-- 0027_profilaktika_boliusai_rules.sql
-- Profilaktika and Boliusai (added in 0026) are drugs: like medicines and
-- vaccines they need a serija + galiojimo terminas on pajamavimas (journals
-- §2.8), appear in the veterinary drug journal, and show on the nurašymo aktas
-- as packages. fn_is_drug_category() is the single list for those rules.
-- The bodies of receive_invoice (0015), generate_write_off_act (0016) and
-- vw_vet_drug_journal (0015) are unchanged apart from the category test.

create or replace function fn_is_drug_category(p_category product_category)
returns boolean
language sql
immutable
as $$
  select p_category::text in ('medicines', 'vakcina', 'profilaktika', 'boliusai');
$$;

create or replace function receive_invoice(p_data jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_mode text := coalesce(nullif(p_data->>'mode', ''), 'pdf');
  v_sup jsonb := coalesce(p_data->'supplier', '{}'::jsonb);
  v_inv jsonb := coalesce(p_data->'invoice', '{}'::jsonb);
  v_number text := nullif(trim(v_inv->>'number'), '');
  v_sup_name text := nullif(trim(v_sup->>'name'), '');
  v_sup_code text := nullif(trim(v_sup->>'code'), '');
  v_sup_vat text := nullif(trim(v_sup->>'vat_code'), '');
  v_supplier_id uuid := nullif(p_data->>'supplier_id', '')::uuid;
  v_invoice_id uuid;
  v_date date := coalesce(nullif(v_inv->>'date', '')::date, current_date);
  v_item jsonb;
  v_product products%rowtype;
  v_line integer := 0;
  v_size numeric;
  v_count numeric;
  v_qty numeric;
  v_total numeric;
  v_unit_price numeric;
  v_lot text;
  v_expiry date;
  v_batch_id uuid;
  v_sum numeric := 0;
begin
  if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') = 0 then
    raise exception 'Pasirinkite bent vieną prekės eilutę.';
  end if;

  -- Supplier: given id, else VAT code, else company code, else exact name.
  if v_supplier_id is null and v_sup_name is not null then
    select id into v_supplier_id from suppliers
    where (v_sup_vat is not null and vat_code = v_sup_vat)
       or (v_sup_code is not null and code = v_sup_code)
       or lower(name) = lower(v_sup_name)
    order by (vat_code = v_sup_vat) desc nulls last, (code = v_sup_code) desc nulls last
    limit 1;
    if v_supplier_id is null then
      insert into suppliers (name, code, vat_code) values (v_sup_name, v_sup_code, v_sup_vat)
      returning id into v_supplier_id;
    end if;
  end if;
  if v_sup_name is null and v_supplier_id is not null then
    select name into v_sup_name from suppliers where id = v_supplier_id;
  end if;

  -- Invoice header (serialized per number so a double click can't race).
  if v_number is not null then
    perform pg_advisory_xact_lock(hashtext('receive_invoice:' || lower(v_number)));
    select id into v_invoice_id from invoices
    where invoice_number = v_number
      and coalesce(supplier_id, '00000000-0000-0000-0000-000000000000') = coalesce(v_supplier_id, '00000000-0000-0000-0000-000000000000');
    if v_invoice_id is not null and v_mode = 'pdf' then
      raise exception 'Sąskaita Nr. % (%) jau pajamuota. Pakartotinai jos priimti negalima.', v_number, coalesce(v_sup_name, 'be tiekėjo');
    end if;
  end if;

  if v_invoice_id is null and (v_number is not null or v_mode = 'pdf') then
    insert into invoices (invoice_number, invoice_date, supplier_id, supplier_name, total_net, total_vat, total_gross,
                          currency, pdf_filename, raw_parsed, created_by)
    values (v_number, v_date, v_supplier_id, v_sup_name,
            nullif(v_inv->>'total_net', '')::numeric, nullif(v_inv->>'total_vat', '')::numeric,
            nullif(v_inv->>'total_gross', '')::numeric,
            coalesce(nullif(v_inv->>'currency', ''), 'EUR'), nullif(p_data->>'pdf_filename', ''),
            case when jsonb_typeof(p_data->'raw_parsed') = 'object' then p_data->'raw_parsed' end, auth.uid())
    returning id into v_invoice_id;
  end if;

  select coalesce(max(line_no), 0) into v_line from invoice_items where invoice_id = v_invoice_id;

  for v_item in select * from jsonb_array_elements(p_data->'items')
  loop
    select * into v_product from products where id = nullif(v_item->>'product_id', '')::uuid;
    if not found then
      raise exception 'Trūksta produkto eilutei „%“.', coalesce(v_item->>'description', '?');
    end if;

    v_size := nullif(v_item->>'package_size', '')::numeric;
    v_count := nullif(v_item->>'package_count', '')::numeric;
    v_qty := case when coalesce(v_size, 0) > 0 and coalesce(v_count, 0) > 0 then v_size * v_count
                  else nullif(v_item->>'qty', '')::numeric end;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Patikrinkite kiekį produktui „%“.', v_product.name;
    end if;

    v_lot := nullif(trim(v_item->>'lot'), '');
    v_expiry := nullif(v_item->>'expiry_date', '')::date;
    if fn_is_drug_category(v_product.category) or v_product.category = 'biocide' then
      if v_lot is null or v_expiry is null then
        raise exception '„%“: nurodykite serijos numerį ir galiojimo terminą.', v_product.name;
      end if;
    end if;
    if v_expiry is not null and v_expiry < current_date then
      raise exception '„%“: galiojimo terminas (%) jau pasibaigęs.', v_product.name, v_expiry;
    end if;

    v_total := nullif(v_item->>'line_total', '')::numeric;
    v_unit_price := case when v_total is not null then v_total / v_qty
                         else nullif(v_item->>'unit_price', '')::numeric end;
    v_total := coalesce(v_total, v_unit_price * v_qty);

    insert into batches (product_id, supplier_id, invoice_id, lot, expiry_date, received_qty, package_size,
                         package_count, purchase_price, currency, created_by)
    values (v_product.id, v_supplier_id, v_invoice_id, v_lot, v_expiry, v_qty,
            case when coalesce(v_size, 0) > 0 and coalesce(v_count, 0) > 0 then v_size end,
            case when coalesce(v_size, 0) > 0 and coalesce(v_count, 0) > 0 then v_count end,
            round(v_unit_price, 4), coalesce(nullif(v_inv->>'currency', ''), 'EUR'), auth.uid())
    returning id into v_batch_id;

    if v_invoice_id is not null then
      v_line := v_line + 1;
      insert into invoice_items (invoice_id, product_id, batch_id, line_no, description, sku, quantity, unit_price, total_price)
      values (v_invoice_id, v_product.id, v_batch_id, v_line, nullif(v_item->>'description', ''), nullif(v_item->>'sku', ''),
              v_qty, round(v_unit_price, 4), round(v_total, 2));
    end if;
    v_sum := v_sum + coalesce(v_total, 0);
  end loop;

  return jsonb_build_object('invoice_id', v_invoice_id, 'batches', jsonb_array_length(p_data->'items'), 'total', round(v_sum, 2));
end;
$$;

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
             when fn_is_drug_category(p.category) and p.pack_size is not null
                  and p.unit not in ('vnt', 'pcs') then 'vnt'
             else coalesce(max(u.unit::text), p.unit::text)
           end as unit,
           case
             when p.act_unit_size is not null then p.act_unit_size
             when fn_is_drug_category(p.category) and p.pack_size is not null
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

-- Veterinarinių vaistų ir veterinarinių preparatų apskaitos žurnalas:
-- drugs + vaccines + profilaktika + boliusai, receipt dated by the invoice.
create or replace view vw_vet_drug_journal
with (security_invoker = true) as
select
  b.id as batch_id,
  p.id as product_id,
  p.name as product_name,
  p.category,
  p.registration_code,
  p.active_substance,
  p.unit,
  coalesce(i.invoice_date, b.received_at::date) as receipt_date,
  coalesce(s.name, i.supplier_name) as supplier_name,
  i.invoice_number,
  i.invoice_date,
  b.received_qty,
  b.expiry_date,
  b.lot as batch_number,
  (b.received_qty - b.qty_left) as quantity_used,
  b.qty_left as quantity_remaining
from batches b
join products p on p.id = b.product_id
left join suppliers s on s.id = b.supplier_id
left join invoices i on i.id = b.invoice_id
where fn_is_drug_category(p.category)
order by receipt_date desc;

notify pgrst, 'reload schema';

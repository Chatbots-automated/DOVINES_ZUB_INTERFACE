-- 0058_receipt_editing.sql
-- Dovinės ŽŪB GVET PRO — Pajamavimas → Redagavimas (farm's request, 2026-11).
-- Pajamavimas is Priedas §2.2/§2.11; editing an already received invoice is an
-- extension of it, billed separately per Sutartis §2.5/§4.6.
--
-- Everything that receive_invoice() (0015/0027) wrote can be corrected:
--   * invoice header (number, date, supplier, totals, currency)
--   * every line = one batch + its invoice_items row (product, qty / pack
--     size × count, line total → per-unit price, serija, galiojimas)
--   * lines can be added and removed
--   * stock received without an invoice (manual, no number) — one batch
--   * suppliers (the name is copied to their invoices' supplier_name snapshot)
-- One RPC = one transaction, like every other stock write (AGENTS.md).
--
-- Stock stays consistent: used = received_qty − qty_left (only usage_items move
-- qty_left, fn_usage_items_deduct_stock / _restore_stock, 0004). A new quantity
-- keeps "used" and moves qty_left by the difference; it can never drop below
-- what was already used. A used line can't change product or be removed (its
-- treatments / karencija / acts were computed for that product). Changing the
-- serija / galiojimas / price of a used line IS allowed: journals and analytics
-- read the batch live; nurašymo aktai already generated keep the values they
-- printed (write_off_act_items snapshot lots and prices, 0007).

-- ---------------------------------------------------------------------------
-- fn_receipt_resolve_supplier(jsonb) — same match as receive_invoice():
-- given id, else VAT code, else company code, else exact name; creates one
-- when nothing matches. NULL when nothing was given.
-- ---------------------------------------------------------------------------

create or replace function fn_receipt_resolve_supplier(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_sup jsonb := coalesce(p_data->'supplier', '{}'::jsonb);
  v_id uuid := nullif(p_data->>'supplier_id', '')::uuid;
  v_name text := nullif(btrim(v_sup->>'name'), '');
  v_code text := nullif(btrim(v_sup->>'code'), '');
  v_vat text := nullif(btrim(v_sup->>'vat_code'), '');
begin
  if v_id is not null then
    if not exists (select 1 from suppliers where id = v_id) then
      raise exception 'Tiekėjas nerastas.';
    end if;
    return v_id;
  end if;
  if v_name is null then
    return null;
  end if;
  select id into v_id from suppliers
  where (v_vat is not null and vat_code = v_vat)
     or (v_code is not null and code = v_code)
     or lower(name) = lower(v_name)
  order by (vat_code = v_vat) desc nulls last, (code = v_code) desc nulls last
  limit 1;
  if v_id is null then
    insert into suppliers (name, code, vat_code) values (v_name, v_code, v_vat) returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- fn_receipt_save_line(batch_id | null, item, supplier, invoice, currency,
-- received_at | null) — inserts or corrects ONE batch (+ its invoice line when
-- the batch belongs to an invoice). Item shape = receive_invoice() items.
-- Returns the batch id.
-- ---------------------------------------------------------------------------

create or replace function fn_receipt_save_line(
  p_batch_id uuid,
  p_item jsonb,
  p_supplier_id uuid,
  p_invoice_id uuid,
  p_currency text,
  p_received_at timestamptz default null
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_old batches%rowtype;
  v_product products%rowtype;
  v_size numeric := nullif(p_item->>'package_size', '')::numeric;
  v_count numeric := nullif(p_item->>'package_count', '')::numeric;
  v_packaged boolean;
  v_qty numeric;
  v_total numeric := nullif(p_item->>'line_total', '')::numeric;
  v_unit_price numeric;
  v_lot text := nullif(btrim(p_item->>'lot'), '');
  v_expiry date := nullif(p_item->>'expiry_date', '')::date;
  v_used numeric := 0;
  v_left numeric;
  v_batch_id uuid := p_batch_id;
  v_line integer;
begin
  if v_batch_id is not null then
    select * into v_old from batches where id = v_batch_id for update;
    if not found then
      raise exception 'Partija nerasta.';
    end if;
    v_used := v_old.received_qty - v_old.qty_left;
  end if;

  select * into v_product from products where id = nullif(p_item->>'product_id', '')::uuid;
  if not found then
    raise exception 'Trūksta produkto eilutei „%“.', coalesce(nullif(p_item->>'description', ''), '?');
  end if;

  v_packaged := coalesce(v_size, 0) > 0 and coalesce(v_count, 0) > 0;
  v_qty := case when v_packaged then v_size * v_count else nullif(p_item->>'qty', '')::numeric end;
  if v_qty is null or v_qty <= 0 then
    raise exception 'Patikrinkite kiekį produktui „%“.', v_product.name;
  end if;

  if v_batch_id is not null then
    if v_product.id <> v_old.product_id
       and (v_used > 0 or exists (select 1 from usage_items where batch_id = v_batch_id)) then
      raise exception 'Partija „%“ (%) jau naudota — produkto pakeisti negalima.',
        coalesce(v_old.lot, 'be serijos'), (select name from products where id = v_old.product_id);
    end if;
    if v_qty < v_used then
      raise exception '„%“: jau sunaudota % — kiekis negali būti mažesnis (įvesta %).', v_product.name, v_used, v_qty;
    end if;
  end if;

  if fn_is_drug_category(v_product.category) or v_product.category = 'biocide' then
    if v_lot is null or v_expiry is null then
      raise exception '„%“: nurodykite serijos numerį ir galiojimo terminą.', v_product.name;
    end if;
  end if;
  -- A new line, or a changed date, can't be already expired; an old batch that
  -- expired since it was received keeps its date when something else is edited.
  if v_expiry is not null and v_expiry < current_date
     and (v_batch_id is null or v_expiry is distinct from v_old.expiry_date) then
    raise exception '„%“: galiojimo terminas (%) jau pasibaigęs.', v_product.name, v_expiry;
  end if;

  v_unit_price := case when v_total is not null then v_total / v_qty
                       else nullif(p_item->>'unit_price', '')::numeric end;
  v_total := coalesce(v_total, v_unit_price * v_qty);

  if v_batch_id is null then
    insert into batches (product_id, supplier_id, invoice_id, lot, expiry_date, received_qty, package_size,
                         package_count, purchase_price, currency, received_at, created_by)
    values (v_product.id, p_supplier_id, p_invoice_id, v_lot, v_expiry, v_qty,
            case when v_packaged then v_size end, case when v_packaged then v_count end,
            round(v_unit_price, 4), coalesce(p_currency, 'EUR'), coalesce(p_received_at, now()), auth.uid())
    returning id into v_batch_id;

    if p_invoice_id is not null then
      select coalesce(max(line_no), 0) + 1 into v_line from invoice_items where invoice_id = p_invoice_id;
      insert into invoice_items (invoice_id, product_id, batch_id, line_no, description, sku, quantity, unit_price, total_price)
      values (p_invoice_id, v_product.id, v_batch_id, v_line, nullif(p_item->>'description', ''), nullif(p_item->>'sku', ''),
              v_qty, round(v_unit_price, 4), round(v_total, 2));
    end if;
    return v_batch_id;
  end if;

  v_left := v_qty - v_used;
  update batches
     set product_id = v_product.id,
         supplier_id = p_supplier_id,
         invoice_id = p_invoice_id,
         lot = v_lot,
         expiry_date = v_expiry,
         received_qty = v_qty,
         qty_left = v_left,
         package_size = case when v_packaged then v_size end,
         package_count = case when v_packaged then v_count end,
         purchase_price = round(v_unit_price, 4),
         currency = coalesce(p_currency, currency),
         received_at = coalesce(p_received_at, received_at),
         status = case when v_left <= 0 then 'depleted'::batch_status else 'active'::batch_status end
   where id = v_batch_id;

  -- The auto medical-waste row (0004) follows the corrected quantity: a batch
  -- that is no longer empty loses it, one that became empty gets it.
  if v_left > 0 and v_old.qty_left <= 0 then
    with gone as (
      delete from batch_waste_tracking t
      using medical_waste w
      where t.batch_id = v_batch_id and w.id = t.medical_waste_id and w.auto_generated
      returning t.medical_waste_id
    )
    delete from medical_waste where id in (select medical_waste_id from gone);
  elsif v_left <= 0 and v_old.qty_left > 0 then
    perform auto_generate_medical_waste(v_batch_id);
  end if;

  if p_invoice_id is not null then
    update invoice_items
       set product_id = v_product.id,
           description = case when p_item ? 'description' then nullif(p_item->>'description', '') else description end,
           sku = case when p_item ? 'sku' then nullif(p_item->>'sku', '') else sku end,
           quantity = v_qty,
           unit_price = round(v_unit_price, 4),
           total_price = round(v_total, 2)
     where batch_id = v_batch_id and invoice_id = p_invoice_id;
    if not found then
      select coalesce(max(line_no), 0) + 1 into v_line from invoice_items where invoice_id = p_invoice_id;
      insert into invoice_items (invoice_id, product_id, batch_id, line_no, description, sku, quantity, unit_price, total_price)
      values (p_invoice_id, v_product.id, v_batch_id, v_line, nullif(p_item->>'description', ''), nullif(p_item->>'sku', ''),
              v_qty, round(v_unit_price, 4), round(v_total, 2));
    end if;
  end if;

  return v_batch_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- fn_receipt_remove_line(batch) — a line that was never used.
-- ---------------------------------------------------------------------------

create or replace function fn_receipt_remove_line(p_batch_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v batches%rowtype;
  v_name text;
begin
  select * into v from batches where id = p_batch_id for update;
  if not found then
    raise exception 'Partija nerasta.';
  end if;
  select name into v_name from products where id = v.product_id;
  if v.qty_left < v.received_qty
     or exists (select 1 from usage_items where batch_id = p_batch_id)
     or exists (select 1 from course_doses where batch_id = p_batch_id)
     or exists (select 1 from general_usage where batch_id = p_batch_id) then
    raise exception '„%“ (serija %) jau naudota — eilutės pašalinti negalima.', v_name, coalesce(v.lot, '—');
  end if;
  delete from invoice_items where batch_id = p_batch_id;
  delete from batches where id = p_batch_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- update_invoice(jsonb) —
-- { invoice_id, supplier_id? | supplier:{name,code,vat_code}?,
--   invoice:{number,date,currency,total_net,total_vat,total_gross},
--   items:[{batch_id?, product_id, description, sku, qty | package_size+package_count,
--           line_total | unit_price, lot, expiry_date}],
--   removed_batch_ids:[uuid] }
-- Lines not mentioned stay as they are. Returns { invoice_id, lines, total }.
-- ---------------------------------------------------------------------------

create or replace function update_invoice(p_data jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_id uuid := nullif(p_data->>'invoice_id', '')::uuid;
  v_inv invoices%rowtype;
  v_h jsonb := coalesce(p_data->'invoice', '{}'::jsonb);
  v_number text;
  v_date date;
  v_currency text;
  v_supplier_id uuid;
  v_supplier_name text;
  v_item jsonb;
  v_batch uuid;
  v_removed uuid;
  v_lines integer;
  v_sum numeric;
begin
  select * into v_inv from invoices where id = v_id for update;
  if not found then
    raise exception 'Sąskaita nerasta.';
  end if;

  v_number := case when v_h ? 'number' then nullif(btrim(v_h->>'number'), '') else v_inv.invoice_number end;
  v_date := case when v_h ? 'date' then coalesce(nullif(v_h->>'date', '')::date, v_inv.invoice_date) else v_inv.invoice_date end;
  v_currency := coalesce(nullif(v_h->>'currency', ''), v_inv.currency, 'EUR');

  if p_data ? 'supplier_id' or p_data ? 'supplier' then
    v_supplier_id := fn_receipt_resolve_supplier(p_data);
  else
    v_supplier_id := v_inv.supplier_id;
  end if;
  v_supplier_name := case when v_supplier_id is null then
                       case when p_data ? 'supplier_id' or p_data ? 'supplier' then null else v_inv.supplier_name end
                     else (select name from suppliers where id = v_supplier_id) end;

  if v_number is not null then
    perform pg_advisory_xact_lock(hashtext('receive_invoice:' || lower(v_number)));
    if exists (
      select 1 from invoices
      where id <> v_id and invoice_number = v_number
        and coalesce(supplier_id, '00000000-0000-0000-0000-000000000000') = coalesce(v_supplier_id, '00000000-0000-0000-0000-000000000000')
    ) then
      raise exception 'Sąskaita Nr. % (%) jau yra — numeris turi būti unikalus tiekėjui.', v_number, coalesce(v_supplier_name, 'be tiekėjo');
    end if;
  end if;

  update invoices
     set invoice_number = v_number,
         invoice_date = v_date,
         supplier_id = v_supplier_id,
         supplier_name = v_supplier_name,
         currency = v_currency,
         total_net = case when v_h ? 'total_net' then nullif(v_h->>'total_net', '')::numeric else total_net end,
         total_vat = case when v_h ? 'total_vat' then nullif(v_h->>'total_vat', '')::numeric else total_vat end,
         total_gross = case when v_h ? 'total_gross' then nullif(v_h->>'total_gross', '')::numeric else total_gross end
   where id = v_id;

  for v_removed in select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(p_data->'removed_batch_ids', '[]'::jsonb)) x loop
    if not exists (select 1 from batches where id = v_removed and invoice_id = v_id) then
      raise exception 'Šalinama eilutė nepriklauso šiai sąskaitai.';
    end if;
    perform fn_receipt_remove_line(v_removed);
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(p_data->'items', '[]'::jsonb)) loop
    v_batch := nullif(v_item->>'batch_id', '')::uuid;
    if v_batch is not null and not exists (select 1 from batches where id = v_batch and invoice_id = v_id) then
      raise exception 'Eilutė nepriklauso šiai sąskaitai.';
    end if;
    perform fn_receipt_save_line(v_batch, v_item, v_supplier_id, v_id, v_currency);
  end loop;

  -- Lines that weren't sent still follow the header's supplier and currency.
  update batches set supplier_id = v_supplier_id, currency = v_currency
   where invoice_id = v_id and (supplier_id is distinct from v_supplier_id or currency is distinct from v_currency);

  select count(*), coalesce(sum(total_price), 0) into v_lines, v_sum from invoice_items where invoice_id = v_id;
  if v_lines = 0 then
    raise exception 'Sąskaitoje neliko eilučių — jei ji nereikalinga, ištrinkite visą sąskaitą.';
  end if;

  return jsonb_build_object('invoice_id', v_id, 'lines', v_lines, 'total', round(v_sum, 2));
end;
$$;

grant execute on function update_invoice(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- update_receipt_batch(jsonb) — stock received without an invoice:
-- { batch_id, supplier_id? | supplier?, received_date?, currency?, ...item fields }.
-- ---------------------------------------------------------------------------

create or replace function update_receipt_batch(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v batches%rowtype;
  v_supplier uuid;
  v_date date := nullif(p_data->>'received_date', '')::date;
begin
  select * into v from batches where id = nullif(p_data->>'batch_id', '')::uuid for update;
  if not found then
    raise exception 'Partija nerasta.';
  end if;
  if v.invoice_id is not null then
    raise exception 'Ši partija priklauso sąskaitai — redaguokite sąskaitą.';
  end if;
  v_supplier := case when p_data ? 'supplier_id' or p_data ? 'supplier' then fn_receipt_resolve_supplier(p_data) else v.supplier_id end;
  return fn_receipt_save_line(v.id, p_data, v_supplier, null, coalesce(nullif(p_data->>'currency', ''), v.currency),
                              case when v_date is null then null
                                   else (v_date::text || ' 12:00 Europe/Vilnius')::timestamptz end);
end;
$$;

grant execute on function update_receipt_batch(jsonb) to authenticated;

create or replace function delete_receipt_batch(p_batch_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  if exists (select 1 from batches where id = p_batch_id and invoice_id is not null) then
    raise exception 'Ši partija priklauso sąskaitai — pašalinkite eilutę redaguodami sąskaitą.';
  end if;
  perform fn_receipt_remove_line(p_batch_id);
end;
$$;

grant execute on function delete_receipt_batch(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- update_supplier(jsonb) — { id, name, code, vat_code, phone, email }.
-- invoices.supplier_name is a snapshot of the name — it follows the edit.
-- ---------------------------------------------------------------------------

create or replace function update_supplier(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid := nullif(p_data->>'id', '')::uuid;
  v_name text := nullif(btrim(p_data->>'name'), '');
begin
  if v_name is null then
    raise exception 'Įveskite tiekėjo pavadinimą.';
  end if;
  if exists (select 1 from suppliers where lower(name) = lower(v_name) and id is distinct from v_id) then
    raise exception 'Tiekėjas „%“ jau yra.', v_name;
  end if;
  if v_id is null then
    insert into suppliers (name, code, vat_code, phone, email)
    values (v_name, nullif(btrim(p_data->>'code'), ''), nullif(btrim(p_data->>'vat_code'), ''),
            nullif(btrim(p_data->>'phone'), ''), nullif(btrim(p_data->>'email'), ''))
    returning id into v_id;
    return v_id;
  end if;
  update suppliers
     set name = v_name,
         code = nullif(btrim(p_data->>'code'), ''),
         vat_code = nullif(btrim(p_data->>'vat_code'), ''),
         phone = nullif(btrim(p_data->>'phone'), ''),
         email = nullif(btrim(p_data->>'email'), '')
   where id = v_id;
  if not found then
    raise exception 'Tiekėjas nerastas.';
  end if;
  update invoices set supplier_name = v_name where supplier_id = v_id and supplier_name is distinct from v_name;
  return v_id;
end;
$$;

grant execute on function update_supplier(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- receipt_edit_detail(invoice_id | null, batch_id | null) — everything the
-- edit dialog needs, incl. how much of each line is already used (the floor
-- for its quantity) and whether it is on a nurašymo aktas.
-- ---------------------------------------------------------------------------

create or replace function receipt_edit_detail(p_invoice_id uuid default null, p_batch_id uuid default null)
returns jsonb
language sql
stable
security invoker
as $$
  with lines as (
    select b.*, ii.id as item_id, ii.line_no, ii.description, ii.sku, ii.total_price,
           p.name as product_name, p.unit::text as product_unit, p.category::text as product_category
    from batches b
    left join invoice_items ii on ii.batch_id = b.id
    join products p on p.id = b.product_id
    where (p_invoice_id is not null and b.invoice_id = p_invoice_id)
       or (p_invoice_id is null and b.id = p_batch_id)
  )
  select jsonb_build_object(
    'invoice', (select to_jsonb(i) - 'raw_parsed' from invoices i where i.id = p_invoice_id),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'batch_id', l.id,
        'item_id', l.item_id,
        'line_no', l.line_no,
        'product_id', l.product_id,
        'product_name', l.product_name,
        'product_unit', l.product_unit,
        'product_category', l.product_category,
        'description', l.description,
        'sku', l.sku,
        'lot', l.lot,
        'expiry_date', l.expiry_date,
        'received_qty', l.received_qty,
        'qty_left', l.qty_left,
        'used_qty', l.received_qty - l.qty_left,
        'package_size', l.package_size,
        'package_count', l.package_count,
        'purchase_price', l.purchase_price,
        'line_total', coalesce(l.total_price, round(l.purchase_price * l.received_qty, 2)),
        'currency', l.currency,
        'supplier_id', l.supplier_id,
        'received_at', l.received_at,
        'on_act', exists (
          select 1 from usage_items u join write_off_act_usage_items w on w.usage_item_id = u.id
          where u.batch_id = l.id)
      ) order by l.line_no nulls last, l.created_at)
      from lines l), '[]'::jsonb)
  );
$$;

grant execute on function receipt_edit_detail(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

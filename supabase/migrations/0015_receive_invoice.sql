-- 0015_receive_invoice.sql
-- Dovinės ŽŪB GVET PRO — pajamavimas hardening (Priedas §2.2, §2.11).
--
-- Before: the PDF/manual receive was several PostgREST calls from
-- TypeScript (invoice, then a batch per line, then invoice_items), so a
-- failure midway left an invoice with no stock or stock with no invoice
-- line. Now one plpgsql function = one transaction, like every other
-- stock-writing path (AGENTS.md).
--
-- Also here:
--   * products.pack_size — standard pack size, prefills "Pak. dydis" on
--     the receive screen (Monika's primary_pack_size).
--   * invoice_items.sku
--   * journals: the vet-drug journal listed every non-biocide product
--     (needles, feed additives...) — now medicines + vaccines only, dated
--     by the invoice date; the biocide journal gets its receiving side.
--   * delete_invoice(): undo a mis-parsed upload, refused once any of its
--     stock has been used.

alter table products add column pack_size numeric check (pack_size > 0);
alter table invoice_items add column sku text;

create index invoices_number_idx on invoices (invoice_number) where invoice_number is not null;

-- ---------------------------------------------------------------------------
-- receive_invoice(jsonb)
--   { mode: 'pdf' | 'manual',
--     supplier_id?, supplier: { name, code, vat_code },
--     invoice: { number, date, currency, total_net, total_vat, total_gross },
--     pdf_filename?, raw_parsed?,
--     items: [{ product_id, description, sku, qty, package_size, package_count,
--               line_total | unit_price, lot, expiry_date }] }
-- pdf    — a second upload of the same supplier + invoice number is refused.
-- manual — products typed in one by one for the same invoice number are
--          appended to that invoice.
-- qty = package_size × package_count when both are given. Drugs, vaccines
-- and biocides need a lot and a non-expired expiry date (journals §2.8).
-- Returns { invoice_id, batches }.
-- ---------------------------------------------------------------------------

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
    if v_product.category in ('medicines', 'vakcina', 'biocide') then
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

grant execute on function receive_invoice(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_invoice — only while none of its stock has been used.
-- ---------------------------------------------------------------------------

create or replace function delete_invoice(p_invoice_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_number text;
begin
  select coalesce(invoice_number, id::text) into v_number from invoices where id = p_invoice_id;
  if not found then
    raise exception 'Sąskaita nerasta.';
  end if;

  if exists (
    select 1 from usage_items ui join batches b on b.id = ui.batch_id where b.invoice_id = p_invoice_id
  ) or exists (
    select 1 from batches where invoice_id = p_invoice_id and qty_left < received_qty
  ) then
    raise exception 'Sąskaitos Nr. % prekės jau naudotos — ištrinti negalima.', v_number;
  end if;

  delete from invoice_items where invoice_id = p_invoice_id;
  delete from batches where invoice_id = p_invoice_id;
  delete from invoices where id = p_invoice_id;
end;
$$;

grant execute on function delete_invoice(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Journals
-- ---------------------------------------------------------------------------

-- Veterinarinių vaistų ir veterinarinių preparatų apskaitos žurnalas:
-- drugs + vaccines only, receipt dated by the invoice (entry date if none).
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
where p.category in ('medicines', 'vakcina')
order by receipt_date desc;

-- Biocidinių produktų žurnalas, receiving side (the usage side is
-- vw_biocide_journal).
create view vw_biocide_receiving_journal
with (security_invoker = true) as
select
  b.id,
  p.name,
  p.registration_code,
  p.active_substance,
  p.unit,
  coalesce(i.invoice_date, b.received_at::date) as receipt_date,
  coalesce(s.name, i.supplier_name) as supplier_name,
  i.invoice_number,
  b.received_qty,
  b.lot as batch_number,
  b.expiry_date,
  b.qty_left as quantity_remaining
from batches b
join products p on p.id = b.product_id
left join suppliers s on s.id = b.supplier_id
left join invoices i on i.id = b.invoice_id
where p.category = 'biocide'
order by receipt_date desc;

notify pgrst, 'reload schema';

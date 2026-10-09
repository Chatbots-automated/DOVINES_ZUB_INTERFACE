-- 0032_analytics.sql
-- Dovinės ŽŪB GVET PRO — Pagrindinis / Analitika (farm's request, 2026-10, not in
-- Priedas Nr. 1 — billed separately per Sutartis §2.5/§4.6).
--
-- Aggregations for the two main pages, done in the database because the raw rows
-- (usage_items, treatments, batches) outgrow PostgREST's 1000-row response cap.
-- Everything is SECURITY INVOKER, so RLS applies as for the underlying tables.
-- Money = qty × batches.purchase_price, which is PER UNIT (see AGENTS.md).
-- Batches without a price count as 0 and are reported (unpriced_batches).

-- ---------------------------------------------------------------------------
-- Current stock value by product category: usable vs expired (active batches
-- with qty_left > 0). Usable = no expiry date, or expiry >= today.
-- ---------------------------------------------------------------------------

create or replace view vw_stock_value_by_category
with (security_invoker = true) as
select
  p.category::text as category,
  coalesce(sum(b.qty_left * coalesce(b.purchase_price, 0)) filter (where b.expiry_date is null or b.expiry_date >= current_date), 0) as usable_value,
  count(*) filter (where b.expiry_date is null or b.expiry_date >= current_date) as usable_batches,
  coalesce(sum(b.qty_left * coalesce(b.purchase_price, 0)) filter (where b.expiry_date < current_date), 0) as expired_value,
  count(*) filter (where b.expiry_date < current_date) as expired_batches,
  count(*) filter (where b.purchase_price is null) as unpriced_batches
from batches b
join products p on p.id = b.product_id
where b.status = 'active' and b.qty_left > 0
group by p.category;

-- Batches that are expired or run out within 60 days, with their remaining value.
create or replace view vw_stock_batch_alerts
with (security_invoker = true) as
select
  b.id as batch_id,
  p.id as product_id,
  p.name as product_name,
  p.category::text as category,
  p.unit,
  b.lot,
  b.expiry_date,
  (b.expiry_date - current_date) as days_left,
  b.qty_left,
  b.qty_left * coalesce(b.purchase_price, 0) as value
from batches b
join products p on p.id = b.product_id
where b.status = 'active' and b.qty_left > 0 and b.expiry_date is not null and b.expiry_date <= current_date + 60
order by b.expiry_date;

-- ---------------------------------------------------------------------------
-- Purchases (pajamavimas) vs consumption per month, p_from..p_to inclusive.
-- Purchases dated by the invoice (entry date if none), like the drug journal.
-- ---------------------------------------------------------------------------

create or replace function analytics_monthly(p_from date, p_to date)
returns table (month date, purchased numeric, consumed numeric)
language sql
stable
security invoker
as $$
  with months as (
    select generate_series(date_trunc('month', p_from)::date, date_trunc('month', p_to)::date, interval '1 month')::date as month
  ),
  bought as (
    select date_trunc('month', coalesce(i.invoice_date, b.received_at::date))::date as month,
           sum(b.received_qty * coalesce(b.purchase_price, 0)) as v
    from batches b
    left join invoices i on i.id = b.invoice_id
    where coalesce(i.invoice_date, b.received_at::date) between p_from and p_to
    group by 1
  ),
  used as (
    select date_trunc('month', u.used_on)::date as month, sum(u.qty * coalesce(u.purchase_price, 0)) as v
    from vw_usage_items_detailed u
    where u.used_on between p_from and p_to
    group by 1
  )
  select m.month, coalesce(bo.v, 0), coalesce(us.v, 0)
  from months m
  left join bought bo on bo.month = m.month
  left join used us on us.month = m.month
  order by m.month;
$$;

-- Consumption value by product category.
create or replace function analytics_spend_by_category(p_from date, p_to date)
returns table (category text, spent numeric, uses bigint)
language sql
stable
security invoker
as $$
  select p.category::text, sum(u.qty * coalesce(u.purchase_price, 0)), count(*)
  from vw_usage_items_detailed u
  join products p on p.id = u.product_id
  where u.used_on between p_from and p_to
  group by p.category
  order by 2 desc;
$$;

-- Top products by consumption value.
create or replace function analytics_top_products(p_from date, p_to date, p_limit integer default 8)
returns table (product_id uuid, product_name text, category text, unit text, qty numeric, spent numeric, uses bigint, is_antimicrobial boolean)
language sql
stable
security invoker
as $$
  select p.id, p.name, p.category::text, p.unit::text, sum(u.qty), sum(u.qty * coalesce(u.purchase_price, 0)), count(*), p.is_antimicrobial
  from vw_usage_items_detailed u
  join products p on p.id = u.product_id
  where u.used_on between p_from and p_to
  group by p.id, p.name, p.category, p.unit, p.is_antimicrobial
  order by 6 desc, 5 desc
  limit p_limit;
$$;

-- Antimicrobial use (qty in the product's unit) per product.
create or replace function analytics_antimicrobial(p_from date, p_to date, p_limit integer default 8)
returns table (product_name text, active_substance text, unit text, qty numeric, uses bigint)
language sql
stable
security invoker
as $$
  select a.name, a.active_substance, a.unit::text, sum(a.qty), count(*)
  from vw_antimicrobial_usage a
  where a.used_on between p_from and p_to
  group by a.name, a.active_substance, a.unit
  order by 4 desc
  limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- Treatments
-- ---------------------------------------------------------------------------

create or replace function analytics_treatments_by_month(p_from date, p_to date)
returns table (month date, procedure_type text, n bigint)
language sql
stable
security invoker
as $$
  select date_trunc('month', t.reg_date)::date, t.procedure_type, count(*)
  from treatments t
  where t.reg_date between p_from and p_to
  group by 1, 2
  order by 1, 2;
$$;

-- Diagnoses: the linked disease's name, else the free-text diagnosis.
create or replace function analytics_top_diseases(p_from date, p_to date, p_limit integer default 8)
returns table (name text, n bigint, animals bigint)
language sql
stable
security invoker
as $$
  select coalesce(d.name, nullif(btrim(t.diagnosis), ''), 'Be diagnozės'), count(*), count(distinct t.animal_id)
  from treatments t
  left join diseases d on d.id = t.disease_id
  where t.reg_date between p_from and p_to and t.procedure_type = 'gydymas'
  group by 1
  order by 2 desc, 1
  limit p_limit;
$$;

-- Treatments per DelPro group (frozen at insert, see AGENTS.md).
create or replace function analytics_treatments_by_group(p_from date, p_to date, p_limit integer default 8)
returns table (animal_group text, n bigint, animals bigint)
language sql
stable
security invoker
as $$
  select coalesce(t.animal_group_snapshot, 'Be grupės'), count(*), count(distinct t.animal_id)
  from treatments t
  where t.reg_date between p_from and p_to and t.procedure_type = 'gydymas'
  group by 1
  order by 2 desc, 1
  limit p_limit;
$$;

grant execute on function analytics_monthly(date, date) to authenticated;
grant execute on function analytics_spend_by_category(date, date) to authenticated;
grant execute on function analytics_top_products(date, date, integer) to authenticated;
grant execute on function analytics_antimicrobial(date, date, integer) to authenticated;
grant execute on function analytics_treatments_by_month(date, date) to authenticated;
grant execute on function analytics_top_diseases(date, date, integer) to authenticated;
grant execute on function analytics_treatments_by_group(date, date, integer) to authenticated;

notify pgrst, 'reload schema';

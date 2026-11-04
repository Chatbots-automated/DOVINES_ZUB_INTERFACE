-- 0057_biocide_usage_plans.sql
-- Biocidų planas (farm's request 2026-11, extends the Biocidai tab — billed separately,
-- Sutartis §2.5/§4.6). Staff plan a week / month ahead: product, amount per day, period
-- (e.g. 10 l every day). One planned row per day. Nothing is written off until someone
-- confirms: each confirmed day becomes an ordinary biocide_usage through
-- create_biocide_usage() (FEFO, journal), dated by the PLANNED day — so confirming
-- 5 forgotten days on the 6th puts each one in the journal on its own date.
-- Several days are confirmed in ONE transaction: a stock shortfall saves none of them.

create table biocide_usage_plans (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  qty_per_day numeric not null check (qty_per_day > 0),
  unit unit,
  start_date date not null,
  end_date date not null,
  purpose text,
  work_scope text,
  used_by_name text,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  constraint biocide_usage_plans_period_check check (end_date >= start_date and end_date - start_date <= 92)
);

create table biocide_planned_usages (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references biocide_usage_plans (id) on delete cascade,
  use_date date not null,
  qty numeric not null check (qty > 0),
  status text not null default 'planned' check (status in ('planned', 'confirmed', 'skipped', 'cancelled')),
  biocide_usage_id uuid references biocide_usage (id) on delete set null,
  confirmed_qty numeric,
  decided_by uuid,
  decided_at timestamptz,
  unique (plan_id, use_date),
  constraint biocide_planned_usages_confirmed_check check (status <> 'confirmed' or confirmed_qty > 0)
);
create index biocide_planned_usages_open_idx on biocide_planned_usages (use_date) where status = 'planned';

-- every active user reads; writes go through the RPCs below (invoker, staff check)
alter table biocide_usage_plans enable row level security;
alter table biocide_planned_usages enable row level security;
create policy biocide_usage_plans_select on biocide_usage_plans for select using (fn_is_authenticated_active());
create policy biocide_usage_plans_insert on biocide_usage_plans for insert with check (fn_is_active_staff());
create policy biocide_usage_plans_update on biocide_usage_plans for update using (fn_is_active_staff());
create policy biocide_planned_usages_select on biocide_planned_usages for select using (fn_is_authenticated_active());
create policy biocide_planned_usages_insert on biocide_planned_usages for insert with check (fn_is_active_staff());
create policy biocide_planned_usages_update on biocide_planned_usages for update using (fn_is_active_staff());
grant select, insert, update on biocide_usage_plans, biocide_planned_usages to authenticated;

create or replace function fn_vilnius_today()
returns date
language sql
stable
as $$ select (now() at time zone 'Europe/Vilnius')::date $$;

-- p_data: product_id, qty_per_day, start_date, end_date, purpose, work_scope, used_by_name, notes
create or replace function create_biocide_usage_plan(p_data jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
  v_product products%rowtype;
  v_qty numeric := nullif(p_data->>'qty_per_day', '')::numeric;
  v_start date := nullif(p_data->>'start_date', '')::date;
  v_end date := nullif(p_data->>'end_date', '')::date;
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės planuoti biocidų naudojimo.';
  end if;
  select * into v_product from products where id = nullif(p_data->>'product_id', '')::uuid;
  if not found or v_product.category::text <> 'biocide' then
    raise exception 'Pasirinkite biocidinį produktą.';
  end if;
  if coalesce(v_qty, 0) <= 0 then
    raise exception 'Nurodykite kiekį per dieną (didesnį už 0).';
  end if;
  if v_start is null or v_end is null then
    raise exception 'Nurodykite plano pradžios ir pabaigos datas.';
  end if;
  if v_end < v_start then
    raise exception 'Plano pabaiga negali būti ankstesnė už pradžią.';
  end if;
  if v_end - v_start > 92 then
    raise exception 'Planą galima sudaryti ne ilgesniam kaip 3 mėnesių laikotarpiui.';
  end if;
  if v_start < fn_vilnius_today() - 31 then
    raise exception 'Plano pradžia negali būti senesnė nei 31 diena.';
  end if;

  insert into biocide_usage_plans (product_id, qty_per_day, unit, start_date, end_date, purpose, work_scope, used_by_name, notes)
  values (v_product.id, v_qty, v_product.unit, v_start, v_end,
          nullif(p_data->>'purpose', ''), nullif(p_data->>'work_scope', ''), nullif(p_data->>'used_by_name', ''), nullif(p_data->>'notes', ''))
  returning id into v_id;

  insert into biocide_planned_usages (plan_id, use_date, qty)
  select v_id, d::date, v_qty from generate_series(v_start, v_end, interval '1 day') d;

  return v_id;
end;
$$;

-- p_data: {items: [{id, qty?}]}. qty overrides the planned amount (what was really used).
-- Only planned rows dated today or earlier; oldest first so FEFO follows the calendar.
create or replace function confirm_biocide_planned_usages(p_data jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  r record;
  v_usage uuid;
  v_count integer := 0;
  v_requested integer;
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės patvirtinti biocidų naudojimo.';
  end if;
  if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') = 0 then
    raise exception 'Pasirinkite bent vieną dieną.';
  end if;
  select count(distinct x->>'id') into v_requested from jsonb_array_elements(p_data->'items') x;

  for r in
    select pu.id, pu.use_date, pu.status, p.product_id, p.unit, p.purpose, p.work_scope, p.used_by_name, pr.name as product_name,
           coalesce(nullif(i.item->>'qty', '')::numeric, pu.qty) as qty
    from (select distinct on (x->>'id') x as item from jsonb_array_elements(p_data->'items') x) i
    join biocide_planned_usages pu on pu.id = (i.item->>'id')::uuid
    join biocide_usage_plans p on p.id = pu.plan_id
    join products pr on pr.id = p.product_id
    order by pu.use_date, pr.name, pu.id
    for update of pu
  loop
    if r.status <> 'planned' then
      raise exception '% %: ši diena jau % — atnaujinkite puslapį.', r.product_name, to_char(r.use_date, 'YYYY-MM-DD'),
        case r.status when 'confirmed' then 'patvirtinta' when 'skipped' then 'pažymėta kaip nenaudota' else 'atšaukta' end;
    end if;
    if r.use_date > fn_vilnius_today() then
      raise exception '% %: ateities dienos patvirtinti negalima.', r.product_name, to_char(r.use_date, 'YYYY-MM-DD');
    end if;
    if coalesce(r.qty, 0) <= 0 then
      raise exception '% %: kiekis turi būti didesnis už 0 (nenaudotą dieną pažymėkite „Nenaudota“).', r.product_name, to_char(r.use_date, 'YYYY-MM-DD');
    end if;

    begin
      v_usage := create_biocide_usage(jsonb_build_object(
        'product_id', r.product_id, 'use_date', r.use_date, 'qty', r.qty, 'unit', r.unit,
        'purpose', r.purpose, 'work_scope', r.work_scope, 'used_by_name', r.used_by_name));
    exception when others then
      raise exception '% %: %', r.product_name, to_char(r.use_date, 'YYYY-MM-DD'), sqlerrm;
    end;

    update biocide_planned_usages
    set status = 'confirmed', biocide_usage_id = v_usage, confirmed_qty = r.qty, decided_by = auth.uid(), decided_at = now()
    where id = r.id;
    v_count := v_count + 1;
  end loop;

  if v_count <> v_requested then
    raise exception 'Kai kurios pasirinktos dienos nerastos — atnaujinkite puslapį.';
  end if;
  return v_count;
end;
$$;

-- "Nenaudota": a planned day that didn't happen. Nothing is written off.
create or replace function skip_biocide_planned_usages(p_ids uuid[])
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės keisti biocidų plano.';
  end if;
  update biocide_planned_usages
  set status = 'skipped', decided_by = auth.uid(), decided_at = now()
  where id = any (p_ids) and status = 'planned';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Cancels the plan's still-open days (confirmed / skipped ones stay as they are).
create or replace function cancel_biocide_usage_plan(p_plan_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  if not fn_is_active_staff() then
    raise exception 'Neturite teisės keisti biocidų plano.';
  end if;
  update biocide_usage_plans set cancelled_at = now(), cancelled_by = auth.uid() where id = p_plan_id and cancelled_at is null;
  if not found then
    raise exception 'Planas nerastas arba jau atšauktas.';
  end if;
  update biocide_planned_usages
  set status = 'cancelled', decided_by = auth.uid(), decided_at = now()
  where plan_id = p_plan_id and status = 'planned';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function create_biocide_usage_plan(jsonb), confirm_biocide_planned_usages(jsonb),
  skip_biocide_planned_usages(uuid[]), cancel_biocide_usage_plan(uuid) from public, anon;
grant execute on function create_biocide_usage_plan(jsonb), confirm_biocide_planned_usages(jsonb),
  skip_biocide_planned_usages(uuid[]), cancel_biocide_usage_plan(uuid) to authenticated;

-- One row per planned day with its plan + product (Biocidai -> Planas).
create or replace view vw_biocide_planned_usages
with (security_invoker = true) as
select
  pu.id, pu.plan_id, pu.use_date, pu.qty, pu.status, pu.confirmed_qty, pu.biocide_usage_id, pu.decided_at,
  p.product_id, pr.name as product_name, coalesce(p.unit::text, pr.unit::text) as unit,
  p.purpose, p.work_scope, p.used_by_name, p.start_date, p.end_date, p.qty_per_day, p.cancelled_at
from biocide_planned_usages pu
join biocide_usage_plans p on p.id = pu.plan_id
join products pr on pr.id = p.product_id;

grant select on vw_biocide_planned_usages to authenticated;

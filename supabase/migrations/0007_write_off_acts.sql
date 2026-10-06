-- 0007_write_off_acts.sql
-- Dovinės ŽŪB GVET PRO — veterinarinių produktų nurašymo aktai with
-- paskirstymas pagal gyvulių grupes / paskirtį (Priedas §2.9, acceptance
-- criterion §5.6).
--
-- Base shape (act -> items, act number, draft/approved/cancelled, approved
-- acts locked) follows OKSANA_INTERFACE's 20260408000006_create_write_off_acts
-- and gerda_gintariniai_zirgai's write-offs. New here:
--   * write_off_act_allocations — each item's total quantity split across
--     animal groups (from the group snapshot frozen on each treatment /
--     vaccination, see 0002) or a manual purpose (biocides, general use).
--     An act can only be approved when every item's allocations sum to
--     exactly the item's quantity.
--   * write_off_act_usage_items — every usage_items row can be written off
--     by at most ONE non-cancelled act, so overlapping periods or a
--     regenerated act can never double-count consumption.
--
-- The printed layout follows the farm's own template (§2.9 "pagal Užsakovo
-- ... pateiktus dokumentų šablonus") — that is app-side, not schema.

-- ---------------------------------------------------------------------------
-- write_off_purposes — manual allocation targets besides DelPro groups.
-- ---------------------------------------------------------------------------

create table write_off_purposes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index write_off_purposes_name_key on write_off_purposes (lower(name));

insert into write_off_purposes (name, sort_order) values
  ('Dezinfekcija / biocidai', 10),
  ('Bendras ūkio naudojimas', 20),
  ('Nepriskirta grupei', 99);

-- ---------------------------------------------------------------------------
-- Acts
-- ---------------------------------------------------------------------------

create table write_off_acts (
  id uuid primary key default gen_random_uuid(),
  act_number text not null unique,
  act_date date not null default current_date,
  period_start date not null,
  period_end date not null,
  product_category product_category,
  status text not null default 'draft' check (status in ('draft', 'approved', 'cancelled')),
  commission text,
  notes text,
  total_amount numeric not null default 0,
  created_by uuid references users (id),
  approved_by uuid references users (id),
  approved_at timestamptz,
  cancelled_by uuid references users (id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start)
);

create index write_off_acts_period_idx on write_off_acts (period_start, period_end);
create index write_off_acts_status_idx on write_off_acts (status);

create trigger trg_write_off_acts_updated_at
  before update on write_off_acts
  for each row execute function set_updated_at();

create table write_off_act_items (
  id uuid primary key default gen_random_uuid(),
  act_id uuid not null references write_off_acts (id) on delete cascade,
  line_no integer not null,
  product_id uuid references products (id),
  product_name text not null,
  product_category product_category,
  registration_code text,
  lots text,
  unit unit,
  quantity numeric not null check (quantity > 0),
  unit_price numeric not null default 0,
  total_price numeric not null default 0,
  notes text
);

create index write_off_act_items_act_id_idx on write_off_act_items (act_id);

create table write_off_act_allocations (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references write_off_act_items (id) on delete cascade,
  label text not null,
  quantity numeric not null check (quantity >= 0),
  animal_count integer,
  suggested boolean not null default false,
  notes text
);

create index write_off_act_allocations_item_id_idx on write_off_act_allocations (item_id);

create table write_off_act_usage_items (
  act_id uuid not null references write_off_acts (id) on delete cascade,
  usage_item_id uuid not null references usage_items (id) on delete cascade,
  primary key (act_id, usage_item_id),
  unique (usage_item_id)
);

-- ---------------------------------------------------------------------------
-- Totals + locking
-- ---------------------------------------------------------------------------

create or replace function fn_write_off_act_recalc_total()
returns trigger
language plpgsql
as $$
declare
  v_act uuid := coalesce(new.act_id, old.act_id);
begin
  update write_off_acts
  set total_amount = coalesce((select sum(total_price) from write_off_act_items where act_id = v_act), 0)
  where id = v_act;
  return coalesce(new, old);
end;
$$;

create trigger trg_write_off_act_items_total
  after insert or update or delete on write_off_act_items
  for each row execute function fn_write_off_act_recalc_total();

-- Items/allocations of a non-draft act are read-only. The cascade delete of
-- a whole draft act is allowed (parent row is gone -> status lookup null).
create or replace function fn_write_off_act_children_locked()
returns trigger
language plpgsql
as $$
declare
  v_status text;
  v_act uuid;
begin
  if tg_table_name = 'write_off_act_items' then
    v_act := coalesce(new.act_id, old.act_id);
  else
    select act_id into v_act from write_off_act_items where id = coalesce(new.item_id, old.item_id);
  end if;

  select status into v_status from write_off_acts where id = v_act;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Patvirtinto ar anuliuoto nurašymo akto keisti negalima.';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger trg_write_off_act_items_locked
  before insert or update or delete on write_off_act_items
  for each row execute function fn_write_off_act_children_locked();

create trigger trg_write_off_act_allocations_locked
  before insert or update or delete on write_off_act_allocations
  for each row execute function fn_write_off_act_children_locked();

create or replace function fn_write_off_acts_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Ištrinti galima tik juodraštį. Patvirtintą aktą galima tik anuliuoti.';
    end if;
    return old;
  end if;

  if old.status = 'cancelled' then
    raise exception 'Anuliuoto akto keisti negalima.';
  end if;
  if old.status = 'approved' and new.status <> 'cancelled' then
    raise exception 'Patvirtinto akto keisti negalima — jį galima tik anuliuoti.';
  end if;
  return new;
end;
$$;

create trigger trg_write_off_acts_guard
  before update or delete on write_off_acts
  for each row execute function fn_write_off_acts_guard();

-- ---------------------------------------------------------------------------
-- generate_write_off_act(jsonb) — builds a draft act from usage in a period.
--   { period_start, period_end, act_date, product_category (optional),
--     commission, notes }
-- Picks up every usage_items row used in the period that no other
-- non-cancelled act has already written off. One item per product (price =
-- weighted average across the batches actually consumed). Allocations are
-- pre-filled from each usage row's frozen animal group; animal-less usage
-- (biocides) is suggested under its biocide purpose or "Dezinfekcija /
-- biocidai". The user adjusts, then approves.
-- ---------------------------------------------------------------------------

create or replace function generate_write_off_act(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_start date := (p_data->>'period_start')::date;
  v_end date := (p_data->>'period_end')::date;
  v_act_date date := coalesce(nullif(p_data->>'act_date', '')::date, current_date);
  v_category product_category := nullif(p_data->>'product_category', '')::product_category;
  v_year text;
  v_seq integer;
  v_act_id uuid;
  v_item_id uuid;
  v_line integer := 0;
  v_ids uuid[];
  r record;
begin
  if v_start is null or v_end is null then
    raise exception 'Nurodykite laikotarpį.';
  end if;

  select array_agg(u.usage_item_id) into v_ids
  from vw_usage_items_detailed u
  join products p on p.id = u.product_id
  where u.used_on between v_start and v_end
    and (v_category is null or p.category = v_category)
    and not exists (select 1 from write_off_act_usage_items w where w.usage_item_id = u.usage_item_id);

  if v_ids is null then
    raise exception 'Šiuo laikotarpiu nėra nenurašytų sunaudotų produktų.';
  end if;

  -- Sequential per-year number, serialized so two users can't collide.
  perform pg_advisory_xact_lock(hashtext('write_off_act_number'));
  v_year := extract(year from v_act_date)::text;
  select count(*) + 1 into v_seq from write_off_acts where act_number like 'NA-' || v_year || '-%';

  insert into write_off_acts (act_number, act_date, period_start, period_end, product_category, commission, notes, created_by)
  values ('NA-' || v_year || '-' || lpad(v_seq::text, 3, '0'), v_act_date, v_start, v_end, v_category,
          nullif(p_data->>'commission', ''), nullif(p_data->>'notes', ''), auth.uid())
  returning id into v_act_id;

  for r in
    select u.product_id, p.name as product_name, p.category, p.registration_code,
           coalesce(max(u.unit::text), max(p.unit::text))::unit as unit,
           sum(u.qty) as qty,
           sum(u.qty * coalesce(u.purchase_price, 0)) as cost,
           string_agg(distinct u.lot, ', ') as lots
    from vw_usage_items_detailed u
    join products p on p.id = u.product_id
    where u.usage_item_id = any (v_ids)
    group by u.product_id, p.name, p.category, p.registration_code
    order by p.category, p.name
  loop
    v_line := v_line + 1;
    insert into write_off_act_items (act_id, line_no, product_id, product_name, product_category, registration_code, lots,
                                     unit, quantity, unit_price, total_price)
    values (v_act_id, v_line, r.product_id, r.product_name, r.category, r.registration_code, r.lots,
            r.unit, round(r.qty, 4), round(r.cost / nullif(r.qty, 0), 4), round(r.cost, 2))
    returning id into v_item_id;

    insert into write_off_act_allocations (item_id, label, quantity, animal_count, suggested)
    select v_item_id,
           coalesce(animal_group,
                    case when source_kind = 'biocide' then coalesce(nullif(biocide_purpose, ''), 'Dezinfekcija / biocidai') end,
                    'Nepriskirta grupei'),
           round(sum(qty), 4),
           nullif(count(distinct animal_id), 0),
           true
    from vw_usage_items_detailed
    where usage_item_id = any (v_ids)
      and product_id = r.product_id
    group by 2
    order by 2;
  end loop;

  insert into write_off_act_usage_items (act_id, usage_item_id)
  select v_act_id, unnest(v_ids);

  return v_act_id;
end;
$$;

grant execute on function generate_write_off_act(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- approve / cancel
-- ---------------------------------------------------------------------------

create or replace function approve_write_off_act(p_act_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_bad text;
begin
  select string_agg(i.product_name || ' (' || i.quantity || ' ≠ ' || coalesce(s.alloc, 0) || ')', '; ')
  into v_bad
  from write_off_act_items i
  left join (
    select item_id, sum(quantity) as alloc from write_off_act_allocations group by item_id
  ) s on s.item_id = i.id
  where i.act_id = p_act_id
    and abs(i.quantity - coalesce(s.alloc, 0)) > 0.001;

  if v_bad is not null then
    raise exception 'Paskirstymas nesutampa su bendru kiekiu: %', v_bad;
  end if;

  update write_off_acts
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_act_id and status = 'draft';

  if not found then
    raise exception 'Aktas nerastas arba jau nebe juodraštis.';
  end if;
end;
$$;

-- Cancelling releases the act's usage rows so a corrected act can be
-- generated for the same period.
create or replace function cancel_write_off_act(p_act_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  update write_off_acts
  set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_act_id and status = 'approved';

  if not found then
    raise exception 'Anuliuoti galima tik patvirtintą aktą (juodraštį tiesiog ištrinkite).';
  end if;

  delete from write_off_act_usage_items where act_id = p_act_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_write_off_allocations(item_id, rows) — replaces one item's split in a
-- single transaction (the editor saves the whole list at once).
--   rows: [{ "label": "Melžiamos 1", "quantity": 30, "animal_count": 12, "notes": null }]
-- Zero-quantity rows are dropped. Locked for non-draft acts by the
-- children-locked trigger.
-- ---------------------------------------------------------------------------

create or replace function set_write_off_allocations(p_item_id uuid, p_rows jsonb)
returns void
language plpgsql
security invoker
as $$
begin
  delete from write_off_act_allocations where item_id = p_item_id;

  insert into write_off_act_allocations (item_id, label, quantity, animal_count, suggested, notes)
  select p_item_id,
         trim(r->>'label'),
         (r->>'quantity')::numeric,
         nullif(r->>'animal_count', '')::integer,
         false,
         nullif(r->>'notes', '')
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where nullif(trim(r->>'label'), '') is not null
    and coalesce((r->>'quantity')::numeric, 0) > 0;
end;
$$;

grant execute on function set_write_off_allocations(uuid, jsonb) to authenticated;

grant execute on function approve_write_off_act(uuid) to authenticated;
grant execute on function cancel_write_off_act(uuid) to authenticated;

-- Allocation targets offered in the editor: active DelPro groups + manual
-- purposes.
create view vw_write_off_allocation_targets
with (security_invoker = true) as
select name as label, 'group' as kind, 0 as sort_order from delpro_groups where active
union
select name, 'purpose', sort_order from write_off_purposes where active;

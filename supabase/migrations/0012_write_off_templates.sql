-- 0012_write_off_templates.sql
-- Dovinės ŽŪB GVET PRO — nurašymo aktai shaped to the farm's three Excel
-- templates (Priedas §2.9, §5.6; templates supplied per Sutartis §5.2):
--
--   vaistai   "Sunaudotų veterinarinių vaistų, biocidų ir kt. panaudojimo
--             aktas" — Eil. Nr., pavadinimas, serija, mato vnt., kaina,
--             then kiekis+suma per group column (Melžiamos karvės, Penimi
--             gyvuliai), then Viso sunaudota kiekis+suma.
--   priedai   "Sunaudotų veterinarinių priedų panaudojimo aktas" — same
--             layout as vaistai.
--   medziagos "Medžiagų, MGSD ir kt. vertybių panaudojimo aktas" — Nom. Nr.,
--             pavadinimas, mato vnt., kiekis, kaina, suma, Pastabos (= the
--             group: Karvės / Veršeliai); plus Sąskaita (209) and Išlaidų
--             objektas.
--
-- Act numbers follow the farm's YYYYMMNN (20260703, 20260704, 20260705 for
-- July 2026), shared across the three templates.
--
-- Groups: the farm splits usage into fixed groups per template, but how an
-- animal maps to "Melžiamos karvės" vs "Penimi gyvuliai" is NOT known yet
-- (DelPro group? lytis? — to be agreed with the farm). So the mapping is
-- data, not code: write_off_group_rules match a usage row's frozen DelPro
-- group (treatments.animal_group_snapshot) or the animal's lytis to a
-- group. With no rules configured, everything lands on "Nepriskirta" and
-- the user splits it by hand; approval requires that nothing stays there.
--
-- Packages: the farm counts drugs in packages (Bioestrovet 25.8 vnt at
-- 8.468 €/vnt), while treatments record doses in ml. products.act_unit /
-- act_unit_size convert stock units to the act's unit at generation time.
--
-- General usage: needles, gloves, boluses, hoof bath... are used without a
-- treatment record. The farm derives these from a stock count (=161-4 in
-- the Excel). general_usage + create_general_usage() record that usage —
-- either a quantity or a counted remaining stock — through FEFO, so it
-- reaches stock levels and the acts like every other consumption.

-- ---------------------------------------------------------------------------
-- Groups + mapping rules
-- ---------------------------------------------------------------------------

create table write_off_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  act_kinds text[] not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (act_kinds <@ array['vaistai', 'priedai', 'medziagos'] and cardinality(act_kinds) > 0)
);

create unique index write_off_groups_name_key on write_off_groups (lower(name));

insert into write_off_groups (name, act_kinds, sort_order) values
  ('Melžiamos karvės', array['vaistai', 'priedai'], 10),
  ('Penimi gyvuliai', array['vaistai', 'priedai'], 20),
  ('Karvės', array['medziagos'], 10),
  ('Veršeliai', array['medziagos'], 20);

create table write_off_group_rules (
  id uuid primary key default gen_random_uuid(),
  write_off_group_id uuid not null references write_off_groups (id) on delete cascade,
  match_field text not null check (match_field in ('delpro_group', 'animal_sex')),
  match_value text not null,
  created_at timestamptz not null default now()
);

create unique index write_off_group_rules_key on write_off_group_rules (write_off_group_id, match_field, lower(match_value));

-- ---------------------------------------------------------------------------
-- Products: act template, accounting nomenclature no., package conversion,
-- default group (used when the usage has no animal, e.g. hoof bath).
-- ---------------------------------------------------------------------------

alter table products
  add column write_off_kind text check (write_off_kind in ('vaistai', 'priedai', 'medziagos')),
  add column nomenclature_no text,
  add column act_unit text,
  add column act_unit_size numeric check (act_unit_size > 0),
  add column default_write_off_group_id uuid references write_off_groups (id) on delete set null;

-- Which act a product lands on: explicit choice, else from its category.
create or replace function fn_product_write_off_kind(p_category product_category, p_kind text)
returns text
language sql
immutable
as $$
  select coalesce(p_kind, case p_category::text
    when 'treatment_materials' then 'medziagos'
    when 'priedas' then 'priedai'
    else 'vaistai'
  end);
$$;

-- ---------------------------------------------------------------------------
-- General usage (no animal / no treatment)
-- ---------------------------------------------------------------------------

create table general_usage (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  batch_id uuid references batches (id),
  use_date date not null default current_date,
  qty numeric not null check (qty > 0),
  unit unit,
  stock_before numeric,
  counted_remaining numeric,
  write_off_group_id uuid references write_off_groups (id) on delete set null,
  notes text,
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);

create index general_usage_use_date_idx on general_usage (use_date);
create index general_usage_product_id_idx on general_usage (product_id);

alter table usage_items
  add column general_usage_id uuid references general_usage (id) on delete cascade;

create index usage_items_general_usage_id_idx on usage_items (general_usage_id) where general_usage_id is not null;

alter table usage_items drop constraint usage_items_single_source;
alter table usage_items add constraint usage_items_single_source check (
  (
    (treatment_id is not null)::int +
    (course_dose_id is not null)::int +
    (vaccination_id is not null)::int +
    (biocide_usage_id is not null)::int +
    (general_usage_id is not null)::int
  ) = 1
);

-- A written-off usage row must not vanish from under its act.
create or replace function fn_general_usage_delete_guard()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from usage_items ui
    join write_off_act_usage_items w on w.usage_item_id = ui.id
    where ui.general_usage_id = old.id
  ) then
    raise exception 'Šis sunaudojimas jau įtrauktas į nurašymo aktą — pirmiau anuliuokite arba ištrinkite aktą.';
  end if;
  return old;
end;
$$;

create trigger trg_general_usage_delete_guard
  before delete on general_usage
  for each row execute function fn_general_usage_delete_guard();

-- fn_consume_fefo gains a fifth source. Dropped + recreated rather than
-- overloaded: an overload would make every existing named-argument call
-- ambiguous.
drop function fn_consume_fefo(uuid, numeric, unit, administration_route, uuid, uuid, uuid, uuid);

create or replace function fn_consume_fefo(
  p_product_id uuid,
  p_qty numeric,
  p_unit unit,
  p_route administration_route,
  p_treatment_id uuid default null,
  p_course_dose_id uuid default null,
  p_vaccination_id uuid default null,
  p_biocide_usage_id uuid default null,
  p_general_usage_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_remaining numeric := p_qty;
  v_take numeric;
  v_first_batch uuid;
  b record;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'Kiekis turi būti didesnis už 0.';
  end if;

  for b in
    select id, qty_left
    from batches
    where product_id = p_product_id
      and status = 'active'
      and qty_left > 0
      and (expiry_date is null or expiry_date >= current_date)
    order by expiry_date asc nulls last, received_at asc
    for update
  loop
    exit when v_remaining <= 0;
    v_take := least(b.qty_left, v_remaining);
    insert into usage_items (product_id, batch_id, qty, unit, administration_route,
                             treatment_id, course_dose_id, vaccination_id, biocide_usage_id, general_usage_id)
    values (p_product_id, b.id, v_take, p_unit, p_route,
            p_treatment_id, p_course_dose_id, p_vaccination_id, p_biocide_usage_id, p_general_usage_id);
    v_first_batch := coalesce(v_first_batch, b.id);
    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0.0001 then
    raise exception 'Nepakanka atsargų produktui „%“: trūksta % %.',
      (select name from products where id = p_product_id), round(v_remaining, 3), coalesce(p_unit::text, '');
  end if;

  return v_first_batch;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_general_usage(jsonb) — one or many products in one transaction
-- (a month-end count of the whole shelf saves all-or-nothing).
--   { use_date, notes,
--     items: [{ product_id, qty | remaining, write_off_group_id }] }
-- `remaining` = the counted stock left on the shelf; usage = current
-- (non-expired) stock − remaining, as the farm's Excel did (=161-4).
-- Returns the number of usage rows created.
-- ---------------------------------------------------------------------------

create or replace function create_general_usage(p_data jsonb)
returns integer
language plpgsql
security invoker
as $$
declare
  v_date date := coalesce(nullif(p_data->>'use_date', '')::date, current_date);
  v_notes text := nullif(p_data->>'notes', '');
  v_count integer := 0;
  v_item jsonb;
  v_product products%rowtype;
  v_qty numeric;
  v_remaining numeric;
  v_stock numeric;
  v_id uuid;
  v_batch uuid;
begin
  for v_item in select * from jsonb_array_elements(coalesce(p_data->'items', '[]'::jsonb))
  loop
    select * into v_product from products where id = nullif(v_item->>'product_id', '')::uuid;
    if not found then
      raise exception 'Pasirinkite produktą.';
    end if;

    v_qty := nullif(v_item->>'qty', '')::numeric;
    v_remaining := nullif(v_item->>'remaining', '')::numeric;
    v_stock := null;

    if v_remaining is not null then
      select coalesce(sum(qty_left), 0) into v_stock
      from batches
      where product_id = v_product.id
        and status = 'active'
        and (expiry_date is null or expiry_date >= current_date);
      if v_remaining < 0 then
        raise exception 'Likutis negali būti neigiamas („%“).', v_product.name;
      end if;
      if v_remaining > v_stock + 0.0001 then
        raise exception '„%“: suskaičiuotas likutis (%) didesnis už apskaitinį (%). Pirmiau supajamuokite trūkstamas prekes.',
          v_product.name, v_remaining, round(v_stock, 4);
      end if;
      v_qty := round(v_stock - v_remaining, 4);
      continue when v_qty <= 0;
    end if;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Nurodykite sunaudotą kiekį („%“).', v_product.name;
    end if;

    insert into general_usage (product_id, use_date, qty, unit, stock_before, counted_remaining, write_off_group_id, notes, created_by)
    values (v_product.id, v_date, v_qty, v_product.unit, v_stock, v_remaining,
            nullif(v_item->>'write_off_group_id', '')::uuid, coalesce(nullif(v_item->>'notes', ''), v_notes), auth.uid())
    returning id into v_id;

    v_batch := fn_consume_fefo(v_product.id, v_qty, v_product.unit, null, p_general_usage_id => v_id);
    update general_usage set batch_id = v_batch where id = v_id;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'Nėra ką įrašyti — nenurodytas joks sunaudojimas.';
  end if;

  return v_count;
end;
$$;

grant execute on function create_general_usage(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- vw_usage_items_detailed — adds general usage (new columns at the end, as
-- CREATE OR REPLACE VIEW requires).
-- ---------------------------------------------------------------------------

create or replace view vw_usage_items_detailed
with (security_invoker = true) as
select
  ui.id as usage_item_id,
  ui.product_id,
  ui.batch_id,
  ui.qty,
  ui.unit,
  ui.administration_route,
  b.purchase_price,
  b.lot,
  case
    when ui.treatment_id is not null then 'treatment'
    when ui.course_dose_id is not null then 'course_dose'
    when ui.vaccination_id is not null then 'vaccination'
    when ui.biocide_usage_id is not null then 'biocide'
    else 'general'
  end as source_kind,
  coalesce(t.reg_date, coalesce(cd.administered_date, cd.scheduled_date), v.vaccination_date, bu.use_date, gu.use_date) as used_on,
  coalesce(t.animal_id, ct.animal_id, v.animal_id) as animal_id,
  coalesce(t.animal_group_snapshot, ct.animal_group_snapshot, v.animal_group_snapshot) as animal_group,
  bu.purpose as biocide_purpose,
  coalesce(t.id, ct.id) as treatment_id,
  ui.vaccination_id,
  ui.biocide_usage_id,
  ui.general_usage_id,
  gu.write_off_group_id as general_write_off_group_id,
  an.sex as animal_sex
from usage_items ui
join batches b on b.id = ui.batch_id
left join treatments t on t.id = ui.treatment_id
left join course_doses cd on cd.id = ui.course_dose_id
left join treatment_courses tc on tc.id = cd.course_id
left join treatments ct on ct.id = tc.treatment_id
left join vaccinations v on v.id = ui.vaccination_id
left join biocide_usage bu on bu.id = ui.biocide_usage_id
left join general_usage gu on gu.id = ui.general_usage_id
left join animals an on an.id = coalesce(t.animal_id, ct.animal_id, v.animal_id);

-- ---------------------------------------------------------------------------
-- Group resolution for one usage row on an act of kind p_kind:
--   1. the group chosen on a general-usage entry (if it belongs to p_kind)
--   2. a rule matching the frozen DelPro group
--   3. a rule matching the animal's lytis
--   4. the product's default group (if it belongs to p_kind)
--   else null = "Nepriskirta" (user splits by hand before approval)
-- ---------------------------------------------------------------------------

create or replace function fn_resolve_write_off_group(
  p_kind text,
  p_explicit_group uuid,
  p_delpro_group text,
  p_animal_sex text,
  p_product_default uuid
)
returns uuid
language sql
stable
as $$
  select coalesce(
    (select g.id from write_off_groups g where g.id = p_explicit_group and p_kind = any (g.act_kinds)),
    (select g.id from write_off_group_rules r join write_off_groups g on g.id = r.write_off_group_id
      where g.active and p_kind = any (g.act_kinds) and r.match_field = 'delpro_group'
        and lower(r.match_value) = lower(p_delpro_group)
      order by g.sort_order limit 1),
    (select g.id from write_off_group_rules r join write_off_groups g on g.id = r.write_off_group_id
      where g.active and p_kind = any (g.act_kinds) and r.match_field = 'animal_sex'
        and lower(r.match_value) = lower(p_animal_sex)
      order by g.sort_order limit 1),
    (select g.id from write_off_groups g where g.id = p_product_default and p_kind = any (g.act_kinds))
  );
$$;

-- ---------------------------------------------------------------------------
-- Acts: template kind + the header/signature fields the templates print.
-- Snapshotted from system_settings at generation, editable while draft.
-- ---------------------------------------------------------------------------

alter table write_off_acts
  add column act_kind text not null default 'vaistai' check (act_kind in ('vaistai', 'priedai', 'medziagos')),
  add column account_no text,
  add column expense_object text,
  add column approver_title text,
  add column approver_name text,
  add column signatories jsonb not null default '[]'::jsonb;

-- unit_label: the act's unit as printed ("vnt", "l"...) — products.act_unit
-- is free text, so it can't always fit the `unit` enum column.
alter table write_off_act_items
  add column nomenclature_no text,
  add column unit_label text;

alter table write_off_act_allocations
  add column write_off_group_id uuid references write_off_groups (id);

insert into system_settings (setting_key, setting_value, description) values
  ('write_off_letterhead_address', 'Sodybinė g. 27, Daukšių mstl., Marijampolės sav.', 'Adresas nurašymo aktų antraštėje'),
  ('write_off_approver_title', 'Pirmininkas', 'Nurašymo aktų „Tvirtinu“ pareigos'),
  ('write_off_approver_name', 'Jonas Kaulickas', 'Nurašymo aktų „Tvirtinu“ vardas, pavardė'),
  ('write_off_signatories_vaistai',
   '[{"title":"Pirmininko pavaduotoja gyvulininkystei","name":"Reda Bindokienė"},{"title":"Vet. gydytoja","name":"Karolina Vaickutė"}]',
   'Vaistų, biocidų akto pasirašantys asmenys (JSON)'),
  ('write_off_signatories_priedai',
   '[{"title":"Pirmininko pavaduotoja gyvulininkystei","name":"Reda Bindokienė"},{"title":"Vet. gydytoja","name":"Karolina Vaickutė"}]',
   'Veterinarinių priedų akto pasirašantys asmenys (JSON)'),
  ('write_off_signatories_medziagos',
   '[{"title":"Materialiai atsakinga","name":"Karolina Vaickutė"}]',
   'Medžiagų akto pasirašantys asmenys (JSON)'),
  ('write_off_medziagos_account', '209', 'Medžiagų akto „Sąskaita“'),
  ('write_off_medziagos_expense_object', 'Galvijų gydymas ir priežiūra', 'Medžiagų akto „Išlaidų objektas“')
on conflict (setting_key) do nothing;

-- ---------------------------------------------------------------------------
-- generate_write_off_act(jsonb) — replaces 0007's version.
--   { act_kind (required), period_start, period_end, act_date, act_number,
--     notes }
-- Picks every not-yet-written-off usage row in the period whose product
-- belongs to act_kind. One item per product; quantity and price converted
-- to the product's act unit (packages) when act_unit_size is set; price =
-- weighted average of the batches actually consumed. Allocations are
-- grouped by fn_resolve_write_off_group().
-- ---------------------------------------------------------------------------

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
           coalesce(nullif(p.act_unit, ''), max(u.unit::text), p.unit::text) as unit,
           coalesce(p.act_unit_size, 1) as factor,
           sum(u.qty) as qty,
           sum(u.qty * coalesce(u.purchase_price, 0)) as cost,
           string_agg(distinct u.lot, ', ') as lots
    from vw_usage_items_detailed u
    join products p on p.id = u.product_id
    where u.usage_item_id = any (v_ids)
    group by u.product_id, p.name, p.category, p.registration_code, p.nomenclature_no, p.act_unit, p.act_unit_size, p.unit
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

-- ---------------------------------------------------------------------------
-- set_write_off_allocations — rows now carry write_off_group_id; the label
-- is the group's name. Replaces 0007's version (same signature).
--   rows: [{ "write_off_group_id": "...", "quantity": 30, "animal_count": 12 }]
-- ---------------------------------------------------------------------------

create or replace function set_write_off_allocations(p_item_id uuid, p_rows jsonb)
returns void
language plpgsql
security invoker
as $$
declare
  v_kind text;
begin
  select a.act_kind into v_kind
  from write_off_act_items i join write_off_acts a on a.id = i.act_id
  where i.id = p_item_id;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
    left join write_off_groups g on g.id = nullif(r->>'write_off_group_id', '')::uuid
    where coalesce((r->>'quantity')::numeric, 0) > 0
      and g.id is not null and not (v_kind = any (g.act_kinds))
  ) then
    raise exception 'Pasirinkta grupė nepriklauso šiam akto tipui.';
  end if;

  delete from write_off_act_allocations where item_id = p_item_id;

  insert into write_off_act_allocations (item_id, write_off_group_id, label, quantity, animal_count, suggested, notes)
  select p_item_id,
         g.id,
         coalesce(g.name, 'Nepriskirta grupei'),
         (r->>'quantity')::numeric,
         nullif(r->>'animal_count', '')::integer,
         false,
         nullif(r->>'notes', '')
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  left join write_off_groups g on g.id = nullif(r->>'write_off_group_id', '')::uuid
  where coalesce((r->>'quantity')::numeric, 0) > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- approve_write_off_act — additionally refuses anything left unassigned:
-- every quantity must sit in one of the template's group columns.
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

  select string_agg(distinct i.product_name, ', ')
  into v_bad
  from write_off_act_items i
  join write_off_act_allocations a on a.item_id = i.id
  where i.act_id = p_act_id and a.write_off_group_id is null;

  if v_bad is not null then
    raise exception 'Nepriskirta grupei: % — priskirkite kiekį grupėms.', v_bad;
  end if;

  update write_off_acts
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_act_id and status = 'draft';

  if not found then
    raise exception 'Aktas nerastas arba jau nebe juodraštis.';
  end if;
end;
$$;

-- Allocation targets: the template groups (purposes from 0007 are retired —
-- the farm's templates have fixed group columns only).
drop view vw_write_off_allocation_targets;

create view vw_write_off_allocation_targets
with (security_invoker = true) as
select id, name as label, act_kinds, sort_order
from write_off_groups
where active;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table general_usage enable row level security;
create policy general_usage_select on general_usage for select using (fn_is_authenticated_active());
create policy general_usage_insert on general_usage for insert with check (fn_is_active_staff());
create policy general_usage_update on general_usage for update using (fn_is_active_staff());
create policy general_usage_delete on general_usage for delete using (fn_is_active_staff());

do $$
declare
  t text;
begin
  foreach t in array array['write_off_groups', 'write_off_group_rules'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (fn_is_authenticated_active())', t || '_select', t);
    execute format('create policy %I on %I for all using (fn_is_admin()) with check (fn_is_admin())', t || '_admin_write', t);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

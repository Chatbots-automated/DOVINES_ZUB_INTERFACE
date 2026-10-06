-- 0001_core_tables.sql
-- Dovinės ŽŪB GVET PRO — baseline schema, part 1: enums + core reference
-- tables (users, system_settings, diseases, delpro_groups, animals,
-- suppliers, products, invoices, batches).
--
-- Squashed from the ZUB_ZIBARTONIAI_INTERFACE sibling project's 0001-0012
-- (minus VIC/UNIFORM/hoof/insemination, none of which are in this
-- contract's Priedas Nr. 1). Single-farm, single-tenant: no farm_id.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type user_role as enum ('admin', 'vet', 'tech', 'viewer');

-- Priedas §2.1 "produkto tipas".
create type product_category as enum ('medicines', 'vakcina', 'biocide', 'treatment_materials', 'other');

create type unit as enum ('ml', 'l', 'g', 'kg', 'pcs', 'vnt', 'tablet', 'dose');

-- Priedas §2.3 "skyrimo būdas". Also drives the optional per-route
-- withdrawal overrides on `products` (fn_route_withdrawal_days, 0004).
create type administration_route as enum ('iv', 'im', 'sc', 'iu', 'imm', 'pos', 'kita');

create type batch_status as enum ('active', 'depleted', 'expired');

create type course_status as enum ('active', 'completed', 'cancelled');

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users (mirrors auth.users; role + freeze flag for app-level access control)
-- ---------------------------------------------------------------------------

create table users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  role user_role not null default 'tech',
  is_frozen boolean not null default false,
  last_login timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- system_settings (key/value) — farm requisites for journal / nurašymo akto
-- letterheads, DelPro integration state (0006).
-- ---------------------------------------------------------------------------

create table system_settings (
  setting_key text primary key,
  setting_value text,
  description text,
  updated_at timestamptz not null default now()
);

create trigger trg_system_settings_updated_at
  before update on system_settings
  for each row execute function set_updated_at();

insert into system_settings (setting_key, setting_value, description) values
  ('farm_name', 'Dovinės žemės ūkio bendrovė', 'Ūkio pavadinimas ataskaitų ir aktų antraštėms'),
  ('farm_code', '165668169', 'Įmonės kodas'),
  ('farm_vat_code', 'LT656681610', 'PVM mokėtojo kodas'),
  ('farm_address', 'Sodybinė g. 27, Daukšiai, LT-69142 Marijampolė', 'Adresas'),
  ('farm_representative', 'Jonas Kaulickas, pirmininkas', 'Atstovas');

-- ---------------------------------------------------------------------------
-- diseases (Priedas §2.3 diagnozė registry — free-form + optional code)
-- ---------------------------------------------------------------------------

create table diseases (
  id uuid primary key default gen_random_uuid(),
  code text,
  name text not null,
  created_at timestamptz not null default now()
);

create unique index diseases_name_key on diseases (lower(name));

-- ---------------------------------------------------------------------------
-- delpro_groups (Priedas §3.3 "bandos / grupės informacija") — synced from
-- DelPro by upsert_animals_from_delpro() (0006). Used for group
-- vaccinations (§2.6) and nurašymo aktų paskirstymas (§2.9, 0007).
-- ---------------------------------------------------------------------------

create table delpro_groups (
  id uuid primary key default gen_random_uuid(),
  delpro_group_id text,
  name text not null,
  active boolean not null default true,
  updated_from_delpro_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index delpro_groups_delpro_group_id_key on delpro_groups (delpro_group_id) where delpro_group_id is not null;
create unique index delpro_groups_name_key on delpro_groups (lower(name));

create trigger trg_delpro_groups_updated_at
  before update on delpro_groups
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- animals (Priedas §2.7, §3.3). `tag_no` is the official ear tag (LT...);
-- `animal_no` is DelPro's short herd number the farm actually uses day to
-- day; `delpro_animal_id` is DelPro's internal key (the upsert match key).
-- ---------------------------------------------------------------------------

create table animals (
  id uuid primary key default gen_random_uuid(),
  tag_no text not null,
  animal_no text,
  delpro_animal_id text,
  name text,
  species text not null default 'galvijas',
  -- Lithuanian farm "lytis" is a lifecycle category (Karvė, Telyčaitė,
  -- Bulius, Veršelis...), not a binary sex — see Kairaitienes' 0012.
  sex text,
  breed text,
  birth_date date,
  group_id uuid references delpro_groups (id) on delete set null,
  group_name text,
  lactation_no integer,
  active boolean not null default true,
  source text not null default 'manual' check (source in ('manual', 'delpro')),
  updated_from_delpro_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index animals_tag_no_key on animals (tag_no);
create unique index animals_delpro_animal_id_key on animals (delpro_animal_id) where delpro_animal_id is not null;
create index animals_animal_no_idx on animals (animal_no);
create index animals_active_idx on animals (active);
create index animals_group_id_idx on animals (group_id);

create trigger trg_animals_updated_at
  before update on animals
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- suppliers
-- ---------------------------------------------------------------------------

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text,
  vat_code text,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- products (Priedas §2.1) — flat withdrawal_days_milk/meat plus optional
-- per-administration-route overrides (fn_route_withdrawal_days, 0004).
-- ---------------------------------------------------------------------------

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category product_category not null default 'medicines',
  is_antimicrobial boolean not null default false,
  unit unit not null default 'vnt',
  active_substance text,
  registration_code text,
  dosage_notes text,
  package_weight_g numeric,
  min_stock_alert numeric,

  withdrawal_days_milk integer not null default 0,
  withdrawal_days_meat integer not null default 0,
  withdrawal_iv_milk integer,
  withdrawal_iv_meat integer,
  withdrawal_im_milk integer,
  withdrawal_im_meat integer,
  withdrawal_sc_milk integer,
  withdrawal_sc_meat integer,
  withdrawal_iu_milk integer,
  withdrawal_iu_meat integer,
  withdrawal_imm_milk integer,
  withdrawal_imm_meat integer,
  withdrawal_pos_milk integer,
  withdrawal_pos_meat integer,

  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index products_category_idx on products (category);
create index products_is_antimicrobial_idx on products (is_antimicrobial) where is_antimicrobial;

create trigger trg_products_updated_at
  before update on products
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- invoices / invoice_items (Priedas §2.2 pajamavimas, §2.11 PDF invoice
-- upload — n8n PDF-parse -> review -> confirm)
-- ---------------------------------------------------------------------------

create table invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text,
  invoice_date date,
  supplier_id uuid references suppliers (id),
  supplier_name text,
  total_net numeric,
  total_vat numeric,
  total_gross numeric,
  currency text not null default 'EUR',
  pdf_filename text,
  raw_parsed jsonb,
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);

create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices (id) on delete cascade,
  product_id uuid references products (id),
  batch_id uuid,
  line_no integer,
  description text,
  quantity numeric,
  unit_price numeric,
  total_price numeric
);

create index invoice_items_invoice_id_idx on invoice_items (invoice_id);

-- ---------------------------------------------------------------------------
-- batches — FEFO stock lots (Priedas §2.1 partija/serija/galiojimo terminas,
-- §2.5 atsargų kontrolė). package_size/package_count are an optional
-- "6 pakuotės po 100 ml" entry aid; received_qty stays the source of truth.
-- ---------------------------------------------------------------------------

create table batches (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  supplier_id uuid references suppliers (id),
  invoice_id uuid references invoices (id),
  lot text,
  mfg_date date,
  expiry_date date,
  received_qty numeric not null check (received_qty >= 0),
  qty_left numeric not null default 0 check (qty_left >= 0),
  package_size numeric,
  package_count numeric,
  purchase_price numeric,
  currency text not null default 'EUR',
  status batch_status not null default 'active',
  received_at timestamptz not null default now(),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index batches_product_id_idx on batches (product_id);
create index batches_status_idx on batches (status);
create index batches_expiry_date_idx on batches (expiry_date);

create trigger trg_batches_updated_at
  before update on batches
  for each row execute function set_updated_at();

alter table invoice_items
  add constraint invoice_items_batch_id_fkey foreign key (batch_id) references batches (id);

-- default qty_left = received_qty on insert unless explicitly given
create or replace function fn_batches_default_qty_left()
returns trigger
language plpgsql
as $$
begin
  if new.qty_left is null or new.qty_left = 0 then
    new.qty_left := new.received_qty;
  end if;
  return new;
end;
$$;

create trigger trg_batches_default_qty_left
  before insert on batches
  for each row execute function fn_batches_default_qty_left();

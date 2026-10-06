-- 0002_treatments_and_courses.sql
-- Dovinės ŽŪB GVET PRO — treatments, multi-day treatment courses,
-- vaccinations, biocide usage.
--
-- No separate `visits` table: `treatments` is the anchor entity directly.
--
-- animal_group_snapshot: the animal's DelPro group AT THE TIME of the
-- treatment/vaccination, frozen on insert. DelPro groups change constantly
-- (fresh -> high -> low -> dry), and nurašymo aktų paskirstymas pagal
-- grupes (Priedas §2.9, 0007) must reflect where the animal was when the
-- product was actually used, not where it is today.

-- ---------------------------------------------------------------------------
-- treatments (gydymo įrašai, Priedas §2.3) — one row per disease episode
-- ---------------------------------------------------------------------------

create table treatments (
  id uuid primary key default gen_random_uuid(),
  animal_id uuid not null references animals (id),
  disease_id uuid references diseases (id),
  procedure_type text not null default 'gydymas' check (procedure_type in ('apziura', 'gydymas', 'profilaktika')),
  reg_date date not null default current_date,
  diagnosis text,
  administration_route administration_route,
  outcome text,
  outcome_date date,
  vet_name text,
  notes text,
  animal_group_snapshot text,

  -- Computed by calculate_withdrawal_dates() whenever linked usage_items
  -- or treatment_courses change.
  withdrawal_until_milk date,
  withdrawal_until_meat date,

  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index treatments_animal_id_idx on treatments (animal_id);
create index treatments_reg_date_idx on treatments (reg_date);
create index treatments_withdrawal_milk_idx on treatments (withdrawal_until_milk);
create index treatments_withdrawal_meat_idx on treatments (withdrawal_until_meat);

create trigger trg_treatments_updated_at
  before update on treatments
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- treatment_courses / course_doses (gydymo kursai, Priedas §2.4). Day 1 is
-- the treatment's own usage_items; days 2..N are course_doses rows whose
-- stock is deducted only once each day is actually administered.
-- ---------------------------------------------------------------------------

create table treatment_courses (
  id uuid primary key default gen_random_uuid(),
  treatment_id uuid not null references treatments (id) on delete cascade,
  days integer not null check (days > 0),
  administration_route administration_route,
  start_date date not null default current_date,
  status course_status not null default 'active',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index treatment_courses_treatment_id_idx on treatment_courses (treatment_id);

create trigger trg_treatment_courses_updated_at
  before update on treatment_courses
  for each row execute function set_updated_at();

create table course_doses (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references treatment_courses (id) on delete cascade,
  day_number integer not null check (day_number > 0),
  scheduled_date date not null,
  product_id uuid references products (id),
  batch_id uuid references batches (id),
  dose_amount numeric,
  unit unit,
  administration_route administration_route,
  administered boolean not null default false,
  administered_date date,
  administered_by uuid references users (id),
  notes text,
  created_at timestamptz not null default now()
);

create index course_doses_course_id_idx on course_doses (course_id);
create index course_doses_scheduled_date_idx on course_doses (scheduled_date);

-- ---------------------------------------------------------------------------
-- vaccinations (Priedas §2.6 — "gyvulį ar gyvulių grupę"). A group
-- vaccination is stored as one row per animal (so withdrawal, stock and
-- history stay per-animal) sharing a `session_id`, with the chosen group
-- recorded in `target_group_name`.
-- ---------------------------------------------------------------------------

create table vaccinations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid,
  target_group_name text,
  animal_id uuid not null references animals (id),
  product_id uuid not null references products (id),
  batch_id uuid references batches (id),
  vaccination_date date not null default current_date,
  dose_amount numeric,
  unit unit,
  administration_route administration_route,
  is_revaccination boolean not null default false,
  next_booster_date date,
  administered_by uuid references users (id),
  vet_name text,
  notes text,
  animal_group_snapshot text,
  withdrawal_until_milk date,
  withdrawal_until_meat date,
  created_at timestamptz not null default now()
);

create index vaccinations_animal_id_idx on vaccinations (animal_id);
create index vaccinations_vaccination_date_idx on vaccinations (vaccination_date);
create index vaccinations_session_id_idx on vaccinations (session_id) where session_id is not null;
create index vaccinations_next_booster_date_idx on vaccinations (next_booster_date) where next_booster_date is not null;

-- ---------------------------------------------------------------------------
-- biocide_usage (Priedas §2.8 biocidinių produktų žurnalas)
-- ---------------------------------------------------------------------------

create table biocide_usage (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  batch_id uuid references batches (id),
  use_date date not null default current_date,
  purpose text,
  work_scope text,
  qty numeric,
  unit unit,
  used_by_name text,
  created_at timestamptz not null default now()
);

create index biocide_usage_use_date_idx on biocide_usage (use_date);

-- ---------------------------------------------------------------------------
-- Group snapshot on insert (see header).
-- ---------------------------------------------------------------------------

create or replace function fn_snapshot_animal_group()
returns trigger
language plpgsql
as $$
begin
  if new.animal_group_snapshot is null then
    select group_name into new.animal_group_snapshot from animals where id = new.animal_id;
  end if;
  return new;
end;
$$;

create trigger trg_treatments_snapshot_group
  before insert on treatments
  for each row execute function fn_snapshot_animal_group();

create trigger trg_vaccinations_snapshot_group
  before insert on vaccinations
  for each row execute function fn_snapshot_animal_group();

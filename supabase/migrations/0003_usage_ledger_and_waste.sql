-- 0003_usage_ledger_and_waste.sql
-- Dovinės ŽŪB GVET PRO — the central stock-consumption ledger and medical
-- waste tracking (Priedas §2.5 atsargų kontrolė, §2.8 medicininių atliekų
-- žurnalas). `usage_items` is polymorphic: exactly one of the *_id source
-- columns must be set, enforced by a CHECK constraint.

create table usage_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  batch_id uuid not null references batches (id),
  qty numeric not null check (qty > 0),
  unit unit,
  administration_route administration_route,

  treatment_id uuid references treatments (id) on delete cascade,
  course_dose_id uuid references course_doses (id) on delete cascade,
  vaccination_id uuid references vaccinations (id) on delete cascade,
  biocide_usage_id uuid references biocide_usage (id) on delete cascade,

  created_at timestamptz not null default now(),

  constraint usage_items_single_source check (
    (
      (treatment_id is not null)::int +
      (course_dose_id is not null)::int +
      (vaccination_id is not null)::int +
      (biocide_usage_id is not null)::int
    ) = 1
  )
);

create index usage_items_product_id_idx on usage_items (product_id);
create index usage_items_batch_id_idx on usage_items (batch_id);
create index usage_items_treatment_id_idx on usage_items (treatment_id) where treatment_id is not null;
create index usage_items_course_dose_id_idx on usage_items (course_dose_id) where course_dose_id is not null;
create index usage_items_vaccination_id_idx on usage_items (vaccination_id) where vaccination_id is not null;
create index usage_items_biocide_usage_id_idx on usage_items (biocide_usage_id) where biocide_usage_id is not null;

-- ---------------------------------------------------------------------------
-- medical_waste — auto-generated on batch depletion, or entered manually.
-- ---------------------------------------------------------------------------

create table medical_waste (
  id uuid primary key default gen_random_uuid(),
  waste_code text,
  name text,
  waste_date date not null default current_date,
  qty_generated numeric,
  qty_transferred numeric,
  carrier text,
  processor text,
  transfer_date date,
  doc_no text,
  responsible text,
  auto_generated boolean not null default false,
  source_batch_id uuid references batches (id),
  created_at timestamptz not null default now()
);

create index medical_waste_waste_date_idx on medical_waste (waste_date);

-- Dedupe guard: at most one auto-generated waste row per depleted batch.
create table batch_waste_tracking (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references batches (id),
  medical_waste_id uuid not null references medical_waste (id),
  created_at timestamptz not null default now(),
  unique (batch_id)
);

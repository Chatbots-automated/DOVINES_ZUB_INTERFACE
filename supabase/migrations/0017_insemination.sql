-- 0017_insemination.sql
-- Dovinės ŽŪB GVET PRO — Sėklinimas (insemination journal), requested by the
-- farm after the original Priedas scope (billed separately). Functional model
-- ported from Monika's Seklinimas.tsx and Kairaitienės 0018:
--   * Lithuania's inter-farm insemination journal fields (pažymėjimo Nr.,
--     sėklintojo kodas, karvės ID, įmonės kodas, reproduktoriaus KK Nr./kodas,
--     dozių savininkas) so the CSV can be uploaded to the journal.
--   * semen straws + gloves are consumed from the normal batches/usage_items
--     FEFO ledger (one RPC = one transaction), so they show up in stock and in
--     the nurašymo aktai like any other product.
--   * pregnancy check: tri-state (null = laukiama / true / false) + the date
--     of the next check; expected calving is insemination_date + 283 d.
-- 'reproduction' is a new product type for bull semen. A new enum value cannot
-- be used in the transaction that adds it, so nothing below references it.

alter type product_category add value if not exists 'reproduction' before 'treatment_materials';

-- ---------------------------------------------------------------------------
-- insemination_records
-- ---------------------------------------------------------------------------

create table insemination_records (
  id uuid primary key default gen_random_uuid(),
  animal_id uuid not null references animals (id),
  insemination_date date not null default current_date,

  -- semen (product category 'reproduction') + optional gloves; stock is
  -- deducted through usage_items.insemination_id, never edited here.
  sperm_product_id uuid references products (id),
  sperm_quantity numeric check (sperm_quantity is null or sperm_quantity > 0),
  glove_product_id uuid references products (id),
  glove_quantity numeric check (glove_quantity is null or glove_quantity > 0),

  -- journal fields (VIC / inter-farm insemination journal)
  pazymejimo_nr text,
  seklintojo_kodas text,
  inseminator_name text,
  karves_id text,                -- snapshot of animals.tag_no at insert
  imones_kodas text,
  bull_name text,
  reproduktoriaus_id text,       -- bull KK number (short, no country prefix)
  reproduktoriaus_kk_kodas text,
  sp_savininkas text,            -- dozių savininkas

  -- pregnancy: null = Laukiama, true = Patvirtinta, false = Nepatvirtinta
  pregnancy_confirmed boolean,
  pregnancy_check_date date,
  next_pregnancy_check_date date,
  pregnancy_notes text,

  notes text,
  animal_group_snapshot text,    -- frozen DelPro group (nurašymo aktų paskirstymas)
  performed_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index insemination_records_animal_id_idx on insemination_records (animal_id);
create index insemination_records_date_idx on insemination_records (insemination_date);
create index insemination_records_pregnancy_idx on insemination_records (pregnancy_confirmed);
create index insemination_records_nr_idx on insemination_records (pazymejimo_nr);

comment on column insemination_records.karves_id is
  'Snapshot of animals.tag_no at insemination time — a later re-tag never rewrites a journal entry.';
comment on column insemination_records.pregnancy_confirmed is
  'null = Laukiama (check pending), true = Patvirtinta, false = Nepatvirtinta.';

create trigger trg_insemination_records_updated_at
  before update on insemination_records
  for each row execute function set_updated_at();

create trigger trg_insemination_records_snapshot_group
  before insert on insemination_records
  for each row execute function fn_snapshot_animal_group();

-- ---------------------------------------------------------------------------
-- usage_items gains a source: the insemination record.
-- ---------------------------------------------------------------------------

alter table usage_items
  add column insemination_id uuid references insemination_records (id) on delete cascade;

create index usage_items_insemination_id_idx on usage_items (insemination_id) where insemination_id is not null;

alter table usage_items drop constraint usage_items_single_source;
alter table usage_items add constraint usage_items_single_source check (
  (
    (treatment_id is not null)::int +
    (course_dose_id is not null)::int +
    (vaccination_id is not null)::int +
    (biocide_usage_id is not null)::int +
    (general_usage_id is not null)::int +
    (insemination_id is not null)::int
  ) = 1
);

-- A written-off usage row must not vanish from under its act (same guard as
-- general_usage, 0012). Deleting an insemination otherwise cascades to its
-- usage_items, and the stock-restore trigger puts the doses back.
create or replace function fn_insemination_delete_guard()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from usage_items ui
    join write_off_act_usage_items w on w.usage_item_id = ui.id
    where ui.insemination_id = old.id
  ) then
    raise exception 'Šis sėklinimas jau įtrauktas į nurašymo aktą — pirmiau anuliuokite arba ištrinkite aktą.';
  end if;
  return old;
end;
$$;

create trigger trg_insemination_delete_guard
  before delete on insemination_records
  for each row execute function fn_insemination_delete_guard();

-- ---------------------------------------------------------------------------
-- FEFO consumption for an insemination. Same algorithm as fn_consume_fefo
-- (soonest-expiring active, non-expired batch first, locked), kept as a
-- separate helper so fn_consume_fefo's signature — which other migrations
-- drop/recreate — is left alone. Raises on shortfall, rolling the caller back.
-- ---------------------------------------------------------------------------

create or replace function fn_consume_fefo_for_insemination(
  p_product_id uuid,
  p_qty numeric,
  p_unit unit,
  p_insemination_id uuid
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
    insert into usage_items (product_id, batch_id, qty, unit, insemination_id)
    values (p_product_id, b.id, v_take, p_unit, p_insemination_id);
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
-- generate_pazymejimo_nr — YY + sėklintojo kodas + running NN for that code
-- this year (Monika's format). A convenience default; the UI also allows a
-- manual number. Not unique-enforced: manual entries may repeat on purpose.
-- ---------------------------------------------------------------------------

create or replace function generate_pazymejimo_nr(p_vet_code text)
returns text
language plpgsql
as $$
declare
  v_prefix text := to_char(current_date, 'YY') || upper(coalesce(p_vet_code, ''));
  v_last integer;
begin
  select coalesce(max(substr(pazymejimo_nr, length(v_prefix) + 1)::integer), 0) into v_last
  from insemination_records
  where pazymejimo_nr ~ ('^' || v_prefix || '[0-9]+$');
  return v_prefix || lpad((v_last + 1)::text, 2, '0');
end;
$$;

grant execute on function generate_pazymejimo_nr(text) to authenticated;

-- ---------------------------------------------------------------------------
-- create_insemination(jsonb) — "Naujas sėklinimas".
--   { animal_id, insemination_date, sperm_product_id, sperm_quantity (default 1),
--     glove_product_id, glove_quantity, pazymejimo_nr (auto when empty and a
--     seklintojo_kodas is given), seklintojo_kodas, inseminator_name,
--     imones_kodas, bull_name, reproduktoriaus_id, reproduktoriaus_kk_kodas,
--     sp_savininkas, next_pregnancy_check_date, notes }
-- Deducts semen + gloves FEFO in the same transaction; a shortfall rolls the
-- whole record back. Returns the new record id.
-- ---------------------------------------------------------------------------

create or replace function create_insemination(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_animal uuid := nullif(p_data->>'animal_id', '')::uuid;
  v_date date := coalesce(nullif(p_data->>'insemination_date', '')::date, current_date);
  v_sperm uuid := nullif(p_data->>'sperm_product_id', '')::uuid;
  v_sperm_qty numeric := nullif(p_data->>'sperm_quantity', '')::numeric;
  v_glove uuid := nullif(p_data->>'glove_product_id', '')::uuid;
  v_glove_qty numeric := nullif(p_data->>'glove_quantity', '')::numeric;
  v_code text := upper(nullif(trim(p_data->>'seklintojo_kodas'), ''));
  v_nr text := nullif(trim(p_data->>'pazymejimo_nr'), '');
  v_tag text;
  v_id uuid;
begin
  if v_animal is null then
    raise exception 'Pasirinkite gyvūną.';
  end if;
  select tag_no into v_tag from animals where id = v_animal;
  if v_tag is null then
    raise exception 'Gyvūnas nerastas.';
  end if;
  if v_sperm is not null then
    v_sperm_qty := coalesce(v_sperm_qty, 1);
  end if;
  if v_glove is not null then
    v_glove_qty := coalesce(v_glove_qty, 1);
  end if;
  if coalesce(v_sperm_qty, 1) <= 0 or coalesce(v_glove_qty, 1) <= 0 then
    raise exception 'Kiekis turi būti didesnis už 0.';
  end if;

  if v_nr is null and v_code is not null then
    -- serialise numbering so two inseminations saved at once can't collide
    perform pg_advisory_xact_lock(hashtext('insemination_nr'));
    v_nr := generate_pazymejimo_nr(v_code);
  end if;

  insert into insemination_records (
    animal_id, insemination_date, sperm_product_id, sperm_quantity, glove_product_id, glove_quantity,
    pazymejimo_nr, seklintojo_kodas, inseminator_name, karves_id, imones_kodas, bull_name,
    reproduktoriaus_id, reproduktoriaus_kk_kodas, sp_savininkas,
    next_pregnancy_check_date, notes, performed_by
  ) values (
    v_animal, v_date,
    v_sperm, case when v_sperm is not null then v_sperm_qty end,
    v_glove, case when v_glove is not null then v_glove_qty end,
    v_nr, v_code, nullif(trim(p_data->>'inseminator_name'), ''), v_tag,
    nullif(trim(p_data->>'imones_kodas'), ''), nullif(trim(p_data->>'bull_name'), ''),
    nullif(trim(p_data->>'reproduktoriaus_id'), ''), nullif(trim(p_data->>'reproduktoriaus_kk_kodas'), ''),
    nullif(trim(p_data->>'sp_savininkas'), ''),
    nullif(p_data->>'next_pregnancy_check_date', '')::date,
    nullif(trim(p_data->>'notes'), ''),
    auth.uid()
  )
  returning id into v_id;

  if v_sperm is not null then
    perform fn_consume_fefo_for_insemination(v_sperm, v_sperm_qty, 'dose'::unit, v_id);
  end if;
  if v_glove is not null then
    perform fn_consume_fefo_for_insemination(v_glove, v_glove_qty, (select unit from products where id = v_glove), v_id);
  end if;

  return v_id;
end;
$$;

grant execute on function create_insemination(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- vw_usage_items_detailed — insemination rows get their own source_kind, the
-- insemination date, the animal and the frozen DelPro group, so semen/gloves
-- land on the right nurašymo akto line. Same columns as 0012 + insemination_id
-- appended (CREATE OR REPLACE VIEW requires new columns at the end).
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
    when ui.insemination_id is not null then 'insemination'
    else 'general'
  end as source_kind,
  coalesce(t.reg_date, coalesce(cd.administered_date, cd.scheduled_date), v.vaccination_date, bu.use_date, gu.use_date, ins.insemination_date) as used_on,
  coalesce(t.animal_id, ct.animal_id, v.animal_id, ins.animal_id) as animal_id,
  coalesce(t.animal_group_snapshot, ct.animal_group_snapshot, v.animal_group_snapshot, ins.animal_group_snapshot) as animal_group,
  bu.purpose as biocide_purpose,
  coalesce(t.id, ct.id) as treatment_id,
  ui.vaccination_id,
  ui.biocide_usage_id,
  ui.general_usage_id,
  gu.write_off_group_id as general_write_off_group_id,
  an.sex as animal_sex,
  ui.insemination_id
from usage_items ui
join batches b on b.id = ui.batch_id
left join treatments t on t.id = ui.treatment_id
left join course_doses cd on cd.id = ui.course_dose_id
left join treatment_courses tc on tc.id = cd.course_id
left join treatments ct on ct.id = tc.treatment_id
left join vaccinations v on v.id = ui.vaccination_id
left join biocide_usage bu on bu.id = ui.biocide_usage_id
left join general_usage gu on gu.id = ui.general_usage_id
left join insemination_records ins on ins.id = ui.insemination_id
left join animals an on an.id = coalesce(t.animal_id, ct.animal_id, v.animal_id, ins.animal_id);

-- ---------------------------------------------------------------------------
-- RLS — same as 0009: every active user reads, active staff write.
-- ---------------------------------------------------------------------------

alter table insemination_records enable row level security;

create policy insemination_records_select on insemination_records
  for select using (fn_is_authenticated_active());
create policy insemination_records_insert on insemination_records
  for insert with check (fn_is_active_staff());
create policy insemination_records_update on insemination_records
  for update using (fn_is_active_staff());
create policy insemination_records_delete on insemination_records
  for delete using (fn_is_active_staff());

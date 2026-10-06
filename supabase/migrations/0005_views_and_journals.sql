-- 0005_views_and_journals.sql
-- Dovinės ŽŪB GVET PRO — stock views, the usage ledger resolved to a date +
-- animal group, and the Priedas §2.8 journals:
--   1. Veterinarinių vaistų ir veterinarinių preparatų apskaitos žurnalas -> vw_vet_drug_journal
--   2. Gydomų gyvūnų žurnalas                                             -> vw_treated_animals
--   3. Gydomų gyvūnų apskaita (one row per treatment case)                -> vw_treated_animals_summary
--   4. Biocidinių produktų žurnalas                                       -> vw_biocide_journal
--   5. Veterinarinių medicininių atliekų žurnalas                          -> vw_medical_waste
--   6. Antimikrobinių vaistų skyrimo ir sunaudojimo ataskaita              -> vw_antimicrobial_usage
--
-- Exact print layouts follow the farm's templates (§2.8 "pagal projekto
-- metu pateiktus ir suderintus šablonus") — the views ship the data;
-- column layout is adjusted in the app without a schema change.
--
-- security_invoker = true on every view so it respects the caller's RLS.

-- ---------------------------------------------------------------------------
-- Stock views (Priedas §2.5)
-- ---------------------------------------------------------------------------

create view stock_by_batch
with (security_invoker = true) as
select b.id, b.product_id, p.name as product_name, p.unit, b.lot, b.qty_left, b.expiry_date
from batches b
join products p on p.id = b.product_id
where b.status = 'active'
order by b.expiry_date nulls last;

create view stock_by_product
with (security_invoker = true) as
select
  b.product_id,
  p.name as product_name,
  p.unit,
  p.min_stock_alert,
  sum(b.qty_left) as qty_left
from batches b
join products p on p.id = b.product_id
where b.status = 'active'
group by b.product_id, p.name, p.unit, p.min_stock_alert;

-- ---------------------------------------------------------------------------
-- vw_usage_items_detailed — every usage_items row resolved to the date the
-- product was actually used, the animal (if any), and the animal's group
-- snapshot at that time. Basis for nurašymo aktai (0007) and the
-- antimicrobial report.
-- ---------------------------------------------------------------------------

create view vw_usage_items_detailed
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
    else 'biocide'
  end as source_kind,
  coalesce(t.reg_date, coalesce(cd.administered_date, cd.scheduled_date), v.vaccination_date, bu.use_date) as used_on,
  coalesce(t.animal_id, ct.animal_id, v.animal_id) as animal_id,
  coalesce(t.animal_group_snapshot, ct.animal_group_snapshot, v.animal_group_snapshot) as animal_group,
  bu.purpose as biocide_purpose,
  coalesce(t.id, ct.id) as treatment_id,
  ui.vaccination_id,
  ui.biocide_usage_id
from usage_items ui
join batches b on b.id = ui.batch_id
left join treatments t on t.id = ui.treatment_id
left join course_doses cd on cd.id = ui.course_dose_id
left join treatment_courses tc on tc.id = cd.course_id
left join treatments ct on ct.id = tc.treatment_id
left join vaccinations v on v.id = ui.vaccination_id
left join biocide_usage bu on bu.id = ui.biocide_usage_id;

-- ---------------------------------------------------------------------------
-- Withdrawal status — per-animal MAX() across treatments + vaccinations
-- ---------------------------------------------------------------------------

create view vw_withdrawal_status
with (security_invoker = true) as
with combined as (
  select animal_id, withdrawal_until_milk as milk_until, withdrawal_until_meat as meat_until
  from treatments
  union all
  select animal_id, withdrawal_until_milk, withdrawal_until_meat
  from vaccinations
)
select
  a.id as animal_id,
  a.tag_no,
  max(c.milk_until) as milk_until,
  max(c.meat_until) as meat_until,
  (max(c.milk_until) is not null and max(c.milk_until) >= current_date) as milk_active,
  (max(c.meat_until) is not null and max(c.meat_until) >= current_date) as meat_active
from animals a
left join combined c on c.animal_id = a.id
group by a.id, a.tag_no;

-- ---------------------------------------------------------------------------
-- Journal 1: Veterinarinių vaistų ir veterinarinių preparatų apskaitos žurnalas
-- ---------------------------------------------------------------------------

create view vw_vet_drug_journal
with (security_invoker = true) as
select
  b.id as batch_id,
  p.id as product_id,
  p.name as product_name,
  p.category,
  p.registration_code,
  p.active_substance,
  p.unit,
  b.received_at::date as receipt_date,
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
where p.category <> 'biocide'
order by receipt_date desc;

-- ---------------------------------------------------------------------------
-- Journal 2: Gydomų gyvūnų žurnalas — one row per medication line (direct
-- treatment usage + administered course doses).
-- ---------------------------------------------------------------------------

create view vw_treated_animals
with (security_invoker = true) as
select
  t.id as treatment_id,
  t.reg_date,
  t.reg_date as used_on,
  a.id as animal_id,
  a.tag_no,
  a.animal_no,
  a.species,
  a.sex,
  a.breed,
  a.birth_date,
  t.animal_group_snapshot as animal_group,
  d.name as disease_name,
  t.diagnosis,
  ui.administration_route,
  p.name as product_name,
  b.lot as batch_number,
  ui.qty,
  ui.unit,
  t.withdrawal_until_meat,
  t.withdrawal_until_milk,
  t.outcome,
  t.outcome_date,
  t.vet_name
from treatments t
join animals a on a.id = t.animal_id
left join diseases d on d.id = t.disease_id
left join usage_items ui on ui.treatment_id = t.id
left join products p on p.id = ui.product_id
left join batches b on b.id = ui.batch_id
union all
select
  t.id as treatment_id,
  t.reg_date,
  coalesce(cd.administered_date, cd.scheduled_date) as used_on,
  a.id as animal_id,
  a.tag_no,
  a.animal_no,
  a.species,
  a.sex,
  a.breed,
  a.birth_date,
  t.animal_group_snapshot as animal_group,
  d.name as disease_name,
  t.diagnosis,
  ui.administration_route,
  p.name as product_name,
  b.lot as batch_number,
  ui.qty,
  ui.unit,
  t.withdrawal_until_meat,
  t.withdrawal_until_milk,
  t.outcome,
  t.outcome_date,
  t.vet_name
from treatments t
join animals a on a.id = t.animal_id
left join diseases d on d.id = t.disease_id
join treatment_courses tc on tc.treatment_id = t.id
join course_doses cd on cd.course_id = tc.id
join usage_items ui on ui.course_dose_id = cd.id
join products p on p.id = ui.product_id
left join batches b on b.id = ui.batch_id;

-- ---------------------------------------------------------------------------
-- Journal 3: Gydomų gyvūnų apskaita — one row per treatment case.
-- ---------------------------------------------------------------------------

create view vw_treated_animals_summary
with (security_invoker = true) as
select
  t.id as treatment_id,
  t.reg_date,
  a.id as animal_id,
  a.tag_no,
  a.animal_no,
  a.species,
  a.sex,
  a.breed,
  t.animal_group_snapshot as animal_group,
  d.name as disease_name,
  t.diagnosis,
  t.outcome,
  t.outcome_date,
  t.withdrawal_until_milk,
  t.withdrawal_until_meat,
  t.vet_name,
  (
    select string_agg(distinct p.name, ', ')
    from usage_items ui
    join products p on p.id = ui.product_id
    left join course_doses cd on cd.id = ui.course_dose_id
    left join treatment_courses tc on tc.id = cd.course_id
    where ui.treatment_id = t.id or tc.treatment_id = t.id
  ) as products_used,
  (select max(tc.days) from treatment_courses tc where tc.treatment_id = t.id) as course_days
from treatments t
join animals a on a.id = t.animal_id
left join diseases d on d.id = t.disease_id;

-- ---------------------------------------------------------------------------
-- Journal 4: Biocidinių produktų žurnalas
-- ---------------------------------------------------------------------------

create view vw_biocide_journal
with (security_invoker = true) as
select
  bu.id,
  p.name,
  p.registration_code,
  p.active_substance,
  p.unit,
  bu.use_date,
  bu.purpose,
  bu.work_scope,
  bu.qty,
  bu.used_by_name,
  b.lot as batch_number,
  b.expiry_date
from biocide_usage bu
join products p on p.id = bu.product_id
left join batches b on b.id = bu.batch_id;

-- ---------------------------------------------------------------------------
-- Journal 5: Veterinarinių medicininių atliekų žurnalas
-- ---------------------------------------------------------------------------

create view vw_medical_waste
with (security_invoker = true) as
select * from medical_waste;

-- ---------------------------------------------------------------------------
-- Journal 6: Antimikrobinių vaistų skyrimo ir sunaudojimo ataskaita — one
-- row per antimicrobial usage line; the app aggregates per product/period.
-- ---------------------------------------------------------------------------

create view vw_antimicrobial_usage
with (security_invoker = true) as
select
  u.used_on,
  u.source_kind,
  p.id as product_id,
  p.name,
  p.active_substance,
  u.qty,
  u.unit,
  u.administration_route,
  a.tag_no,
  a.animal_no,
  u.animal_group,
  t.diagnosis,
  t.vet_name
from vw_usage_items_detailed u
join products p on p.id = u.product_id and p.is_antimicrobial
left join animals a on a.id = u.animal_id
left join treatments t on t.id = u.treatment_id;

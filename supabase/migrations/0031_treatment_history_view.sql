-- 0031_treatment_history_view.sql
-- Gydymų istorija is now a card-per-treatment screen that shows the kind of
-- record (Gydymas / Profilaktika / Apžiūra / Sinchronizacija). Appends
-- procedure_type to vw_treated_animals (journal 2, 0005); every existing column
-- keeps its name and position, so the journal pages are unaffected.

create or replace view vw_treated_animals
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
  t.vet_name,
  t.procedure_type
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
  t.vet_name,
  t.procedure_type
from treatments t
join animals a on a.id = t.animal_id
left join diseases d on d.id = t.disease_id
join treatment_courses tc on tc.treatment_id = t.id
join course_doses cd on cd.course_id = tc.id
join usage_items ui on ui.course_dose_id = cd.id
join products p on p.id = ui.product_id
left join batches b on b.id = ui.batch_id;

notify pgrst, 'reload schema';

-- 0022_hoof_care_category.sql
-- New product type "Nagų priežiūra" (hoof blocks, bandages, bath chemicals).
-- A new enum value cannot be used in the transaction that adds it, so this
-- migration contains nothing else; the rest is in 0023.
alter type product_category add value if not exists 'hoof_care' before 'treatment_materials';

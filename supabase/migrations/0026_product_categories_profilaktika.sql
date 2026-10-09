-- 0026_product_categories_profilaktika.sql
-- Two new product types requested by the farm (2026-10): "Profilaktika" and
-- "Boliusai". The Profilaktika treatment (animal panel / visit card) lists only
-- products of these two types. A new enum value cannot be used in the
-- transaction that adds it, so this migration contains nothing else; the rules
-- that treat them as drugs are in 0027.
alter type product_category add value if not exists 'profilaktika' before 'treatment_materials';
alter type product_category add value if not exists 'boliusai' before 'treatment_materials';

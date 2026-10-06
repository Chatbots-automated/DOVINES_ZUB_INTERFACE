-- 0011_product_category_priedas.sql
-- Dovinės ŽŪB GVET PRO — "Veterinarinis priedas" product type (Calcitop,
-- Pectolit, Tympacalf...). The farm writes these off on their own act,
-- "Sunaudotų veterinarinių priedų panaudojimo aktas" (Priedas §2.9, farm
-- template supplied 2026-10). Kept alone in its own migration: a new enum
-- value can't be used in the transaction that adds it.

alter type product_category add value if not exists 'priedas' before 'treatment_materials';

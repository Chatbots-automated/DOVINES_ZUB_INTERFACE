-- TODO(discovery): replace with the real DelPro query once the DelPro database
-- schema has been inspected on the farm PC (`npm run discover`).
--
-- CONTRACT — the query must return exactly these column aliases (extra columns
-- are ignored, missing optional ones are fine):
--   delpro_animal_id  (text, required — DelPro's internal animal key)
--   animal_no         (text — the herd number the farm uses day to day)
--   tag_no            (text — official ear tag, LT...)
--   name              (text)
--   sex               (text — lifecycle category: Karvė / Telyčia / Bulius / Veršelis)
--   breed             (text)
--   birth_date        (date)
--   group_id          (text — DelPro group key)
--   group_name        (text)
--   lactation_no      (int)
--   active            (bit — 1 while the animal is in the herd)
-- OPTIONAL DairyPlan-style columns (Priedas §3.3 "kiti suderinti laukai") — shown on
-- the GVET animal card; omit any DelPro cannot supply, GVET keeps the old value:
--   reproduction_status     (text — cow state: Laktuojanti / Užtrūkusi / Apsėklinta / Veršinga...)
--   last_calving_date       (date)          days_in_milk          (int — laktacijos dienos)
--   milk_yield_kg           (decimal — average daily milk)
--   last_milking_at         (datetime)      last_milking_kg       (decimal)
--   produces_milk           (bit)           last_insemination_date (date)
--   insemination_count      (int)           last_bulls            (text, comma separated)
--   is_pregnant             (bit)           pregnancy_days        (int)
--   expected_calving_date   (date)          dry_off_date          (date)
--   genetic_worth           (text)          blood_line            (text)
--   missing_teats           (text — comma separated subset of FL,FR,HL,HR)
--   health_alert            (text — e.g. mastitas / DelPro attention flag)
--   group_since             (date — entered the current group)
-- The worker sends the FULL result as a herd snapshot: animals missing from it
-- are marked inactive in GVET PRO, so do not filter to a subset of the herd.
SELECT
  CAST(NULL AS nvarchar(50)) AS delpro_animal_id,
  CAST(NULL AS nvarchar(50)) AS animal_no,
  CAST(NULL AS nvarchar(50)) AS tag_no
WHERE 1 = 0;

-- TODO(discovery): read the record written by insert-treatment.sql back from
-- DelPro so GVET PRO can verify it (acceptance criterion Priedas §5.8).
-- Parameters: same as insert-treatment.sql (use @sync_id to find the row).
-- CONTRACT — return ONE row with aliases:
--   animal_no, event_date (date), diagnosis, treatment_code,
--   milk_withdrawal_days (int), meat_withdrawal_days (int)
SELECT CAST(NULL AS nvarchar(50)) AS animal_no WHERE 1 = 0;

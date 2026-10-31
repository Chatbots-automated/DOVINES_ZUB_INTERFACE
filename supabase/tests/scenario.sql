-- users
-- This scenario covers the approval + UI-script behaviour (0033/0034). 0044 switches the farm to
-- auto + gateway; that path is tested in delpro-worker/test/treatment-gateway.test.js.
update system_settings set setting_value = 'approval' where setting_key = 'delpro_outbound_mode';
update system_settings set setting_value = '10' where setting_key = 'delpro_auto_delay_minutes';
update system_settings set setting_value = 'ui_script' where setting_key = 'delpro_write_channel';
-- 0045's temporary admin gate is tested in its own block at the end.
update system_settings set setting_value = 'false' where setting_key = 'delpro_admin_approval_required';
insert into auth.users values ('00000000-0000-0000-0000-00000000000a','admin@x'),('00000000-0000-0000-0000-00000000000b','vet@x'),('00000000-0000-0000-0000-00000000000c','viewer@x');
insert into users (id,email,role) values ('00000000-0000-0000-0000-00000000000a','admin@x','admin'),('00000000-0000-0000-0000-00000000000b','vet@x','vet'),('00000000-0000-0000-0000-00000000000c','viewer@x','viewer');

-- 1. DelPro inbound as worker (service_role)
set role service_role;
select 'inbound' as step, upsert_animals_from_delpro('{"worker_id":"farm-pc","groups":[{"delpro_group_id":"1","name":"Melžiamos 1"},{"delpro_group_id":"2","name":"Užtrūkusios"}],
 "animals":[{"delpro_animal_id":"101","animal_no":"512","tag_no":"LT000000000512","sex":"Karvė","birth_date":"2021-03-14","group_id":"1","lactation_no":"3"},
            {"delpro_animal_id":"102","animal_no":"513","tag_no":"LT000000000513","sex":"Karvė","group_id":"1"},
            {"delpro_animal_id":"103","animal_no":"514","tag_no":"LT000000000514","sex":"Karvė","group_id":"2"},
            {"delpro_animal_id":"104","animal_no":"900","sex":"Veršelis","group_name":"Veršeliai"}]}'::jsonb) as r;
-- second run: 104 gone, 103 moved group; duplicate tag row gets skipped
select 'inbound2' as step, upsert_animals_from_delpro('{"animals":[{"delpro_animal_id":"101","animal_no":"512","tag_no":"LT000000000512","group_id":"1"},
            {"delpro_animal_id":"102","animal_no":"513","tag_no":"LT000000000513","group_id":"1"},
            {"delpro_animal_id":"103","animal_no":"514","tag_no":"LT000000000514","group_id":"1"},
            {"delpro_animal_id":"999","animal_no":"515","tag_no":"LT000000000512"}]}'::jsonb) as r;
reset role;
select 'animals' as step, animal_no, tag_no, group_name, active, source from animals order by animal_no;

-- 2. As vet: products + batches
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
insert into products (id,name,category,unit,withdrawal_days_milk,withdrawal_days_meat,withdrawal_im_milk,is_antimicrobial,package_weight_g) values
 ('11111111-0000-0000-0000-000000000001','Penicilinas','medicines','ml',4,10,6,true,50),
 ('11111111-0000-0000-0000-000000000002','Vakcina X','vakcina','dose',0,0,null,false,null),
 ('11111111-0000-0000-0000-000000000003','Dezinfektantas','biocide','l',0,0,null,false,null);
insert into batches (product_id,lot,expiry_date,received_qty,purchase_price) values
 ('11111111-0000-0000-0000-000000000001','A1','2027-01-01',30,1.00),
 ('11111111-0000-0000-0000-000000000001','A2','2026-12-01',20,2.00),
 ('11111111-0000-0000-0000-000000000001','OLD','2020-01-01',100,0.5),
 ('11111111-0000-0000-0000-000000000002','V1','2027-06-01',100,3.00),
 ('11111111-0000-0000-0000-000000000003','D1','2027-06-01',50,4.00);

-- 3. Treatment: 25 ml im today (FEFO: A2 20 + A1 5), 2-day course
select 'treatment' as step, create_treatment(jsonb_build_object(
  'animal_id',(select id from animals where animal_no='512'),'reg_date','2026-09-01','diagnosis','Mastitas kairė priekinė',
  'disease_id',(select id from diseases where name='Mastitas'),'vet_name','Dr. Test',
  'medications', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','qty',25,'unit','ml','administration_route','im')),
  'course_days', jsonb_build_array(
     jsonb_build_object('scheduled_date','2026-09-02','product_id','11111111-0000-0000-0000-000000000001','qty',10,'unit','ml','administration_route','im'),
     jsonb_build_object('scheduled_date','2026-09-03','product_id','11111111-0000-0000-0000-000000000001','qty',10,'unit','ml','administration_route','im')))) is not null as ok;
select 'withdrawal' as step, reg_date, withdrawal_until_milk, withdrawal_until_meat, animal_group_snapshot from treatments;
select 'stock_after_t' as step, lot, qty_left, status from batches where product_id='11111111-0000-0000-0000-000000000001' order by lot;

-- shortfall must roll back everything
do $$ declare blocked boolean := false; begin
  begin perform create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),
    'medications', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','qty',9999,'unit','ml')))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: shortfall ok'; end if;
end $$;
select 'assert' as step, 'shortfall ok' as what;
select 'treatments_count' as step, count(*) from treatments;

-- administer course doses
select administer_course_dose(id, scheduled_date) from course_doses order by day_number;
select administer_course_dose(id) from course_doses order by day_number; -- idempotent
select 'course' as step, status from treatment_courses;
select 'stock_after_course' as step, lot, qty_left, status from batches where product_id='11111111-0000-0000-0000-000000000001' order by lot;
select 'waste' as step, name, qty_generated from medical_waste;

-- apžiūra must not enqueue
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'procedure_type','apziura','reg_date','2026-09-05'));

-- 4. group vaccination + biocide
select 'vacc' as step, create_vaccinations(jsonb_build_object('animal_ids',(select jsonb_agg(id) from animals where group_name='Melžiamos 1' and active),
  'target_group_name','Melžiamos 1','product_id','11111111-0000-0000-0000-000000000002','dose_amount',2,'unit','dose','vaccination_date','2026-09-10','next_booster_date','2026-10-10'));
select 'bio' as step, create_biocide_usage('{"product_id":"11111111-0000-0000-0000-000000000003","qty":5,"unit":"l","use_date":"2026-09-12","purpose":"Tvartų dezinfekcija"}'::jsonb) is not null;

-- 5. DelPro approval (0006 + 0033): who may approve, and what blocks it
-- viewer cannot approve
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
do $$ declare blocked boolean := false; begin
  begin perform delpro_approve_jobs(array(select id from delpro_sync_jobs)); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: viewer approve blocked'; end if;
end $$;
select 'assert' as step, 'viewer approve blocked' as what;
do $$ declare blocked boolean := false; begin
  begin perform delpro_approve_treatment((select treatment_id from delpro_sync_jobs)); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: viewer approve_treatment blocked'; end if;
end $$;
select 'assert' as step, 'viewer approve_treatment blocked' as what;

-- vet: allowed role. No DelPro mapping is needed (names are the same as in GVET), but the fixture's
-- planned course days (10 ml) differ from day 1 (25 ml) and the UI script enters ONE dose
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select 'jobs' as step, status, preview_payload->'delpro'->>'milk_withdrawal_days' as milk_days, preview_payload->'delpro'->'products' as products from vw_delpro_sync_jobs;
do $$ declare r jsonb; codes text[]; begin
  r := delpro_approve_treatment((select treatment_id from delpro_sync_jobs));
  select array_agg(p->>'code') into codes from jsonb_array_elements(r->'problems') p;
  if (r->>'ok')::boolean or r->>'outcome' <> 'blocked' or codes <> array['course_variants'] then
    raise exception 'only the course dose variants should block (no mapping needed): %', r;
  end if;
  if (select status from delpro_sync_jobs) <> 'pending_approval' or (select approved_payload from delpro_sync_jobs) is not null then
    raise exception 'blocked approval must not change the job';
  end if;
  if delpro_approve_jobs(array(select id from delpro_sync_jobs)) <> 0 then raise exception 'bulk approve must skip the blocked job'; end if;
end $$;
select 'assert' as step, 'course dose variants block; mappings not required' as what;
-- a vet cannot write mappings (admin-write by RLS)
do $$ declare blocked boolean := false; begin
  begin insert into delpro_mappings(kind, local_id, delpro_code, delpro_name) values ('disease', gen_random_uuid(), '1', 'x'); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: vet writes mapping'; end if;
end $$;
select 'assert' as step, 'vet cannot write mappings' as what;
reset role;
-- the vet re-plans the course with the same dose every day
update course_doses set dose_amount = 25;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);

-- vet approves from the treatment screen; payload is frozen from the database, not from the client
select 'approved' as step, delpro_approve_treatment((select treatment_id from delpro_sync_jobs)) as r;
do $$ declare j delpro_sync_jobs%rowtype; u jsonb; begin
  select * into j from delpro_sync_jobs;
  u := j.approved_payload->'delpro'->'ui_entry';
  if j.status <> 'approved' or j.approved_by <> '00000000-0000-0000-0000-00000000000b' or j.approved_at is null then
    raise exception 'approval not recorded: %', to_jsonb(j);
  end if;
  if u->>'animal_number' <> '512' or u->>'diagnosis_name' <> 'Mastitas' or u->>'diagnosis_code' is not null
     or u->>'medicine_name' <> 'Penicilinas' or (u->>'dose')::numeric <> 25 or (u->>'course_days')::int <> 3
     or u->>'treatment_id' <> j.treatment_id::text or j.approved_payload->>'sync_id' <> j.id::text then
    raise exception 'unexpected ui_entry: %', u;
  end if;
end $$;
select 'assert' as step, 'approval frozen with ui_entry and approver' as what;

-- idempotent: a second click / bulk approve changes nothing and creates no second job
do $$ declare before jsonb; r jsonb; begin
  select to_jsonb(j) into before from delpro_sync_jobs j;
  r := delpro_approve_treatment((select treatment_id from delpro_sync_jobs));
  if r->>'outcome' <> 'already_approved' or not (r->>'ok')::boolean then raise exception 'second approval: %', r; end if;
  if delpro_approve_jobs(array(select id from delpro_sync_jobs)) <> 0 then raise exception 'bulk approve of approved job counted'; end if;
  if (select to_jsonb(j) from delpro_sync_jobs j) is distinct from before or (select count(*) from delpro_sync_jobs) <> 1 then
    raise exception 'duplicate approval changed the job';
  end if;
end $$;
select 'assert' as step, 'repeat approval is idempotent' as what;
reset role;
do $$ begin
  if (select count(*) from user_audit_logs where action = 'delpro_transfer_approved' and record_id = (select id from delpro_sync_jobs)
        and user_id = '00000000-0000-0000-0000-00000000000b') <> 1 then
    raise exception 'approval must be audited exactly once';
  end if;
end $$;
select 'assert' as step, 'approval audited once' as what;

-- 6. worker claims + reports
set role service_role;
select 'claim' as step, (delpro_claim_next_job('farm-pc'))->'animal'->>'animal_no' as animal_no;
select 'claim_empty' as step, delpro_claim_next_job('farm-pc') is null as empty;
select 'report' as step, (delpro_report_job_result(jsonb_build_object('sync_id',(select id from delpro_sync_jobs),'success',true,
  'actual_result', jsonb_build_object('animal_no','512','event_date','2026-09-01',
      'milk_withdrawal_days',(select (approved_payload->'delpro'->>'milk_withdrawal_days')::int from delpro_sync_jobs),
      'meat_withdrawal_days',(select (approved_payload->'delpro'->>'meat_withdrawal_days')::int from delpro_sync_jobs)))))->>'status' as status;
reset role;

-- 7. write-off acts (farm templates, 0012)
-- 7a. admin configures group rules + product act settings
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
insert into write_off_group_rules (write_off_group_id, match_field, match_value) values
  ((select id from write_off_groups where name='Melžiamos karvės'),'delpro_group','Melžiamos 1'),
  ((select id from write_off_groups where name='Karvės'),'delpro_group','Melžiamos 1'),
  ((select id from write_off_groups where name='Penimi gyvuliai'),'animal_sex','Veršelis');
update products set pack_size=50 where name='Penicilinas';
update products set default_write_off_group_id=(select id from write_off_groups where name='Melžiamos karvės') where name='Dezinfektantas';
-- vet cannot change group config
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare n int; begin
  update write_off_groups set name='x' where name='Karvės';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: vet edits groups'; end if;
end $$;
select 'assert' as step, 'vet group edit blocked' as what;

-- 7b. general usage (no animal) — needles counted on the shelf, a feed additive by quantity
insert into products (id,name,category,unit,nomenclature_no) values
 ('11111111-0000-0000-0000-000000000004','Adatos 18g','treatment_materials','pcs','3101'),
 ('11111111-0000-0000-0000-000000000005','Calcitop','priedas','vnt',null);
insert into batches (product_id,lot,expiry_date,received_qty,purchase_price) values
 ('11111111-0000-0000-0000-000000000004',null,null,100,0.5),
 ('11111111-0000-0000-0000-000000000005',null,'2027-01-01',20,2.916);
select 'general' as step, create_general_usage(jsonb_build_object('use_date','2026-09-30','items',jsonb_build_array(
  jsonb_build_object('product_id','11111111-0000-0000-0000-000000000004','remaining',96,'write_off_group_id',(select id from write_off_groups where name='Karvės')),
  jsonb_build_object('product_id','11111111-0000-0000-0000-000000000005','qty',2,'write_off_group_id',(select id from write_off_groups where name='Melžiamos karvės'))))) as n;
select 'general_rows' as step, p.name, g.qty, g.stock_before, g.counted_remaining from general_usage g join products p on p.id=g.product_id order by 2;
do $$ declare blocked boolean := false; begin
  begin perform create_general_usage(jsonb_build_object('items',jsonb_build_array(
    jsonb_build_object('product_id','11111111-0000-0000-0000-000000000004','remaining',500)))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: remaining above stock'; end if;
end $$;
select 'assert' as step, 'remaining above stock blocked' as what;

-- 7c. vaistai act: packages (Penicilinas 50 ml = 1 vnt), groups resolved by rules / product default
select 'act' as step, generate_write_off_act('{"act_kind":"vaistai","period_start":"2026-09-01","period_end":"2026-09-30"}'::jsonb) is not null;
select 'act_head' as step, act_number, act_kind, approver_name, signatories->1->>'name' as vet from write_off_acts;
select 'items' as step, line_no, product_name, unit, quantity, unit_price, total_price, lots from write_off_act_items order by line_no;
select 'alloc' as step, i.product_name, a.label, a.quantity, a.animal_count from write_off_act_allocations a join write_off_act_items i on i.id=a.item_id order by 2,3;
do $$ declare blocked boolean := false; begin
  begin perform generate_write_off_act('{"act_kind":"vaistai","period_start":"2026-09-01","period_end":"2026-09-30"}'::jsonb); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: double write-off blocked'; end if;
end $$;
select 'assert' as step, 'double write-off blocked' as what;
-- unbalanced approve must fail
update write_off_act_allocations set quantity = quantity - 0.1 where item_id=(select id from write_off_act_items where product_name='Penicilinas');
do $$ declare blocked boolean := false; begin
  begin perform approve_write_off_act((select id from write_off_acts)); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: unbalanced blocked'; end if;
end $$;
select 'assert' as step, 'unbalanced blocked' as what;
-- a group from another template is refused
do $$ declare blocked boolean := false; begin
  begin perform set_write_off_allocations((select id from write_off_act_items where product_name='Penicilinas'),
    jsonb_build_array(jsonb_build_object('write_off_group_id',(select id from write_off_groups where name='Karvės'),'quantity',0.9))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: wrong-template group'; end if;
end $$;
select 'assert' as step, 'wrong-template group blocked' as what;
-- split penicillin 0.8 / 0.1; blank and zero rows dropped
select set_write_off_allocations((select id from write_off_act_items where product_name='Penicilinas'), jsonb_build_array(
  jsonb_build_object('write_off_group_id',(select id from write_off_groups where name='Melžiamos karvės'),'quantity',0.8,'animal_count',1),
  jsonb_build_object('write_off_group_id',(select id from write_off_groups where name='Penimi gyvuliai'),'quantity',0.1),
  jsonb_build_object('write_off_group_id',(select id from write_off_groups where name='Penimi gyvuliai'),'quantity',0)));
select 'alloc_set' as step, a.label, a.quantity from write_off_act_allocations a join write_off_act_items i on i.id=a.item_id
  where i.product_name='Penicilinas' order by 2;
-- quantity left "Nepriskirta" blocks approval even when balanced
select set_write_off_allocations((select id from write_off_act_items where product_name='Vakcina X'), '[{"write_off_group_id":"","quantity":6}]'::jsonb);
do $$ declare blocked boolean := false; begin
  begin perform approve_write_off_act((select id from write_off_acts)); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: unassigned blocked'; end if;
end $$;
select 'assert' as step, 'unassigned blocked' as what;
select set_write_off_allocations((select id from write_off_act_items where product_name='Vakcina X'),
  jsonb_build_array(jsonb_build_object('write_off_group_id',(select id from write_off_groups where name='Melžiamos karvės'),'quantity',6)));
select approve_write_off_act((select id from write_off_acts));
select 'act_status' as step, act_number, status, total_amount from write_off_acts;
do $$ declare blocked boolean := false; begin
  begin update write_off_act_allocations set quantity=0; exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: locked ok'; end if;
end $$;
select 'assert' as step, 'locked ok' as what;
select cancel_write_off_act((select id from write_off_acts));
select 'regen' as step, generate_write_off_act('{"act_kind":"vaistai","period_start":"2026-09-01","period_end":"2026-09-30"}'::jsonb) is not null;

-- 7d. priedai + medžiagos acts; numbers continue YYYYMMNN across templates
select 'priedai' as step, generate_write_off_act('{"act_kind":"priedai","period_start":"2026-09-01","period_end":"2026-09-30"}'::jsonb) is not null;
select 'medziagos' as step, generate_write_off_act('{"act_kind":"medziagos","period_start":"2026-09-01","period_end":"2026-09-30"}'::jsonb) is not null;
select 'acts' as step, act_number, act_kind, status, account_no, expense_object from write_off_acts order by act_number;
select 'kind_items' as step, w.act_kind, i.nomenclature_no, i.product_name, i.quantity, i.unit_price, a.label
  from write_off_act_items i join write_off_acts w on w.id=i.act_id join write_off_act_allocations a on a.item_id=i.id
  where w.act_kind in ('priedai','medziagos') order by 2,4;
-- a written-off general usage row can't be deleted
do $$ declare blocked boolean := false; begin
  begin delete from general_usage where product_id='11111111-0000-0000-0000-000000000004'; exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: written-off general usage delete'; end if;
end $$;
select 'assert' as step, 'general usage delete guarded' as what;
reset role;

-- 7e. VIC credentials: admin-only, password never readable from the app
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare blocked boolean := false; begin
  begin perform vic_save_credentials('seklinimas','vet','pw',true); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: vet saves VIC'; end if;
end $$;
select 'assert' as step, 'vet VIC blocked' as what;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select vic_save_credentials('seklinimas','dovine','slapta1',true);
select vic_save_credentials('seklinimas','dovine2','',false);
select vic_save_credentials('veterinaras','vetas','vetslapta',true);
select 'vic' as step, vic_username, password_set, is_active from vic_get_settings('seklinimas');
select 'vic_vet' as step, vic_username, password_set, is_active from vic_get_settings('veterinaras');
select 'vic_direct' as step, count(*) as visible_rows from vic_credentials;
reset role;
select 'vic_stored' as step, kind, vic_username, vic_password from vic_credentials order by kind;

-- 8. viewer cannot write
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
do $$ declare blocked boolean := false; begin
  begin insert into diseases(name) values ('hack'); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: viewer blocked'; end if;
end $$;
select 'assert' as step, 'viewer blocked' as what;
select 'journals' as step,
  (select count(*) from vw_vet_drug_journal) drug, (select count(*) from vw_treated_animals) treated,
  (select count(*) from vw_treated_animals_summary) summary, (select count(*) from vw_biocide_journal) bio,
  (select count(*) from vw_medical_waste) waste, (select count(*) from vw_antimicrobial_usage) amr,
  (select count(*) from vw_withdrawal_status where milk_active or meat_active) wd;
reset role;

-- 10. auto mode: a fresh gydymas becomes claimable only after the settle delay
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
update system_settings set setting_value='auto' where setting_key='delpro_outbound_mode';
-- auto mode: nothing is claimed before the settle delay
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'reg_date','2026-09-20','diagnosis','Endometritas',
  'disease_id',(select id from diseases where name='Endometritas'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','qty',2,'unit','ml'))));
reset role;
set role service_role;
select 'auto_too_early' as step, delpro_claim_next_job('farm-pc') is null as empty;
reset role;
update delpro_sync_jobs set created_at = now() - interval '20 minutes' where status='pending_approval';
set role service_role;
select 'auto_claim' as step, (delpro_claim_next_job('farm-pc'))->'delpro'->>'diagnosis' as diagnosis;
-- DelPro saved the wrong withdrawal -> verification_failed
select 'mismatch' as step, (delpro_report_job_result(jsonb_build_object('sync_id',(select id from delpro_sync_jobs where status='processing'),'success',true,
  'actual_result', jsonb_build_object('animal_no','513','event_date','2026-09-20','milk_withdrawal_days',0,'meat_withdrawal_days',0))))->>'status' as status;
reset role;
select 'auto_flag' as step, auto_approved, verified from delpro_sync_jobs where status='verification_failed';

-- 11. admin retry puts it back in the queue, stale processing jobs are released
set role authenticated;
select delpro_retry_job((select id from delpro_sync_jobs where status='verification_failed'), true);
reset role;
select 'retried' as step, j.status from delpro_sync_jobs j join treatments t on t.id=j.treatment_id where t.diagnosis='Endometritas';
set role service_role;
select 'reclaim' as step, delpro_claim_next_job('farm-pc') is not null as claimed;
reset role;
update delpro_sync_jobs set started_at = now() - interval '1 hour' where status='processing';
set role service_role;
select 'released' as step, delpro_release_stale_jobs() as n;
reset role;
select 'after_release' as step, status from delpro_sync_jobs j join treatments t on t.id=j.treatment_id where t.diagnosis='Endometritas';

-- 12. VIC animal sync (0014): enrich-only for existing tags, insert unknown, never touches DelPro group/active
set role service_role;
do $$ declare blocked boolean := false; begin
  begin perform upsert_animals_from_vic('[]'::jsonb); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: empty VIC snapshot'; end if;
end $$;
select 'assert' as step, 'empty VIC snapshot blocked' as what;
select 'vic_sync1' as step, upsert_animals_from_vic('[
  {"tag_no":"lt 000000000512","breed":"Holšteinas","sex":"Telyčia","birth_date":"1999-01-01"},
  {"tag_no":"LT000000000999","sex":"Karvė","breed":"Holšteinas","birth_date":"2022-05-05"},
  {"tag_no":"LT000000000888","sex":"Karvė"},
  {"tag_no":""}]'::jsonb) as r;
reset role;
select 'vic_animals' as step, tag_no, source, sex, breed, birth_date, active, group_name, updated_from_vic_at is not null as stamped
  from animals where tag_no in ('LT000000000512','LT000000000999') order by tag_no;
set role service_role;
-- snapshot without 999 and 888: only the source='vic' animals go inactive
select 'vic_sync2' as step, upsert_animals_from_vic('{"animals":[{"tag_no":"LT000000000512"}],"full_snapshot":true}'::jsonb) as r;
-- DelPro later claims a VIC-created animal (tag fallback) and takes it over
select 'adopt' as step, (upsert_animals_from_delpro('{"full_snapshot":false,"animals":[{"delpro_animal_id":"777","animal_no":"777","tag_no":"LT000000000999","group_name":"Melžiamos 1"}]}'::jsonb))->>'updated' as updated;
reset role;
select 'vic_after' as step, tag_no, source, active, group_name from animals where tag_no in ('LT000000000999','LT000000000888','LT000000000512') order by tag_no;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$ declare blocked boolean := false; begin
  begin perform upsert_animals_from_vic('[{"tag_no":"X"}]'::jsonb); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: app calls VIC upsert'; end if;
end $$;
select 'assert' as step, 'app cannot call VIC upsert' as what;
select vic_save_credentials('seklinimas','dovine2','',true,'LT123456');
select 'vic_settings' as step, vic_farm_code, password_set, last_error from vic_get_settings('seklinimas');
-- 0040: farm identity for the import; n8n gets exactly the VIC request, never "[undefined]"
reset role;
set role service_role;
do $$ declare blocked boolean := false; begin
  begin perform vic_import_request('{}'::jsonb); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: VIC request without farm id/name/code'; end if;
end $$;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select vic_save_credentials('veterinaras','vetas','',true,null,'bandymas-pakeisti','KT Dovinės ŽŪB','300000000');
do $$ declare blocked boolean := false; begin
  begin perform vic_import_request('{}'::jsonb); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: the app calling vic_import_request'; end if;
end $$;
select 'vic_farm' as step, vic_farm_id, vic_farm_name, vic_client_personal_code, password_set from vic_get_settings('veterinaras');
reset role;
set role service_role;
select 'vic_request' as step, vic_import_request('{"search_date":"2026-10-30"}'::jsonb) as r;
do $$ begin
  if vic_import_request('{"search_date":"2026-10-30"}'::jsonb) <> jsonb_build_object(
       'vet', '{"vic_username":"vetas","vic_password":"vetslapta"}'::jsonb, 'search_date', '2026-10-30',
       'farm', jsonb_build_object('id', (select setting_value from system_settings where setting_key = 'vic_farm_id'),
                                  'name', 'KT Dovinės ŽŪB', 'client_personal_code', '300000000')) then
    raise exception 'vic_import_request shape wrong (farm id must be GVET''s own, never the typed value)';
  end if;
  if (select setting_value from system_settings where setting_key = 'vic_farm_id') !~ '^[0-9a-f-]{36}$' then
    raise exception 'vic_farm_id must be a generated uuid';
  end if;
end $$;
-- 0041: the scraper posts animals back; every body shape, other farms skipped, never a full snapshot unless asked
select set_config('t.farm', (select setting_value from system_settings where setting_key = 'vic_farm_id'), false);
select 'vic_client_array' as step, upsert_animals_for_client(jsonb_build_array(
  jsonb_build_object('tag_no', 'LT 0000 0000 7001', 'farm_id', current_setting('t.farm'), 'sex', 'Karvė', 'breed', 'Holšteinas', 'birth_date', '2023-01-02'),
  jsonb_build_object('tag_no', 'LT000000007002', 'farm_id', '11111111-1111-1111-1111-111111111111', 'sex', 'Telyčaitė'))) as r;
select 'vic_client_rows' as step, upsert_animals_for_client(jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('tag_no', 'LT000000007003')))) as r;
select 'vic_client_single' as step, upsert_animals_for_client('{"tag_no":"LT000000007001","breed":"Kita veislė"}'::jsonb) as r;
select 'vic_client_empty' as step, upsert_animals_for_client('[]'::jsonb) as r;
do $$ declare blocked boolean := false; begin
  begin perform upsert_animals_for_client('{"rows":[],"full_snapshot":true}'::jsonb); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: empty full snapshot'; end if;
end $$;
reset role;
do $$ begin
  if not exists (select 1 from animals where tag_no = 'LT000000007001' and source = 'vic' and breed = 'Holšteinas' and birth_date = '2023-01-02')
     or not exists (select 1 from animals where tag_no = 'LT000000007003' and active) then
    raise exception 'VIC client rows not stored (or breed overwritten instead of enriched)';
  end if;
  if exists (select 1 from animals where tag_no = 'LT000000007002') then
    raise exception 'another farm''s animal must never be stored';
  end if;
  if not (select active from animals where tag_no = 'LT000000007003') or not (select active from animals where tag_no = 'LT000000007001') then
    raise exception 'a partial post must not deactivate anything';
  end if;
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$ declare blocked boolean := false; begin
  begin perform upsert_animals_for_client('[{"tag_no":"LT000000007009"}]'::jsonb); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: the app calling upsert_animals_for_client'; end if;
end $$;
reset role;
set role service_role;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
reset role;

-- 13. receive_invoice (0015): atomic, duplicate-safe, pack size x count, journals
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select 'recv_pdf' as step, receive_invoice(jsonb_build_object('mode','pdf','pdf_filename','a.pdf',
  'supplier', jsonb_build_object('name','UAB Vetpharma','code','123','vat_code','LT999'),
  'invoice', jsonb_build_object('number','VP-001','date','2026-09-10','total_net',130),
  'items', jsonb_build_array(
    jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','description','Penicilinas 100ml','sku','P1','package_size',100,'package_count',6,'qty',6,'line_total',120,'lot','X1','expiry_date','2030-01-01'),
    jsonb_build_object('product_id','11111111-0000-0000-0000-000000000004','description','Adatos','qty',50,'line_total',10)))) as r;
select 'recv_batches' as step, p.name, b.received_qty, b.purchase_price, b.package_size, b.package_count, b.lot, b.supplier_id is not null as has_supplier, b.invoice_id is not null as has_invoice
  from batches b join invoices i on i.id=b.invoice_id join products p on p.id=b.product_id where i.invoice_number='VP-001' order by 2;
do $$ declare blocked boolean := false; begin
  begin perform receive_invoice(jsonb_build_object('mode','pdf','supplier',jsonb_build_object('name','uab vetpharma'),'invoice',jsonb_build_object('number','VP-001'),
    'items',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000004','qty',1,'line_total',1)))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: duplicate invoice'; end if;
end $$;
select 'assert' as step, 'duplicate invoice blocked' as what;
-- second line lacks a lot -> whole receive rolls back, no orphan invoice/batch/supplier
do $$ declare blocked boolean := false; begin
  begin perform receive_invoice(jsonb_build_object('mode','pdf','supplier',jsonb_build_object('name','Nauja UAB'),'invoice',jsonb_build_object('number','VP-002'),
    'items',jsonb_build_array(
      jsonb_build_object('product_id','11111111-0000-0000-0000-000000000004','qty',5,'line_total',5),
      jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','qty',5,'line_total',5)))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: missing lot'; end if;
end $$;
select 'assert' as step, 'missing lot blocked' as what;
select 'rollback' as step, (select count(*) from invoices where invoice_number='VP-002') as inv,
  (select count(*) from suppliers where name='Nauja UAB') as sup, (select count(*) from suppliers where lower(name)='uab vetpharma') as vetpharma;
do $$ declare blocked boolean := false; begin
  begin perform receive_invoice(jsonb_build_object('mode','pdf','invoice',jsonb_build_object('number','VP-003'),
    'items',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','qty',5,'line_total',5,'lot','Z','expiry_date','2020-01-01')))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: expired'; end if;
end $$;
select 'assert' as step, 'expired blocked' as what;
-- manual: same number twice appends to one invoice
select receive_invoice(jsonb_build_object('mode','manual','invoice',jsonb_build_object('number','M-1'),
  'items',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000004','qty',5,'unit_price',0.5))));
select receive_invoice(jsonb_build_object('mode','manual','invoice',jsonb_build_object('number','M-1'),
  'items',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000004','qty',7,'unit_price',0.5))));
select 'manual' as step, (select count(*) from invoices where invoice_number='M-1') as invoices,
  (select count(*) from invoice_items ii join invoices i on i.id=ii.invoice_id where i.invoice_number='M-1') as lines,
  (select max(line_no) from invoice_items ii join invoices i on i.id=ii.invoice_id where i.invoice_number='M-1') as max_line;
-- journals: drugs only, dated by invoice
select 'journal' as step, product_name, receipt_date, invoice_number, supplier_name from vw_vet_drug_journal where invoice_number='VP-001';
select 'journal_excl' as step, count(*) as needles from vw_vet_drug_journal where product_name='Adatos 18g';
-- delete: allowed while unused, refused once used
select receive_invoice(jsonb_build_object('mode','pdf','invoice',jsonb_build_object('number','B-1'),
  'items',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000003','qty',10,'line_total',40,'lot','D2','expiry_date','2027-01-01'))));
select delete_invoice((select id from invoices where invoice_number='M-1'));
select 'deleted' as step, (select count(*) from invoices where invoice_number='M-1') as inv, (select count(*) from batches where invoice_id is null and received_qty in (5,7)) as stray;
select create_biocide_usage('{"product_id":"11111111-0000-0000-0000-000000000003","qty":1,"unit":"l","purpose":"x"}'::jsonb);
do $$ declare blocked boolean := false; begin
  begin perform delete_invoice((select id from invoices where invoice_number='B-1')); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: delete used invoice'; end if;
end $$;
select 'assert' as step, 'delete used invoice blocked' as what;
select 'bio_recv' as step, name, invoice_number, quantity_remaining from vw_biocide_receiving_journal where invoice_number='B-1';
reset role;

-- 9. Nagų sveikata (0019): visit + findings + FEFO stock in one transaction
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
insert into products (id,name,category,unit) values ('11111111-0000-0000-0000-0000000000b1','Nagų purškalas','treatment_materials','ml');
insert into batches (product_id,lot,expiry_date,received_qty,purchase_price) values ('11111111-0000-0000-0000-0000000000b1','H1','2027-06-01',100,0.10);
select 'hoof_exam' as step, create_hoof_exam(jsonb_build_object(
  'animal_id',(select id from animals where animal_no='512'),'exam_date','2026-10-05','performed_by','Kalvis',
  'findings', jsonb_build_array(
    jsonb_build_object('leg','FL','zones','[{"zone":4,"claw":"inner"},{"zone":5,"claw":"inner"}]'::jsonb,'condition_code','DD','severity',3,
      'was_trimmed',true,'was_treated',true,'followup_required',true,'followup_date','2026-10-19',
      'products',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000b1','qty',30,'unit','ml'))),
    jsonb_build_object('leg','HR','zones','[{"zone":2,"claw":"outer"}]'::jsonb,'condition_code','SU','severity',2,'was_trimmed',true)))) is not null as ok;
select 'hoof_exam_ok' as step, create_hoof_exam(jsonb_build_object(
  'animal_id',(select id from animals where animal_no='513'),'exam_date','2026-10-05',
  'findings', jsonb_build_array(jsonb_build_object('condition_code','OK')))) is not null as ok;
select 'hoof_counts' as step, (select count(*) from hoof_exams) as exams, (select count(*) from hoof_findings) as findings,
  (select count(*) from hoof_findings where followup_required and not followup_completed) as open_followups;
select 'hoof_stock' as step, qty_left from batches where lot='H1';
select 'hoof_usage' as step, source_kind, used_on, animal_group, qty, hoof_finding_id is not null as linked from vw_usage_items_detailed where source_kind='hoof';
-- shortfall rolls back the whole visit (exam + findings + earlier products)
do $$ declare blocked boolean := false; begin
  begin perform create_hoof_exam(jsonb_build_object('animal_id',(select id from animals where animal_no='512'),
    'findings', jsonb_build_array(jsonb_build_object('leg','FR','zones','[{"zone":1,"claw":"inner"}]'::jsonb,'condition_code','DD',
      'products',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000b1','qty',5),
                                   jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000b1','qty',9999)))))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: hoof shortfall'; end if;
end $$;
select 'assert' as step, 'hoof shortfall blocked' as what;
select 'hoof_after_shortfall' as step, (select count(*) from hoof_exams) as exams, (select qty_left from batches where lot='H1') as stock;
-- validation: leg/zones required, follow-up needs a date
do $$ declare blocked boolean := false; begin
  begin perform create_hoof_exam(jsonb_build_object('animal_id',(select id from animals where animal_no='512'),
    'findings', jsonb_build_array(jsonb_build_object('condition_code','DD')))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: hoof no zones'; end if;
end $$;
select 'assert' as step, 'hoof no zones blocked' as what;
do $$ declare blocked boolean := false; begin
  begin perform create_hoof_exam(jsonb_build_object('animal_id',(select id from animals where animal_no='512'),
    'findings', jsonb_build_array(jsonb_build_object('leg','FL','zones','[{"zone":1,"claw":"inner"}]'::jsonb,'followup_required',true)))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: hoof followup without date'; end if;
end $$;
select 'assert' as step, 'hoof followup without date blocked' as what;
-- deleting an exam returns stock
select create_hoof_exam(jsonb_build_object('animal_id',(select id from animals where animal_no='514'),'exam_date','2026-10-05',
  'findings', jsonb_build_array(jsonb_build_object('leg','HL','zones','[{"zone":3,"claw":"inner"}]'::jsonb,'condition_code','WLD',
    'products',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000b1','qty',10)))))) is not null as ok;
select 'hoof_stock_before_delete' as step, qty_left from batches where lot='H1';
delete from hoof_exams where animal_id=(select id from animals where animal_no='514');
select 'hoof_stock_after_delete' as step, qty_left from batches where lot='H1';
-- viewer cannot record
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
do $$ declare blocked boolean := false; begin
  begin perform create_hoof_exam(jsonb_build_object('animal_id',(select id from animals where animal_no='512'),
    'findings', jsonb_build_array(jsonb_build_object('condition_code','OK')))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: viewer hoof'; end if;
end $$;
select 'assert' as step, 'viewer hoof blocked' as what;
select 'viewer_reads_hoof' as step, count(*) from hoof_exams;
-- written-off hoof usage pins the exam (medziagos act picks up the spray)
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select 'hoof_act' as step, generate_write_off_act('{"act_kind":"medziagos","period_start":"2026-10-01","period_end":"2026-10-31"}'::jsonb) is not null;
select 'hoof_act_items' as step, i.product_name, i.quantity, a.label, a.animal_count from write_off_act_items i join write_off_act_allocations a on a.item_id=i.id where i.product_name='Nagų purškalas';
do $$ declare blocked boolean := false; begin
  begin delete from hoof_exams where animal_id=(select id from animals where animal_no='512'); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: delete written-off hoof exam'; end if;
end $$;
select 'assert' as step, 'delete written-off hoof exam blocked' as what;
reset role;

-- 17. Sėklinimas (0017): semen + gloves FEFO, numbering, pregnancy, write-off, RLS
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
insert into products (id,name,category,unit) values
 ('11111111-0000-0000-0000-0000000000a1','Bulius Test 123','reproduction','dose'),
 ('11111111-0000-0000-0000-0000000000a2','Pirštinės sėkl.','treatment_materials','vnt');
insert into batches (product_id,lot,expiry_date,received_qty,purchase_price) values
 ('11111111-0000-0000-0000-0000000000a1','S1','2027-06-01',3,10.00),
 ('11111111-0000-0000-0000-0000000000a2','G1','2027-06-01',50,0.10);
select 'ins1' as step, create_insemination(jsonb_build_object(
  'animal_id',(select id from animals where animal_no='512'),'insemination_date','2026-09-10',
  'sperm_product_id','11111111-0000-0000-0000-0000000000a1','glove_product_id','11111111-0000-0000-0000-0000000000a2',
  'seklintojo_kodas','ab12','reproduktoriaus_id','577128831','reproduktoriaus_kk_kodas','0')) is not null as ok;
select 'ins2' as step, create_insemination(jsonb_build_object(
  'animal_id',(select id from animals where animal_no='513'),'insemination_date','2026-09-11',
  'sperm_product_id','11111111-0000-0000-0000-0000000000a1','sperm_quantity',1,'seklintojo_kodas','AB12')) is not null as ok;
select 'ins_rows' as step, pazymejimo_nr, seklintojo_kodas, karves_id, animal_group_snapshot, sperm_quantity, glove_quantity, pregnancy_confirmed
  from insemination_records order by insemination_date;
select 'ins_stock' as step, p.name, b.qty_left from batches b join products p on p.id=b.product_id where p.id in ('11111111-0000-0000-0000-0000000000a1','11111111-0000-0000-0000-0000000000a2') order by p.name;
select 'ins_ledger' as step, source_kind, qty, animal_group, used_on from vw_usage_items_detailed where insemination_id is not null order by used_on, qty;
-- shortfall (1 straw left, ask 5) rolls everything back, incl. the record
do $$ declare blocked boolean := false; begin
  begin perform create_insemination(jsonb_build_object('animal_id',(select id from animals where animal_no='514'),
    'sperm_product_id','11111111-0000-0000-0000-0000000000a1','sperm_quantity',5,'seklintojo_kodas','AB12')); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: insemination shortfall'; end if;
end $$;
select 'assert' as step, 'insemination shortfall blocked' as what;
select 'ins_count' as step, count(*) as records, (select qty_left from batches where lot='S1') as straws_left from insemination_records;
do $$ declare blocked boolean := false; begin
  begin perform create_insemination('{"seklintojo_kodas":"AB12"}'::jsonb); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: insemination without animal'; end if;
end $$;
select 'assert' as step, 'insemination without animal blocked' as what;
-- pregnancy result (plain update, no stock involved)
update insemination_records set pregnancy_confirmed = true, pregnancy_check_date = '2026-10-12'
  where pazymejimo_nr = (select min(pazymejimo_nr) from insemination_records);
select 'preg' as step, pazymejimo_nr, pregnancy_confirmed, insemination_date + 283 as expected_calving from insemination_records order by pazymejimo_nr;
-- write-off: semen lands on a vaistai act, grouped by the frozen DelPro group
select 'ins_act' as step, generate_write_off_act(jsonb_build_object('act_kind','vaistai','period_start','2026-09-10','period_end','2026-09-11')) is not null as ok;
select 'ins_act_items' as step, i.product_name, i.quantity from write_off_act_items i where i.product_id='11111111-0000-0000-0000-0000000000a1';
do $$ declare blocked boolean := false; begin
  begin delete from insemination_records where pazymejimo_nr = (select min(pazymejimo_nr) from insemination_records); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: delete written-off insemination'; end if;
end $$;
select 'assert' as step, 'delete written-off insemination blocked' as what;
-- RLS: viewer reads but can't write
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
select 'ins_viewer_reads' as step, count(*) from insemination_records;
do $$ declare blocked boolean := false; begin
  begin perform create_insemination(jsonb_build_object('animal_id',(select id from animals where animal_no='514'))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: viewer insemination'; end if;
end $$;
select 'assert' as step, 'viewer cannot inseminate' as what;
reset role;

-- 14. Vizitai (0018): visit scheduling + stock-consuming records linked atomically
-- (clean slate: the course-day visits that 0035 created for earlier treatments are covered by their own block at the end)
reset role;
delete from animal_visits;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select 'visit' as step, create_visit(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),
  'visit_datetime','2026-10-10T09:00:00Z','procedures',jsonb_build_array('gydymas','vakcina'),'vet_name','Dr. Test',
  'next_visit_required',true,'next_visit_date','2026-10-17')) is not null as ok;
select 'visit_rows' as step, status, procedures, next_visit_required, related_visit_id is not null as is_followup, visit_datetime
  from animal_visits order by visit_datetime;
do $$ declare blocked boolean := false; begin
  begin perform create_visit(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'procedures','[]'::jsonb)); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: visit without procedures'; end if;
end $$;
select 'assert' as step, 'visit without procedures blocked' as what;
do $$ declare blocked boolean := false; begin
  begin perform create_visit(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'procedures',jsonb_build_array('nagai'))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: out-of-scope procedure'; end if;
end $$;
select 'assert' as step, 'out-of-scope procedure blocked' as what;
-- treatment shortfall: no record, no link, status untouched
do $$ declare blocked boolean := false; v uuid := (select id from animal_visits where related_visit_id is null); begin
  begin perform create_treatment_for_visit(v, jsonb_build_object('medications',
    jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','qty',99999,'unit','ml')))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: visit treatment shortfall'; end if;
end $$;
select 'assert' as step, 'visit treatment shortfall blocked' as what;
select 'after_shortfall' as step, (select count(*) from treatments where visit_id is not null) as linked,
  (select status from animal_visits where related_visit_id is null) as status;
-- treatment for the visit: animal forced from the visit, FEFO consumed, visit -> vykdomas (vakcina still open)
select create_treatment_for_visit((select id from animal_visits where related_visit_id is null), jsonb_build_object(
  'animal_id',(select id from animals where animal_no='512'),'reg_date','2026-10-10','diagnosis','Šlubavimas',
  'medications', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','qty',1,'unit','ml','administration_route','im')))) is not null as ok;
select 'visit_treatment' as step, a.animal_no, t.procedure_type, t.visit_id is not null as linked,
  (select count(*) from usage_items ui where ui.treatment_id = t.id) as usage_rows,
  (select status from animal_visits where id = t.visit_id) as visit_status
  from treatments t join animals a on a.id = t.animal_id where t.visit_id is not null;
-- vaccination for the visit closes it
select 'visit_vacc' as step, create_vaccination_for_visit((select id from animal_visits where related_visit_id is null),
  jsonb_build_object('product_id','11111111-0000-0000-0000-000000000002','vaccination_date','2026-10-10','dose_amount',2,'unit','dose')) as n;
select 'visit_done' as step, status, (select count(*) from vaccinations where visit_id = animal_visits.id) as vacc,
  (select animal_no from animals a join vaccinations v on v.animal_id = a.id where v.visit_id = animal_visits.id) as vacc_animal
  from animal_visits where related_visit_id is null;
-- cancelled visits take no records
update animal_visits set status = 'atsauktas' where related_visit_id is not null;
do $$ declare blocked boolean := false; begin
  begin perform create_treatment_for_visit((select id from animal_visits where related_visit_id is not null), '{}'::jsonb); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: cancelled visit record'; end if;
end $$;
select 'assert' as step, 'cancelled visit blocked' as what;
-- deleting a visit keeps the clinical records
delete from animal_visits where related_visit_id is null;
select 'visit_deleted' as step, (select count(*) from treatments where diagnosis = 'Šlubavimas') as treatment_kept,
  (select count(*) from vaccinations where vaccination_date = '2026-10-10') as vacc_kept, (select count(*) from treatments where visit_id is not null) as still_linked,
  (select count(*) from animal_visits) as visits_left, (select count(*) from animal_visits where related_visit_id is not null) as dangling;
-- viewer: read-only
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
select 'viewer_reads_visits' as step, count(*) from animal_visits;
do $$ declare blocked boolean := false; begin
  begin perform create_visit(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'procedures',jsonb_build_array('apziura'))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: viewer creates visit'; end if;
end $$;
select 'assert' as step, 'viewer cannot create visit' as what;
reset role;

-- 0021: multi-product course days + karencija from the course's last day
select 'course2_create' as step, create_treatment(jsonb_build_object(
  'animal_id',(select id from animals where animal_no='513'),'reg_date','2026-09-10','diagnosis','Kurso planas',
  'medications', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','qty',5,'unit','ml','administration_route','im')),
  'course_days', jsonb_build_array(
     jsonb_build_object('day_number',2,'scheduled_date','2026-09-12','product_id','11111111-0000-0000-0000-000000000001','qty',1,'unit','ml','administration_route','im'),
     jsonb_build_object('day_number',2,'scheduled_date','2026-09-12','product_id','11111111-0000-0000-0000-000000000002','qty',1,'unit','dose','administration_route','sc'),
     jsonb_build_object('day_number',3,'scheduled_date','2026-09-14','product_id','11111111-0000-0000-0000-000000000001','qty',1,'unit','ml','administration_route','im')))) is not null as ok;
select 'course2_days' as step, tc.days, count(cd.id) as doses, count(distinct cd.day_number) as distinct_days
from treatment_courses tc join course_doses cd on cd.course_id = tc.id
join treatments t on t.id = tc.treatment_id where t.diagnosis = 'Kurso planas' group by tc.days;
do $$ declare v_days integer; v_milk date; v_expected date; begin
  select tc.days into v_days from treatment_courses tc join treatments t on t.id = tc.treatment_id where t.diagnosis = 'Kurso planas';
  if v_days is distinct from 3 then raise exception 'course days expected 3, got %', v_days; end if;
  select withdrawal_until_milk into v_milk from treatments where diagnosis = 'Kurso planas';
  v_expected := date '2026-09-14' + fn_route_withdrawal_days('11111111-0000-0000-0000-000000000001', 'im', 'milk') + 1;
  if v_milk is distinct from v_expected then raise exception 'karencija expected %, got %', v_expected, v_milk; end if;
end $$;
select 'assert' as step, 'course last-day karencija ok' as what;
do $$ declare blocked boolean := false; begin
  begin perform create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),
    'course_days', jsonb_build_array(jsonb_build_object('day_number',1,'scheduled_date','2026-09-10','product_id','11111111-0000-0000-0000-000000000001','qty',1,'unit','ml')))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: day_number 1 rejected'; end if;
end $$;
select 'assert' as step, 'day_number 1 rejected' as what;

-- 0020: DairyPlan-style DelPro fields on animals
reset role;
set role service_role;
select 'dp_fields1' as step, upsert_animals_from_delpro('{"full_snapshot":false,"animals":[{"delpro_animal_id":"101","animal_no":"512","tag_no":"LT000000000512",
  "reproduction_status":"Veršinga","last_calving_date":"2026-01-05","days_in_milk":"250","milk_yield_kg":"31,4","last_milking_at":"2026-10-05T06:30:00Z","last_milking_kg":"12.1",
  "produces_milk":true,"last_insemination_date":"2026-03-01","insemination_count":2,"last_bulls":"Atlas, Zeus","is_pregnant":true,"pregnancy_days":"200",
  "expected_calving_date":"2026-12-10","dry_off_date":"2026-10-15","genetic_worth":"+120","blood_line":"HOL-1","missing_teats":["FL","XX","HR"],"health_alert":"Mastitas","group_since":"2026-09-01"},
  {"delpro_animal_id":"102","animal_no":"513","tag_no":"LT000000000513","days_in_milk":"abc","last_calving_date":"not-a-date","milk_yield_kg":"x","is_pregnant":"maybe"}]}'::jsonb) as r;
reset role;
do $$ declare a animals; begin
  select * into a from animals where animal_no = '512';
  if a.reproduction_status is distinct from 'Veršinga' or a.days_in_milk is distinct from 250 or a.milk_yield_kg is distinct from 31.4
     or a.last_calving_date is distinct from date '2026-01-05' or a.expected_calving_date is distinct from date '2026-12-10'
     or a.is_pregnant is distinct from true or a.pregnancy_days is distinct from 200 or a.insemination_count is distinct from 2
     or a.last_bulls is distinct from 'Atlas, Zeus' or a.missing_teats is distinct from array['FL','HR'] or a.health_alert is distinct from 'Mastitas'
     or a.group_since is distinct from date '2026-09-01' or a.last_milking_kg is distinct from 12.1 or a.produces_milk is distinct from true
     or a.dry_off_date is distinct from date '2026-10-15' or a.genetic_worth is distinct from '+120' or a.blood_line is distinct from 'HOL-1'
     or a.last_milking_at is null or a.last_insemination_date is distinct from date '2026-03-01' then
    raise exception 'DelPro fields not stored as expected: %', row_to_json(a);
  end if;
  select * into a from animals where animal_no = '513';
  if a.days_in_milk is not null or a.last_calving_date is not null or a.milk_yield_kg is not null or a.is_pregnant is not null then
    raise exception 'bad DelPro values should become null: %', row_to_json(a);
  end if;
end $$;
select 'assert' as step, 'delpro dairyplan fields stored, bad values nulled' as what;
-- patch semantics: a later sync without the fields keeps them; is_pregnant=false retires the due date
set role service_role;
select 'dp_fields2' as step, upsert_animals_from_delpro('{"full_snapshot":false,"animals":[{"delpro_animal_id":"101","animal_no":"512","tag_no":"LT000000000512","group_id":"1"}]}'::jsonb) as r;
reset role;
do $$ begin
  if (select days_in_milk from animals where animal_no = '512') is distinct from 250 or (select expected_calving_date from animals where animal_no = '512') is null then
    raise exception 'missing fields must not blank existing DelPro data';
  end if;
end $$;
set role service_role;
select 'dp_fields3' as step, upsert_animals_from_delpro('{"full_snapshot":false,"animals":[{"delpro_animal_id":"101","animal_no":"512","tag_no":"LT000000000512","is_pregnant":false,"last_calving_date":"2026-12-12"}]}'::jsonb) as r;
reset role;
do $$ declare a animals; begin
  select * into a from animals where animal_no = '512';
  if a.is_pregnant is distinct from false or a.expected_calving_date is not null or a.pregnancy_days is not null or a.last_calving_date is distinct from date '2026-12-12' then
    raise exception 'is_pregnant=false should retire due date: %', row_to_json(a);
  end if;
end $$;
select 'assert' as step, 'delpro fields patch + pregnancy retire ok' as what;
-- worker RPC stays service-role only; authenticated users can read the new columns
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
select 'viewer_reads_dp_fields' as step, days_in_milk, reproduction_status from animals where animal_no = '512';
do $$ declare blocked boolean := false; begin
  begin perform upsert_animals_from_delpro('{"animals":[{"delpro_animal_id":"101","days_in_milk":1}]}'::jsonb); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: authenticated calls upsert_animals_from_delpro'; end if;
end $$;
select 'assert' as step, 'authenticated cannot call upsert_animals_from_delpro' as what;
reset role;

-- 15. Produktų subkategorijos + hoof_care (0022/0023)
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select 'subcat_seed' as step, name from product_subcategories where category='hoof_care' order by sort_order;
select 'hoof_kind' as step, fn_product_write_off_kind('hoof_care'::product_category, null) as hoof_care,
  fn_product_write_off_kind('treatment_materials'::product_category, null) as materials,
  fn_product_write_off_kind('reproduction'::product_category, null) as repro,
  fn_product_write_off_kind('hoof_care'::product_category, 'vaistai') as explicit_wins;
insert into products (id,name,category,unit,subcategory_id,standard_amount)
  values ('11111111-0000-0000-0000-0000000000b2','Paduka M','hoof_care','vnt',(select id from product_subcategories where name='Paduka'),1);
insert into batches (product_id,lot,expiry_date,received_qty,purchase_price) values ('11111111-0000-0000-0000-0000000000b2','P1','2027-06-01',10,2);
select 'hoof_product' as step, p.name, s.name as subcategory, p.standard_amount from products p join product_subcategories s on s.id=p.subcategory_id where p.id='11111111-0000-0000-0000-0000000000b2';
-- hoof exam consumes the hoof_care product from FEFO stock
select 'hoof_block_exam' as step, create_hoof_exam(jsonb_build_object(
  'animal_id',(select id from animals where animal_no='513'),'exam_date','2026-10-06',
  'findings', jsonb_build_array(jsonb_build_object('leg','HL','zones','[{"zone":3,"claw":"outer"}]'::jsonb,'condition_code','SU','severity',2,
    'products',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000b2','qty',1,'unit','vnt')))))) is not null as ok;
select 'hoof_block_stock' as step, qty_left from batches where lot='P1';
-- duplicate name per category (case-insensitive) is rejected; same name in another category is fine
do $$ declare blocked boolean := false; begin
  begin insert into product_subcategories (category,name) values ('hoof_care','paduka'); exception when unique_violation then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: duplicate subcategory'; end if;
end $$;
select 'assert' as step, 'duplicate subcategory blocked' as what;
insert into product_subcategories (category,name) values ('medicines','Paduka');
update product_subcategories set name='Padukos', active=false where category='hoof_care' and name='Tvarsčiai';
select 'subcat_renamed' as step, name, active from product_subcategories where category='hoof_care' order by sort_order;
delete from product_subcategories where category='medicines' and name='Paduka';
-- viewer: reads, cannot write
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
select 'viewer_reads_subcats' as step, count(*) from product_subcategories;
do $$ declare blocked boolean := false; begin
  begin insert into product_subcategories (category,name) values ('hoof_care','Viewer'); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: viewer creates subcategory'; end if;
end $$;
select 'assert' as step, 'viewer cannot create subcategory' as what;
reset role;

-- 16. Sinchronizacijos protokolai (0025): own protocols -> planned visits -> FEFO only when recorded
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
insert into products (id,name,category,unit,withdrawal_days_milk,withdrawal_days_meat) values
 ('11111111-0000-0000-0000-0000000000c1','GnRH','medicines','ml',0,0),
 ('11111111-0000-0000-0000-0000000000c2','PGF2a','medicines','ml',1,2);
insert into batches (product_id,lot,expiry_date,received_qty,purchase_price) values
 ('11111111-0000-0000-0000-0000000000c1','SYNC-G','2027-06-01',20,2),
 ('11111111-0000-0000-0000-0000000000c2','SYNC-F','2027-06-01',20,3);
select 'sync_save' as step, save_sync_protocol(jsonb_build_object('name','Ovsynch','description','GnRH-PGF-GnRH','steps',jsonb_build_array(
  -- client unit 'l' is ignored: the product's own unit (ml) is stored
  jsonb_build_object('day_offset',0,'title','GnRH injekcija','medications',jsonb_build_array(
    jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000c1','qty',2,'unit','l','administration_route','im'))),
  jsonb_build_object('day_offset',7,'title','Ultragarsas','notes','patikrinti kiaušidę'),
  jsonb_build_object('day_offset',9,'title','PGF2a injekcija','medications',jsonb_build_array(
    jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000c2','qty',5)))))) is not null as ok;
select 'sync_steps' as step, s.day_offset, s.title, s.sort_order, s.medications->0->>'unit' as unit, jsonb_array_length(s.medications) as meds
  from sync_protocol_steps s join sync_protocols p on p.id = s.protocol_id where p.name = 'Ovsynch' order by s.sort_order;
-- validation
do $$ declare blocked boolean := false; begin
  begin perform save_sync_protocol(jsonb_build_object('name','ovsynch','steps',jsonb_build_array(jsonb_build_object('day_offset',0,'title','x')))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: duplicate protocol name'; end if;
end $$;
do $$ declare blocked boolean := false; begin
  begin perform save_sync_protocol(jsonb_build_object('name','Tuščias','steps','[]'::jsonb)); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: protocol without steps'; end if;
end $$;
do $$ declare blocked boolean := false; begin
  begin perform save_sync_protocol(jsonb_build_object('name','Blogas','steps',jsonb_build_array(jsonb_build_object('day_offset',0,'title','x','medications',jsonb_build_array(
    jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000c1','qty',0)))))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: zero medicine qty'; end if;
end $$;
do $$ declare blocked boolean := false; begin
  begin perform save_sync_protocol(jsonb_build_object('name','Biocidas','steps',jsonb_build_array(jsonb_build_object('day_offset',0,'title','x','medications',jsonb_build_array(
    jsonb_build_object('product_id','11111111-0000-0000-0000-000000000003','qty',1)))))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: biocide in protocol'; end if;
end $$;
select 'assert' as step, 'protocol validation blocks duplicate/empty/zero-qty/biocide' as what;
-- the treatment dialog cannot give bull semen / reproduction products, so a protocol cannot plan them either
insert into products (id,name,category,unit) values ('11111111-0000-0000-0000-0000000000c3','Sėkla X','reproduction','vnt');
do $$ declare blocked boolean := false; begin
  begin perform save_sync_protocol(jsonb_build_object('name','Sėkla','steps',jsonb_build_array(jsonb_build_object('day_offset',0,'title','x','medications',jsonb_build_array(
    jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000c3','qty',1)))))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: reproduction product in protocol'; end if;
end $$;
select 'assert' as step, 'non-treatment category blocked' as what;
select 'sync_protocol_count' as step, count(*) from sync_protocols;

-- apply: one planned visit per step, nothing consumed yet
select 'sync_apply' as step, apply_sync_protocol((select id from sync_protocols where name='Ovsynch'),
  (select id from animals where animal_no='513'), date '2026-10-20', '08:30', 'Dr. Test') as visits;
select 'sync_visits' as step, v.sync_step_no, v.sync_step_total, v.sync_step_title, v.procedures, v.status,
  to_char(v.visit_datetime at time zone 'Europe/Vilnius', 'YYYY-MM-DD HH24:MI') as at_vilnius, jsonb_array_length(v.planned_medications) as planned_meds
  from animal_visits v where v.sync_application_id is not null order by v.visit_datetime;
select 'sync_stock_untouched' as step, (select qty_left from batches where lot='SYNC-G') as g1, (select qty_left from batches where lot='SYNC-F') as f1;
do $$ declare blocked boolean := false; begin
  begin perform apply_sync_protocol((select id from sync_protocols where name='Ovsynch'), (select id from animals where animal_no='513'), date '2026-11-01'); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: second protocol while one is open'; end if;
end $$;
select 'assert' as step, 'second open protocol blocked' as what;

-- recording step 1 (has medicine): FEFO consumed, treatment typed sinchronizacija, visit done, NOT queued for DelPro
select 'sync_record1' as step, create_treatment_for_visit((select id from animal_visits where sync_step_no = 1), jsonb_build_object(
  'procedure_type','sinchronizacija','reg_date','2026-10-20','vet_name','Dr. Test',
  'medications', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000c1','qty',2,'unit','ml','administration_route','im')))) is not null as ok;
select 'sync_after1' as step, v.status, (select qty_left from batches where lot='SYNC-G') as g1,
  (select count(*) from delpro_sync_jobs j join treatments t on t.id = j.treatment_id where t.visit_id = v.id) as delpro_jobs
  from animal_visits v where v.sync_step_no = 1;
-- step 2 has no medicine: a (record-only) treatment never auto-closes it — it is closed by hand
select 'sync_record2' as step, create_treatment_for_visit((select id from animal_visits where sync_step_no = 2), jsonb_build_object(
  'procedure_type','sinchronizacija','reg_date','2026-10-27')) is not null as ok;
select 'sync_after2' as step, status from animal_visits where sync_step_no = 2;

-- editing the template does not rewrite visits that were already planned
select 'sync_edit' as step, save_sync_protocol(jsonb_build_object('id',(select id from sync_protocols where name='Ovsynch'),'name','Ovsynch v2',
  'steps',jsonb_build_array(jsonb_build_object('day_offset',0,'title','Nauja diena')))) is not null as ok;
select 'sync_edit_check' as step, (select count(*) from sync_protocol_steps s join sync_protocols p on p.id=s.protocol_id where p.name='Ovsynch v2') as new_steps,
  (select count(*) from animal_visits where sync_step_title = 'PGF2a injekcija') as visit_keeps_old_step;

-- cancel the running protocol: open steps cancelled, the recorded one stays
select 'sync_cancel' as step, cancel_sync_application((select id from sync_protocol_applications limit 1)) as cancelled;
select 'sync_statuses' as step, sync_step_no, status from animal_visits where sync_application_id is not null order by sync_step_no;
-- the animal is free again once the running protocol was cancelled
select 'sync_reapply' as step, apply_sync_protocol((select id from sync_protocols where name='Ovsynch v2'), (select id from animals where animal_no='513'), date '2026-11-01') as visits;

-- deleting a protocol keeps applications (name snapshot) and visits
delete from sync_protocols where name = 'Ovsynch v2';
select 'sync_deleted' as step, (select count(*) from sync_protocols) as protocols,
  (select count(*) from sync_protocol_steps) as steps,
  (select count(*) from sync_protocol_applications where protocol_id is null and protocol_name = 'Ovsynch') as app_kept,
  (select count(*) from sync_protocol_applications where protocol_id is null and protocol_name = 'Ovsynch v2') as app2_kept,
  (select count(*) from animal_visits where sync_application_id is not null) as visits_kept;

-- viewer reads, cannot write
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
select 'viewer_reads_sync' as step, count(*) from sync_protocol_applications;
do $$ declare blocked boolean := false; begin
  begin perform save_sync_protocol(jsonb_build_object('name','Viewer','steps',jsonb_build_array(jsonb_build_object('day_offset',0,'title','x')))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: viewer saves protocol'; end if;
end $$;
select 'assert' as step, 'viewer cannot save protocol' as what;
reset role;

-- 17. Profilaktika / Boliusai product types (0026/0027): drugs like medicines
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
insert into products (id,name,category,unit,withdrawal_days_milk,withdrawal_days_meat) values
 ('11111111-0000-0000-0000-0000000000d1','Vitaminas ADE','profilaktika','ml',0,0),
 ('11111111-0000-0000-0000-0000000000d2','Mineralinis bolius','boliusai','vnt',0,28);
-- like medicines they need serija + galiojimo terminas on pajamavimas
do $$ declare blocked boolean := false; begin
  begin perform receive_invoice(jsonb_build_object('mode','manual','invoice',jsonb_build_object('number','PR-1'),
    'items',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000d2','qty',10,'unit_price',2)))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: bolius without lot'; end if;
end $$;
select 'assert' as step, 'boliusai need serija + galiojimas' as what;
select 'recv_prof' as step, receive_invoice(jsonb_build_object('mode','manual','invoice',jsonb_build_object('number','PR-2','date','2026-10-01'),
  'items',jsonb_build_array(
    jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000d1','qty',20,'unit_price',1,'lot','PR-A','expiry_date','2030-01-01'),
    jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000d2','qty',10,'unit_price',2,'lot','PR-B','expiry_date','2030-01-01')))) is not null as ok;
-- they appear in the legal veterinary drug journal
select 'prof_journal' as step, product_name, category, batch_number from vw_vet_drug_journal where batch_number in ('PR-A','PR-B') order by product_name;
-- and can be given as a profilaktika treatment (FEFO)
select 'prof_treatment' as step, create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'procedure_type','profilaktika',
  'reg_date','2026-10-09','medications',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000d2','qty',1,'unit','vnt')))) is not null as ok;
select 'prof_stock' as step, qty_left from batches where lot = 'PR-B';
-- and planned in a sync protocol step
select 'prof_in_protocol' as step, save_sync_protocol(jsonb_build_object('name','Su bolius','steps',jsonb_build_array(jsonb_build_object('day_offset',0,'title','Bolius','medications',jsonb_build_array(
  jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000d2','qty',1)))))) is not null as ok;
reset role;

-- 18. Karencija of a 0-day product (0028): no restriction at all, not "date + 1"
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
insert into products (id,name,category,unit,withdrawal_days_milk,withdrawal_days_meat) values
 ('11111111-0000-0000-0000-0000000000e1','Bioestrovet','medicines','ml',0,0),
 ('11111111-0000-0000-0000-0000000000e2','Mėsos vaistas','medicines','ml',0,5);
insert into batches (product_id,lot,expiry_date,received_qty,purchase_price) values
 ('11111111-0000-0000-0000-0000000000e1','BIO1','2027-06-01',50,2),
 ('11111111-0000-0000-0000-0000000000e2','MV1','2027-06-01',50,2);
select 'zero_days_single' as step, create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'diagnosis','Nulis',
  'reg_date','2026-10-01','medications',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000e1','qty',2,'unit','ml')))) is not null as ok;
select 'zero_days_check' as step, withdrawal_until_milk, withdrawal_until_meat from treatments where diagnosis = 'Nulis';
-- mixed: the product with meat days sets only the meat date, milk stays unrestricted
select 'zero_days_mixed' as step, create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'diagnosis','Mišrus',
  'reg_date','2026-10-01','medications',jsonb_build_array(
    jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000e1','qty',2,'unit','ml'),
    jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000e2','qty',2,'unit','ml')))) is not null as ok;
select 'zero_days_mixed_check' as step, withdrawal_until_milk, withdrawal_until_meat from treatments where diagnosis = 'Mišrus';
do $$ declare m date; t date; begin
  select withdrawal_until_milk, withdrawal_until_meat into m, t from treatments where diagnosis = 'Nulis';
  if m is not null or t is not null then raise exception '0-day product must not set karencija: % %', m, t; end if;
  select withdrawal_until_milk, withdrawal_until_meat into m, t from treatments where diagnosis = 'Mišrus';
  if m is not null or t is distinct from date '2026-10-07' then raise exception 'mixed karencija wrong: % %', m, t; end if;
end $$;
select 'assert' as step, '0-day product sets no karencija' as what;
reset role;

-- 29. Sėklinimas kaip vizito žingsnis (0029): protocol's last step = insemination
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
insert into products (id,name,category,unit) values ('11111111-0000-0000-0000-0000000000f1','Sėkla FTAI','reproduction','dose');
insert into batches (product_id,lot,expiry_date,received_qty,purchase_price) values ('11111111-0000-0000-0000-0000000000f1','SEK1','2027-06-01',3,10);
select 'sek_protocol' as step, save_sync_protocol(jsonb_build_object('name','Su sėklinimu','steps',jsonb_build_array(
  jsonb_build_object('day_offset',0,'title','GnRH','medications',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000c1','qty',2))),
  -- medicine on a sekinimas step is dropped: semen/gloves are chosen when the insemination is recorded
  jsonb_build_object('day_offset',10,'title','FTAI sėklinimas','kind','sekinimas','medications',jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-0000000000c1','qty',9)))))) is not null as ok;
select 'sek_steps' as step, title, kind, jsonb_array_length(medications) as meds from sync_protocol_steps where protocol_id = (select id from sync_protocols where name='Su sėklinimu') order by sort_order;
do $$ declare blocked boolean := false; begin
  begin perform save_sync_protocol(jsonb_build_object('name','Blogas tipas','steps',jsonb_build_array(jsonb_build_object('day_offset',0,'title','x','kind','kita')))); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: bad step kind'; end if;
end $$;
select 'assert' as step, 'bad step kind blocked' as what;
select 'sek_apply' as step, apply_sync_protocol((select id from sync_protocols where name='Su sėklinimu'), (select id from animals where animal_no='512'), date '2026-11-10') as visits;
select 'sek_visits' as step, sync_step_no, sync_step_title, procedures, jsonb_array_length(planned_medications) as planned
  from animal_visits where sync_application_id = (select id from sync_protocol_applications where protocol_name='Su sėklinimu') order by sync_step_no;
-- recording the insemination: semen consumed FEFO, linked, visit done
select 'sek_record' as step, create_insemination_for_visit((select id from animal_visits where sync_step_title='FTAI sėklinimas'),
  jsonb_build_object('insemination_date','2026-11-20','sperm_product_id','11111111-0000-0000-0000-0000000000f1','sperm_quantity',1,'animal_id','00000000-0000-0000-0000-000000000000')) is not null as ok;
select 'sek_after' as step, v.status, a.animal_no, (select qty_left from batches where lot='SEK1') as semen_left
  from animal_visits v join animals a on a.id = v.animal_id
  join insemination_records i on i.visit_id = v.id where v.sync_step_title='FTAI sėklinimas';
-- standalone sekinimas visit; shortfall rolls back record + link + status
select 'sek_visit2' as step, create_visit(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'procedures',jsonb_build_array('sekinimas'))) is not null as ok;
do $$ declare blocked boolean := false; begin
  begin perform create_insemination_for_visit((select id from animal_visits where animal_id=(select id from animals where animal_no='513') and procedures=array['sekinimas']),
    jsonb_build_object('sperm_product_id','11111111-0000-0000-0000-0000000000f1','sperm_quantity',50)); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: semen shortfall'; end if;
end $$;
select 'assert' as step, 'insemination shortfall blocked' as what;
select 'sek_rollback' as step, (select count(*) from insemination_records where visit_id is not null) as linked, (select qty_left from batches where lot='SEK1') as semen_left;
-- deleting the visit keeps the insemination journal row
delete from animal_visits where sync_step_title = 'FTAI sėklinimas';
select 'sek_deleted' as step, (select count(*) from insemination_records where visit_id is null and insemination_date = date '2026-11-20') as journal_kept;
reset role;

-- 31. Gydymų istorija (0031): vw_treated_animals exposes procedure_type, old columns intact
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select 'history_types' as step, procedure_type, count(distinct treatment_id) as treatments from vw_treated_animals group by procedure_type order by 2;
do $$ declare n integer; begin
  select count(*) into n from vw_treated_animals where diagnosis = 'Nulis' and procedure_type = 'gydymas' and product_name = 'Bioestrovet' and withdrawal_until_milk is null;
  if n <> 1 then raise exception 'history view: expected the 0-day Bioestrovet treatment once, got %', n; end if;
end $$;
select 'assert' as step, 'history view has procedure_type and null karencija for 0-day product' as what;
reset role;

-- 32. Analitika (0032): aggregates agree with the raw ledger; readable by a viewer
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
do $$ declare
  raw_used numeric; fn_used numeric; raw_stock numeric; view_stock numeric; raw_expired numeric; view_expired numeric; raw_bought numeric; fn_bought numeric; n_cat numeric;
begin
  select coalesce(sum(qty * coalesce(purchase_price, 0)), 0) into raw_used from vw_usage_items_detailed where used_on between date '2000-01-01' and date '2100-01-01';
  select coalesce(sum(consumed), 0), coalesce(sum(purchased), 0) into fn_used, fn_bought from analytics_monthly(date '2000-01-01', date '2100-01-01');
  if raw_used <> fn_used then raise exception 'analytics_monthly consumed % <> raw %', fn_used, raw_used; end if;
  select coalesce(sum(b.received_qty * coalesce(b.purchase_price, 0)), 0) into raw_bought from batches b;
  if raw_bought <> fn_bought then raise exception 'analytics_monthly purchased % <> raw %', fn_bought, raw_bought; end if;
  select coalesce(sum(spent), 0) into n_cat from analytics_spend_by_category(date '2000-01-01', date '2100-01-01');
  if n_cat <> raw_used then raise exception 'spend by category % <> raw %', n_cat, raw_used; end if;
  select coalesce(sum(b.qty_left * coalesce(b.purchase_price, 0)), 0) into raw_stock from batches b where b.status = 'active' and (b.expiry_date is null or b.expiry_date >= current_date);
  select coalesce(sum(usable_value), 0), coalesce(sum(expired_value), 0) into view_stock, view_expired from vw_stock_value_by_category;
  if raw_stock <> view_stock then raise exception 'stock value % <> raw %', view_stock, raw_stock; end if;
  select coalesce(sum(b.qty_left * coalesce(b.purchase_price, 0)), 0) into raw_expired from batches b where b.status = 'active' and b.qty_left > 0 and b.expiry_date < current_date;
  if raw_expired <> view_expired then raise exception 'expired value % <> raw %', view_expired, raw_expired; end if;
end $$;
select 'assert' as step, 'analytics totals match the ledger' as what;
select 'an_monthly' as step, to_char(month,'YYYY-MM') as month, purchased, consumed from analytics_monthly(date '2026-08-01', date '2026-10-31');
select 'an_category' as step, category, spent from analytics_spend_by_category(date '2026-01-01', date '2026-12-31');
select 'an_top' as step, product_name, qty, spent, is_antimicrobial from analytics_top_products(date '2026-01-01', date '2026-12-31', 3);
select 'an_amr' as step, product_name, qty from analytics_antimicrobial(date '2026-01-01', date '2026-12-31', 3);
select 'an_tr_month' as step, to_char(month,'YYYY-MM') as month, procedure_type, n from analytics_treatments_by_month(date '2026-08-01', date '2026-10-31');
select 'an_diseases' as step, name, n from analytics_top_diseases(date '2026-01-01', date '2026-12-31', 3);
select 'an_groups' as step, animal_group, n from analytics_treatments_by_group(date '2026-01-01', date '2026-12-31', 3);
select 'an_stock' as step, category, usable_value, expired_value, unpriced_batches from vw_stock_value_by_category order by 1;
select 'an_alerts' as step, product_name, lot, days_left < 0 as expired from vw_stock_batch_alerts limit 3;
reset role;

-- 30. Nagos: kurso planavimas (0030) — a drug in a hoof finding is a treatment record, a course plans later doses
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
insert into products (id,name,category,unit,withdrawal_days_milk,withdrawal_days_meat) values
 ('11111111-0000-0000-0000-000000003001','Nagų antibiotikas','medicines','ml',3,7),
 ('11111111-0000-0000-0000-000000003002','Nagų tvarstis','hoof_care','vnt',0,0);
insert into batches (product_id,lot,expiry_date,received_qty,purchase_price) values
 ('11111111-0000-0000-0000-000000003001','NAGOS-AB1','2027-06-01',20,2),
 ('11111111-0000-0000-0000-000000003002','NAGOS-TV1','2027-06-01',10,1);
-- finding with a drug (day 1 now), a bandage and a 2-dose course
select 'hoof_course_exam' as step, create_hoof_exam(jsonb_build_object(
  'animal_id',(select id from animals where animal_no='513'),'exam_date','2026-10-09','performed_by','Dr. Test',
  'findings', jsonb_build_array(jsonb_build_object('leg','HL','zones','[{"zone":3,"claw":"outer"}]'::jsonb,'condition_code','SU','severity',2,'was_treated',true,
    'products', jsonb_build_array(
      jsonb_build_object('product_id','11111111-0000-0000-0000-000000003001','qty',4,'unit','ml','administration_route','im'),
      jsonb_build_object('product_id','11111111-0000-0000-0000-000000003002','qty',1,'unit','vnt')),
    'course_days', jsonb_build_array(
      jsonb_build_object('scheduled_date','2026-10-10','product_id','11111111-0000-0000-0000-000000003001','qty',4,'unit','ml','administration_route','im'),
      jsonb_build_object('scheduled_date','2026-10-12','product_id','11111111-0000-0000-0000-000000003001','qty',4,'unit','ml','administration_route','im')))))) is not null as ok;
select 'hoof_course_treatment' as step, t.procedure_type, t.diagnosis, t.hoof_finding_id is not null as linked, tc.days, tc.status,
  (select count(*) from course_doses cd where cd.course_id = tc.id) as doses,
  (select count(*) from course_doses cd where cd.course_id = tc.id and cd.administered) as given,
  t.withdrawal_until_milk, t.withdrawal_until_meat
  from treatments t join treatment_courses tc on tc.treatment_id = t.id where t.hoof_finding_id is not null;
-- day 1 consumed now (drug via the treatment, bandage via the finding); later doses not yet
select 'hoof_course_stock' as step, (select qty_left from batches where lot='NAGOS-AB1') as drug_left, (select qty_left from batches where lot='NAGOS-TV1') as bandage_left,
  (select count(*) from usage_items where treatment_id is not null and product_id='11111111-0000-0000-0000-000000003001') as drug_usage_rows,
  (select count(*) from usage_items where hoof_finding_id is not null and product_id='11111111-0000-0000-0000-000000003002') as bandage_usage_rows;
-- karencija counts from the LAST planned dose: 12 Oct + 3 / + 7 + 1
do $$ declare m date; t date; begin
  select withdrawal_until_milk, withdrawal_until_meat into m, t from treatments where hoof_finding_id is not null;
  if m is distinct from date '2026-10-16' or t is distinct from date '2026-10-20' then raise exception 'hoof course karencija wrong: % %', m, t; end if;
end $$;
select 'assert' as step, 'hoof course karencija from last dose' as what;
-- administering a planned dose consumes FEFO stock then
select administer_course_dose((select cd.id from course_doses cd join treatment_courses tc on tc.id = cd.course_id
  join treatments t on t.id = tc.treatment_id where t.hoof_finding_id is not null order by cd.day_number limit 1), date '2026-10-10');
select 'hoof_dose_admin' as step, (select qty_left from batches where lot='NAGOS-AB1') as drug_left,
  (select count(*) from course_doses where administered) >= 1 as dose_marked,
  (select count(*) from usage_items where course_dose_id is not null and product_id='11111111-0000-0000-0000-000000003001') as dose_usage_rows;
-- a drug without a course is still a treatment record (karencija from the exam date)
select 'hoof_drug_only' as step, create_hoof_exam(jsonb_build_object(
  'animal_id',(select id from animals where animal_no='513'),'exam_date','2026-10-09',
  'findings', jsonb_build_array(jsonb_build_object('leg','FL','zones','[{"zone":1,"claw":"inner"}]'::jsonb,
    'products', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000003001','qty',1,'unit','ml','administration_route','im')))))) is not null as ok;
select 'hoof_drug_only_check' as step, count(*) filter (where tc.id is null) as no_course, max(t.withdrawal_until_milk) as milk
  from treatments t left join treatment_courses tc on tc.treatment_id = t.id where t.hoof_finding_id is not null and tc.id is null;
-- shortfall on the drug rolls the whole exam back (no exam, finding, treatment or course left behind)
do $$ declare blocked boolean := false; n_ex integer; n_tr integer; begin
  select count(*) into n_ex from hoof_exams; select count(*) into n_tr from treatments where hoof_finding_id is not null;
  begin perform create_hoof_exam(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),
    'findings', jsonb_build_array(jsonb_build_object('leg','HR','zones','[{"zone":2,"claw":"inner"}]'::jsonb,
      'products', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000003001','qty',999,'unit','ml'))))));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: hoof drug shortfall'; end if;
  if (select count(*) from hoof_exams) <> n_ex or (select count(*) from treatments where hoof_finding_id is not null) <> n_tr then raise exception 'shortfall left partial rows'; end if;
end $$;
select 'assert' as step, 'hoof drug shortfall rolls back exam + treatment' as what;
-- a course date on/before the exam date is refused
do $$ declare blocked boolean := false; begin
  begin perform create_hoof_exam(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'exam_date','2026-10-09',
    'findings', jsonb_build_array(jsonb_build_object('leg','HR','zones','[{"zone":2,"claw":"inner"}]'::jsonb,
      'products', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000003001','qty',1,'unit','ml')),
      'course_days', jsonb_build_array(jsonb_build_object('scheduled_date','2026-10-09','product_id','11111111-0000-0000-0000-000000003001','qty',1,'unit','ml'))))));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: course date not after exam'; end if;
end $$;
select 'assert' as step, 'hoof course date must be after exam date' as what;
-- deleting the exam removes its treatment / course and returns the stock
select 'hoof_exam_delete' as step, (select count(*) from hoof_exams) as exams_before;
delete from hoof_exams where animal_id = (select id from animals where animal_no='513') and id in (select exam_id from hoof_findings where leg in ('HL','FL'));
select 'hoof_exam_deleted' as step, (select count(*) from treatments where hoof_finding_id is not null) as linked_left,
  (select count(*) from course_doses cd join treatment_courses tc on tc.id = cd.course_id where tc.treatment_id not in (select id from treatments)) as orphan_doses,
  (select qty_left from batches where lot='NAGOS-AB1') as drug_left, (select qty_left from batches where lot='NAGOS-TV1') as bandage_left;
reset role;

-- ===========================================================================
-- 0033: treatment-level DelPro confirmation (fresh fixtures, labelled T-DP-*)
-- ===========================================================================
reset role;
update system_settings set setting_value='approval' where setting_key='delpro_outbound_mode';
update system_settings set setting_value=null where setting_key='delpro_worker_last_seen_at';
-- everything earlier in the file is finished with: park its open jobs so counts below are about our fixtures
update delpro_sync_jobs set status='rejected' where status in ('pending_approval','approved');

insert into animals (tag_no, animal_no) values ('LT000000009001','9001'), ('LT000000009002','9002'), ('LT000000009003', null);
insert into diseases (name) values ('DP Viduriavimas'), ('DP Neturi susiejimo');
insert into products (id,name,category,unit) values
 ('99999999-0000-0000-0000-0000000000e1','DP Vitamin C','medicines','ml'),
 ('99999999-0000-0000-0000-0000000000e2','DP Antras vaistas','medicines','ml'),
 ('99999999-0000-0000-0000-0000000000e3','DP Nesusietas vaistas','medicines','ml');
insert into batches (product_id,lot,expiry_date,received_qty,purchase_price) values
 ('99999999-0000-0000-0000-0000000000e1','D1','2030-01-01',500,1),
 ('99999999-0000-0000-0000-0000000000e2','D2','2030-01-01',500,1),
 ('99999999-0000-0000-0000-0000000000e3','D3','2030-01-01',500,1);

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
insert into delpro_mappings (kind, local_id, delpro_code, delpro_name) values
 ('disease', (select id from diseases where name='DP Viduriavimas'), '54', 'Viduriavimas'),
 ('product', '99999999-0000-0000-0000-0000000000e1', null, 'Vitamin C'),
 ('product', '99999999-0000-0000-0000-0000000000e2', null, 'Antras DelPro vaistas');

select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
-- T-DP-1 eligible: 1 ml... 3 ml dose, 2-day course with the same dose
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='9001'),'reg_date','2026-10-10','diagnosis','T-DP-1',
  'disease_id',(select id from diseases where name='DP Viduriavimas'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e1','qty',3,'unit','ml','administration_route','im')),
  'course_days', jsonb_build_array(jsonb_build_object('scheduled_date','2026-10-11','product_id','99999999-0000-0000-0000-0000000000e1','qty',3,'unit','ml','administration_route','im'))));
-- T-DP-2 single day, no course
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='9002'),'reg_date','2026-10-10','diagnosis','T-DP-2',
  'disease_id',(select id from diseases where name='DP Viduriavimas'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e1','qty',2,'unit','ml'))));
-- T-DP-3 two medicines
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='9001'),'reg_date','2026-10-10','diagnosis','T-DP-3',
  'disease_id',(select id from diseases where name='DP Viduriavimas'),
  'medications', jsonb_build_array(
    jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e1','qty',1,'unit','ml'),
    jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e2','qty',1,'unit','ml'))));
-- T-DP-4 disease without mapping; T-DP-5 no disease at all; T-DP-6 unmapped medicine; T-DP-7 animal without a DelPro number
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='9001'),'reg_date','2026-10-10','diagnosis','T-DP-4',
  'disease_id',(select id from diseases where name='DP Neturi susiejimo'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e1','qty',1,'unit','ml'))));
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='9001'),'reg_date','2026-10-10','diagnosis','T-DP-5',
  'medications', jsonb_build_array(jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e1','qty',1,'unit','ml'))));
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='9001'),'reg_date','2026-10-10','diagnosis','T-DP-6',
  'disease_id',(select id from diseases where name='DP Viduriavimas'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e3','qty',1,'unit','ml'))));
select create_treatment(jsonb_build_object('animal_id',(select id from animals where tag_no='LT000000009003'),'reg_date','2026-10-10','diagnosis','T-DP-7',
  'disease_id',(select id from diseases where name='DP Viduriavimas'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e1','qty',1,'unit','ml'))));
-- T-DP-8 profilaktika / T-DP-9 apžiūra: never queued
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='9001'),'procedure_type','profilaktika','reg_date','2026-10-10','diagnosis','T-DP-8',
  'medications', jsonb_build_array(jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e1','qty',1,'unit','ml'))));
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='9001'),'procedure_type','apziura','reg_date','2026-10-10','diagnosis','T-DP-9'));

do $$
declare
  function_codes text;
  r jsonb;
  tid uuid;
  lbl text;
  want text;
begin
  -- blocked treatments: exactly the expected problem code, and no approval leaks through
  for lbl, want in values ('T-DP-3','multi_medicine'),('T-DP-5','diagnosis_missing'),('T-DP-7','animal_number') loop
    select id into tid from treatments where diagnosis = lbl;
    r := delpro_approve_treatment(tid);
    if (r->>'ok')::boolean or r->>'outcome' <> 'blocked' or not exists (select 1 from jsonb_array_elements(r->'problems') p where p->>'code' = want) then
      raise exception '% should be blocked by %: %', lbl, want, r;
    end if;
    if (select status from delpro_sync_jobs where treatment_id = tid) <> 'pending_approval' then raise exception '% job changed', lbl; end if;
  end loop;

  -- profilaktika / apžiūra: no job, approve refuses and creates none
  for lbl in values ('T-DP-8'),('T-DP-9') loop
    select id into tid from treatments where diagnosis = lbl;
    if exists (select 1 from delpro_sync_jobs where treatment_id = tid) then raise exception '% must not be queued', lbl; end if;
    r := delpro_approve_treatment(tid);
    if (r->>'ok')::boolean or not exists (select 1 from jsonb_array_elements(r->'problems') p where p->>'code' = 'not_gydymas') then
      raise exception '% must be refused as not gydymas: %', lbl, r;
    end if;
    if exists (select 1 from delpro_sync_jobs where treatment_id = tid) then raise exception '% approve created a job', lbl; end if;
  end loop;
end $$;
select 'assert' as step, 'blocked treatments + ineligible procedure types' as what;

-- no mapping at all: the DelPro names are the GVET disease / product names, code stays empty
do $$ declare u jsonb; begin
  u := delpro_treatment_transfer_state((select id from treatments where diagnosis = 'T-DP-4'))->'preview'->'delpro'->'ui_entry';
  if u->>'diagnosis_name' <> 'DP Neturi susiejimo' or u->>'diagnosis_code' is not null or u->>'medicine_name' <> 'Vitamin C'
     or jsonb_array_length(delpro_treatment_transfer_state((select id from treatments where diagnosis = 'T-DP-4'))->'problems') <> 0 then
    raise exception 'unmapped disease should fall back to GVET names: %', u;
  end if;
  u := delpro_treatment_transfer_state((select id from treatments where diagnosis = 'T-DP-6'))->'preview'->'delpro'->'ui_entry';
  if u->>'medicine_name' <> 'DP Nesusietas vaistas' then raise exception 'unmapped medicine should use the product name: %', u; end if;
end $$;
select 'assert' as step, 'names default to GVET names, mappings are optional overrides' as what;

-- read model the dialog uses (vet): preview is built by the database, mappings resolved, nothing frozen yet
do $$
declare s jsonb; u jsonb;
begin
  s := delpro_treatment_transfer_state((select id from treatments where diagnosis = 'T-DP-1'));
  u := s->'preview'->'delpro'->'ui_entry';
  if not (s->>'eligible')::boolean or not (s->>'can_approve')::boolean or (s->>'frozen')::boolean or jsonb_array_length(s->'problems') <> 0 then
    raise exception 'unexpected state: %', s;
  end if;
  if u->>'animal_number' <> '9001' or u->>'diagnosis_name' <> 'Viduriavimas' or u->>'diagnosis_code' <> '54'
     or u->>'medicine_name' <> 'Vitamin C' or (u->>'dose')::numeric <> 3 or (u->>'course_days')::int <> 2 then
    raise exception 'unexpected ui_entry preview: %', u;
  end if;
  -- single-day treatment: CourseDays is derived as 1, not defaulted to something else
  u := delpro_treatment_transfer_state((select id from treatments where diagnosis = 'T-DP-2'))->'preview'->'delpro'->'ui_entry';
  if (u->>'course_days')::int <> 1 or (u->>'dose')::numeric <> 2 then raise exception 'single-day ui_entry: %', u; end if;
  -- the worker is not online (never seen)
  if (s->'worker'->>'online')::boolean then raise exception 'worker must not look online'; end if;
end $$;
select 'assert' as step, 'transfer state read model' as what;

-- unauthorized roles: viewer reads state but cannot approve; the queue table cannot be written from a client
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
do $$ declare blocked boolean := false; s jsonb; begin
  s := delpro_treatment_transfer_state((select id from treatments where diagnosis = 'T-DP-1'));
  if (s->>'can_approve')::boolean then raise exception 'viewer must not be able to approve'; end if;
  begin perform delpro_approve_treatment((select id from treatments where diagnosis = 'T-DP-1')); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: viewer approve T-DP-1'; end if;
end $$;
select 'assert' as step, 'viewer cannot approve' as what;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$ declare blocked boolean := false; n integer; begin
  -- (the harness re-grants table privileges after the migrations, so here RLS alone must hold: 0 rows touched)
  begin update delpro_sync_jobs set status = 'success', verified = true; get diagnostics n = row_count; exception when others then n := 0; end;
  if n <> 0 then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: admin marks job success from client (% rows)', n; end if;
  begin delete from delpro_sync_jobs; get diagnostics n = row_count; exception when others then n := 0; end;
  if n <> 0 then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: admin deletes jobs from client (% rows)', n; end if;
  begin insert into delpro_sync_jobs (treatment_id, status, approved_payload) values ((select id from treatments where diagnosis = 'T-DP-9'), 'approved', '{"x":1}'); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: admin inserts forged approved job'; end if;
  blocked := false;
  begin perform delpro_claim_next_job('hacker'); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: authenticated claims job'; end if;
  blocked := false;
  begin perform delpro_report_job_result(jsonb_build_object('sync_id', (select id from delpro_sync_jobs limit 1), 'success', true)); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: authenticated reports job result'; end if;
end $$;
select 'assert' as step, 'client cannot mark success / forge / claim / report' as what;

-- a frozen account cannot approve
reset role;
update users set is_frozen = true where id = '00000000-0000-0000-0000-00000000000b';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare blocked boolean := false; begin
  begin perform delpro_approve_treatment((select id from treatments where diagnosis = 'T-DP-1')); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: frozen vet approves'; end if;
end $$;
select 'assert' as step, 'frozen user cannot approve' as what;
reset role;
update users set is_frozen = false where id = '00000000-0000-0000-0000-00000000000b';

-- approve T-DP-1 (vet), frozen payload, then worker offline: nothing is lost
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select 'dp1_approved' as step, delpro_approve_treatment((select id from treatments where diagnosis = 'T-DP-1'))->>'outcome' as outcome;
do $$ declare j delpro_sync_jobs%rowtype; begin
  select * into j from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-1');
  if j.status <> 'approved' or j.verified or j.completed_at is not null or j.started_at is not null then raise exception 'approval must not look completed: %', to_jsonb(j); end if;
  if (select count(*) from delpro_sync_jobs where treatment_id = j.treatment_id) <> 1 then raise exception 'duplicate job'; end if;
  if (delpro_treatment_transfer_state(j.treatment_id)->>'frozen')::boolean is not true then raise exception 'state must report frozen'; end if;
end $$;
select 'assert' as step, 'approved is not completed; one job per treatment' as what;
reset role;
-- worker offline for a day: the approved job is still there, untouched, and the heartbeat says offline
update system_settings set setting_value = (now() - interval '1 day')::text where setting_key='delpro_worker_last_seen_at';
do $$ begin
  if (select status from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-1')) <> 'approved' then raise exception 'job lost'; end if;
  if (select released from (select delpro_release_stale_jobs() as released) x) <> 0 then raise exception 'approved job must not be released/changed'; end if;
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ begin
  if (delpro_treatment_transfer_state((select id from treatments where diagnosis = 'T-DP-1'))->'worker'->>'online')::boolean then
    raise exception 'worker last seen yesterday must be offline';
  end if;
end $$;
reset role;
select 'assert' as step, 'offline worker: approved job stays queued' as what;

-- STALE: the diagnosis mapping changes after approval. The frozen payload is untouched and flagged ...
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
update delpro_mappings set delpro_code = '55' where kind='disease' and local_id = (select id from diseases where name='DP Viduriavimas');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare s jsonb; begin
  s := delpro_treatment_transfer_state((select id from treatments where diagnosis = 'T-DP-1'));
  if not (s->>'stale')::boolean then raise exception 'must be stale after mapping change'; end if;
  if s->'payload'->'delpro'->'ui_entry'->>'diagnosis_code' <> '54' then raise exception 'frozen payload must still say 54: %', s->'payload'; end if;
  -- clicking confirm again does NOT silently replace it
  if delpro_approve_treatment((select id from treatments where diagnosis = 'T-DP-1'))->>'outcome' <> 'stale' then raise exception 'stale approval must be refused without reapprove'; end if;
  if (select approved_payload->'delpro'->'ui_entry'->>'diagnosis_code' from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-1')) <> '54' then
    raise exception 'frozen payload was replaced';
  end if;
  if (select payload_stale from vw_delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-1')) is not true then raise exception 'queue view must flag stale'; end if;
end $$;
reset role;
select 'assert' as step, 'edit after approval: payload frozen, flagged, not silently replaced' as what;
-- ... and the worker is never handed the stale payload: the job goes back to pending_approval
set role service_role;
select 'stale_claim' as step, delpro_claim_next_job('farm-pc') is null as empty;
reset role;
do $$ begin
  if (select status from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-1')) <> 'pending_approval'
     or (select approved_payload from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-1')) is not null then
    raise exception 'stale job must return to pending_approval';
  end if;
  if not exists (select 1 from user_audit_logs where action='delpro_transfer_invalidated') then raise exception 'invalidation not audited'; end if;
end $$;
select 'assert' as step, 'claim never releases a stale payload' as what;

-- explicit re-approval with the new data; then a deliberate re-approval of an approved+stale job
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select delpro_approve_treatment((select id from treatments where diagnosis = 'T-DP-1'));
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
update delpro_mappings set delpro_code = '56' where kind='disease' and local_id = (select id from diseases where name='DP Viduriavimas');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare r jsonb; begin
  r := delpro_approve_treatment((select id from treatments where diagnosis = 'T-DP-1'), true);
  if r->>'outcome' <> 'reapproved' or (select approved_payload->'delpro'->'ui_entry'->>'diagnosis_code' from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-1')) <> '56' then
    raise exception 'reapproval failed: %', r;
  end if;
end $$;
reset role;
select 'assert' as step, 'explicit re-approval refreezes' as what;

-- worker claims it, then every later approve click is a no-op on the running/finished job
set role service_role;
select 'dp1_claim' as step, delpro_claim_next_job('farm-pc')->'delpro'->'ui_entry' as ui_entry;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare r jsonb; begin
  r := delpro_approve_treatment((select id from treatments where diagnosis = 'T-DP-1'), true);
  if r->>'outcome' <> 'already_processing' then raise exception 'processing job: %', r; end if;
end $$;
reset role;
set role service_role;
select 'dp1_report' as step, delpro_report_job_result(jsonb_build_object(
  'sync_id', (select id from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-1')), 'success', true,
  'actual_result', jsonb_build_object('animal_no','9001','event_date','2026-10-10',
    'milk_withdrawal_days', (select (approved_payload->'delpro'->>'milk_withdrawal_days')::int from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-1')),
    'meat_withdrawal_days', (select (approved_payload->'delpro'->>'meat_withdrawal_days')::int from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-1')))))->>'status' as status;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare r jsonb; begin
  r := delpro_approve_treatment((select id from treatments where diagnosis = 'T-DP-1'), true);
  if r->>'outcome' <> 'already_success' or (select status from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-1')) <> 'success' then
    raise exception 'completed job must stay completed: %', r;
  end if;
end $$;
reset role;
select 'assert' as step, 'approve after processing / completed is a no-op' as what;

-- failed and rejected jobs are not silently revived by a vet's confirm click
update delpro_sync_jobs set status='error', error='boom' where treatment_id = (select id from treatments where diagnosis = 'T-DP-2');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare r jsonb; begin
  r := delpro_approve_treatment((select id from treatments where diagnosis = 'T-DP-2'));
  if r->>'outcome' <> 'needs_retry' or (select status from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-2')) <> 'error' then raise exception 'error job: %', r; end if;
end $$;
reset role;
select 'assert' as step, 'failed job is not revived by confirm' as what;

-- integration switched off: nothing can be approved, and a treatment with no job does not get one created
update delpro_sync_jobs set status='pending_approval', error=null where treatment_id = (select id from treatments where diagnosis = 'T-DP-2');
update system_settings set setting_value='off' where setting_key='delpro_outbound_mode';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare r jsonb; begin
  r := delpro_approve_treatment((select id from treatments where diagnosis = 'T-DP-2'));
  if (r->>'ok')::boolean or not exists (select 1 from jsonb_array_elements(r->'problems') p where p->>'code' = 'integration_off') then raise exception 'off mode must block: %', r; end if;
  if (delpro_treatment_transfer_state((select id from treatments where diagnosis = 'T-DP-2'))->>'eligible')::boolean then raise exception 'off mode: not eligible'; end if;
end $$;
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='9002'),'reg_date','2026-10-11','diagnosis','T-DP-10',
  'disease_id',(select id from diseases where name='DP Viduriavimas'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e1','qty',1,'unit','ml'))));
reset role;
do $$ begin
  if exists (select 1 from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-10')) then raise exception 'off mode must not enqueue'; end if;
end $$;
-- ... switched back on: the treatment recorded while off can still be confirmed (the one job is created on demand)
update system_settings set setting_value='approval' where setting_key='delpro_outbound_mode';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare r jsonb; begin
  r := delpro_approve_treatment((select id from treatments where diagnosis = 'T-DP-10'));
  if r->>'outcome' <> 'approved' then raise exception 'late job creation: %', r; end if;
  if (select count(*) from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-10')) <> 1 then raise exception 'exactly one job expected'; end if;
end $$;
reset role;
select 'assert' as step, 'integration off blocks; on-demand job creation is unique' as what;

-- admin queue retry with refreshed data: the optional product mapping is gone -> the GVET product name is used
update delpro_sync_jobs set status='error', error='boom' where treatment_id = (select id from treatments where diagnosis = 'T-DP-2');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
delete from delpro_mappings where kind='product' and local_id='99999999-0000-0000-0000-0000000000e1';
select delpro_retry_job((select id from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-2')), true);
do $$ begin
  if (select approved_payload->'delpro'->'ui_entry'->>'medicine_name' from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-2')) <> 'DP Vitamin C' then
    raise exception 'retry should use the GVET product name';
  end if;
end $$;
-- retry of a multi-medicine job is still refused when refreshing
reset role;
update delpro_sync_jobs set status='error', error='boom' where treatment_id = (select id from treatments where diagnosis = 'T-DP-3');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$ declare blocked boolean := false; begin
  begin perform delpro_retry_job((select id from delpro_sync_jobs where treatment_id = (select id from treatments where diagnosis = 'T-DP-3')), true); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: retry with several medicines'; end if;
end $$;
reset role;
select 'assert' as step, 'retry with refreshed data is validated' as what;

-- ===========================================================================
-- 0035: course days and standalone treatments show up in Vizitai
-- ===========================================================================
reset role;
update system_settings set setting_value='approval' where setting_key='delpro_outbound_mode';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);

-- standalone treatment, 4-day course (days 2,3,4; day 3 has two medicines) -> finished day-1 visit + 3 planned visits
select create_treatment_with_visits(jsonb_build_object('animal_id',(select id from animals where animal_no='9002'),'reg_date',(now() at time zone 'Europe/Vilnius')::date::text,'diagnosis','T-V-1',
  'disease_id',(select id from diseases where name='DP Viduriavimas'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e1','qty',2,'unit','ml','frequency_per_day',2,'course_days',3)),
  'course_days', jsonb_build_array(
    jsonb_build_object('day_number',2,'scheduled_date','2030-03-02','product_id','99999999-0000-0000-0000-0000000000e1','qty',2,'unit','ml'),
    jsonb_build_object('day_number',3,'scheduled_date','2030-03-03','product_id','99999999-0000-0000-0000-0000000000e1','qty',2,'unit','ml'),
    jsonb_build_object('day_number',3,'scheduled_date','2030-03-03','product_id','99999999-0000-0000-0000-0000000000e2','qty',1,'unit','ml'),
    jsonb_build_object('day_number',4,'scheduled_date','2030-03-04','product_id','99999999-0000-0000-0000-0000000000e1','qty',2,'unit','ml')))) as treatment;
do $$ declare t uuid := (select id from treatments where diagnosis = 'T-V-1'); d1 uuid := (select visit_id from treatments where diagnosis = 'T-V-1'); begin
  if d1 is null or (select status from animal_visits where id = d1) <> 'baigtas' or (select procedures from animal_visits where id = d1) <> array['gydymas'] then
    raise exception 'day-1 visit missing / not finished';
  end if;
  if (select count(*) from animal_visits where related_visit_id = d1 and status = 'planuojamas' and procedures = array['gydymas']) <> 3 then
    raise exception 'expected 3 planned course-day visits, got %', (select count(*) from animal_visits where related_visit_id = d1);
  end if;
  -- day 3 has two doses but ONE visit
  if (select count(distinct cd.visit_id) from course_doses cd join treatment_courses tc on tc.id = cd.course_id where tc.treatment_id = t and cd.scheduled_date = '2030-03-03') <> 1 then
    raise exception 'same-day doses must share one visit';
  end if;
  if exists (select 1 from course_doses cd join treatment_courses tc on tc.id = cd.course_id where tc.treatment_id = t and cd.visit_id is null) then raise exception 'dose without visit'; end if;
  if (select visit_datetime from animal_visits where id = (select visit_id from course_doses cd join treatment_courses tc on tc.id = cd.course_id where tc.treatment_id = t and cd.scheduled_date = '2030-03-02'))
       <> '2030-03-02 09:00 Europe/Vilnius'::timestamptz then raise exception 'course-day visit time'; end if;
  -- the visit itself consumed nothing: stock moved only for day 1
  if (select count(*) from usage_items where course_dose_id in (select cd.id from course_doses cd join treatment_courses tc on tc.id = cd.course_id where tc.treatment_id = t)) <> 0 then
    raise exception 'planning visits must not consume stock';
  end if;
end $$;
select 'assert' as step, 'standalone treatment: finished day-1 visit + planned course-day visits' as what;

-- giving the doses closes the visits (day 3 only when BOTH of its doses are given)
select administer_course_dose(id) from course_doses cd where scheduled_date = '2030-03-02' and cd.course_id in (select id from treatment_courses where treatment_id = (select id from treatments where diagnosis = 'T-V-1'));
select administer_course_dose(id) from course_doses cd where scheduled_date = '2030-03-03' and product_id = '99999999-0000-0000-0000-0000000000e1' and cd.course_id in (select id from treatment_courses where treatment_id = (select id from treatments where diagnosis = 'T-V-1'));
do $$ declare t uuid := (select id from treatments where diagnosis = 'T-V-1'); begin
  if (select v.status from animal_visits v where v.id = (select cd.visit_id from course_doses cd join treatment_courses tc on tc.id = cd.course_id where tc.treatment_id = t and cd.scheduled_date = '2030-03-02')) <> 'baigtas' then
    raise exception 'day 2 visit should be finished';
  end if;
  if (select v.status from animal_visits v where v.id = (select cd.visit_id from course_doses cd join treatment_courses tc on tc.id = cd.course_id where tc.treatment_id = t and cd.scheduled_date = '2030-03-03' limit 1)) <> 'planuojamas' then
    raise exception 'day 3 visit must stay open until both doses are given';
  end if;
end $$;
select administer_course_dose(id) from course_doses cd where scheduled_date = '2030-03-03' and product_id = '99999999-0000-0000-0000-0000000000e2' and cd.course_id in (select id from treatment_courses where treatment_id = (select id from treatments where diagnosis = 'T-V-1'));
do $$ declare t uuid := (select id from treatments where diagnosis = 'T-V-1'); begin
  if (select v.status from animal_visits v where v.id = (select cd.visit_id from course_doses cd join treatment_courses tc on tc.id = cd.course_id where tc.treatment_id = t and cd.scheduled_date = '2030-03-03' limit 1)) <> 'baigtas' then
    raise exception 'day 3 visit should be finished after both doses';
  end if;
end $$;
select 'assert' as step, 'administering course doses closes their visits' as what;

-- rescheduling a dose moves its visit
update course_doses set scheduled_date = '2030-03-06' where scheduled_date = '2030-03-04' and course_id in (select id from treatment_courses where treatment_id = (select id from treatments where diagnosis = 'T-V-1'));
do $$ begin
  if (select v.visit_datetime from animal_visits v where v.id = (select cd.visit_id from course_doses cd where cd.scheduled_date = '2030-03-06')) <> '2030-03-06 09:00 Europe/Vilnius'::timestamptz then
    raise exception 'visit should follow the rescheduled dose';
  end if;
end $$;
select 'assert' as step, 'rescheduled dose moves its visit' as what;

-- from a visit card: the card's visit is used (no extra day-1 visit); the course days hang off it
reset role;
insert into animal_visits (id, animal_id, visit_datetime, procedures, status)
  values ('99999999-0000-0000-0000-0000000000f1', (select id from animals where animal_no='9002'), now(), array['gydymas'], 'planuojamas');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select create_treatment_with_visits(jsonb_build_object('diagnosis','T-V-2','disease_id',(select id from diseases where name='DP Viduriavimas'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','99999999-0000-0000-0000-0000000000e1','qty',1,'unit','ml','frequency_per_day',2,'course_days',3)),
  'course_days', jsonb_build_array(jsonb_build_object('day_number',2,'scheduled_date','2030-04-02','product_id','99999999-0000-0000-0000-0000000000e1','qty',1,'unit','ml'))),
  '99999999-0000-0000-0000-0000000000f1') as treatment;
do $$ begin
  if (select visit_id from treatments where diagnosis = 'T-V-2') <> '99999999-0000-0000-0000-0000000000f1' then raise exception 'must link the card visit'; end if;
  if (select count(*) from animal_visits where animal_id = (select id from animals where animal_no='9002') and notes is null and status = 'baigtas' and id <> (select visit_id from treatments where diagnosis = 'T-V-1')) <> 1 then
    raise exception 'no second day-1 visit expected';
  end if;
  if (select count(*) from animal_visits where related_visit_id = '99999999-0000-0000-0000-0000000000f1') <> 1 then raise exception 'course day should follow the card visit'; end if;
end $$;
select 'assert' as step, 'treatment from a visit card links it and plans the course days' as what;

-- deleting the treatment removes its planned course-day visits, keeps the finished day-1 visit
reset role;
delete from treatments where diagnosis = 'T-V-2';
do $$ begin
  if exists (select 1 from animal_visits where related_visit_id = '99999999-0000-0000-0000-0000000000f1') then raise exception 'planned course visit must be removed with its treatment'; end if;
  if not exists (select 1 from animal_visits where id = '99999999-0000-0000-0000-0000000000f1') then raise exception 'the card visit must stay'; end if;
end $$;
select 'assert' as step, 'deleting a treatment removes its planned course-day visits' as what;

-- 18. DelPro catalog sync (0036): Gateway snapshot -> mirror -> reconciliation.
-- TreatmentDrugUsage 197 and DrugParameters 218 are the real Gateway records;
-- the rest are test data. Nothing is ever linked by name alone.
reset role;
insert into diseases (id, name) values
  ('36000000-0000-0000-0000-0000000000d1', 'KT Mastitas'),
  ('36000000-0000-0000-0000-0000000000d2', 'KT Dviguba');
insert into products (id, name, category, unit, withdrawal_days_milk, withdrawal_days_meat) values
  ('36000000-0000-0000-0000-0000000000a1', 'KT Penicilinas', 'medicines', 'ml', 4, 10);
insert into animals (tag_no, animal_no, active) values ('LT0000000KT337', 'KT337', true);

set role service_role;
select set_config('t.run', delpro_catalog_begin_run('{"worker_id":"test-pc"}')->>'run_id', false);
select 'cat_upload_params' as step, delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run'), 'object_type', 'DrugParameters', 'records', '[
  {"key":"218","uom":"ml","application_method":null,"dump_milk_days":"0","meat_withhold_days":"4"},
  {"key":"219","uom":"ml","application_method":"Intramuscular","dump_milk_days":"3","meat_withhold_days":"10"},
  {"key":"300","uom":"ml","dump_milk_days":"abc"}]'::jsonb)) as r;
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run'), 'object_type', 'Drug', 'records', '[
  {"code":"7","name":"KT  Penicilinas","active":"true","medicine_name":"Penicillin","active_substance":null,"default_parameters":"219"},
  {"code":"8","name":"KT Naujas DelPro vaistas","active":"true","active_substance":"Oxytetracyclinum","default_parameters":"218"}]'::jsonb));
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run'), 'object_type', 'Diagnosis', 'records', '[
  {"code":"11","name":"KT Mastitas","active":"true","recommended_treatment":"40"},
  {"code":"12","name":"KT Tik DelPro liga","active":"true"},
  {"code":"13","name":"KT Dviguba","active":"true"},
  {"code":"14","name":"kt  dviguba ","active":"false"},
  {"code":"15","name":"KT Be gydymo","active":"true","recommended_treatment":"999"}]'::jsonb));
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run'), 'object_type', 'Treatment', 'records', '[
  {"code":"40","name":"KT Mastito gydymas","active":"true","treatment_type":"Treatment","drug_usages":"197"}]'::jsonb));
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run'), 'object_type', 'TreatmentDrugUsage', 'records', '[
  {"key":"197","treatment":"40","drug":"7","drug_params":"218","dosage":"20","frequency":"1","treat_cow_days":"1"}]'::jsonb));
select 'cat_finish' as step, r->'status' as status, r->'reconcile' as reconcile
from (select delpro_catalog_finish_run(jsonb_build_object('run_id', current_setting('t.run'), 'types', jsonb_build_object(
  'DrugParameters', '{"complete":true,"returned":3,"limit":5000}'::jsonb, 'Drug', '{"complete":true}'::jsonb,
  'Diagnosis', '{"complete":true}'::jsonb, 'Treatment', '{"complete":true}'::jsonb, 'TreatmentDrugUsage', '{"complete":true}'::jsonb))) as r) x;
reset role;

do $$ begin
  if (select (stats->'DrugParameters'->>'invalid')::int from delpro_catalog_runs where id = current_setting('t.run')::uuid) <> 1 then
    raise exception 'bad DrugParameters record must be counted as invalid, not abort the batch';
  end if;
  if exists (select 1 from delpro_catalog_links) then raise exception 'nothing may be linked automatically'; end if;
  if (select fields->>'dump_milk_days' from delpro_catalog_items where object_type = 'DrugParameters' and delpro_key = '218') <> '0'
     or (select fields->'dosage' from delpro_catalog_items where object_type = 'TreatmentDrugUsage' and delpro_key = '197') <> '20'::jsonb then
    raise exception 'typed normalization failed';
  end if;
  if (select fields->>'name' from delpro_catalog_items where object_type = 'Drug' and delpro_key = '7') <> 'KT Penicilinas' then
    raise exception 'whitespace must be normalized';
  end if;
  if not exists (select 1 from delpro_catalog_issues where status = 'open' and issue_type = 'suggested_match' and object_type = 'Diagnosis' and delpro_key = '11' and gvet_id = '36000000-0000-0000-0000-0000000000d1')
     or not exists (select 1 from delpro_catalog_issues where status = 'open' and issue_type = 'suggested_match' and object_type = 'Drug' and delpro_key = '7' and gvet_id = '36000000-0000-0000-0000-0000000000a1') then
    raise exception 'exact-name suggestions missing';
  end if;
  if (select count(*) from delpro_catalog_issues where status = 'open' and issue_type = 'ambiguous_match' and delpro_key in ('13', '14')) <> 2 then
    raise exception 'two DelPro records with one name must both be ambiguous';
  end if;
  if not exists (select 1 from delpro_catalog_issues where status = 'open' and issue_type = 'broken_reference' and delpro_key = '15') then
    raise exception 'missing RecommendedTreatment must be flagged';
  end if;
  if exists (select 1 from delpro_catalog_issues where delpro_key in ('12', '8')) then raise exception 'no GVET candidate = just unlinked'; end if;
end $$;
select 'cat_treatment_template' as step, code, name, drug_usages->0->>'drug_name' as drug, drug_usages->0->'dosage' as dosage,
       drug_usages->0->'meat_withhold_days' as meat, recommended_for from vw_delpro_catalog_treatments;
select 'cat_summary' as step, object_type, items, linked, unlinked, complete from vw_delpro_catalog_summary order by object_type;

-- only an admin decides; the API can't write the tables or call worker RPCs
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_confirm_suggestions(); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: vet confirmed catalog links'; end if;
end $$;
do $$ declare blocked boolean := false; begin
  begin insert into delpro_catalog_links (object_type, delpro_key, disease_id, origin) values ('Diagnosis', '12', '36000000-0000-0000-0000-0000000000d1', 'manual');
  exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: direct link insert'; end if;
end $$;
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_upload('{}'::jsonb); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: worker RPC from the app'; end if;
end $$;
select 'assert' as step, 'catalog: vet/app cannot link or upload' as what;

-- admin confirms both suggestions; Drug 7's DefaultParameters (milk 3) differ from GVET (milk 4)
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select 'cat_confirm' as step, delpro_catalog_confirm_suggestions()->>'linked' as linked;
select 'cat_initial_diff' as step, issue_type, details->'fields' as fields from delpro_catalog_issues
 where status = 'open' and link_id is not null order by issue_type;

-- keep GVET's 4 -> becomes an outbound change (writing disabled, so it waits)
select delpro_catalog_resolve_issue((select id from delpro_catalog_issues where status = 'open' and issue_type = 'field_difference'), 'keep_gvet');
do $$ begin
  if not exists (select 1 from delpro_catalog_issues where status = 'open' and issue_type = 'outbound_pending'
                 and details->'fields'->'milk_days'->>'gvet' = '4' and details->'fields'->'milk_days'->>'delpro' = '3') then
    raise exception 'keep_gvet must leave an outbound change';
  end if;
  if (select setting_value from system_settings where setting_key = 'delpro_catalog_write_enabled') <> 'false' then raise exception 'catalog writing must default to off'; end if;
end $$;
select 'assert' as step, 'catalog: keep_gvet queues an outbound change' as what;

-- run 2 (DrugParameters only): DelPro changes meat 10 -> 12. Inbound change; other types untouched.
reset role;
set role service_role;
select set_config('t.run', delpro_catalog_begin_run('{"worker_id":"test-pc"}')->>'run_id', false);
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run'), 'object_type', 'DrugParameters', 'records', '[
  {"key":"218","uom":"ml","dump_milk_days":"0","meat_withhold_days":"4"},
  {"key":"219","uom":"ml","application_method":"Intramuscular","dump_milk_days":"3","meat_withhold_days":"12"}]'::jsonb));
select delpro_catalog_finish_run(jsonb_build_object('run_id', current_setting('t.run'), 'types', '{"DrugParameters":{"complete":true}}'::jsonb));
reset role;
do $$ begin
  if not exists (select 1 from delpro_catalog_issues where status = 'open' and issue_type = 'inbound_change' and details->'fields' ? 'meat_days') then
    raise exception 'DelPro edit must show as inbound change';
  end if;
  if (select count(*) from delpro_catalog_items where removed_at is null and object_type = 'Diagnosis') <> 5 then
    raise exception 'a run without Diagnosis must not remove diagnoses';
  end if;
  if (select withdrawal_days_meat from products where id = '36000000-0000-0000-0000-0000000000a1') <> 10 then
    raise exception 'withdrawal days are never applied without review';
  end if;
end $$;

-- take DelPro's 12; the GVET edit this causes is NOT echoed back (no loop)
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_resolve_issue((select id from delpro_catalog_issues where status = 'open' and issue_type = 'inbound_change'), 'take_delpro');
reset role;
do $$ begin
  if (select withdrawal_days_meat from products where id = '36000000-0000-0000-0000-0000000000a1') <> 12 then raise exception 'take_delpro must update GVET'; end if;
  if exists (select 1 from delpro_catalog_issues where status = 'open' and link_id is not null and (details->'fields') ? 'meat_days') then
    raise exception 'applied inbound change must not come back as outbound (loop)';
  end if;
  if (select count(*) from user_audit_logs where action like 'delpro_catalog_%') < 3 then raise exception 'catalog decisions must be audited'; end if;
end $$;
select 'assert' as step, 'catalog: inbound applied once, no sync loop' as what;

-- conflict: GVET milk 4 -> 5 while DelPro milk 3 -> 6
update products set withdrawal_days_milk = 5 where id = '36000000-0000-0000-0000-0000000000a1';
set role service_role;
select set_config('t.run', delpro_catalog_begin_run('{}')->>'run_id', false);
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run'), 'object_type', 'DrugParameters', 'records', '[
  {"key":"218","uom":"ml","dump_milk_days":"0","meat_withhold_days":"4"},
  {"key":"219","uom":"ml","application_method":"Intramuscular","dump_milk_days":"6","meat_withhold_days":"12"}]'::jsonb));
select delpro_catalog_finish_run(jsonb_build_object('run_id', current_setting('t.run'), 'types', '{"DrugParameters":{"complete":true}}'::jsonb));
reset role;
select 'cat_conflict' as step, issue_type, details->'fields'->'milk_days' as milk from delpro_catalog_issues where status = 'open' and issue_type = 'conflict';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_resolve_issue((select id from delpro_catalog_issues where status = 'open' and issue_type = 'conflict'), 'take_delpro');
reset role;
do $$ begin
  if (select withdrawal_days_milk from products where id = '36000000-0000-0000-0000-0000000000a1') <> 6 then raise exception 'conflict resolution failed'; end if;
  if exists (select 1 from delpro_catalog_issues where status = 'open' and gvet_id = '36000000-0000-0000-0000-0000000000a1') then
    raise exception 'resolved link must be clean: %', (select jsonb_agg(details) from delpro_catalog_issues where status = 'open' and gvet_id = '36000000-0000-0000-0000-0000000000a1');
  end if;
end $$;
select 'assert' as step, 'catalog: conflict detected and reconciled' as what;

-- auto inbound mode applies a DelPro rename (never withdrawal days)
update system_settings set setting_value = 'auto' where setting_key = 'delpro_catalog_inbound_mode';
set role service_role;
select set_config('t.run', delpro_catalog_begin_run('{}')->>'run_id', false);
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run'), 'object_type', 'Drug', 'records', '[
  {"code":"7","name":"KT Penicilinas LA","active":"true","default_parameters":"219"},
  {"code":"8","name":"KT Naujas DelPro vaistas","active":"true","active_substance":"Oxytetracyclinum","default_parameters":"218"}]'::jsonb));
select delpro_catalog_finish_run(jsonb_build_object('run_id', current_setting('t.run'), 'types', '{"Drug":{"complete":true}}'::jsonb));
reset role;
update system_settings set setting_value = 'review' where setting_key = 'delpro_catalog_inbound_mode';
do $$ begin
  if (select name from products where id = '36000000-0000-0000-0000-0000000000a1') <> 'KT Penicilinas LA' then raise exception 'auto mode must apply the rename'; end if;
  if exists (select 1 from delpro_catalog_issues where status = 'open' and gvet_id = '36000000-0000-0000-0000-0000000000a1') then raise exception 'auto-applied rename left an issue'; end if;
end $$;
select 'assert' as step, 'catalog: auto mode applies names only' as what;

-- import unlinked DelPro records into GVET; duplicates refused
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select 'cat_import_drug' as step, delpro_catalog_import('Drug', array['8', '7'])->'skipped'->0->>'reason' as skipped_reason;
select 'cat_import_diag' as step, (r->>'created')::int as created from (select delpro_catalog_import('Diagnosis', array['12']) as r) x;
reset role;
select 'cat_imported' as step, p.name, p.unit, p.withdrawal_days_milk, p.withdrawal_days_meat, p.active_substance, l.origin
from products p join delpro_catalog_links l on l.product_id = p.id and l.retired_at is null where p.name = 'KT Naujas DelPro vaistas';
do $$ begin
  if not exists (select 1 from delpro_catalog_issues where status = 'open' and issue_type = 'clinical_review' and delpro_key = '8') then
    raise exception 'imported drug must wait for clinical review';
  end if;
  if not exists (select 1 from diseases d join delpro_catalog_links l on l.disease_id = d.id where d.name = 'KT Tik DelPro liga') then
    raise exception 'diagnosis import failed';
  end if;
end $$;

-- removals: only on complete snapshots; linked removal is flagged, never deleted
set role service_role;
select set_config('t.run', delpro_catalog_begin_run('{}')->>'run_id', false);
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run'), 'object_type', 'Diagnosis', 'records', '[
  {"code":"12","name":"KT Tik DelPro liga","active":"true"},{"code":"13","name":"KT Dviguba"},{"code":"14","name":"kt dviguba"}]'::jsonb));
select 'cat_removed' as step, r->'stats'->'Diagnosis'->'removed' as removed
from (select delpro_catalog_finish_run(jsonb_build_object('run_id', current_setting('t.run'), 'types', '{"Diagnosis":{"complete":true}}'::jsonb)) as r) x;
-- empty "complete" snapshot removes nothing
select set_config('t.run', delpro_catalog_begin_run('{}')->>'run_id', false);
select 'cat_empty' as step, r->'stats'->'Diagnosis' as stats
from (select delpro_catalog_finish_run(jsonb_build_object('run_id', current_setting('t.run'), 'types', '{"Diagnosis":{"complete":true}}'::jsonb)) as r) x;
reset role;
do $$ begin
  if not exists (select 1 from delpro_catalog_issues where status = 'open' and issue_type = 'removed_in_delpro' and delpro_key = '11') then
    raise exception 'linked record removed in DelPro must be flagged';
  end if;
  if not exists (select 1 from delpro_catalog_links where delpro_key = '11' and retired_at is null) then raise exception 'link must survive removal'; end if;
  if exists (select 1 from delpro_catalog_issues where status = 'open' and issue_type = 'broken_reference' and delpro_key = '15') then
    raise exception 'issue of a removed record must close';
  end if;
  if (select count(*) from delpro_catalog_items where object_type = 'Diagnosis' and removed_at is null) <> 3 then raise exception 'empty snapshot must not remove'; end if;
end $$;

-- mass-removal guard: 20 diagnoses, then a "complete" snapshot with 2 of them
set role service_role;
select set_config('t.run', delpro_catalog_begin_run('{}')->>'run_id', false);
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run'), 'object_type', 'Diagnosis',
  'records', (select jsonb_agg(jsonb_build_object('code', 'G' || g, 'name', 'KT guard ' || g)) from generate_series(1, 20) g)));
select delpro_catalog_finish_run(jsonb_build_object('run_id', current_setting('t.run'), 'types', '{"Diagnosis":{"complete":false}}'::jsonb));
select set_config('t.run', delpro_catalog_begin_run('{}')->>'run_id', false);
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run'), 'object_type', 'Diagnosis', 'records', '[{"code":"G1","name":"KT guard 1"},{"code":"G2","name":"KT guard 2"}]'::jsonb));
select 'cat_guard' as step, r->'stats'->'Diagnosis'->>'note' as note, r->'stats'->'Diagnosis'->'removed' as removed
from (select delpro_catalog_finish_run(jsonb_build_object('run_id', current_setting('t.run'), 'types', '{"Diagnosis":{"complete":true}}'::jsonb)) as r) x;
reset role;
select 'assert' as step, 'catalog: removals only from complete, plausible snapshots' as what;

-- manual sync request, animal GUID mapping (real Gateway pair for animal 337)
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_request_sync();
reset role;
set role service_role;
select 'cat_requested' as step, delpro_catalog_sync_requested('{}') as requested;
select set_config('t.run', delpro_catalog_begin_run('{}')->>'run_id', false);
select 'cat_animal_ids' as step, delpro_ingest_animal_ids(jsonb_build_object('run_id', current_setting('t.run'), 'animals', '[
  {"object_guid":"f3d9f5df-f72f-4659-8d25-66a02cf583eb","number":"KT337"},{"object_guid":"00000000-0000-0000-0000-000000000999","number":"nope"}]'::jsonb)) as r;
select delpro_catalog_finish_run(jsonb_build_object('run_id', current_setting('t.run'), 'types', '{}'::jsonb));
select 'cat_requested_after' as step, delpro_catalog_sync_requested('{}') as requested;
select 'cat_animal_conflict' as step, delpro_ingest_animal_ids('{"animals":[{"object_guid":"11111111-2222-3333-4444-555555555555","number":"KT337"}]}'::jsonb)->'conflicts' as conflicts;
reset role;
do $$ begin
  if (select delpro_object_guid from animals where animal_no = 'KT337') <> 'f3d9f5df-f72f-4659-8d25-66a02cf583eb' then raise exception 'animal GUID mapping failed'; end if;
end $$;
select 'assert' as step, 'catalog: sync request + animal ids' as what;

-- deleting a linked GVET disease retires the link (history kept)
delete from diseases where name = 'KT Tik DelPro liga';
do $$ begin
  if not exists (select 1 from delpro_catalog_links where delpro_key = '12' and retired_at is not null and retire_reason = 'GVET įrašas ištrintas') then
    raise exception 'link must be retired, not lost';
  end if;
end $$;
select 'assert' as step, 'catalog: deleted GVET record retires its link' as what;

-- a herd number reported with two GUIDs is skipped, never guessed
insert into animals (tag_no, animal_no, active) values ('LT0000000KT338', 'KT338', true);
set role service_role;
select 'cat_animal_dup' as step, delpro_ingest_animal_ids('{"animals":[{"object_guid":"21111111-2222-3333-4444-555555555555","number":"KT338"},
  {"object_guid":"31111111-2222-3333-4444-555555555555","number":"KT338"}]}'::jsonb)->'ambiguous' as ambiguous;
reset role;
do $$ begin
  if (select delpro_object_guid from animals where animal_no = 'KT338') is not null then raise exception 'ambiguous number must not be mapped'; end if;
end $$;
select 'assert' as step, 'catalog: reused herd number is not guessed' as what;

-- 0047: an animal without a short DelPro Number gets its GUID by ORN
insert into animals (tag_no, animal_no, active, source) values ('LT000007300901', null, true, 'vic'), ('LT000007300902', 'KT902', true, 'delpro'),
  ('LT000007300903', 'KT903', true, 'delpro'), ('LT000007300904', null, true, 'vic');
set role service_role;
select 'cat_animal_orn' as step, delpro_ingest_animal_ids('{"animals":[
  {"object_guid":"51111111-2222-3333-4444-555555555555","number":"901","orn":"lt 0000 0730 0901"},
  {"object_guid":"61111111-2222-3333-4444-555555555555","number":"KT903","orn":"LT000007300902"},
  {"object_guid":"71111111-2222-3333-4444-555555555555","orn":"LT000007300904"},
  {"object_guid":"81111111-2222-3333-4444-555555555555","orn":"LT000007300904"}]}'::jsonb) as r;
reset role;
do $$ begin
  if (select delpro_object_guid from animals where tag_no = 'LT000007300901') is distinct from '51111111-2222-3333-4444-555555555555' then
    raise exception 'ORN match must set the GUID';
  end if;
  if (select animal_no from animals where tag_no = 'LT000007300901') is not null then raise exception 'ORN match must not invent a Number'; end if;
  if exists (select 1 from animals where tag_no in ('LT000007300902', 'LT000007300903') and delpro_object_guid is not null) then
    raise exception 'ORN and Number on different animals must not be mapped';
  end if;
  if (select delpro_object_guid from animals where tag_no = 'LT000007300904') is not null then raise exception 'ORN with two GUIDs must not be mapped'; end if;
end $$;
select 'assert' as step, 'catalog: animal GUID by ORN, conflicts skipped' as what;

-- 19. DelPro catalog phase 2 (0037): templates, write queue + gate, Gateway treatment channel.
-- 19a. Import DelPro Treatment 40 as a GVET template (its drug 7 is linked to 'KT Penicilinas LA').
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select 'tpl_import' as step, (r->>'created')::int as created, r->'skipped' as skipped from (select delpro_catalog_import('Treatment', array['40']) as r) x;
reset role;
select 'tpl_items' as step, t.name, i.dosage, i.frequency, i.treat_cow_days, i.uom, i.milk_days, i.meat_days, i.delpro_usage_key, i.delpro_params_key
from treatment_templates t join treatment_template_items i on i.template_id = t.id where t.name = 'KT Mastito gydymas';
do $$ begin
  if exists (select 1 from delpro_catalog_issues where status = 'open' and gvet_table = 'treatment_templates' and issue_type <> 'clinical_review') then
    raise exception 'freshly imported template must agree with DelPro: %', (select jsonb_agg(details) from delpro_catalog_issues where status = 'open' and gvet_table = 'treatment_templates');
  end if;
  if not exists (select 1 from delpro_catalog_issues where status = 'open' and issue_type = 'clinical_review' and object_type = 'Treatment') then
    raise exception 'imported template must wait for clinical review';
  end if;
end $$;

-- 19b. the vet changes the dose 20 -> 25 -> outbound change on 'usages'
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select save_treatment_template((select jsonb_build_object('id', t.id, 'name', t.name, 'active', t.active, 'treatment_type', t.treatment_type,
  'items', jsonb_agg(jsonb_build_object('id', i.id, 'product_id', i.product_id, 'dosage', 25, 'frequency', i.frequency, 'treat_cow_days', i.treat_cow_days,
                                        'uom', i.uom, 'milk_days', i.milk_days, 'meat_days', i.meat_days))) from treatment_templates t join treatment_template_items i on i.template_id = t.id
  where t.name = 'KT Mastito gydymas' group by t.id)) is not null as saved;
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_set_write_enabled(true); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: vet enabled DelPro writes'; end if;
end $$;
reset role;
select 'tpl_outbound' as step, issue_type, details->'fields'->'usages'->'gvet'->0->'dosage' as gvet_dose, details->'fields'->'usages'->'delpro'->0->'dosage' as delpro_dose
from delpro_catalog_issues where status = 'open' and gvet_table = 'treatment_templates' and issue_type = 'outbound_pending';

-- 19c. admin sends it: params 218 are shared (drug 8 default + usage 197) -> a NEW params record, usage re-pointed
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_resolve_issue((select id from delpro_catalog_issues where status = 'open' and gvet_table = 'treatment_templates' and issue_type = 'outbound_pending'), 'send');
reset role;
select 'tpl_job_steps' as step, s->>'id' as id, s->>'object' as object, s->>'operation' as op, s->>'key' as key
from delpro_catalog_jobs j, jsonb_array_elements(j.steps) s where j.object_type = 'Treatment' and j.status = 'queued';

-- 19d. the gate: nothing is handed out while writing is off, nor for an unvalidated operation
set role service_role;
select 'gate_off' as step, delpro_catalog_claim_job('{"worker_id":"test-pc"}') is null as nothing;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_set_write_enabled(true);
reset role;
set role service_role;
select 'gate_unvalidated' as step, delpro_catalog_claim_job('{"worker_id":"test-pc"}') is null as nothing;
reset role;

-- 19e. a TEST job (inactive "GVET TEST" record) runs, then its operation can be marked validated
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_create_test_job('Diagnosis.create');
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_create_test_job('Diagnosis.update'); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: update test before a create test'; end if;
end $$;
reset role;
set role service_role;
select set_config('t.job', (select delpro_catalog_claim_job('{"worker_id":"test-pc"}')->>'job_id'), false);
select 'test_job_claimed' as step, is_test, steps->0->'properties' as props from delpro_catalog_jobs where id = current_setting('t.job')::uuid;
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.job'), 'step', 'main', 'phase', 'start'));
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.job'), 'step', 'main', 'phase', 'done', 'key', 'T1'));
select 'test_job_done' as step, delpro_catalog_job_result(jsonb_build_object('job_id', current_setting('t.job'), 'success', true,
  'readback', jsonb_build_array(jsonb_build_object('object_type', 'Diagnosis', 'record', jsonb_build_object('code', 'T1', 'name', 'GVET TEST x', 'active', false)))))->>'status' as status;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_mark_validated(current_setting('t.job')::uuid);
reset role;
do $$ begin
  if (select setting_value from system_settings where setting_key = 'delpro_catalog_validated_operations') <> 'Diagnosis.create' then raise exception 'validation not recorded'; end if;
  if not exists (select 1 from delpro_catalog_items where object_type = 'Diagnosis' and delpro_key = 'T1' and active = false) then raise exception 'read-back must land in the mirror'; end if;
end $$;
select 'assert' as step, 'catalog write: gate + test job + validation' as what;

-- 19f. Treatment.update validated (same test-job route as above) -> the real template job runs
update system_settings set setting_value = 'Diagnosis.create,Treatment.update' where setting_key = 'delpro_catalog_validated_operations';
set role service_role;
select set_config('t.job', (select delpro_catalog_claim_job('{"worker_id":"test-pc"}')->>'job_id'), false);
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.job'), 'step', 'params_1', 'phase', 'start'));
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.job'), 'step', 'params_1', 'phase', 'done', 'key', 'P900'));
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.job'), 'step', 'usage_1', 'phase', 'start'));
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.job'), 'step', 'usage_1', 'phase', 'done', 'key', '197'));
select 'tpl_job_done' as step, delpro_catalog_job_result(jsonb_build_object('job_id', current_setting('t.job'), 'success', true, 'readback', '[
  {"object_type":"DrugParameters","record":{"key":"P900","uom":"ml","dump_milk_days":0,"meat_withhold_days":4}},
  {"object_type":"TreatmentDrugUsage","record":{"key":"197","treatment":"40","drug":"7","drug_params":"P900","dosage":25,"frequency":1,"treat_cow_days":1}}]'::jsonb))->>'status' as status;
reset role;
do $$ begin
  if exists (select 1 from delpro_catalog_issues where status = 'open' and gvet_table = 'treatment_templates' and issue_type <> 'clinical_review') then
    raise exception 'after the verified write GVET and DelPro must agree: %', (select jsonb_agg(details) from delpro_catalog_issues where status = 'open' and gvet_table = 'treatment_templates');
  end if;
  if (select delpro_params_key from treatment_template_items i join treatment_templates t on t.id = i.template_id where t.name = 'KT Mastito gydymas') <> 'P900' then
    raise exception 'template line must remember its new DelPro parameters';
  end if;
  if (select fields->>'dump_milk_days' from delpro_catalog_items where object_type = 'DrugParameters' and delpro_key = '218') <> '0' then
    raise exception 'shared parameters 218 must be untouched';
  end if;
end $$;
select 'assert' as step, 'catalog write: template update verified, shared params untouched, no echo' as what;

-- 19g. create in DelPro: a step started but never finished survives a lost worker (outcome unknown)
reset role;
insert into diseases (id, name) values ('37000000-0000-0000-0000-0000000000d1', 'KT Nauja GVET liga');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_enqueue_create('Diagnosis', '37000000-0000-0000-0000-0000000000d1');
reset role;
set role service_role;
select set_config('t.job', (select delpro_catalog_claim_job('{"worker_id":"test-pc","lease_seconds":60}')->>'job_id'), false);
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.job'), 'step', 'main', 'phase', 'start'));
reset role;
update delpro_catalog_jobs set lease_expires_at = now() - interval '1 minute' where id = current_setting('t.job')::uuid;
set role service_role;
select 'lease_reclaim' as step, (r->'progress'->'main'->>'started_at') is not null as started_known, r->'steps'->0->>'lookup_name' as lookup
from (select delpro_catalog_claim_job('{"worker_id":"test-pc"}') as r) x;
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.job'), 'step', 'main', 'phase', 'done', 'key', '501'));
select delpro_catalog_job_result(jsonb_build_object('job_id', current_setting('t.job'), 'success', true,
  'readback', '[{"object_type":"Diagnosis","record":{"code":"501","name":"KT Nauja GVET liga","active":true}}]'::jsonb));
reset role;
do $$ begin
  if not exists (select 1 from delpro_catalog_links where disease_id = '37000000-0000-0000-0000-0000000000d1' and delpro_key = '501' and origin = 'created' and retired_at is null) then
    raise exception 'created record must be linked';
  end if;
  if exists (select 1 from delpro_catalog_issues where status = 'open' and gvet_id = '37000000-0000-0000-0000-0000000000d1') then raise exception 'new link must agree'; end if;
end $$;

-- 19g2. unknown outcome is never resolved by name: retry refused, admin adopts a key (checked) or confirms a resend
reset role;
insert into diseases (id, name) values ('37000000-0000-0000-0000-0000000000e7', 'KT Neaiški liga');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_enqueue_create('Diagnosis', '37000000-0000-0000-0000-0000000000e7');
reset role;
select set_config('t.job2', (select id::text from delpro_catalog_jobs where disease_id = '37000000-0000-0000-0000-0000000000e7' and status = 'queued'), false);
update delpro_catalog_jobs set status = 'processing', attempts = 1 where id = current_setting('t.job2')::uuid;
set role service_role;
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.job2'), 'step', 'main', 'phase', 'start'));
select delpro_catalog_job_result(jsonb_build_object('job_id', current_setting('t.job2'), 'success', false, 'needs_review', true,
  'error', 'rezultatas nežinomas', 'details', '{"uncertain_step":"main","candidates":[{"key":"601","name":"KT Neaiški liga"}]}'::jsonb));
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_job_action(current_setting('t.job2')::uuid, 'retry'); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: retry with an uncertain step'; end if;
end $$;
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_job_action(current_setting('t.job2')::uuid, 'adopt', 'main', '501'); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: adopting a key linked to another GVET record'; end if;
end $$;
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_job_action(current_setting('t.job2')::uuid, 'adopt', 'main', ''); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: adopt without a key'; end if;
end $$;
select delpro_catalog_job_action(current_setting('t.job2')::uuid, 'resend', 'main');
reset role;
do $$ begin
  if (select status from delpro_catalog_jobs where id = current_setting('t.job2')::uuid) <> 'queued'
     or (select progress->'main' ? 'started_at' from delpro_catalog_jobs where id = current_setting('t.job2')::uuid) then
    raise exception 'resend must clear the uncertain start and queue the job';
  end if;
end $$;
-- the same again, now adopting a record the admin found in DelPro
update delpro_catalog_jobs set status = 'needs_review', progress = jsonb_build_object('main', jsonb_build_object('started_at', now()))
where id = current_setting('t.job2')::uuid;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_job_action(current_setting('t.job2')::uuid, 'adopt', 'main', '601');
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_job_action(current_setting('t.job2')::uuid, 'adopt', 'main', '602'); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: adopting twice'; end if;
end $$;
reset role;
select 'adopted' as step, status, progress->'main'->>'key' as key, (progress->'main'->>'adopted_by') is not null as by_admin,
  (select count(*) from user_audit_logs where record_id = current_setting('t.job2')::uuid and action = 'delpro_catalog_job_adopt') as audited
from delpro_catalog_jobs where id = current_setting('t.job2')::uuid;
update delpro_catalog_jobs set status = 'cancelled' where id = current_setting('t.job2')::uuid;

-- 19h. failures: retryable -> queued with backoff; read-back mismatch -> verification_failed; supersede
update diseases set name = 'KT Nauja GVET liga 2' where id = '37000000-0000-0000-0000-0000000000d1';
update system_settings set setting_value = 'Diagnosis.create,Diagnosis.update,Treatment.update' where setting_key = 'delpro_catalog_validated_operations';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_resolve_issue((select id from delpro_catalog_issues where status = 'open' and gvet_id = '37000000-0000-0000-0000-0000000000d1' and issue_type = 'outbound_pending'), 'send');
reset role;
update diseases set name = 'KT Nauja GVET liga 3' where id = '37000000-0000-0000-0000-0000000000d1';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_resolve_issue((select id from delpro_catalog_issues where status = 'open' and gvet_id = '37000000-0000-0000-0000-0000000000d1' and issue_type = 'outbound_pending'), 'send');
reset role;
select 'supersede' as step, status, steps->0->'properties'->0->>'value' as name from delpro_catalog_jobs
where disease_id = '37000000-0000-0000-0000-0000000000d1' and operation = 'update' order by created_at;
set role service_role;
select set_config('t.job', (select delpro_catalog_claim_job('{"worker_id":"test-pc"}')->>'job_id'), false);
select 'retryable' as step, delpro_catalog_job_result(jsonb_build_object('job_id', current_setting('t.job'), 'success', false, 'retryable', true, 'error', 'Gateway: TIMEOUT'))->>'status' as status;
reset role;
update delpro_catalog_jobs set next_attempt_at = now() - interval '1 second' where id = current_setting('t.job')::uuid;
set role service_role;
select delpro_catalog_claim_job('{"worker_id":"test-pc"}') is not null as reclaimed;
select 'mismatch' as step, delpro_catalog_job_result(jsonb_build_object('job_id', current_setting('t.job'), 'success', false, 'verification_failed', true,
  'error', 'Name: laukta „KT Nauja GVET liga 3“, DelPro „KT Nauja GVET liga“'))->>'status' as status;
reset role;
select 'assert' as step, 'catalog write: retry, verification failure, supersede' as what;

-- 19i. auto outbound: a GVET record created after auto mode is switched on is queued for creation
update system_settings set setting_value = 'auto' where setting_key = 'delpro_catalog_outbound_mode';
insert into diseases (id, name) values ('37000000-0000-0000-0000-0000000000d2', 'KT Auto liga');
select fn_delpro_catalog_reconcile()->'queued' as queued;
do $$ begin
  if not exists (select 1 from delpro_catalog_jobs where disease_id = '37000000-0000-0000-0000-0000000000d2' and operation = 'create' and status = 'queued') then
    raise exception 'auto mode must queue new GVET records';
  end if;
  if exists (select 1 from delpro_catalog_jobs where disease_id = '36000000-0000-0000-0000-0000000000d2' and operation = 'create') then
    raise exception 'records older than the switch must not be queued';
  end if;
end $$;
update system_settings set setting_value = 'manual' where setting_key = 'delpro_catalog_outbound_mode';
update system_settings set setting_value = 'false' where setting_key = 'delpro_catalog_write_enabled';
select 'assert' as step, 'catalog write: auto outbound queues new records only' as what;

-- 19j. Gateway channel for treatments (off by default): problems, claim, verified report
update delpro_sync_jobs set status = 'rejected' where status in ('approved', 'pending_approval'); -- isolate this check
insert into batches (product_id, lot, expiry_date, received_qty) values ('36000000-0000-0000-0000-0000000000a1', 'GW1', '2030-01-01', 100);
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_link('Diagnosis', '13', '36000000-0000-0000-0000-0000000000d2');
reset role;
update system_settings set setting_value = 'gateway' where setting_key = 'delpro_write_channel';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select set_config('t.treat', create_treatment_with_visits(jsonb_build_object('animal_id', (select id from animals where animal_no = 'KT338'), 'reg_date', '2026-10-29',
  'diagnosis', 'Mastitas', 'disease_id', '36000000-0000-0000-0000-0000000000d2', 'vet_name', 'Dr. Test',
  'medications', jsonb_build_array(jsonb_build_object('product_id', '36000000-0000-0000-0000-0000000000a1', 'qty', 10, 'unit', 'ml',
    'frequency_per_day', 2, 'course_days', 3))))::text, false);
reset role;
select 'gw_problems' as step, jsonb_agg(p->>'code' order by p->>'code') as codes
from jsonb_array_elements(fn_delpro_transfer_problems(current_setting('t.treat')::uuid)) p;
update animals set delpro_object_guid = '41111111-2222-3333-4444-555555555555' where animal_no = 'KT338';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select 'gw_approve' as step, delpro_approve_treatment(current_setting('t.treat')::uuid)->>'outcome' as outcome;
reset role;
set role service_role;
select 'gw_wrong_channel' as step, delpro_claim_next_job('ui-pc', 'ui_script') is null as nothing;
select set_config('t.gw', delpro_claim_next_job('gw-pc', 'gateway')::text, false);
select 'gw_claim' as step, current_setting('t.gw')::jsonb->>'channel' as channel,
       current_setting('t.gw')::jsonb->'gateway'->>'diagnosis_code' as diagnosis,
       left(current_setting('t.gw')::jsonb->'gateway'->>'comment', 5) as marker,
       current_setting('t.gw')::jsonb->'gateway'->>'event_time' as event_time,
       current_setting('t.gw')::jsonb->'verify_before_write' as verify;
select 'gw_report' as step, delpro_report_job_result(jsonb_build_object('sync_id', current_setting('t.gw')::jsonb->>'sync_id', 'success', true,
  'actual_result', jsonb_build_object('channel', 'gateway', 'object_guid', '489751f2-ffc7-4491-a445-482160d62620',
    'animal_guid', '41111111-2222-3333-4444-555555555555', 'diagnosis_code', '13',
    'event_date', current_setting('t.gw')::jsonb->'gateway'->>'event_at',
    'comment', current_setting('t.gw')::jsonb->'gateway'->>'comment')))->>'status' as status;
reset role;
update system_settings set setting_value = 'ui_script' where setting_key = 'delpro_write_channel';
select 'assert' as step, 'gateway channel: guid + catalog diagnosis required, marker frozen, read-back verified' as what;

-- 20. DelPro -> GVET import with preview + approval (0039): mappings, exact unique names, review, blocked, idempotent.
reset role;
update system_settings set setting_value = 'false' where setting_key = 'delpro_catalog_write_enabled';
insert into diseases (id, name) values
  ('39000000-0000-0000-0000-0000000000d1', 'KT Import Esama'),
  ('39000000-0000-0000-0000-0000000000d2', 'KT Ūkio pavadinimas');
insert into delpro_mappings (kind, local_id, delpro_code) values ('disease', '39000000-0000-0000-0000-0000000000d2', '903');
set role service_role;
select set_config('t.run20', delpro_catalog_begin_run('{"worker_id":"test-pc"}')->>'run_id', false);
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run20'), 'object_type', 'DrugParameters', 'records', '[
  {"key":"9510","uom":"ml","application_method":"7","dump_milk_days":"2","meat_withhold_days":"5"},
  {"key":"9530","uom":"xyz","dump_milk_days":"0","meat_withhold_days":"0"}]'::jsonb));
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run20'), 'object_type', 'Drug', 'records', '[
  {"code":"951","name":"KT Import Vaistas","active":"true","active_substance":"Ceftiofurum","default_parameters":"9510"},
  {"code":"952","name":"KT Import Be parametrų","active":"true","default_parameters":"9520"},
  {"code":"953","name":"KT Import Keistas vienetas","active":"true","default_parameters":"9530"}]'::jsonb));
select delpro_catalog_upload(jsonb_build_object('run_id', current_setting('t.run20'), 'object_type', 'Diagnosis', 'records', '[
  {"code":"901","name":"KT Import Nauja","active":"true"},
  {"code":"902","name":"KT  import esama","active":"true"},
  {"code":"903","name":"KT DelPro kodu susieta","active":"true"},
  {"code":"904","name":"KT Import Du","active":"true"},
  {"code":"905","name":"KT Import Du","active":"false"},
  {"code":"906","name":"KT Mastitas","active":"true"},
  {"code":"909","name":"KT Import Vėliau","active":"true"}]'::jsonb));
-- DrugParameters incomplete (as on the farm): nothing may be removed, unknown parameters never guessed
select 'imp_run' as step, r->>'status' as status from (select delpro_catalog_finish_run(jsonb_build_object('run_id', current_setting('t.run20'), 'types', jsonb_build_object(
  'DrugParameters', '{"complete":false,"note":"truncated"}'::jsonb, 'Drug', '{"complete":false}'::jsonb, 'Diagnosis', '{"complete":false}'::jsonb))) as r) x;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_import_preview(); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: a vet previewing the import'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select set_config('t.plan', delpro_catalog_import_preview()::text, false);
reset role;
select 'imp_plan' as step, r->>'delpro_key' as key, r->>'action' as action, r->>'match_source' as source, r->>'gvet_name' as gvet, r->>'reason' as reason
from jsonb_array_elements(current_setting('t.plan')::jsonb->'rows') r
where r->>'delpro_key' in ('901','902','903','904','905','906','909','951','952','953') order by r->>'delpro_key';
do $$
declare
  a jsonb := (select jsonb_object_agg(r->>'delpro_key', r->>'action') from jsonb_array_elements(current_setting('t.plan')::jsonb->'rows') r);
begin
  if a->>'901' <> 'create' or a->>'902' <> 'link' or a->>'903' <> 'link' or a->>'904' <> 'review' or a->>'905' <> 'review'
     or a->>'906' <> 'review' or a->>'951' <> 'create' or a->>'952' <> 'blocked' or a->>'953' <> 'blocked' then
    raise exception 'import plan wrong: %', a;
  end if;
  if (current_setting('t.plan')::jsonb->>'drug_parameters_complete')::boolean then
    raise exception 'DrugParameters must be reported incomplete';
  end if;
end $$;

-- approve: create 901 + 951, link 902 (name) + 903 (farm mapping), and try to sneak in review 904 and blocked 952
select set_config('t.items', (select jsonb_agg(jsonb_build_object('object_type', r->>'object_type', 'delpro_key', r->>'delpro_key',
  'action', case when r->>'delpro_key' in ('904', '952') then 'create' else r->>'action' end, 'fingerprint', r->>'fingerprint'))
  from jsonb_array_elements(current_setting('t.plan')::jsonb->'rows') r where r->>'delpro_key' in ('901','902','903','904','951','952'))::text, false);
-- a DelPro change after the preview makes that row stale
set role service_role;
select fn_delpro_catalog_put_item('Diagnosis', '{"code":"909","name":"KT Import Vėliau pakeista","active":"true"}'::jsonb);
reset role;
select set_config('t.items', (current_setting('t.items')::jsonb || (select jsonb_build_object('object_type', 'Diagnosis', 'delpro_key', '909', 'action', 'create', 'fingerprint', r->>'fingerprint')
  from jsonb_array_elements(current_setting('t.plan')::jsonb->'rows') r where r->>'delpro_key' = '909'))::text, false);
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select set_config('t.applied', delpro_catalog_import_apply(current_setting('t.items')::jsonb)::text, false);
reset role;
select 'imp_apply' as step, current_setting('t.applied')::jsonb->>'created' as created, current_setting('t.applied')::jsonb->>'linked' as linked,
       (select jsonb_agg(s->>'key' order by s->>'key') from jsonb_array_elements(current_setting('t.applied')::jsonb->'skipped') s) as skipped;
do $$ begin
  if (current_setting('t.applied')::jsonb->>'created')::int <> 2 or (current_setting('t.applied')::jsonb->>'linked')::int <> 2 then
    raise exception 'import apply counts wrong: %', current_setting('t.applied');
  end if;
  if (select origin from delpro_catalog_links where object_type = 'Diagnosis' and delpro_key = '901' and retired_at is null) <> 'imported'
     or (select import_snapshot->>'source' from delpro_catalog_links where delpro_key = '903' and object_type = 'Diagnosis') <> 'mapping'
     or (select disease_id from delpro_catalog_links where delpro_key = '903' and object_type = 'Diagnosis' and retired_at is null) <> '39000000-0000-0000-0000-0000000000d2' then
    raise exception 'import provenance / mapping link wrong';
  end if;
  -- linking never overwrites GVET: the name stays, the difference is shown for a decision
  if (select name from diseases where id = '39000000-0000-0000-0000-0000000000d2') <> 'KT Ūkio pavadinimas'
     or not exists (select 1 from delpro_catalog_issues where status = 'open' and issue_type = 'field_difference' and delpro_key = '903') then
    raise exception 'linking must keep GVET values and flag the difference';
  end if;
  if (select row(unit::text, withdrawal_days_milk, withdrawal_days_meat, active_substance, is_active)::text from products where name = 'KT Import Vaistas')
     <> row('ml', 2, 5, 'Ceftiofurum', true)::text then
    raise exception 'imported medicine values wrong';
  end if;
  if (select import_snapshot->'params'->>'application_method' from delpro_catalog_links where object_type = 'Drug' and delpro_key = '951') <> '7'
     or not exists (select 1 from delpro_catalog_issues where status = 'open' and issue_type = 'clinical_review' and delpro_key = '951') then
    raise exception 'imported medicine must keep its DelPro parameters and get a clinical review';
  end if;
  if exists (select 1 from products where name like 'KT Import Be param%') or exists (select 1 from diseases where name like 'KT Import Du%')
     or exists (select 1 from diseases where name like 'KT Import Vėliau%') then
    raise exception 'blocked / review / stale rows must not be imported';
  end if;
end $$;
-- the same approval again: nothing new, no duplicates
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select 'imp_again' as step, r->>'created' as created, r->>'linked' as linked from (select delpro_catalog_import_apply(current_setting('t.items')::jsonb) as r) x;
reset role;
do $$ begin
  if (select count(*) from diseases where name = 'KT Import Nauja') <> 1 or (select count(*) from products where name = 'KT Import Vaistas') <> 1 then
    raise exception 'repeating the import must not duplicate';
  end if;
  if exists (select 1 from fn_delpro_catalog_import_plan('Diagnosis') p where p.delpro_key in ('901','902','903') and p.action <> 'linked') then
    raise exception 'imported rows must plan as linked';
  end if;
end $$;
select 'assert' as step, 'import: preview, approval, mapping/name/review/blocked, stale, idempotent' as what;

-- 21. First real GVET -> DelPro medicine (pilot): one test medicine, one job, a gate for exactly that job.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_create_pilot_drug(); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: a vet creating the pilot'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select set_config('t.pilot', delpro_catalog_create_pilot_drug()->>'job_id', false);
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_create_pilot_drug(); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: a second pilot'; end if;
end $$;
select delpro_catalog_create_test_job('Diagnosis.create'); -- another job that must stay untouched
reset role;
select 'pilot_job' as step, j.status, j.pilot, j.is_test, p.is_active, p.unit, jsonb_path_query_array(j.steps, '$[*].object') as objects,
       (select s->'properties' from jsonb_array_elements(j.steps) s where s->>'id' = 'main') as drug_props
from delpro_catalog_jobs j join products p on p.id = j.product_id where j.id = current_setting('t.pilot')::uuid;

set role service_role;
select 'pilot_gate_closed' as step, delpro_catalog_claim_job(jsonb_build_object('worker_id', 'pc', 'job_id', current_setting('t.pilot'))) is null as nothing;
reset role;
-- the global switch alone does not release an unvalidated Drug.create
update system_settings set setting_value = 'true' where setting_key = 'delpro_catalog_write_enabled';
set role service_role;
select 'pilot_global_only' as step, delpro_catalog_claim_job(jsonb_build_object('worker_id', 'pc', 'job_id', current_setting('t.pilot'))) is null as nothing;
reset role;
update system_settings set setting_value = 'false' where setting_key = 'delpro_catalog_write_enabled';

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select delpro_catalog_release_single_job(current_setting('t.pilot')::uuid);
reset role;
set role service_role;
do $$ begin
  if delpro_catalog_claim_job('{"worker_id":"pc"}') is not null then
    raise exception 'a released single job must not go to a worker that does not name it';
  end if;
  if delpro_catalog_claim_job(jsonb_build_object('worker_id', 'pc', 'job_id',
       (select id from delpro_catalog_jobs where is_test and status = 'queued' and object_type = 'Diagnosis' order by created_at desc limit 1))) is not null then
    raise exception 'only the released job may be claimed';
  end if;
end $$;
select set_config('t.claim', delpro_catalog_claim_job(jsonb_build_object('worker_id', 'pc', 'job_id', current_setting('t.pilot')))::text, false);
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.pilot'), 'step', 'params', 'phase', 'start'));
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.pilot'), 'step', 'params', 'phase', 'done', 'key', '99001'));
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.pilot'), 'step', 'main', 'phase', 'start'));
select delpro_catalog_job_step(jsonb_build_object('job_id', current_setting('t.pilot'), 'step', 'main', 'phase', 'done', 'key', '990'));
select 'pilot_result' as step, delpro_catalog_job_result(jsonb_build_object('job_id', current_setting('t.pilot'), 'success', true, 'readback', jsonb_build_array(
  jsonb_build_object('object_type', 'DrugParameters', 'record', '{"key":"99001","uom":"ml","dump_milk_days":0,"meat_withhold_days":0}'::jsonb),
  jsonb_build_object('object_type', 'Drug', 'record', jsonb_build_object('code', '990', 'name',
    (select name from products p join delpro_catalog_jobs j on j.product_id = p.id where j.id = current_setting('t.pilot')::uuid),
    'active', false, 'default_parameters', '99001')))))->>'status' as status;
select 'pilot_rerun' as step, delpro_catalog_claim_job(jsonb_build_object('worker_id', 'pc', 'job_id', current_setting('t.pilot'))) is null as nothing;
reset role;
do $$ begin
  if (select setting_value from system_settings where setting_key = 'delpro_catalog_write_enabled') <> 'false'
     or (select setting_value from system_settings where setting_key = 'delpro_catalog_write_only_job') <> '' then
    raise exception 'the single-job gate must close itself after the job';
  end if;
  if (select l.delpro_key from delpro_catalog_links l join delpro_catalog_jobs j on j.product_id = l.product_id
      where j.id = current_setting('t.pilot')::uuid and l.retired_at is null) <> '990' then
    raise exception 'pilot mapping GVET <-> DelPro not saved';
  end if;
  if (select status from delpro_catalog_jobs where is_test and object_type = 'Diagnosis' order by created_at desc limit 1) <> 'queued' then
    raise exception 'other jobs must stay queued';
  end if;
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_enqueue_create('Drug', (select product_id from delpro_catalog_jobs where id = current_setting('t.pilot')::uuid));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: creating the pilot medicine in DelPro twice'; end if;
end $$;
do $$ declare blocked boolean := false; begin
  begin perform delpro_catalog_create_pilot_drug(); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: a new pilot after a successful one'; end if;
end $$;
reset role;
update delpro_catalog_jobs set status = 'cancelled' where is_test and status = 'queued';
select 'assert' as step, 'pilot: one job released, gate closes itself, mapping saved, no duplicate' as what;

-- 0045. Temporary administrator approval: a stamped job is never claimed before an admin sends it
reset role;
update system_settings set setting_value = 'true' where setting_key = 'delpro_admin_approval_required';
update system_settings set setting_value = 'auto' where setting_key = 'delpro_outbound_mode';
update system_settings set setting_value = '0' where setting_key = 'delpro_auto_delay_minutes';
update system_settings set setting_value = 'ui_script' where setting_key = 'delpro_write_channel';
update delpro_sync_jobs set status = 'rejected' where status in ('pending_approval', 'approved');  -- earlier blocks' leftovers
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select set_config('t.gate1', create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='514'),'reg_date','2026-10-30',
  'diagnosis','Endometritas','disease_id',(select id from diseases where name='Endometritas'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','qty',2,'unit','ml'))))::text, false);
select set_config('t.gate2', create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'reg_date','2026-10-30',
  'diagnosis','Endometritas','disease_id',(select id from diseases where name='Endometritas'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','qty',2,'unit','ml'))))::text, false);
do $$ begin
  if (select count(*) from delpro_sync_jobs where treatment_id in (current_setting('t.gate1')::uuid, current_setting('t.gate2')::uuid)
        and status = 'pending_approval' and admin_approval_required) <> 2 then
    raise exception 'saving a gydymas must queue a job that needs an administrator';
  end if;
  if (delpro_treatment_transfer_state(current_setting('t.gate1')::uuid)->>'can_approve')::boolean then
    raise exception 'a vet must not see the send button while the gate is on';
  end if;
end $$;
do $$ declare blocked boolean := false; begin
  begin perform delpro_approve_treatment(current_setting('t.gate1')::uuid); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: vet sends a gated treatment'; end if;
end $$;
do $$ declare blocked boolean := false; begin
  begin perform delpro_approve_jobs(array(select id from delpro_sync_jobs where treatment_id = current_setting('t.gate1')::uuid));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: vet bulk-sends a gated treatment'; end if;
end $$;
reset role;
set role service_role;
do $$ begin
  if delpro_claim_next_job('farm-pc') is not null then raise exception 'the worker claimed an unapproved job'; end if;
end $$;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
do $$ declare r jsonb; j delpro_sync_jobs%rowtype; before jsonb; begin
  if not (delpro_treatment_transfer_state(current_setting('t.gate1')::uuid)->>'can_approve')::boolean then
    raise exception 'an admin must see the send button';
  end if;
  r := delpro_approve_treatment(current_setting('t.gate1')::uuid);
  if r->>'outcome' <> 'approved' then raise exception 'admin send: %', r; end if;
  select * into j from delpro_sync_jobs where treatment_id = current_setting('t.gate1')::uuid;
  if j.status <> 'approved' or j.approved_by <> '00000000-0000-0000-0000-00000000000a' or j.approved_at is null or j.auto_approved then
    raise exception 'admin approval not recorded: %', to_jsonb(j);
  end if;
  before := to_jsonb(j);
  r := delpro_approve_treatment(current_setting('t.gate1')::uuid);
  if r->>'outcome' <> 'already_approved' or (select to_jsonb(x) from delpro_sync_jobs x where id = j.id) is distinct from before then
    raise exception 'second send must change nothing: %', r;
  end if;
  if (select status from delpro_sync_jobs where treatment_id = current_setting('t.gate2')::uuid) <> 'pending_approval' then
    raise exception 'sending one treatment must not release another';
  end if;
end $$;
reset role;
set role service_role;
do $$ declare c jsonb; begin
  c := delpro_claim_next_job('farm-pc');
  if c->>'treatment_id' <> current_setting('t.gate1') then raise exception 'the approved job must be claimed: %', c; end if;
  if delpro_claim_next_job('farm-pc') is not null then raise exception 'the other gated job must stay unclaimed'; end if;
end $$;
reset role;
-- gate off: NEW treatments go automatically, the one queued under the gate still waits
update system_settings set setting_value = 'false' where setting_key = 'delpro_admin_approval_required';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select set_config('t.gate3', create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='512'),'reg_date','2026-10-30',
  'diagnosis','Endometritas','disease_id',(select id from diseases where name='Endometritas'),
  'medications', jsonb_build_array(jsonb_build_object('product_id','11111111-0000-0000-0000-000000000001','qty',2,'unit','ml'))))::text, false);
reset role;
set role service_role;
do $$ declare c jsonb; begin
  c := delpro_claim_next_job('farm-pc');
  if c->>'treatment_id' <> current_setting('t.gate3') then raise exception 'a new treatment must send automatically once the gate is off: %', c; end if;
  if delpro_claim_next_job('farm-pc') is not null then raise exception 'a job queued under the gate was released silently'; end if;
end $$;
reset role;
do $$ begin
  if (select status from delpro_sync_jobs where treatment_id = current_setting('t.gate2')::uuid) <> 'pending_approval' then
    raise exception 'gated job must still wait for an administrator';
  end if;
end $$;
select 'assert' as step, '0045 admin gate: admin-only send, idempotent, claim guard, gate off releases only new jobs' as what;

-- 0046. Frequency + duration per medicine: required for gydymas, never defaulted, carried in the DelPro plan
do $$ declare m jsonb; begin
  select x into m from jsonb_array_elements(fn_delpro_treatment_plan((select id from delpro_sync_jobs where treatment_id = current_setting('t.treat')::uuid))->'medicines') x;
  if (m->>'frequency_per_day')::int <> 2 or (m->>'course_days')::int <> 3 then raise exception 'plan must carry frequency + duration: %', m; end if;
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
do $$ declare blocked boolean := false; begin
  begin perform create_treatment_with_visits(jsonb_build_object('animal_id', (select id from animals where animal_no = 'KT338'), 'reg_date', '2026-10-30',
    'diagnosis', 'Mastitas', 'disease_id', '36000000-0000-0000-0000-0000000000d2',
    'medications', jsonb_build_array(jsonb_build_object('product_id', '36000000-0000-0000-0000-0000000000a1', 'qty', 1, 'unit', 'ml', 'course_days', 3))));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: gydymas without frequency'; end if;
end $$;
do $$ declare blocked boolean := false; begin
  begin perform create_treatment_with_visits(jsonb_build_object('animal_id', (select id from animals where animal_no = 'KT338'), 'reg_date', '2026-10-30',
    'diagnosis', 'Mastitas', 'disease_id', '36000000-0000-0000-0000-0000000000d2',
    'medications', jsonb_build_array(jsonb_build_object('product_id', '36000000-0000-0000-0000-0000000000a1', 'qty', 1, 'unit', 'ml', 'frequency_per_day', 1, 'course_days', 0))));
  exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: gydymas with 0 days'; end if;
end $$;
reset role;
-- a treatment saved without them (older one / other entry point): the DelPro plan lists the problem, nothing is assumed
select set_config('t.nosched', create_treatment(jsonb_build_object('animal_id', (select id from animals where animal_no = 'KT338'), 'reg_date', '2026-10-30',
  'diagnosis', 'Mastitas', 'disease_id', '36000000-0000-0000-0000-0000000000d2',
  'medications', jsonb_build_array(jsonb_build_object('product_id', '36000000-0000-0000-0000-0000000000a1', 'qty', 1, 'unit', 'ml'))))::text, false);
do $$ declare c text[]; begin
  select array_agg(p->>'code' order by p->>'code') into c
  from jsonb_array_elements(fn_delpro_treatment_plan((select id from delpro_sync_jobs where treatment_id = current_setting('t.nosched')::uuid))->'problems') p
  where p->>'code' in ('frequency_missing', 'course_days_missing');
  if c is distinct from array['course_days_missing', 'frequency_missing'] then raise exception 'missing schedule must be a plan problem: %', c; end if;
end $$;
select 'assert' as step, '0046 frequency + duration: required, stored, in the plan, never defaulted' as what;

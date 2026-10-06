-- users
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

-- 5. vet cannot approve DelPro
do $$ declare blocked boolean := false; begin
  begin perform delpro_approve_jobs(array(select id from delpro_sync_jobs)); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: vet approve blocked'; end if;
end $$;
select 'assert' as step, 'vet approve blocked' as what;
select 'jobs' as step, status, preview_payload->'delpro'->>'milk_withdrawal_days' as milk_days, preview_payload->'delpro'->'products' as products from vw_delpro_sync_jobs;

-- admin approves
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select 'approved' as step, delpro_approve_jobs(array(select id from delpro_sync_jobs));
reset role;

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
  begin perform vic_save_credentials('vet','pw',true); exception when others then blocked := true; end;
  if not blocked then raise exception 'EXPECTED BLOCK DID NOT HAPPEN: vet saves VIC'; end if;
end $$;
select 'assert' as step, 'vet VIC blocked' as what;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select vic_save_credentials('dovine','slapta1',true);
select vic_save_credentials('dovine2','',false);
select 'vic' as step, vic_username, password_set, is_active from vic_get_settings();
select 'vic_direct' as step, count(*) as visible_rows from vic_credentials;
reset role;
select 'vic_stored' as step, vic_username, vic_password from vic_credentials;

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
select create_treatment(jsonb_build_object('animal_id',(select id from animals where animal_no='513'),'reg_date','2026-09-20','diagnosis','Endometritas',
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
select vic_save_credentials('dovine2','',true,'LT123456');
select 'vic_settings' as step, vic_farm_code, password_set, last_error from vic_get_settings();
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

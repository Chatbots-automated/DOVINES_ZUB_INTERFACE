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
select vic_save_credentials('seklinimas','dovine2','',true,'LT123456');
select 'vic_settings' as step, vic_farm_code, password_set, last_error from vic_get_settings('seklinimas');
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

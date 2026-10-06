-- 0019_hoof_care.sql
-- Dovinės ŽŪB GVET PRO — Nagų sveikata (hoof care), requested by the farm
-- 2026-10 (previously out of scope; ported from Kairaitienės' nagos module
-- and cross-checked against Monika's Hoofs.tsx).
--
-- Model:
--   hoof_exams     one visit per animal (date, who trimmed/treated, notes);
--                  animal_group_snapshot frozen at insert like treatments.
--   hoof_findings  one row per leg + set of zones sharing the same
--                  condition/treatment: per-claw zones (jsonb), lesion code,
--                  severity 0-4, trimmed / treated / bandaged, follow-up.
--                  A "healthy" check is a finding with condition_code 'OK'
--                  and no leg.
--   usage_items.hoof_finding_id   products used on a finding. Consumed in
--                  create_hoof_exam() through FEFO (fn_consume_fefo_for_hoof), so a stock
--                  shortfall rolls the whole visit back and the usage reaches
--                  nurašymo aktai via vw_usage_items_detailed.

-- ---------------------------------------------------------------------------
-- Lesion lookup
-- ---------------------------------------------------------------------------

create table hoof_condition_codes (
  code text primary key,
  description text not null,
  severity_default integer not null default 0 check (severity_default between 0 and 4),
  sort_order integer not null default 100
);

insert into hoof_condition_codes (code, description, severity_default, sort_order) values
  ('OK', 'Sveikas — jokių pažeidimų', 0, 1),
  ('DD', 'Skaitmeninis dermatitas (Digital Dermatitis)', 3, 10),
  ('SU', 'Padų opa (Sole Ulcer)', 3, 11),
  ('WLD', 'Baltosios linijos liga (White Line Disease)', 2, 12),
  ('ID', 'Tarpupirščio dermatitas (Interdigital Dermatitis)', 2, 13),
  ('IH', 'Tarpupirščio hiperplazija (Interdigital Hyperplasia)', 1, 14),
  ('SH', 'Pado kraujosruva (Sole Haemorrhage)', 1, 15),
  ('HE', 'Kulno rago erozija (Heel Horn Erosion)', 2, 16),
  ('LAM', 'Laminitas', 3, 17),
  ('FRACT', 'Naginio kaulo lūžis', 4, 18),
  ('AF', 'Ašinė fisūra (plyšys ašinėje dalyje)', 2, 19),
  ('HF', 'Horizontali fisūra', 1, 20),
  ('VF', 'Vertikali fisūra', 2, 21),
  ('TU', 'Nago galo žaizda', 3, 22),
  ('IP', 'Tarppiršlio flegmona (abscesas tarp nagų)', 4, 23),
  ('OTHER', 'Kita', 1, 99);

-- ---------------------------------------------------------------------------
-- hoof_exams / hoof_findings
-- ---------------------------------------------------------------------------

create table hoof_exams (
  id uuid primary key default gen_random_uuid(),
  animal_id uuid not null references animals (id),
  exam_date date not null default current_date,
  performed_by text,
  notes text,
  animal_group_snapshot text,
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);

create index hoof_exams_animal_id_idx on hoof_exams (animal_id);
create index hoof_exams_exam_date_idx on hoof_exams (exam_date);

create trigger trg_hoof_exams_snapshot_group
  before insert on hoof_exams
  for each row execute function fn_snapshot_animal_group();

create table hoof_findings (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references hoof_exams (id) on delete cascade,
  -- FL/FR = priekinė kairė/dešinė, HL/HR = galinė kairė/dešinė.
  leg text check (leg is null or leg in ('FL', 'FR', 'HL', 'HR')),
  -- [{"zone": 1-10, "claw": "inner" | "outer"}] — claw = vidinis/išorinis nagas.
  zones jsonb not null default '[]'::jsonb check (jsonb_typeof(zones) = 'array'),
  condition_code text references hoof_condition_codes (code),
  diagnosis text,
  severity integer not null default 0 check (severity between 0 and 4),
  was_trimmed boolean not null default false,
  was_treated boolean not null default false,
  bandage_applied boolean not null default false,
  followup_required boolean not null default false,
  followup_date date,
  followup_completed boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create index hoof_findings_exam_id_idx on hoof_findings (exam_id);
create index hoof_findings_condition_idx on hoof_findings (condition_code);
create index hoof_findings_followup_idx on hoof_findings (followup_date)
  where followup_required and not followup_completed;

-- ---------------------------------------------------------------------------
-- Ledger: usage_items gains a sixth source.
-- ---------------------------------------------------------------------------

alter table usage_items
  add column hoof_finding_id uuid references hoof_findings (id) on delete cascade;

create index usage_items_hoof_finding_id_idx on usage_items (hoof_finding_id) where hoof_finding_id is not null;

alter table usage_items drop constraint usage_items_single_source;
alter table usage_items add constraint usage_items_single_source check (
  (
    (treatment_id is not null)::int +
    (course_dose_id is not null)::int +
    (vaccination_id is not null)::int +
    (biocide_usage_id is not null)::int +
    (general_usage_id is not null)::int +
    (insemination_id is not null)::int +
    (hoof_finding_id is not null)::int
  ) = 1
);

-- A written-off usage row must not vanish from under its act.
create or replace function fn_hoof_exam_delete_guard()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from hoof_findings f
    join usage_items ui on ui.hoof_finding_id = f.id
    join write_off_act_usage_items w on w.usage_item_id = ui.id
    where f.exam_id = old.id
  ) then
    raise exception 'Šios apžiūros produktai jau įtraukti į nurašymo aktą — pirmiau anuliuokite arba ištrinkite aktą.';
  end if;
  return old;
end;
$$;

create trigger trg_hoof_exam_delete_guard
  before delete on hoof_exams
  for each row execute function fn_hoof_exam_delete_guard();

-- FEFO consumption for a hoof finding. Same algorithm as fn_consume_fefo
-- (soonest-expiring active, non-expired batch first, locked), kept as a
-- separate helper so fn_consume_fefo's signature — which other migrations
-- drop/recreate — is left alone. Raises on shortfall, rolling the caller back.

create or replace function fn_consume_fefo_for_hoof(
  p_product_id uuid,
  p_qty numeric,
  p_unit unit,
  p_hoof_finding_id uuid
)
returns uuid
language plpgsql
as $$
declare
  v_remaining numeric := p_qty;
  v_take numeric;
  v_first_batch uuid;
  b record;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'Kiekis turi būti didesnis už 0.';
  end if;

  for b in
    select id, qty_left
    from batches
    where product_id = p_product_id
      and status = 'active'
      and qty_left > 0
      and (expiry_date is null or expiry_date >= current_date)
    order by expiry_date asc nulls last, received_at asc
    for update
  loop
    exit when v_remaining <= 0;
    v_take := least(b.qty_left, v_remaining);
    insert into usage_items (product_id, batch_id, qty, unit, hoof_finding_id)
    values (p_product_id, b.id, v_take, p_unit, p_hoof_finding_id);
    v_first_batch := coalesce(v_first_batch, b.id);
    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0.0001 then
    raise exception 'Nepakanka atsargų produktui „%“: trūksta % %.',
      (select name from products where id = p_product_id), round(v_remaining, 3), coalesce(p_unit::text, '');
  end if;

  return v_first_batch;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_hoof_exam(jsonb) — one visit, all findings, all stock, one
-- transaction.
--   { animal_id, exam_date, performed_by, notes,
--     findings: [{ leg, zones: [{zone, claw}], condition_code, diagnosis,
--                  severity, was_trimmed, was_treated, bandage_applied,
--                  followup_required, followup_date, notes,
--                  products: [{ product_id, qty, unit }] }] }
-- A finding needs either a leg + zones, or condition_code 'OK' (healthy
-- check). Returns the hoof_exams id.
-- ---------------------------------------------------------------------------

create or replace function create_hoof_exam(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_exam_id uuid;
  v_finding_id uuid;
  v_animal uuid := nullif(p_data->>'animal_id', '')::uuid;
  v_f jsonb;
  v_p jsonb;
  v_leg text;
  v_zones jsonb;
  v_code text;
  v_followup boolean;
  v_followup_date date;
  v_product products%rowtype;
  v_qty numeric;
  v_unit unit;
  v_z jsonb;
begin
  if v_animal is null or not exists (select 1 from animals where id = v_animal) then
    raise exception 'Pasirinkite gyvūną.';
  end if;
  if jsonb_typeof(p_data->'findings') is distinct from 'array' or jsonb_array_length(p_data->'findings') = 0 then
    raise exception 'Pridėkite bent vieną radinį.';
  end if;

  insert into hoof_exams (animal_id, exam_date, performed_by, notes, created_by)
  values (v_animal, coalesce(nullif(p_data->>'exam_date', '')::date, current_date),
          nullif(p_data->>'performed_by', ''), nullif(p_data->>'notes', ''), auth.uid())
  returning id into v_exam_id;

  for v_f in select * from jsonb_array_elements(p_data->'findings')
  loop
    v_leg := nullif(v_f->>'leg', '');
    v_zones := coalesce(v_f->'zones', '[]'::jsonb);
    v_code := nullif(v_f->>'condition_code', '');
    v_followup := coalesce((v_f->>'followup_required')::boolean, false);
    v_followup_date := nullif(v_f->>'followup_date', '')::date;

    if jsonb_typeof(v_zones) is distinct from 'array' then
      raise exception 'Neteisingas zonų sąrašas.';
    end if;
    for v_z in select * from jsonb_array_elements(v_zones)
    loop
      if (v_z->>'zone')::integer not between 0 and 10 or coalesce(v_z->>'claw', '') not in ('inner', 'outer') then
        raise exception 'Neteisinga nagos zona.';
      end if;
    end loop;

    if v_code is distinct from 'OK' and (v_leg is null or jsonb_array_length(v_zones) = 0) then
      raise exception 'Kiekvienam radiniui pasirinkite nagą ir bent vieną zoną (arba pažymėkite „Sveikas“).';
    end if;
    if v_followup and v_followup_date is null then
      raise exception 'Nurodykite pakartotinio patikrinimo datą.';
    end if;

    insert into hoof_findings (exam_id, leg, zones, condition_code, diagnosis, severity, was_trimmed, was_treated,
                               bandage_applied, followup_required, followup_date, notes)
    values (v_exam_id, v_leg, v_zones, v_code, nullif(v_f->>'diagnosis', ''),
            coalesce(nullif(v_f->>'severity', '')::integer, 0),
            coalesce((v_f->>'was_trimmed')::boolean, false),
            coalesce((v_f->>'was_treated')::boolean, false),
            coalesce((v_f->>'bandage_applied')::boolean, false),
            v_followup, case when v_followup then v_followup_date end, nullif(v_f->>'notes', ''))
    returning id into v_finding_id;

    for v_p in select * from jsonb_array_elements(coalesce(v_f->'products', '[]'::jsonb))
    loop
      select * into v_product from products where id = nullif(v_p->>'product_id', '')::uuid;
      if not found then
        raise exception 'Pasirinkite produktą.';
      end if;
      v_qty := nullif(v_p->>'qty', '')::numeric;
      if v_qty is null or v_qty <= 0 then
        raise exception 'Nurodykite sunaudotą kiekį („%“).', v_product.name;
      end if;
      v_unit := coalesce(nullif(v_p->>'unit', '')::unit, v_product.unit);
      perform fn_consume_fefo_for_hoof(v_product.id, v_qty, v_unit, v_finding_id);
    end loop;
  end loop;

  return v_exam_id;
end;
$$;

grant execute on function create_hoof_exam(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- vw_usage_items_detailed — adds hoof usage (new columns at the end, as
-- CREATE OR REPLACE VIEW requires).
-- ---------------------------------------------------------------------------

create or replace view vw_usage_items_detailed
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
    when ui.biocide_usage_id is not null then 'biocide'
    when ui.insemination_id is not null then 'insemination'
    when ui.hoof_finding_id is not null then 'hoof'
    else 'general'
  end as source_kind,
  coalesce(t.reg_date, coalesce(cd.administered_date, cd.scheduled_date), v.vaccination_date, bu.use_date, gu.use_date, ins.insemination_date, he.exam_date) as used_on,
  coalesce(t.animal_id, ct.animal_id, v.animal_id, ins.animal_id, he.animal_id) as animal_id,
  coalesce(t.animal_group_snapshot, ct.animal_group_snapshot, v.animal_group_snapshot, ins.animal_group_snapshot, he.animal_group_snapshot) as animal_group,
  bu.purpose as biocide_purpose,
  coalesce(t.id, ct.id) as treatment_id,
  ui.vaccination_id,
  ui.biocide_usage_id,
  ui.general_usage_id,
  gu.write_off_group_id as general_write_off_group_id,
  an.sex as animal_sex,
  ui.insemination_id,
  ui.hoof_finding_id,
  hf.exam_id as hoof_exam_id
from usage_items ui
join batches b on b.id = ui.batch_id
left join treatments t on t.id = ui.treatment_id
left join course_doses cd on cd.id = ui.course_dose_id
left join treatment_courses tc on tc.id = cd.course_id
left join treatments ct on ct.id = tc.treatment_id
left join vaccinations v on v.id = ui.vaccination_id
left join biocide_usage bu on bu.id = ui.biocide_usage_id
left join general_usage gu on gu.id = ui.general_usage_id
left join insemination_records ins on ins.id = ui.insemination_id
left join hoof_findings hf on hf.id = ui.hoof_finding_id
left join hoof_exams he on he.id = hf.exam_id
left join animals an on an.id = coalesce(t.animal_id, ct.animal_id, v.animal_id, ins.animal_id, he.animal_id);

-- ---------------------------------------------------------------------------
-- RLS (same shape as 0009: every active user reads, active staff writes).
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['hoof_exams', 'hoof_findings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (fn_is_authenticated_active())', t || '_select', t);
    execute format('create policy %I on %I for insert with check (fn_is_active_staff())', t || '_insert', t);
    execute format('create policy %I on %I for update using (fn_is_active_staff())', t || '_update', t);
    execute format('create policy %I on %I for delete using (fn_is_active_staff())', t || '_delete', t);
  end loop;
end;
$$;

alter table hoof_condition_codes enable row level security;
create policy hoof_condition_codes_select on hoof_condition_codes for select using (fn_is_authenticated_active());
create policy hoof_condition_codes_admin_write on hoof_condition_codes for all using (fn_is_admin()) with check (fn_is_admin());

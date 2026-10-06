-- 0020_animal_delpro_fields.sql
-- Dovinės ŽŪB GVET PRO — DairyPlan-style fields on animals, fed by DelPro
-- (Priedas §3.3 "kiti suderinti laukai"). Shown on the animal card; all are
-- nullable — until the DelPro worker's queries/animals.sql is filled in
-- (TODO(discovery)) the card shows "Duomenų iš DelPro dar nėra".
-- Field set follows what Oksana's AnimalDetailSidebar shows from the GEA
-- ("DairyPlan") daily reports: cow state, calving / lactation days,
-- insemination + pregnancy, milk yield, bulls, genetic value, missing teats.
--
-- upsert_animals_from_delpro(jsonb) is re-created from 0006 with identical
-- behaviour plus patch-with-coalesce of the new fields.

alter table animals
  add column reproduction_status text,          -- DelPro cow state: Laktuojanti / Užtrūkusi / Apsėklinta / Veršinga...
  add column last_calving_date date,            -- Apsiveršiavo
  add column days_in_milk integer check (days_in_milk is null or days_in_milk >= 0),
  add column milk_yield_kg numeric(6,1),        -- average daily milk, kg
  add column last_milking_at timestamptz,
  add column last_milking_kg numeric(6,1),
  add column produces_milk boolean,             -- Gamina pieną
  add column last_insemination_date date,       -- Apsėklinta
  add column insemination_count integer check (insemination_count is null or insemination_count >= 0),
  add column last_bulls text,                   -- bulls used (comma separated)
  add column is_pregnant boolean,
  add column pregnancy_days integer check (pregnancy_days is null or pregnancy_days >= 0),
  add column expected_calving_date date,        -- Veršiuosis
  add column dry_off_date date,                 -- Užtrūkimo data
  add column genetic_worth text,                -- Veislinė vertė
  add column blood_line text,                   -- Kraujo linija
  add column missing_teats text[],              -- subset of FL / FR / HL / HR (no / blind teat)
  add column health_alert text,                 -- DelPro attention flag (e.g. mastitas)
  add column group_since date;                  -- date the animal entered its current group

comment on column animals.last_insemination_date is
  'As reported by DelPro. The GVET sėklinimo žurnalas (insemination_records) is separate and remains the journal of record.';

-- Defensive casts for the DelPro payload: bad input becomes null instead of
-- aborting the whole herd sync.
create or replace function fn_delpro_date(text) returns date
language plpgsql immutable as $$
begin
  if $1 is null or $1 !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
  return left($1, 10)::date;
exception when others then return null;
end;
$$;

create or replace function fn_delpro_num(text) returns numeric
language plpgsql immutable as $$
begin
  if $1 is null or trim($1) !~ '^-?[0-9]+([.,][0-9]+)?$' then return null; end if;
  return replace(trim($1), ',', '.')::numeric;
exception when others then return null;
end;
$$;

create or replace function fn_delpro_ts(text) returns timestamptz
language plpgsql stable as $$
begin
  if $1 is null or $1 !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
  return $1::timestamptz;
exception when others then return null;
end;
$$;

create or replace function fn_delpro_bool(text) returns boolean
language sql immutable as $$
  select case when lower(trim($1)) in ('true', 't', '1', 'yes', 'taip') then true
              when lower(trim($1)) in ('false', 'f', '0', 'no', 'ne') then false end
$$;

-- ---------------------------------------------------------------------------
-- upsert_animals_from_delpro(jsonb) — body shape as in 0006, animal objects
-- additionally accept: reproduction_status, last_calving_date, days_in_milk,
-- milk_yield_kg, last_milking_at, last_milking_kg, produces_milk,
-- last_insemination_date, insemination_count, last_bulls, is_pregnant,
-- pregnancy_days, expected_calving_date, dry_off_date, genetic_worth,
-- blood_line, missing_teats (["FL","HR"...]), health_alert, group_since.
-- Missing/unparseable fields never blank existing data. is_pregnant=false
-- retires expected_calving_date / pregnancy_days.
-- ---------------------------------------------------------------------------

create or replace function upsert_animals_from_delpro(jsonb)
returns jsonb
language plpgsql
security invoker
as $$
declare
  p_body alias for $1;
  v_animals jsonb;
  v_groups jsonb;
  v_full boolean;
  v_worker text;
  v_received integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_deactivated integer := 0;
  v_groups_received integer := 0;
  v_seen_ids uuid[] := '{}';
  elem jsonb;
  v_id uuid;
  v_dp_id text;
  v_animal_no text;
  v_tag text;
  v_group_id uuid;
  v_group_name text;
  v_birth date;
  v_lact integer;
  v_active boolean;
  v_repro text;
  v_last_calving date;
  v_dim integer;
  v_yield numeric;
  v_last_milking_at timestamptz;
  v_last_milking_kg numeric;
  v_produces boolean;
  v_last_insem date;
  v_insem_count integer;
  v_bulls text;
  v_preg boolean;
  v_preg_days integer;
  v_expected date;
  v_dry_off date;
  v_genetic text;
  v_blood text;
  v_teats text[];
  v_alert text;
  v_group_since date;
begin
  if jsonb_typeof(p_body) = 'array' then
    v_animals := p_body;
    v_groups := '[]'::jsonb;
    v_full := true;
  else
    v_animals := coalesce(p_body->'animals', '[]'::jsonb);
    v_groups := coalesce(p_body->'groups', '[]'::jsonb);
    v_full := coalesce((p_body->>'full_snapshot')::boolean, true);
    v_worker := p_body->>'worker_id';
  end if;

  if jsonb_typeof(v_animals) <> 'array' then
    raise exception 'Laukiamas gyvulių sąrašas (JSON masyvas).';
  end if;

  -- Groups first, so animals can reference them. Matched by DelPro group
  -- id, else by name (a group first seen only by name on an animal row
  -- gets its DelPro id attached once the group list reports it).
  for elem in select * from jsonb_array_elements(v_groups) loop
    v_group_name := nullif(trim(elem->>'name'), '');
    continue when v_group_name is null;
    v_groups_received := v_groups_received + 1;
    v_group_id := null;
    if nullif(elem->>'delpro_group_id', '') is not null then
      select id into v_group_id from delpro_groups where delpro_group_id = elem->>'delpro_group_id';
    end if;
    if v_group_id is null then
      select id into v_group_id from delpro_groups where lower(name) = lower(v_group_name);
    end if;
    if v_group_id is null then
      insert into delpro_groups (delpro_group_id, name, active, updated_from_delpro_at)
      values (nullif(elem->>'delpro_group_id', ''), v_group_name, coalesce((elem->>'active')::boolean, true), now());
    else
      update delpro_groups
      set delpro_group_id = coalesce(nullif(elem->>'delpro_group_id', ''), delpro_group_id),
          name = v_group_name,
          active = coalesce((elem->>'active')::boolean, true),
          updated_from_delpro_at = now()
      where id = v_group_id;
    end if;
  end loop;

  v_received := jsonb_array_length(v_animals);

  for elem in select * from jsonb_array_elements(v_animals) loop
    v_dp_id := nullif(trim(elem->>'delpro_animal_id'), '');
    v_animal_no := nullif(trim(elem->>'animal_no'), '');
    v_tag := nullif(trim(elem->>'tag_no'), '');
    -- DelPro can hold animals (young calves) without an official ear tag
    -- yet; tag_no is NOT NULL + unique, so fall back to a stable surrogate.
    if v_tag is null and v_animal_no is not null then
      v_tag := 'DP-' || v_animal_no;
    end if;

    if v_dp_id is null and v_tag is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Resolve group: by DelPro group id, else by name (auto-creating it).
    v_group_id := null;
    v_group_name := nullif(trim(elem->>'group_name'), '');
    if nullif(elem->>'group_id', '') is not null then
      select id, name into v_group_id, v_group_name from delpro_groups where delpro_group_id = elem->>'group_id';
    end if;
    if v_group_id is null and v_group_name is not null then
      select id, name into v_group_id, v_group_name from delpro_groups where lower(name) = lower(v_group_name);
      if v_group_id is null then
        insert into delpro_groups (name, updated_from_delpro_at) values (trim(elem->>'group_name'), now())
        returning id, name into v_group_id, v_group_name;
      end if;
    end if;

    v_birth := case when (elem->>'birth_date') ~ '^\d{4}-\d{2}-\d{2}' then left(elem->>'birth_date', 10)::date end;
    v_lact := case when (elem->>'lactation_no') ~ '^[0-9]+$' then (elem->>'lactation_no')::integer end;
    v_active := coalesce((elem->>'active')::boolean, true);

    -- DairyPlan-style fields (0020): every one optional and parsed
    -- defensively — a bad value becomes null, it never aborts the sync.
    v_repro := nullif(trim(elem->>'reproduction_status'), '');
    v_last_calving := fn_delpro_date(elem->>'last_calving_date');
    v_dim := round(fn_delpro_num(elem->>'days_in_milk'))::integer;
    v_yield := fn_delpro_num(elem->>'milk_yield_kg');
    v_last_milking_at := fn_delpro_ts(elem->>'last_milking_at');
    v_last_milking_kg := fn_delpro_num(elem->>'last_milking_kg');
    v_produces := fn_delpro_bool(elem->>'produces_milk');
    v_last_insem := fn_delpro_date(elem->>'last_insemination_date');
    v_insem_count := round(fn_delpro_num(elem->>'insemination_count'))::integer;
    v_bulls := nullif(trim(elem->>'last_bulls'), '');
    v_preg := fn_delpro_bool(elem->>'is_pregnant');
    v_preg_days := round(fn_delpro_num(elem->>'pregnancy_days'))::integer;
    v_expected := fn_delpro_date(elem->>'expected_calving_date');
    v_dry_off := fn_delpro_date(elem->>'dry_off_date');
    v_genetic := nullif(trim(elem->>'genetic_worth'), '');
    v_blood := nullif(trim(elem->>'blood_line'), '');
    v_alert := nullif(trim(elem->>'health_alert'), '');
    v_group_since := fn_delpro_date(elem->>'group_since');
    v_teats := null;
    if jsonb_typeof(elem->'missing_teats') = 'array' then
      v_teats := array(select t from jsonb_array_elements_text(elem->'missing_teats') t where t in ('FL', 'FR', 'HL', 'HR'));
    end if;

    -- One bad row (e.g. an ear tag already used by a different animal)
    -- must not abort the whole herd sync: skip it and count it.
    begin
      v_id := null;
      if v_dp_id is not null then
        select id into v_id from animals where delpro_animal_id = v_dp_id;
      end if;
      -- Tag fallback only adopts an animal DelPro doesn't own yet (manual
      -- entry). A tag held by a DIFFERENT DelPro animal is a data conflict
      -- in DelPro itself — skip the row rather than hijack that animal.
      if v_id is null and v_tag is not null then
        select id into v_id from animals where tag_no = v_tag and (delpro_animal_id is null or v_dp_id is null);
        if v_id is null and exists (select 1 from animals where tag_no = v_tag) then
          v_skipped := v_skipped + 1;
          continue;
        end if;
      end if;

      if v_id is null then
        insert into animals (tag_no, animal_no, delpro_animal_id, name, sex, breed, birth_date, group_id, group_name,
                             lactation_no, active, source, updated_from_delpro_at,
                             reproduction_status, last_calving_date, days_in_milk, milk_yield_kg, last_milking_at,
                             last_milking_kg, produces_milk, last_insemination_date, insemination_count, last_bulls,
                             is_pregnant, pregnancy_days, expected_calving_date, dry_off_date, genetic_worth,
                             blood_line, missing_teats, health_alert, group_since)
        values (v_tag, v_animal_no, v_dp_id, nullif(elem->>'name', ''), nullif(elem->>'sex', ''), nullif(elem->>'breed', ''),
                v_birth, v_group_id, v_group_name, v_lact, v_active, 'delpro', now(),
                v_repro, v_last_calving, v_dim, v_yield, v_last_milking_at,
                v_last_milking_kg, v_produces, v_last_insem, v_insem_count, v_bulls,
                v_preg, case when v_preg is false then null else v_preg_days end,
                case when v_preg is false then null else v_expected end, v_dry_off, v_genetic,
                v_blood, v_teats, v_alert, v_group_since)
        returning id into v_id;
        v_inserted := v_inserted + 1;
      else
        update animals set
          tag_no = coalesce(v_tag, tag_no),
          animal_no = coalesce(v_animal_no, animal_no),
          delpro_animal_id = coalesce(v_dp_id, delpro_animal_id),
          name = coalesce(nullif(elem->>'name', ''), name),
          sex = coalesce(nullif(elem->>'sex', ''), sex),
          breed = coalesce(nullif(elem->>'breed', ''), breed),
          birth_date = coalesce(v_birth, birth_date),
          group_id = coalesce(v_group_id, group_id),
          group_name = coalesce(v_group_name, group_name),
          lactation_no = coalesce(v_lact, lactation_no),
          active = v_active,
          source = 'delpro',
          updated_from_delpro_at = now(),
          reproduction_status = coalesce(v_repro, reproduction_status),
          last_calving_date = coalesce(v_last_calving, last_calving_date),
          days_in_milk = coalesce(v_dim, days_in_milk),
          milk_yield_kg = coalesce(v_yield, milk_yield_kg),
          last_milking_at = coalesce(v_last_milking_at, last_milking_at),
          last_milking_kg = coalesce(v_last_milking_kg, last_milking_kg),
          produces_milk = coalesce(v_produces, produces_milk),
          last_insemination_date = coalesce(v_last_insem, last_insemination_date),
          insemination_count = coalesce(v_insem_count, insemination_count),
          last_bulls = coalesce(v_bulls, last_bulls),
          is_pregnant = coalesce(v_preg, is_pregnant),
          -- a DelPro "not pregnant" (calved / aborted / open) retires the stale due date
          pregnancy_days = case when v_preg is false then null else coalesce(v_preg_days, pregnancy_days) end,
          expected_calving_date = case when v_preg is false then null else coalesce(v_expected, expected_calving_date) end,
          dry_off_date = coalesce(v_dry_off, dry_off_date),
          genetic_worth = coalesce(v_genetic, genetic_worth),
          blood_line = coalesce(v_blood, blood_line),
          missing_teats = coalesce(v_teats, missing_teats),
          health_alert = coalesce(v_alert, health_alert),
          group_since = coalesce(v_group_since, group_since)
        where id = v_id;
        v_updated := v_updated + 1;
      end if;

      v_seen_ids := array_append(v_seen_ids, v_id);
    exception when unique_violation then
      v_skipped := v_skipped + 1;
      -- An existing animal whose update failed is still in the herd —
      -- don't let the snapshot deactivation below mark it as gone.
      if v_id is not null then
        v_seen_ids := array_append(v_seen_ids, v_id);
      end if;
    end;
  end loop;

  if v_full and array_length(v_seen_ids, 1) > 0 then
    with deactivated as (
      update animals
      set active = false, updated_from_delpro_at = now()
      where source = 'delpro'
        and active
        and not (id = any (v_seen_ids))
      returning 1
    )
    select count(*) into v_deactivated from deactivated;
  end if;

  insert into delpro_sync_runs (kind, worker_id, received_rows, inserted, updated, deactivated, groups_received, skipped)
  values ('animals', v_worker, v_received, v_inserted, v_updated, v_deactivated, v_groups_received, v_skipped);

  update system_settings set setting_value = now()::text where setting_key in ('delpro_last_inbound_at', 'delpro_worker_last_seen_at');

  return jsonb_build_object(
    'received_rows', v_received,
    'inserted', v_inserted,
    'updated', v_updated,
    'deactivated', v_deactivated,
    'groups_received', v_groups_received,
    'skipped', v_skipped
  );
end;
$$;

revoke all on function upsert_animals_from_delpro(jsonb) from public, authenticated;
grant execute on function upsert_animals_from_delpro(jsonb) to service_role;

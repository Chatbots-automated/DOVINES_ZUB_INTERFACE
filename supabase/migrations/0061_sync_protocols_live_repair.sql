-- 0061_sync_protocols_live_repair.sql
-- Repair (2026-11-05): the live project's sync_protocol_steps has no `kind` column —
-- 0025 was changed in the repo after it had been applied there (the sėklinimas step,
-- 'veiksmas' | 'sekinimas'). Every protocol query (`…sync_protocol_steps(…, kind, …)`)
-- failed, so the protocol picker / Sinchronizacijos page showed no protocols and the
-- protocol dialog got no medicines to choose from.
--
-- Brings any database to the current 0025 shape; a no-op where 0025 is already
-- current (PGlite tests, fresh projects). The function bodies are 0025's, verbatim
-- (fn_visit_refresh_status is newer in 0029 and is not touched).

alter table sync_protocol_steps
  add column if not exists kind text not null default 'veiksmas';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sync_protocol_steps_kind_check') then
    alter table sync_protocol_steps add constraint sync_protocol_steps_kind_check check (kind in ('veiksmas', 'sekinimas'));
  end if;
end $$;

alter table animal_visits drop constraint if exists animal_visits_procedures_check;
alter table animal_visits add constraint animal_visits_procedures_check
  check (procedures <@ array['temperatura', 'apziura', 'profilaktika', 'gydymas', 'vakcina', 'sinchronizacija', 'sekinimas', 'kita']::text[]);

alter table treatments drop constraint if exists treatments_procedure_type_check;
alter table treatments add constraint treatments_procedure_type_check
  check (procedure_type in ('apziura', 'gydymas', 'profilaktika', 'sinchronizacija'));

create or replace function fn_sync_clean_medications(p_meds jsonb)
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  m jsonb;
  v_prod products%rowtype;
  v_out jsonb := '[]'::jsonb;
begin
  if p_meds is null or jsonb_typeof(p_meds) <> 'array' then
    return '[]'::jsonb;
  end if;
  for m in select * from jsonb_array_elements(p_meds) loop
    continue when nullif(m->>'product_id', '') is null and coalesce(nullif(m->>'qty', '')::numeric, 0) <= 0;
    if nullif(m->>'product_id', '') is null then
      raise exception 'Pasirinkite produktą vaisto eilutei.';
    end if;
    select * into v_prod from products where id = (m->>'product_id')::uuid;
    if not found then
      raise exception 'Produktas nerastas.';
    end if;
    if coalesce(nullif(m->>'qty', '')::numeric, 0) <= 0 then
      raise exception 'Nurodykite produkto „%“ kiekį (didesnį už 0).', v_prod.name;
    end if;
    -- Same categories the treatment dialog can give (TREATMENT_PRODUCT_CATEGORIES):
    -- a planned medicine must be recordable when the step is done.
    if v_prod.category::text not in ('medicines', 'vakcina', 'profilaktika', 'boliusai', 'treatment_materials') then
      raise exception 'Produktas „%“ netinka sinchronizacijos protokolui.', v_prod.name;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'product_id', v_prod.id,
      'qty', (m->>'qty')::numeric,
      'unit', v_prod.unit,
      'administration_route', nullif(m->>'administration_route', '')
    ));
  end loop;
  return v_out;
end;
$$;

create or replace function save_sync_protocol(p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_id uuid := nullif(p_data->>'id', '')::uuid;
  v_name text := btrim(coalesce(p_data->>'name', ''));
  v_steps jsonb := coalesce(p_data->'steps', '[]'::jsonb);
  s jsonb;
  i integer := 0;
begin
  if v_name = '' then
    raise exception 'Įveskite protokolo pavadinimą.';
  end if;
  if jsonb_typeof(v_steps) <> 'array' or jsonb_array_length(v_steps) = 0 then
    raise exception 'Pridėkite bent vieną protokolo žingsnį.';
  end if;
  if exists (select 1 from sync_protocols where lower(name) = lower(v_name) and id is distinct from v_id) then
    raise exception 'Protokolas „%“ jau yra.', v_name;
  end if;

  if v_id is null then
    insert into sync_protocols (name, description, created_by)
    values (v_name, nullif(btrim(coalesce(p_data->>'description', '')), ''), auth.uid())
    returning id into v_id;
  else
    update sync_protocols
       set name = v_name,
           description = nullif(btrim(coalesce(p_data->>'description', '')), '')
     where id = v_id;
    if not found then
      raise exception 'Protokolas nerastas.';
    end if;
    delete from sync_protocol_steps where protocol_id = v_id;
  end if;

  for s in select * from jsonb_array_elements(v_steps) loop
    i := i + 1;
    if btrim(coalesce(s->>'title', '')) = '' then
      raise exception '% žingsniui įveskite veiksmo pavadinimą.', i;
    end if;
    if coalesce(nullif(s->>'day_offset', '')::integer, 0) not between 0 and 120 then
      raise exception '% žingsnio diena turi būti nuo 0 iki 120.', i;
    end if;
    if coalesce(nullif(s->>'kind', ''), 'veiksmas') not in ('veiksmas', 'sekinimas') then
      raise exception '% žingsnio tipas netinkamas.', i;
    end if;
    insert into sync_protocol_steps (protocol_id, day_offset, title, notes, sort_order, kind, medications)
    values (v_id, coalesce(nullif(s->>'day_offset', '')::integer, 0), btrim(s->>'title'),
            nullif(btrim(coalesce(s->>'notes', '')), ''), i, coalesce(nullif(s->>'kind', ''), 'veiksmas'),
            case when coalesce(nullif(s->>'kind', ''), 'veiksmas') = 'sekinimas' then '[]'::jsonb
                 else fn_sync_clean_medications(s->'medications') end);
  end loop;

  return v_id;
end;
$$;

grant execute on function save_sync_protocol(jsonb) to authenticated;

create or replace function apply_sync_protocol(
  p_protocol_id uuid,
  p_animal_id uuid,
  p_start_date date,
  p_start_time text default '09:00',
  p_vet_name text default null
)
returns integer
language plpgsql
security invoker
as $$
declare
  v_protocol sync_protocols%rowtype;
  v_app uuid;
  v_total integer;
  v_open text;
  v_time text := coalesce(nullif(btrim(p_start_time), ''), '09:00');
  st record;
  n integer := 0;
begin
  if p_animal_id is null then
    raise exception 'Pasirinkite gyvūną.';
  end if;
  if p_start_date is null then
    raise exception 'Įveskite pradžios datą.';
  end if;
  select * into v_protocol from sync_protocols where id = p_protocol_id;
  if not found then
    raise exception 'Pasirinkite sinchronizacijos protokolą.';
  end if;
  select count(*) into v_total from sync_protocol_steps where protocol_id = p_protocol_id;
  if v_total = 0 then
    raise exception 'Protokolas „%“ neturi žingsnių.', v_protocol.name;
  end if;

  select a.protocol_name into v_open
  from animal_visits v
  join sync_protocol_applications a on a.id = v.sync_application_id
  where v.animal_id = p_animal_id and v.status in ('planuojamas', 'vykdomas')
  limit 1;
  if v_open is not null then
    raise exception 'Gyvūnui jau taikomas protokolas „%“ — pirmiausia nutraukite jį.', v_open;
  end if;

  insert into sync_protocol_applications (protocol_id, protocol_name, animal_id, start_date, applied_by, created_by)
  values (p_protocol_id, v_protocol.name, p_animal_id, p_start_date, nullif(p_vet_name, ''), auth.uid())
  returning id into v_app;

  for st in select * from sync_protocol_steps where protocol_id = p_protocol_id order by day_offset, sort_order loop
    n := n + 1;
    insert into animal_visits (animal_id, visit_datetime, procedures, status, notes, vet_name, created_by,
                               sync_application_id, sync_step_title, sync_step_no, sync_step_total, planned_medications)
    values (p_animal_id, ((p_start_date + st.day_offset)::text || ' ' || v_time || ' Europe/Vilnius')::timestamptz,
            case st.kind when 'sekinimas' then array['sekinimas'] else array['sinchronizacija'] end,
            'planuojamas', st.notes, nullif(p_vet_name, ''), auth.uid(),
            v_app, st.title, n, v_total, st.medications);
  end loop;

  return n;
end;
$$;

grant execute on function apply_sync_protocol(uuid, uuid, date, text, text) to authenticated;

notify pgrst, 'reload schema';

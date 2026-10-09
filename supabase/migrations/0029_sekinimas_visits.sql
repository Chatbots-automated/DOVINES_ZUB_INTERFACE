-- 0029_sekinimas_visits.sql
-- Sėklinimas as a visit procedure (farm's request, 2026-10) — in particular the
-- LAST step of a sinchronizacijos protokolas (FTAI). A visit with the 'sekinimas'
-- procedure (allowed since 0025) is closed by recording an insemination:
-- insemination_records.visit_id links it, exactly like treatments/vaccinations.
-- Semen + gloves are still consumed FEFO inside create_insemination() (0017);
-- the wrapper below links the record and advances the visit in the SAME
-- transaction, so a stock shortfall rolls back the record, the link and the
-- status together. Deleting a visit never deletes the (journal) insemination.

alter table insemination_records add column visit_id uuid references animal_visits (id) on delete set null;
create index insemination_records_visit_id_idx on insemination_records (visit_id) where visit_id is not null;

-- fn_visit_refresh_status (0018 / 0025) + 'sekinimas': done once an insemination is linked.
create or replace function fn_visit_refresh_status(p_visit_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v animal_visits%rowtype;
  v_pending boolean;
begin
  select * into v from animal_visits where id = p_visit_id;
  if not found or v.status not in ('planuojamas', 'vykdomas') then
    return;
  end if;

  v_pending :=
    exists (
      select 1 from unnest(v.procedures) p
      where p in ('apziura', 'gydymas', 'profilaktika')
        and not exists (select 1 from treatments t where t.visit_id = v.id and t.procedure_type = p)
    )
    or ('vakcina' = any (v.procedures) and not exists (select 1 from vaccinations x where x.visit_id = v.id))
    or ('temperatura' = any (v.procedures) and v.temperature is null)
    or ('sinchronizacija' = any (v.procedures)
        and (jsonb_array_length(v.planned_medications) = 0
             or not exists (select 1 from treatments t where t.visit_id = v.id and t.procedure_type = 'sinchronizacija')))
    or ('sekinimas' = any (v.procedures) and not exists (select 1 from insemination_records i where i.visit_id = v.id))
    or 'kita' = any (v.procedures);

  update animal_visits set status = case when v_pending then 'vykdomas' else 'baigtas' end where id = p_visit_id;
end;
$$;

-- create_insemination_for_visit(visit, create_insemination payload) — the animal
-- always comes from the visit (any animal_id in the payload is overridden).
create or replace function create_insemination_for_visit(p_visit_id uuid, p_data jsonb)
returns uuid
language plpgsql
security invoker
as $$
declare
  v animal_visits%rowtype;
  v_id uuid;
begin
  select * into v from animal_visits where id = p_visit_id for update;
  if not found then
    raise exception 'Vizitas nerastas.';
  end if;
  if v.status in ('atsauktas', 'neivykes') then
    raise exception 'Vizitas atšauktas — įrašo pridėti negalima.';
  end if;

  v_id := create_insemination(p_data || jsonb_build_object('animal_id', v.animal_id));
  update insemination_records set visit_id = p_visit_id where id = v_id;
  perform fn_visit_refresh_status(p_visit_id);
  return v_id;
end;
$$;

grant execute on function create_insemination_for_visit(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

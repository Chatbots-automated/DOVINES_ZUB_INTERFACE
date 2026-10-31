import { GatewayError, buildRequestData, escapeXml, parseDdmData } from "./gateway.js";
import { validateModel } from "./treatment-model.js";

// GVET treatment -> DelPro through the Gateway (delpro_write_channel = 'gateway', 0044):
//   1. the DiagnosesAndTreatmentEvent (shape verified on the farm: Animal guid, Diagnosis
//      code, EventDate UTC, EventTime local, Comment "GVET:<job> …"), looked up by its
//      marker FIRST on every attempt, so a retry never makes a second one;
//   2. one per-animal medicine usage per GVET medicine line, through the object and
//      properties in treatment-model.json (verified on the farm, never assumed);
//   3. every written property read back and compared.
// GVET marks the job synchronized only when all of it is verified (report v4);
// a diagnosis event with medicine names in its Comment is not a treatment.

const EVENT = "DiagnosesAndTreatmentEvent";
const EVENT_PROPS = ["ObjectGuid", "Animal", "Diagnosis", "EventDate", "EventTime", "Comment"];

export function buildEventXml(g) {
  return (
    `<ddmData><object name="${EVENT}">` +
    `<property name="Animal" objectType="Animal">${escapeXml(g.animal_guid)}</property>` +
    `<property name="Diagnosis" objectType="Diagnosis">${escapeXml(g.diagnosis_code)}</property>` +
    `<property name="EventDate">${escapeXml(g.event_at)}</property>` +
    `<property name="EventTime">${escapeXml(g.event_time)}</property>` +
    `<property name="Comment">${escapeXml(g.comment)}</property>` +
    `</object></ddmData>`
  );
}

const fmt = (v) => (v === null || v === undefined ? "" : String(v));
const sameNum = (a, b) => a !== null && b !== null && Number(String(a).replace(",", ".")) === Number(String(b).replace(",", "."));

/** The values each usage record would get — from GVET data only; a mapped property without a value is a problem, never a guess. */
export function plannedUsages(plan, model) {
  const problems = [];
  const usages = [];
  const p = model.properties;
  for (const m of plan.medicines) {
    const values = { [p.drug]: { value: m.drug_code, objectType: "Drug" }, [p.dosage]: { value: m.qty } };
    if (p.drug_params) {
      if (!m.drug_params_key) problems.push({ code: "medicine_params_missing", message: `${m.product_name}: nėra DelPro parametrų rakto.` });
      values[p.drug_params] = { value: m.drug_params_key, objectType: "DrugParameters" };
    }
    if (p.treat_days) {
      if (!plan.treatment.course_days && plan.treatment.course_days !== 0) {
        // a single-day treatment has no course: 1 day is what was recorded, not a guess
        values[p.treat_days] = { value: 1 };
      } else values[p.treat_days] = { value: plan.treatment.course_days };
    }
    if (p.frequency) problems.push({ code: "frequency_unknown", message: `${m.product_name}: GVET neturi dažnumo (kartai per dieną) — DelPro savybė ${p.frequency} neužpildoma spėjant.` });
    if (p.date) values[p.date] = { value: plan.gateway_event.event_at };
    if (m.qty === null || m.qty === undefined || Number(m.qty) <= 0) problems.push({ code: "missing_dose", message: `${m.product_name}: nėra dozės.` });
    usages.push({ product: m.product_name, drug_code: m.drug_code, values });
  }
  return { usages, problems };
}

export function buildUsageXml(model, eventGuid, usage) {
  const props = [`<property name="${model.properties.event}" objectType="${EVENT}">${escapeXml(eventGuid)}</property>`];
  for (const [name, { value, objectType }] of Object.entries(usage.values)) {
    const t = objectType ? ` objectType="${objectType}"` : "";
    props.push(fmt(value) === "" ? `<property name="${name}"${t} />` : `<property name="${name}"${t}>${escapeXml(fmt(value))}</property>`);
  }
  return `<ddmData><object name="${model.usage_object}">${props.join("")}</object></ddmData>`;
}

/** Worker-side checks on top of the database plan (which already lists the GVET-side problems). */
export function treatmentProblems(plan, model) {
  const problems = [...plan.problems];
  for (const e of validateModel(model)) problems.push({ code: "medication_model", message: e });
  if (model && validateModel(model).length === 0) {
    problems.push(...plannedUsages(plan, model).problems);
    if (model.event_treatment_property && !plan.diagnosis.recommended_treatment) {
      problems.push({ code: "no_treatment_protocol", message: "Diagnozė neturi DelPro gydymo protokolo (RecommendedTreatment)." });
    }
  }
  return problems;
}

async function get(client, objectName, properties, where, top = 5) {
  return parseDdmData(await client.getDataXml(buildRequestData({ objectName, properties, where, top }))).filter((o) => o.objectName === objectName);
}

/** Read-only checks against the live Gateway: the references exist and match. */
export async function liveChecks(client, plan) {
  const problems = [];
  const a = plan.animal;
  if (a.delpro_object_guid) {
    const [animal] = await get(client, "Animal", ["ObjectGuid", "Number"], [{ name: "ObjectGuid", value: a.delpro_object_guid }], 2);
    if (!animal) problems.push({ code: "animal_not_in_delpro", message: `DelPro neturi gyvulio ${a.delpro_object_guid}.` });
    else if (a.animal_no && animal.properties.Number?.value && animal.properties.Number.value !== a.animal_no) {
      problems.push({ code: "animal_number_mismatch", message: `DelPro gyvulio Number ${animal.properties.Number.value} ≠ GVET ${a.animal_no}.` });
    }
  }
  if (plan.diagnosis.code) {
    const d = await get(client, "Diagnosis", ["Code", "Name"], [{ name: "Code", value: plan.diagnosis.code }], 2);
    if (!d.some((x) => x.properties.Code?.value === plan.diagnosis.code)) problems.push({ code: "diagnosis_not_in_delpro", message: `DelPro neturi diagnozės ${plan.diagnosis.code}.` });
  }
  for (const m of plan.medicines) {
    if (!m.drug_code) continue;
    const d = await get(client, "Drug", ["Code", "Name", "DefaultParameters"], [{ name: "Code", value: m.drug_code }], 2);
    if (!d.some((x) => x.properties.Code?.value === m.drug_code)) problems.push({ code: "drug_not_in_delpro", message: `DelPro neturi vaisto ${m.drug_code}.` });
    if (m.drug_params_key) {
      const [dp] = await get(client, "DrugParameters", ["Key", "UOM", "DumpMilkDays", "MeatWithholdDays"], [{ name: "Key", value: m.drug_params_key }], 2);
      if (!dp) problems.push({ code: "params_not_in_delpro", message: `DelPro neturi parametrų ${m.drug_params_key}.` });
      else if (!sameNum(dp.properties.DumpMilkDays?.value ?? null, m.delpro_milk_days) || !sameNum(dp.properties.MeatWithholdDays?.value ?? null, m.delpro_meat_days)) {
        problems.push({ code: "withdrawal_changed_in_delpro", message: `${m.product_name}: DelPro karencija pasikeitė nuo sinchronizacijos — paleiskite katalogo sinchronizaciją.` });
      }
    }
  }
  return problems;
}

/** Events carrying this job's GVET:<id> marker (filtered client-side: <equal> on Comment is not verified). */
async function markedEvents(client, g) {
  const marker = g.comment.split(" ")[0];
  const found = await get(client, EVENT, EVENT_PROPS, [{ name: "Comment", value: g.comment }]);
  return found.filter((o) => (o.properties.Comment?.value ?? "").startsWith(marker));
}

class TreatmentWriteError extends Error {
  constructor(message, { outcomeUnknown = false, details = null } = {}) {
    super(message);
    this.outcomeUnknown = outcomeUnknown;
    this.details = details;
  }
}

/**
 * Writes one claimed treatment. Returns actual_result for delpro_report_job_result;
 * throws TreatmentWriteError (outcomeUnknown when a write may have landed).
 */
export async function writeTreatment(client, plan, model) {
  const g = plan.gateway_event;
  const p = model.properties;
  const written = [];
  try {
    // 1. the event: look it up by marker BEFORE any write
    let event;
    const existing = await markedEvents(client, g);
    if (existing.length > 1) throw new TreatmentWriteError(`DelPro turi ${existing.length} įvykius su šios užduoties žyme — patikrinkite ranka.`);
    if (existing.length === 1) {
      event = existing[0];
      if (String(event.properties.Animal?.value ?? "").toLowerCase() !== String(g.animal_guid).toLowerCase() || event.properties.Diagnosis?.value !== g.diagnosis_code) {
        throw new TreatmentWriteError("DelPro įvykis su šios užduoties žyme yra kitam gyvuliui ar diagnozei — patikrinkite ranka.");
      }
    } else {
      const res = await client.createData(buildEventXml(g));
      const created = res.created.find((c) => c.type === EVENT) ?? res.created[0];
      if (!created?.keyValue) throw new TreatmentWriteError("DelPro sukūrė įvykį, bet negrąžino ObjectGuid.", { outcomeUnknown: true });
      written.push({ object: EVENT, key: created.keyValue });
      [event] = await get(client, EVENT, EVENT_PROPS, [{ name: "ObjectGuid", value: created.keyValue }], 2);
      if (!event) throw new TreatmentWriteError(`Įvykis ${created.keyValue} DelPro nerastas po įrašymo.`, { outcomeUnknown: true });
    }
    const eventGuid = event.properties.ObjectGuid?.value;

    // 2. medicine usages: adopt existing ones for this event, create only the missing
    const { usages } = plannedUsages(plan, model);
    const readProps = [model.key_property ?? "ObjectGuid", p.event, ...new Set(usages.flatMap((u) => Object.keys(u.values)))];
    const onEvent = await get(client, model.usage_object, readProps, [{ name: p.event, value: eventGuid }], 50);
    const results = [];
    const used = new Set();
    for (const u of usages) {
      const match = onEvent.find((o) => !used.has(o) && o.properties[p.drug]?.value === u.drug_code && sameNum(o.properties[p.dosage]?.value ?? null, u.values[p.dosage].value));
      let record = match ?? null;
      if (record) used.add(record);
      else {
        const res = await client.createData(buildUsageXml(model, eventGuid, u));
        const created = res.created.find((c) => c.type === model.usage_object) ?? res.created[0];
        if (!created?.keyValue) throw new TreatmentWriteError(`DelPro sukūrė vaisto įrašą (${u.product}), bet negrąžino rakto.`, { outcomeUnknown: true });
        written.push({ object: model.usage_object, key: created.keyValue });
        [record] = await get(client, model.usage_object, readProps, [{ name: created.keyProperty || model.key_property || "ObjectGuid", value: created.keyValue }], 2);
        if (!record) throw new TreatmentWriteError(`Vaisto įrašas ${created.keyValue} DelPro nerastas po įrašymo.`, { outcomeUnknown: true });
      }
      // 3. compare every written property
      const diffs = [];
      if (String(record.properties[p.event]?.value ?? "").toLowerCase() !== String(eventGuid).toLowerCase()) diffs.push({ property: p.event, expected: eventGuid, actual: record.properties[p.event]?.value ?? null });
      for (const [name, { value }] of Object.entries(u.values)) {
        const actual = record.properties[name]?.value ?? null;
        const ok = typeof value === "number" || /^-?\d+([.,]\d+)?$/.test(fmt(value)) ? sameNum(actual, value) : fmt(actual).trim() === fmt(value).trim();
        if (!ok) diffs.push({ property: name, expected: value, actual });
      }
      results.push({ product: u.product, drug_code: u.drug_code, key: record.properties[model.key_property ?? "ObjectGuid"]?.value ?? null, adopted: !!match, verified: diffs.length === 0, diffs });
    }
    const unexpected = onEvent.filter((o) => !used.has(o) && !results.some((r) => r.key === o.properties[model.key_property ?? "ObjectGuid"]?.value));

    return {
      channel: "gateway",
      object_guid: eventGuid,
      animal_guid: event.properties.Animal?.value ?? null,
      diagnosis_code: event.properties.Diagnosis?.value ?? null,
      event_date: event.properties.EventDate?.value ?? null,
      event_time: event.properties.EventTime?.value ?? null,
      comment: event.properties.Comment?.value ?? null,
      found_existing_event: existing.length === 1,
      medication: {
        required: true,
        object: model.usage_object,
        usages: results,
        unexpected_on_event: unexpected.length,
        verified: results.length === plan.medicines.length && results.every((r) => r.verified) && unexpected.length === 0,
      },
      written,
    };
  } catch (err) {
    if (err instanceof TreatmentWriteError) {
      err.details = { ...(err.details ?? {}), written };
      throw err;
    }
    const unknown = err instanceof GatewayError ? err.outcomeUnknown || written.length > 0 : written.length > 0;
    throw new TreatmentWriteError(err.message, { outcomeUnknown: unknown, details: { code: err.code ?? null, written } });
  }
}

export { TreatmentWriteError };

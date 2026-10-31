import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { buildRequestData, createGatewayClient, parseDdmData } from "./gateway.js";

// READ-ONLY: what does THIS farm's Gateway expose for a treatment given to an
// animal? GetData (and GetMetadata) only. Writes discovery/treatment-probe.json.
//
//   npm run treatment-probe                       -> uses the verified event 489751f2-…
//   npm run treatment-probe -- <event ObjectGuid> -> another existing event (e.g. one entered by hand in DelPro WITH a medicine)
//
// 1. which DiagnosesAndTreatmentEvent properties exist (each queried alone: an unknown
//    property makes the Gateway fail that request, a known one is echoed back);
// 2. which candidate object names exist for per-animal medicine usage, and their properties;
// 3. whether records of those objects point at the event — i.e. whether DelPro applied the
//    diagnosis's RecommendedTreatment by itself (checked, not assumed).
// Candidate names are only probes; nothing is used for writing until a person records the
// verified result in treatment-model.json.

const OUT = path.join(ROOT, "discovery");
const EVENT_GUID = process.argv[2] ?? "489751f2-ffc7-4491-a445-482160d62620";
const EVENT_CANDIDATES = ["ObjectGuid", "Animal", "Diagnosis", "EventDate", "EventTime", "Comment", "Treatment", "Treatments", "DrugUsages",
  "HealthEventDrugUsages", "TreatmentDrugUsages", "DrugUsage", "Drugs", "Medications", "Status", "User", "Technician", "Veterinarian",
  "EndDate", "CuredDate", "Cured", "Remark", "Lactation", "WithdrawalMilkEnd", "WithdrawalMeatEnd", "DumpMilkUntil", "MeatWithholdUntil"];
const OBJECT_CANDIDATES = ["HealthEventDrugUsage", "DrugUsage", "AnimalDrugUsage", "EventDrugUsage", "DiagnosesAndTreatmentEventDrugUsage",
  "TreatmentEventDrugUsage", "HealthEvent", "TreatmentEvent", "AnimalTreatment", "DrugTreatment", "DrugAdministration", "Medication",
  "HealthTreatment", "WithdrawalPeriod", "AnimalWithdrawal"];
const USAGE_PROP_CANDIDATES = ["ObjectGuid", "Key", "Animal", "Event", "HealthEvent", "DiagnosesAndTreatmentEvent", "TreatmentEvent", "Treatment",
  "Drug", "DrugParameters", "DrugParams", "Dosage", "Dose", "Amount", "Quantity", "UOM", "Date", "EventDate", "StartDate", "EndDate",
  "TreatCowDays", "Frequency", "DumpMilkDays", "MeatWithholdDays", "MilkWithdrawalEnd", "MeatWithdrawalEnd", "Comment"];

const client = createGatewayClient();
const tryGet = async (objectName, properties, where = [], top = 3) => {
  try {
    const xml = await client.getDataXml(buildRequestData({ objectName, properties, where, top }));
    return { ok: true, objects: parseDdmData(xml).filter((o) => o.objectName === objectName) };
  } catch (err) {
    return { ok: false, error: `${err.code ?? ""} ${err.message}`.trim() };
  }
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { event_guid: EVENT_GUID, at: new Date().toISOString(), event_properties: {}, objects: {}, metadata: null };

  console.log(`DiagnosesAndTreatmentEvent ${EVENT_GUID}:`);
  for (const prop of EVENT_CANDIDATES) {
    const r = await tryGet("DiagnosesAndTreatmentEvent", [prop], [{ name: "ObjectGuid", value: EVENT_GUID }], 2);
    const o = r.ok ? r.objects[0] : null;
    const present = r.ok && !!o && prop in o.properties;
    report.event_properties[prop] = present ? { value: o.properties[prop].value, objectType: o.properties[prop].objectType ?? null } : { missing: true, error: r.error ?? null };
    if (present) console.log(`  ${prop} = ${o.properties[prop].value ?? "(tuščia)"}${o.properties[prop].objectType ? ` [${o.properties[prop].objectType}]` : ""}`);
  }

  console.log("\nObjektai vaisto naudojimui (bandomi pavadinimai):");
  for (const name of OBJECT_CANDIDATES) {
    const base = await tryGet(name, ["ObjectGuid"], [], 1);
    const baseKey = base.ok ? base : await tryGet(name, ["Key"], [], 1);
    if (!baseKey.ok) {
      report.objects[name] = { exists: false, error: baseKey.error };
      continue;
    }
    const props = {};
    for (const prop of USAGE_PROP_CANDIDATES) {
      const r = await tryGet(name, [prop], [], 3);
      if (r.ok && r.objects.some((o) => prop in o.properties)) props[prop] = r.objects.map((o) => o.properties[prop]?.value ?? null);
    }
    // records pointing at the event (any property whose value equals the event guid)
    const refs = [];
    for (const prop of Object.keys(props)) {
      const r = await tryGet(name, Object.keys(props), [{ name: prop, value: EVENT_GUID }], 20);
      if (r.ok) for (const o of r.objects) if (String(o.properties[prop]?.value ?? "").toLowerCase() === EVENT_GUID.toLowerCase()) refs.push({ via: prop, record: Object.fromEntries(Object.entries(o.properties).map(([k, v]) => [k, v.value])) });
    }
    report.objects[name] = { exists: true, properties: props, records_for_event: refs };
    console.log(`  ✓ ${name}: savybės ${Object.keys(props).join(", ") || "(nerasta iš sąrašo)"}; įrašų šiam įvykiui: ${refs.length}`);
  }

  try {
    report.metadata = await client.getMetadata({ objectName: "DiagnosesAndTreatmentEvent" });
  } catch (err) {
    report.metadata = { error: `${err.code ?? ""} ${err.message}`.trim() };
  }

  const file = path.join(OUT, "treatment-probe.json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  const found = Object.entries(report.objects).filter(([, v]) => v.exists).map(([k]) => k);
  console.log(`\n${found.length ? `Rasti objektai: ${found.join(", ")}.` : "NĖ VIENAS bandytas vaisto naudojimo objektas neegzistuoja — vaistų įrašymas per Gateway nepatvirtintas."}`);
  console.log(`Ataskaita: ${file}\nNieko neįrašyta. treatment-model.json kuriamas ranka tik patikrinus DelPro.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

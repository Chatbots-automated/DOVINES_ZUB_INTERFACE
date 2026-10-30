import { buildRequestData, escapeXml, parseDdmData } from "./gateway.js";
import { CATALOG_TYPES } from "./catalog.js";

// Read-only check of a queued catalog job against the LIVE DelPro Gateway,
// run before any CreateData/UpdateData (`npm run catalog:write-check -- <job>`,
// and automatically by `catalog:write-one`). GetData only.
//
// Per write step it checks, with DelPro's own answers as the evidence:
//   * every property the step writes is a property DelPro returns for that
//     object (a GetData of exactly those properties must succeed and echo them);
//   * a reference property carries the objectType the step declares;
//   * a boolean is written in the format DelPro itself returns (true/false);
//   * UOM / ApplicationMethod values are ones DelPro already uses;
//   * a created record's Name does not already exist in DelPro (no duplicate).
// It also prints the exact ddmData each step will send (step references shown
// as {step:<id>} until the earlier step has its key).

const typeOf = (name) => CATALOG_TYPES.find((t) => t.objectName === name);
const DOMAIN_PROPERTIES = new Set(["UOM", "ApplicationMethod"]);

function previewXml(step) {
  const props = [];
  if (step.operation === "update") props.push(`<property name="${step.key_property}">${escapeXml(step.key)}</property>`);
  for (const p of step.properties) {
    const v = p.ref_step ? `{step:${p.ref_step}}` : p.value === null || p.value === undefined ? "" : typeof p.value === "boolean" ? String(p.value) : String(p.value);
    const typeAttr = p.object_type ? ` objectType="${p.object_type}"` : "";
    props.push(v === "" ? `<property name="${p.name}"${typeAttr} />` : `<property name="${p.name}"${typeAttr}>${escapeXml(v)}</property>`);
  }
  return `<ddmData><object name="${step.object}">${props.join("")}</object></ddmData>`;
}

async function getObjects(client, objectName, properties, where, top) {
  const xml = await client.getDataXml(buildRequestData({ objectName, properties, where, top }));
  return parseDdmData(xml).filter((o) => o.objectName === objectName);
}

/** @returns {{ ok: boolean, problems: string[], notes: string[], steps: { id: string, object: string, operation: string, xml: string }[] }} */
export async function checkCatalogJob(client, job) {
  const problems = [];
  const notes = [];
  const steps = [];

  for (const step of job.steps) {
    if (step.operation === "verify_refs") continue;
    steps.push({ id: step.id, object: step.object, operation: step.operation, xml: previewXml(step) });
    const where = `${step.id} (${step.object}.${step.operation})`;

    const names = [step.key_property, ...step.properties.map((p) => p.name)];
    let sample = [];
    try {
      sample = await getObjects(client, step.object, names, [], 20);
    } catch (err) {
      problems.push(`${where}: DelPro neatpažįsta savybių ${names.join(", ")} — ${err.message}`);
      continue;
    }
    if (sample.length === 0) {
      notes.push(`${where}: DelPro neturi nė vieno ${step.object} — savybių pavadinimų patikrinti negalima.`);
    }
    for (const p of step.properties) {
      if (sample.length && !sample.some((o) => p.name in o.properties)) {
        problems.push(`${where}: DelPro ${step.object} negrąžina savybės ${p.name}.`);
        continue;
      }
      const filled = sample.map((o) => o.properties[p.name]).filter((x) => x && x.value !== null && x.value !== "");
      if (p.object_type) {
        const declared = filled.map((x) => x.objectType).filter(Boolean);
        if (declared.length && !declared.every((t) => t === p.object_type)) {
          problems.push(`${where}: ${p.name} DelPro rodo objectType ${[...new Set(declared)].join("/")}, žingsnis siunčia ${p.object_type}.`);
        }
      }
      if (typeof p.value === "boolean" && filled.length && !filled.every((x) => /^(true|false)$/.test(x.value))) {
        problems.push(`${where}: ${p.name} DelPro formatas „${filled[0].value}“, o siunčiama ${p.value}.`);
      }
      if (DOMAIN_PROPERTIES.has(p.name) && p.value !== null && p.value !== undefined && p.value !== "") {
        const used = await getObjects(client, step.object, [step.key_property, p.name], [{ name: p.name, value: p.value }], 1);
        if (!used.some((o) => o.properties[p.name]?.value === String(p.value))) {
          problems.push(`${where}: ${p.name}=„${p.value}“ DelPro dar nenaudojama — patikrinkite reikšmę.`);
        }
      }
    }
    if (step.operation === "create" && step.lookup_name && typeOf(step.object)?.fields.name) {
      const same = (await getObjects(client, step.object, [step.key_property, "Name"], [{ name: "Name", value: step.lookup_name }], 5)).filter(
        (o) => (o.properties.Name?.value ?? "").trim() === step.lookup_name.trim(),
      );
      if (same.length) {
        problems.push(`${where}: DelPro jau turi „${step.lookup_name}“ (${same.map((o) => o.properties[step.key_property]?.value).join(", ")}) — kurti nereikia, susiekite.`);
      }
    }
  }
  return { ok: problems.length === 0, problems, notes, steps };
}

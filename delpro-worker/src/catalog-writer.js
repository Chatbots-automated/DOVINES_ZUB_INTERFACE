import { config } from "./config.js";
import { gvet } from "./gvet.js";
import { GatewayError, buildRequestData, escapeXml, parseDdmData } from "./gateway.js";
import { CATALOG_TYPES, normalizeRecord } from "./catalog.js";
import { log } from "./log.js";

// GVET -> DelPro catalog writes (0037 delpro_catalog_jobs). A job is a frozen
// list of steps built by the database; this file only executes them:
//
//   for each step:  "start" reported to GVET  ->  CreateData / UpdateData
//                   -> read the record back by its key -> compare with what
//                   was written -> "done" (+ key) reported to GVET
//
// Safety:
//   * GVET only hands out jobs while delpro_catalog_write_enabled is on and the
//     operation was validated by a test job; this worker additionally needs
//     CATALOG_WRITE_ENABLED=true and is the only place a write-enabled Gateway
//     client is created for the catalog.
//   * A step reported "start" but never "done" (crash, timeout) has an unknown
//     outcome. It is never re-sent and never adopted by name: the job goes to
//     needs_review (same-name DelPro records listed as candidates) until an
//     admin assigns the DelPro record (delpro_catalog_job_action 'adopt' — the
//     worker then reads it back and compares every property) or confirms it
//     does not exist ('resend').
//   * The read-back must match every written property, else verification_failed.
//   * No DeleteData anywhere.

const MAX_JOBS_PER_TICK = 10;
const typeOf = (name) => CATALOG_TYPES.find((t) => t.objectName === name);

class StepError extends Error {
  constructor(kind, message, details) {
    super(message);
    this.kind = kind; // "verification_failed" | "needs_review"
    this.details = details;
  }
}

/** The value a property step writes, with step references resolved to DelPro keys. */
function resolveValue(prop, keys) {
  if (prop.ref_step) {
    const key = keys[prop.ref_step];
    if (!key) throw new StepError("needs_review", `Žingsnis ${prop.ref_step} neturi DelPro rakto (${prop.name}).`);
    return key;
  }
  return prop.value ?? null;
}

const formatValue = (v) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "true" : "false") : String(v));

/** <ddmData><object name=".."><property name="Key">..</property>…</object></ddmData> — the verified CreateData shape. */
export function buildWriteXml(step, keys) {
  const props = [];
  if (step.operation === "update") {
    // UpdateData identifies the record by its key property (to be confirmed by the Gateway test jobs).
    props.push(`<property name="${step.key_property}">${escapeXml(step.key)}</property>`);
  }
  for (const p of step.properties) {
    const value = formatValue(resolveValue(p, keys));
    const typeAttr = p.object_type ? ` objectType="${p.object_type}"` : "";
    props.push(value === "" ? `<property name="${p.name}"${typeAttr} />` : `<property name="${p.name}"${typeAttr}>${escapeXml(value)}</property>`);
  }
  return `<ddmData><object name="${step.object}">${props.join("")}</object></ddmData>`;
}

function same(expected, actual) {
  if (expected === null || expected === undefined || expected === "") return actual === null || actual === "";
  if (actual === null) return false;
  if (typeof expected === "boolean") return /^(true|1|yes)$/i.test(actual) === expected && /^(true|false|1|0|yes|no)$/i.test(actual);
  if (typeof expected === "number") return Number(String(actual).replace(",", ".")) === expected;
  return String(actual).trim() === String(expected).trim();
}

/** Properties of the read-back record that differ from what the step wrote. */
export function compareStep(step, object, keys) {
  const diffs = [];
  for (const p of step.properties) {
    const expected = resolveValue(p, keys);
    const actual = object.properties[p.name]?.value ?? null;
    if (!same(expected, actual)) diffs.push({ property: p.name, expected, actual });
  }
  return diffs;
}

async function readByKey(client, objectName, keyProperty, key) {
  const type = typeOf(objectName);
  const properties = type ? Object.values(type.fields).map(([prop]) => prop) : [keyProperty];
  const xml = await client.getDataXml(buildRequestData({ objectName, properties, where: [{ name: keyProperty, value: key }], top: 2 }));
  const found = parseDdmData(xml).filter((o) => o.objectName === objectName);
  if (found.length !== 1) {
    throw new StepError("verification_failed", `${objectName} ${keyProperty}=${key}: DelPro grąžino ${found.length} įrašų po įrašymo.`);
  }
  return found[0];
}

/** DelPro records named exactly like the step's record — review candidates only, never adopted automatically. */
async function findByName(client, step) {
  const xml = await client.getDataXml(
    buildRequestData({ objectName: step.object, properties: [step.key_property, "Name"], where: [{ name: "Name", value: step.lookup_name }], top: 5 }),
  );
  // Filtered again here: whether the Gateway honours <equal> on Name is not verified.
  return parseDdmData(xml)
    .filter((o) => o.objectName === step.object && (o.properties.Name?.value ?? "").trim() === step.lookup_name.trim())
    .map((o) => ({ key: o.properties[step.key_property]?.value ?? null, name: o.properties.Name?.value ?? null }))
    .filter((c) => c.key);
}

async function uncertainCreate(client, step) {
  const candidates = step.lookup_name ? await findByName(client, step) : [];
  const what = step.lookup_name ? `${step.object} „${step.lookup_name}“` : step.object;
  const found = candidates.length
    ? `DelPro rasta ${candidates.length} to paties pavadinimo įraš${candidates.length === 1 ? "as" : "ai"} (${candidates.map((c) => c.key).join(", ")}) — tai gali būti ir ne GVET sukurtas įrašas.`
    : "DelPro to paties pavadinimo įrašo nerasta.";
  return new StepError(
    "needs_review",
    `${what}: ankstesnio įrašymo rezultatas nežinomas. ${found} Patikrinkite DelPro ir priskirkite įrašą arba patvirtinkite, kad jo nėra.`,
    { uncertain_step: step.id, object: step.object, lookup_name: step.lookup_name ?? null, candidates },
  );
}

/** The created record's key: CreatedObject.keyValue when it is the step's key property, else looked up by it. */
async function createdKey(client, step, res) {
  const created = res.created.find((c) => !c.type || c.type === step.object) ?? res.created[0];
  if (!created?.keyValue) throw new StepError("needs_review", `${step.object} sukurtas, bet Gateway negrąžino rakto.`);
  if (created.keyProperty === step.key_property) return created.keyValue;
  const xml = await client.getDataXml(
    buildRequestData({ objectName: step.object, properties: [step.key_property], where: [{ name: created.keyProperty, value: created.keyValue }], top: 2 }),
  );
  const [o] = parseDdmData(xml).filter((x) => x.objectName === step.object);
  const key = o?.properties[step.key_property]?.value;
  if (!key) throw new StepError("needs_review", `${step.object} sukurtas (${created.keyProperty}=${created.keyValue}), bet ${step.key_property} nerastas.`);
  return key;
}

const readbackEntry = (objectName, object) => {
  const type = typeOf(objectName);
  return type ? { object_type: objectName, record: normalizeRecord(type, object).record } : null;
};

export async function executeCatalogJob(client, job) {
  const keys = {};
  for (const [id, p] of Object.entries(job.progress ?? {})) if (p?.key) keys[id] = p.key;
  const readback = [];

  try {
    for (const step of job.steps) {
      if (step.operation === "verify_refs") {
        // Treatment.DrugUsages is read-only in the Gateway mapping: check DelPro linked the usages itself.
        const key = step.key ?? keys[step.ref_step];
        const t = await readByKey(client, step.object, step.key_property, key);
        const listed = (t.properties[step.property]?.value ?? "").split(",").map((k) => k.trim()).filter(Boolean);
        const missing = step.expect_steps.map((s) => keys[s]).filter((k) => !listed.includes(k));
        if (missing.length) {
          throw new StepError("verification_failed", `${step.object} ${key}: ${step.property} neturi ${missing.join(", ")}.`, { listed });
        }
        const entry = readbackEntry(step.object, t);
        if (entry) readback.push(entry);
        continue;
      }

      let key = step.operation === "update" ? step.key : keys[step.id];
      const started = job.progress?.[step.id]?.started_at;

      if (!(step.operation === "create" && keys[step.id])) {
        if (started && !job.progress?.[step.id]?.key && step.operation === "create") {
          // An earlier attempt may have written this step. A name is not proof
          // that the record is ours (DelPro may hold a same-named diagnosis or
          // medicine entered by hand), so nothing is adopted or re-sent here:
          // an admin checks DelPro and either assigns the record (adopt — then
          // read back and compared like any write) or confirms it is absent
          // (resend). Same-name records are listed only as candidates.
          throw await uncertainCreate(client, step);
        }
        // An update is idempotent: writing the same values again is safe.

        if (!key || step.operation === "update") {
          const xml = buildWriteXml(step, keys);
          await gvet.catalogJobStep({ job_id: job.job_id, step: step.id, phase: "start" });
          const res = step.operation === "create" ? await client.createData(xml) : await client.updateData(xml);
          if (step.operation === "create") key = await createdKey(client, step, res);
        }
      }

      const object = await readByKey(client, step.object, step.key_property, key);
      const diffs = compareStep(step, object, keys);
      if (diffs.length) {
        throw new StepError(
          "verification_failed",
          `${step.object} ${key}: DelPro įrašas nesutampa — ${diffs.map((d) => `${d.property}: laukta „${formatValue(d.expected)}“, yra „${d.actual ?? ""}“`).join("; ")}`,
          { diffs },
        );
      }
      keys[step.id] = key;
      await gvet.catalogJobStep({ job_id: job.job_id, step: step.id, phase: "done", key });
      const entry = readbackEntry(step.object, object);
      if (entry) readback.push(entry);
    }

    const res = await gvet.catalogJobResult({ job_id: job.job_id, success: true, readback });
    log.info(`DelPro katalogas ← GVET: ${job.object_type}.${job.operation}${job.is_test ? " (bandymas)" : ""} → ${res?.status}`);
    return res;
  } catch (err) {
    const gw = err instanceof GatewayError ? err : null;
    const body = {
      job_id: job.job_id,
      success: false,
      error: err.message,
      error_code: gw?.code ?? err.kind ?? "ERROR",
      verification_failed: err.kind === "verification_failed",
      // a write whose outcome is unknown is handled on the next attempt via the step's "start" marker
      needs_review: err.kind === "needs_review",
      retryable: gw ? gw.retryable : false,
      details: err.details ?? gw?.details ?? null,
      readback,
    };
    log.error(`DelPro katalogas ← GVET nepavyko (${job.object_type}.${job.operation}):`, err.message);
    return gvet.catalogJobResult(body);
  }
}

export async function runCatalogWrites(client) {
  if (!config.catalogWriteEnabled) return 0;
  let processed = 0;
  while (processed < MAX_JOBS_PER_TICK) {
    const job = await gvet.catalogClaimJob({ worker_id: config.workerId, lease_seconds: 300 });
    if (!job) break;
    processed += 1;
    await executeCatalogJob(client, job);
  }
  return processed;
}

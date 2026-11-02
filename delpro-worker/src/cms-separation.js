import { GatewayError, buildRequestData, escapeXml, parseDdmData } from "./gateway.js";
import { config } from "./config.js";
import { gvet } from "./gvet.js";
import { log } from "./log.js";

// GVET CMS atskyrimai -> DelPro (0048). One approved GVET job = one DelPro AnimalActionSetting (ActionType SortCow)
// on the animal's AnimalMilkSetting:
//   Animal (ObjectGuid) -> AnimalMilkSetting (Key, Animal) -> AnimalActionSetting (AnimalMilkSetting = Key).
// READS are verified on the farm (DelPro 10.9). The CreateData payload below is the PROPOSED shape — not yet
// verified: nothing is written unless CMS_OUTBOUND_MODE=gateway AND GVET hands the job out (single supervised
// job, or a mode an admin marked verified after such a test). No SortArea / Sort Once property is ever sent.
// A write that may have reached DelPro but was not read back and compared goes to "Reikia peržiūros" in GVET.

export const ACTION_OBJECT = "AnimalActionSetting";
export const SESSION_PROPS = Array.from({ length: 10 }, (_, i) => `IsValidForSession${i + 1}`);
export const ACTION_READ_PROPS = ["Key", "AnimalMilkSetting", "ActionType", "Active", "StartDate", "EndDate", ...SESSION_PROPS, "LastUpdatedTime"];
const SENDABLE_MODES = ["period", "ongoing"];

export class CmsError extends Error {
  /** @param {string} code @param {string} message @param {{ retryable?: boolean, details?: object }} [opts] */
  constructor(code, message, { retryable = false, details } = {}) {
    super(message);
    this.name = "CmsError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

const bool = (v) => (v === true || v === false ? v : String(v ?? "").trim().toLowerCase() === "true");
const ts = (v) => (v ? Date.parse(v) : NaN);
const sameInstant = (a, b) => (!a && !b) || (!!a && !!b && ts(a) === ts(b));
const ornNorm = (v) => String(v ?? "").replace(/[\s.-]/g, "").toUpperCase();

async function get(client, objectName, properties, where = [], top = 50) {
  return parseDdmData(await client.getDataXml(buildRequestData({ objectName, properties, where, top }))).filter((o) => o.objectName === objectName);
}
const val = (o, p) => o?.properties?.[p]?.value ?? null;

/** Problems in the approved snapshot itself — checked again here, never trusted blindly. */
export function snapshotProblems(s, now = new Date()) {
  const p = [];
  if (!s?.animal_guid) p.push("Nėra gyvulio DelPro ObjectGuid.");
  if (!SENDABLE_MODES.includes(s?.mode)) p.push(`Režimas „${s?.mode}“ per Gateway nesiunčiamas.`);
  if (!s?.start_at || Number.isNaN(ts(s.start_at))) p.push("Nėra pradžios.");
  if (s?.mode === "period") {
    if (!s.end_at || Number.isNaN(ts(s.end_at))) p.push("Nėra pabaigos.");
    else if (ts(s.end_at) <= ts(s.start_at)) p.push("Pabaiga ne vėlesnė už pradžią.");
  }
  if (s?.mode === "ongoing" && s.end_at) p.push("Neterminuotas atskyrimas turi pabaigą.");
  if (s?.end_at && ts(s.end_at) <= now.getTime()) p.push("Pabaiga jau praėjo.");
  const sessions = Array.isArray(s?.sessions) ? s.sessions.map(Number) : [];
  if (sessions.length === 0) p.push("Nepasirinkta melžimo sesija.");
  if (sessions.some((x) => !Number.isInteger(x) || x < 1 || x > 10) || new Set(sessions).size !== sessions.length) p.push("Netinkamos melžimo sesijos.");
  if (s?.sort_area_key) p.push("Rūšiavimo vietos parinkimas per Gateway nepatikrintas.");
  return p;
}

/** The exact properties the write would set (all ten sessions explicit — selected true, the rest false). */
export function plannedActionProperties(s, milkSettingKey) {
  const sessions = new Set((s.sessions ?? []).map(Number));
  const props = [
    ["AnimalMilkSetting", String(milkSettingKey), "AnimalMilkSetting"],
    ["ActionType", "SortCow"],
    ["Active", "true"],
    ["StartDate", s.start_at],
  ];
  if (s.end_at) props.push(["EndDate", s.end_at]);
  SESSION_PROPS.forEach((name, i) => props.push([name, sessions.has(i + 1) ? "true" : "false"]));
  return props;
}

/** Pure: the CreateData ddmData document (PROPOSED shape, see header). */
export function buildActionSettingXml(s, milkSettingKey) {
  const body = plannedActionProperties(s, milkSettingKey)
    .map(([n, v, objectType]) => `<property name="${n}"${objectType ? ` objectType="${objectType}"` : ""}>${escapeXml(v)}</property>`)
    .join("");
  return `<ddmData><object name="${ACTION_OBJECT}">${body}</object></ddmData>`;
}

/** Read-back vs approved snapshot: every property we would write. [] = identical. */
export function compareActionSetting(record, s, milkSettingKey) {
  const diffs = [];
  const r = (p) => val(record, p);
  if (String(r("AnimalMilkSetting") ?? "") !== String(milkSettingKey)) diffs.push({ property: "AnimalMilkSetting", expected: String(milkSettingKey), actual: r("AnimalMilkSetting") });
  if (r("ActionType") !== "SortCow") diffs.push({ property: "ActionType", expected: "SortCow", actual: r("ActionType") });
  if (!bool(r("Active"))) diffs.push({ property: "Active", expected: "true", actual: r("Active") });
  if (!sameInstant(r("StartDate"), s.start_at)) diffs.push({ property: "StartDate", expected: s.start_at, actual: r("StartDate") });
  if (!sameInstant(r("EndDate"), s.end_at)) diffs.push({ property: "EndDate", expected: s.end_at ?? null, actual: r("EndDate") });
  const want = new Set((s.sessions ?? []).map(Number));
  SESSION_PROPS.forEach((name, i) => {
    if (bool(r(name)) !== want.has(i + 1)) diffs.push({ property: name, expected: String(want.has(i + 1)), actual: r(name) });
  });
  return diffs;
}

export function actionSummary(o) {
  return {
    key: val(o, "Key"),
    milk_setting_key: val(o, "AnimalMilkSetting"),
    action_type: val(o, "ActionType"),
    active: val(o, "Active") == null ? null : bool(val(o, "Active")),
    start_at: val(o, "StartDate") || null,
    end_at: val(o, "EndDate") || null,
    sessions: SESSION_PROPS.map((p, i) => (bool(val(o, p)) ? i + 1 : null)).filter(Boolean),
    last_updated_at: val(o, "LastUpdatedTime") || null,
  };
}

/** Active SortCow = Active true and no end, or an end still ahead. */
export function activeSortCows(actions, now = new Date()) {
  return actions.map(actionSummary).filter((a) => a.action_type === "SortCow" && a.active && (!a.end_at || ts(a.end_at) > now.getTime()));
}

/** The animal must exist in DelPro under this GUID (and carry the same ORN when DelPro returns one). */
export async function verifyAnimal(client, s, ornProperty = config.gateway.animalOrnProperty) {
  let rows;
  try {
    rows = await get(client, "Animal", ["ObjectGuid", "Number", ...(ornProperty ? [ornProperty] : [])], [{ name: "ObjectGuid", value: s.animal_guid }], 2);
  } catch (err) {
    if (!ornProperty || (err instanceof GatewayError && err.retryable)) throw err;
    rows = await get(client, "Animal", ["ObjectGuid", "Number"], [{ name: "ObjectGuid", value: s.animal_guid }], 2);
  }
  rows = rows.filter((o) => String(val(o, "ObjectGuid") ?? "").toLowerCase() === String(s.animal_guid).toLowerCase());
  if (rows.length !== 1) throw new CmsError("animal_not_found", `DelPro neturi gyvulio ${s.animal_guid}.`);
  const orn = ornProperty ? val(rows[0], ornProperty) : null;
  if (orn && s.orn && ornNorm(orn) !== ornNorm(s.orn)) {
    throw new CmsError("animal_orn_mismatch", `DelPro gyvulio ORN ${orn} ≠ GVET ${s.orn}.`);
  }
  return { number: val(rows[0], "Number"), orn };
}

/** Exactly one AnimalMilkSetting per animal, or nothing is written. */
export async function findMilkSetting(client, animalGuid) {
  const rows = (await get(client, "AnimalMilkSetting", ["Key", "Animal"], [{ name: "Animal", value: animalGuid }], 5))
    .filter((o) => String(val(o, "Animal") ?? "").toLowerCase() === String(animalGuid).toLowerCase());
  if (rows.length === 0) throw new CmsError("milk_setting_missing", "DelPro neturi šio gyvulio melžimo nustatymų (AnimalMilkSetting).");
  if (rows.length > 1) throw new CmsError("milk_setting_ambiguous", `DelPro grąžino ${rows.length} AnimalMilkSetting įrašus — nesiunčiama.`);
  return val(rows[0], "Key");
}

export async function readActions(client, milkSettingKey) {
  return (await get(client, ACTION_OBJECT, ACTION_READ_PROPS, [{ name: "AnimalMilkSetting", value: String(milkSettingKey) }], 100))
    .filter((o) => String(val(o, "AnimalMilkSetting") ?? "") === String(milkSettingKey));
}

async function readByKey(client, key) {
  const rows = (await get(client, ACTION_OBJECT, ACTION_READ_PROPS, [{ name: "Key", value: String(key) }], 2)).filter((o) => String(val(o, "Key")) === String(key));
  return rows.length === 1 ? rows[0] : null;
}

/** Everything up to (not including) the write. Read-only. Throws CmsError on a definite stop. */
export async function prepareJob(client, job, now = new Date()) {
  const s = job.snapshot;
  const problems = snapshotProblems(s, now);
  if (problems.length) throw new CmsError("invalid_snapshot", problems.join(" "));
  const animal = await verifyAnimal(client, s);
  const milkKey = await findMilkSetting(client, s.animal_guid);
  const actions = await readActions(client, milkKey);
  const xml = buildActionSettingXml(s, milkKey);
  return { s, animal, milkKey, actions, active: activeSortCows(actions, now), xml };
}

/**
 * One claimed job: prepare -> (adopt: read the given key | write: report start, CreateData, read back) -> report.
 * Never throws for a job outcome; returns what was reported.
 */
export async function processJob(client, job, { workerId = config.workerId, report = (b) => gvet.cmsReportJob(b), now = new Date() } = {}) {
  const base = { job_id: job.job_id, worker_id: workerId, phase: "result" };
  let started = false;
  let prep = null;
  try {
    prep = await prepareJob(client, job, now);
    const summary = { milk_setting_key: prep.milkKey, existing_actions: prep.actions.map(actionSummary), xml: prep.xml };

    if (job.adopt_key) {
      const record = await readByKey(client, job.adopt_key);
      if (!record) throw new CmsError("adopt_not_found", `DelPro neturi AnimalActionSetting ${job.adopt_key}.`);
      const diffs = compareActionSetting(record, prep.s, prep.milkKey);
      return report({ ...base, outcome: "success", action_key: String(job.adopt_key), milk_setting_key: prep.milkKey, gateway_summary: { ...summary, adopted: true },
        readback: { verified: diffs.length === 0, diffs, record: actionSummary(record) },
        error_message: diffs.length ? `DelPro įrašas ${job.adopt_key} nesutampa: ${diffs.map((d) => d.property).join(", ")}` : null });
    }

    if (prep.active.length) {
      throw new CmsError("existing_active_sortcow", `DelPro jau turi aktyvų SortCow (${prep.active.map((a) => a.key).join(", ")}) — nekeičiama.`,
        { details: { active: prep.active } });
    }

    await report({ job_id: job.job_id, worker_id: workerId, phase: "start", milk_setting_key: prep.milkKey });
    started = true;
    const res = await client.createData(prep.xml);
    const created = (res.created ?? []).find((c) => !c.type || c.type === ACTION_OBJECT) ?? null;
    if (!created?.keyValue) {
      return report({ ...base, outcome: "unknown", milk_setting_key: prep.milkKey, gateway_summary: { ...summary, response: res },
        error_message: "DelPro priėmė įrašą, bet negrąžino rakto — patikrinkite DelPro." });
    }
    const record = await readByKey(client, created.keyValue);
    if (!record) {
      return report({ ...base, outcome: "unknown", action_key: created.keyValue, milk_setting_key: prep.milkKey, gateway_summary: { ...summary, created },
        error_message: `Sukurtas įrašas ${created.keyValue} nenuskaitomas — patikrinkite DelPro.` });
    }
    const diffs = compareActionSetting(record, prep.s, prep.milkKey);
    return report({ ...base, outcome: "success", action_key: String(created.keyValue), milk_setting_key: prep.milkKey, gateway_summary: { ...summary, created },
      readback: { verified: diffs.length === 0, diffs, record: actionSummary(record) },
      error_message: diffs.length ? `DelPro įrašas nesutampa: ${diffs.map((d) => d.property).join(", ")}` : null });
  } catch (err) {
    const gw = err instanceof GatewayError ? err : null;
    const outcome = started ? "unknown" : err instanceof CmsError ? (err.retryable ? "retry" : "error") : gw?.retryable ? "retry" : "error";
    return report({ ...base, outcome, milk_setting_key: prep?.milkKey ?? null, error_message: err.message,
      error_details: { code: err.code ?? null, ...(err.details ?? gw?.details ?? {}) } });
  }
}

/** CMS_OUTBOUND_MODE=gateway: routine jobs (modes an admin verified). A single supervised job only via cms:write-one. */
export async function runCmsOutbound(client, { max = 20, jobId = null } = {}) {
  let n = 0;
  while (n < max) {
    const job = await gvet.cmsClaimJob({ worker_id: config.workerId, ...(jobId ? { job_id: jobId } : {}) });
    if (!job) break;
    n += 1;
    const res = await processJob(client, job);
    log.info(`GVET → DelPro CMS: ${job.snapshot?.orn} → ${res?.status ?? "?"}`);
    if (jobId) break;
  }
  return n;
}

/**
 * DelPro's own SortCow settings + sort areas (read-only). ActionType is filtered in the Gateway (<equal>); rows of
 * another type are dropped here too. A read reaching the row cap is incomplete — GVET then removes nothing.
 */
export async function readLiveState(client, { maxRows = config.catalogMaxRows, rowCap = config.catalogGatewayRowCap, maxLookups = 500 } = {}) {
  const errors = [];
  const raw = await get(client, ACTION_OBJECT, ACTION_READ_PROPS, [{ name: "ActionType", value: "SortCow" }], maxRows);
  const actions = raw.map(actionSummary).filter((a) => a.key && a.action_type === "SortCow");
  let complete = raw.length < Math.min(maxRows, rowCap || maxRows);
  const keys = [...new Set(actions.map((a) => a.milk_setting_key).filter(Boolean))];
  if (keys.length > maxLookups) {
    errors.push(`Per daug melžimo nustatymų (${keys.length}) — nuskaityta ${maxLookups}.`);
    complete = false;
  }
  const guidByKey = new Map();
  for (const key of keys.slice(0, maxLookups)) {
    try {
      const [ms] = (await get(client, "AnimalMilkSetting", ["Key", "Animal"], [{ name: "Key", value: key }], 2)).filter((o) => String(val(o, "Key")) === key);
      guidByKey.set(key, ms ? val(ms, "Animal") : null);
    } catch (err) {
      errors.push(`AnimalMilkSetting ${key}: ${err.message}`);
      complete = false;
    }
  }
  let sortAreas = [];
  try {
    sortAreas = (await get(client, "SortArea", ["Key", "SortAreaNumber", "SortAreaName"], [], 200))
      .map((o) => ({ key: val(o, "Key"), number: val(o, "SortAreaNumber"), name: val(o, "SortAreaName") })).filter((a) => a.key);
  } catch (err) {
    errors.push(`SortArea: ${err.message}`);
  }
  return {
    complete,
    errors,
    actions: actions.map((a) => ({ ...a, animal_guid: guidByKey.get(a.milk_setting_key) ?? null })),
    sort_areas: sortAreas,
  };
}

export async function runCmsLive(client) {
  const state = await readLiveState(client);
  const res = await gvet.cmsLiveUpload({ worker_id: config.workerId, ...state });
  log.info(`DelPro CMS būsena → GVET: ${JSON.stringify(res)}`);
  return res;
}

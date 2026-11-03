import { GatewayError, buildRequestData, escapeXml, parseDdmData } from "./gateway.js";
import { config } from "./config.js";
import { gvet } from "./gvet.js";
import { log } from "./log.js";

// GVET CMS atskyrimai -> DelPro (0048). One approved GVET job = one DelPro AnimalActionSetting (ActionType SortCow)
// on the animal's AnimalMilkSetting:
//   Animal (ObjectGuid) -> AnimalMilkSetting (Key, Animal) -> AnimalActionSetting (AnimalMilkSetting = Key).
// Reads and the CreateData shape are verified on the farm (DelPro 10.9, 2026-11: job 443b4846…, period mode). Nothing is
// written unless CMS_OUTBOUND_MODE=gateway AND GVET hands the job out (master switch, admin approval, single supervised job or
// a verified mode + confirmed destination). No SortArea / Sort Once property is ever sent. A write that may have reached DelPro
// but was not read back and compared goes to "Reikia peržiūros" in GVET.
//
// 0051 (worker 0.4.0): everything is TARGETED — one animal at a time, a handful of small reads. The full-herd scan
// (readLiveState, `npm run cms:live`) is an optional diagnostic and never gates sending.

export const ACTION_OBJECT = "AnimalActionSetting";
export const SESSION_PROPS = Array.from({ length: 10 }, (_, i) => `IsValidForSession${i + 1}`);
export const ACTION_READ_PROPS = ["Key", "AnimalMilkSetting", "ActionType", "Active", "StartDate", "EndDate", ...SESSION_PROPS, "LastUpdatedTime"];
const SENDABLE_MODES = ["period", "ongoing"];
// Per-animal reads. An animal has one milk setting; its action settings are a handful (4 types). Reaching either limit means
// the answer may be cut off -> fail closed (never "no conflict" from a possibly truncated list).
export const MILK_TOP = 10;
export const ACTIONS_TOP = 20;

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

/** Active as DelPro sent it: true / false, or null when missing or not a boolean (= unknown, never "inactive"). */
function boolOrNull(v) {
  const t = String(v ?? "").trim().toLowerCase();
  return t === "true" ? true : t === "false" ? false : null;
}

export function actionSummary(o) {
  return {
    key: val(o, "Key"),
    milk_setting_key: val(o, "AnimalMilkSetting"),
    action_type: val(o, "ActionType"),
    active: boolOrNull(val(o, "Active")),
    start_at: val(o, "StartDate") || null,
    end_at: val(o, "EndDate") || null,
    sessions: SESSION_PROPS.map((p, i) => (bool(val(o, p)) ? i + 1 : null)).filter(Boolean),
    last_updated_at: val(o, "LastUpdatedTime") || null,
  };
}

/**
 * What a SortCow record means right now (same rule GVET uses for "galioja": Active, not ended, ≥ 1 session):
 *   effective  = Active, started, not ended, at least one session selected
 *   scheduled  = Active, starts later
 *   no_sessions= Active, not ended, but no session selected
 *   ended      = EndDate passed
 *   inactive   = Active=false (e.g. disabled by hand in DelPro)
 *   unknown    = Active missing / not a boolean, or a date that can't be read
 */
export function actionStatus(a, now = new Date()) {
  const t = now.getTime();
  if (a.active === null || a.active === undefined) return "unknown";
  if ((a.start_at && Number.isNaN(ts(a.start_at))) || (a.end_at && Number.isNaN(ts(a.end_at)))) return "unknown";
  if (a.active === false) return "inactive";
  if (a.end_at && ts(a.end_at) <= t) return "ended";
  if (a.sessions.length === 0) return "no_sessions";
  if (a.start_at && ts(a.start_at) > t) return "scheduled";
  return "effective";
}

/** Statuses that stop a new GVET write for the same animal: anything that is or may become active, or that can't be read. */
export const CONFLICTING = new Set(["effective", "scheduled", "no_sessions", "unknown"]);

/** SortCow records that conflict with a new instruction (with their status). Inactive / ended ones don't. */
export function activeSortCows(actions, now = new Date()) {
  return actions
    .map(actionSummary)
    .filter((a) => a.action_type === "SortCow")
    .map((a) => ({ ...a, status: actionStatus(a, now) }))
    .filter((a) => CONFLICTING.has(a.status));
}

/**
 * The animal must exist in DelPro under exactly this GUID, and be the same animal: its OfficialRegNumber equals GVET's ORN, or —
 * when DelPro returns no ORN — its short Number equals GVET's DelPro number. An ORN is never compared with a Number.
 */
export async function verifyAnimal(client, s, ornProperty = config.gateway.animalOrnProperty) {
  let rows;
  try {
    rows = await get(client, "Animal", ["ObjectGuid", "Number", ...(ornProperty ? [ornProperty] : [])], [{ name: "ObjectGuid", value: s.animal_guid }], 2);
  } catch (err) {
    if (!ornProperty || (err instanceof GatewayError && err.retryable)) throw err;
    rows = await get(client, "Animal", ["ObjectGuid", "Number"], [{ name: "ObjectGuid", value: s.animal_guid }], 2);
  }
  rows = rows.filter((o) => String(val(o, "ObjectGuid") ?? "").toLowerCase() === String(s.animal_guid).toLowerCase());
  if (rows.length === 0) throw new CmsError("animal_not_found", `DelPro neturi gyvulio ${s.animal_guid}.`);
  if (rows.length > 1) throw new CmsError("animal_ambiguous", `DelPro grąžino ${rows.length} gyvulius su ObjectGuid ${s.animal_guid}.`);
  const orn = ornProperty ? val(rows[0], ornProperty) : null;
  const number = val(rows[0], "Number");
  if (orn && s.orn) {
    if (ornNorm(orn) !== ornNorm(s.orn)) throw new CmsError("animal_orn_mismatch", `DelPro gyvulio ORN ${orn} ≠ GVET ${s.orn}.`);
  } else if (number && s.animal_no) {
    if (String(number).trim() !== String(s.animal_no).trim()) {
      throw new CmsError("animal_number_mismatch", `DelPro gyvulio Nr. ${number} ≠ GVET ${s.animal_no} (ORN DelPro negrąžino).`);
    }
  } else {
    throw new CmsError("animal_identity_unverified", `Gyvulio ${s.animal_guid} tapatybės nepavyko patvirtinti (DelPro negrąžino nei ORN, nei sutampančio Nr.).`);
  }
  return { number, orn };
}

/** Exactly one AnimalMilkSetting per animal, or nothing is written. `optional`: none -> null (a read-only "no settings" answer). */
export async function findMilkSetting(client, animalGuid, { optional = false } = {}) {
  const raw = await get(client, "AnimalMilkSetting", ["Key", "Animal"], [{ name: "Animal", value: animalGuid }], MILK_TOP);
  if (raw.length >= MILK_TOP) throw new CmsError("milk_setting_ambiguous", `DelPro grąžino ${raw.length} AnimalMilkSetting įrašus (riba ${MILK_TOP}) — nesiunčiama.`);
  const rows = raw.filter((o) => String(val(o, "Animal") ?? "").toLowerCase() === String(animalGuid).toLowerCase());
  if (rows.length === 0) {
    if (optional) return null;
    throw new CmsError("milk_setting_missing", "DelPro neturi šio gyvulio melžimo nustatymų (AnimalMilkSetting).");
  }
  if (rows.length > 1) throw new CmsError("milk_setting_ambiguous", `DelPro grąžino ${rows.length} AnimalMilkSetting įrašus — nesiunčiama.`);
  const key = val(rows[0], "Key");
  if (!key) throw new CmsError("milk_setting_unreadable", "AnimalMilkSetting be rakto — nesiunčiama.");
  return key;
}

/** Every action setting of one milk setting. Truncated or unreadable -> CmsError (fail closed). */
export async function readActions(client, milkSettingKey) {
  const raw = await get(client, ACTION_OBJECT, ACTION_READ_PROPS, [{ name: "AnimalMilkSetting", value: String(milkSettingKey) }], ACTIONS_TOP);
  if (raw.length >= ACTIONS_TOP) {
    throw new CmsError("actions_truncated", `DelPro grąžino ${raw.length} veiksmų įrašus (riba ${ACTIONS_TOP}) — gali būti ne visi; nesiunčiama.`);
  }
  const rows = raw.filter((o) => String(val(o, "AnimalMilkSetting") ?? "") === String(milkSettingKey));
  const broken = rows.filter((o) => !val(o, "Key") || !val(o, "ActionType"));
  if (broken.length) throw new CmsError("actions_unreadable", `${broken.length} DelPro veiksmų įrašai be rakto ar tipo — būsena nežinoma; nesiunčiama.`);
  return rows;
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
      throw new CmsError("existing_active_sortcow", `DelPro jau turi aktyvų SortCow (${prep.active.map((a) => `${a.key} ${a.status}`).join(", ")}) — nekeičiama.`,
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

/**
 * CMS_OUTBOUND_MODE=gateway: claims what GVET releases (routine: verified modes; or one supervised job via cms:write-one) and
 * processes each job on its own — its own animal lookup and conflict check, no herd read first. At most `concurrency` jobs are
 * claimed and in flight at once (claims are leased, so none is held while others wait), at most `max` per call. One failed cow
 * never stops the others; GVET never hands the same job (or a second open job for the same animal) out twice.
 */
export async function runCmsOutbound(client, { max = config.cmsBatchLimit, concurrency = config.cmsConcurrency, jobId = null, handle = processJob } = {}) {
  let n = 0;
  const lanes = jobId ? 1 : Math.max(1, concurrency);
  while (n < max) {
    const batch = [];
    while (batch.length < lanes && n + batch.length < max) {
      const job = await gvet.cmsClaimJob({ worker_id: config.workerId, ...(jobId ? { job_id: jobId } : {}) });
      if (!job) break;
      batch.push(job);
    }
    if (!batch.length) break;
    n += batch.length;
    await Promise.all(batch.map(async (job) => {
      try {
        const res = await handle(client, job);
        log.info(`GVET → DelPro CMS: ${job.snapshot?.orn} → ${res?.status ?? "?"}`);
      } catch (err) {
        // only the report itself can throw here; GVET's lease turns the job into review / retry, nothing is re-sent blindly
        log.error(`GVET → DelPro CMS ${job.snapshot?.orn} (${job.job_id}): ${err.message}`);
      }
    }));
    if (jobId || batch.length < lanes) break;
  }
  return n;
}

/**
 * One GVET animal's DelPro separation state, read-only: Animal (GUID + identity) -> its milk setting (none = no separations)
 * -> every action setting under it -> SortCow only. ok=false with the error when any step can't be answered completely.
 */
export async function readAnimalState(client, target, now = new Date()) {
  const base = { animal_id: target.animal_id, animal_guid: target.animal_guid };
  try {
    const animal = await verifyAnimal(client, { animal_guid: target.animal_guid, orn: target.orn, animal_no: target.animal_no });
    const milkKey = await findMilkSetting(client, target.animal_guid, { optional: true });
    const rows = milkKey ? await readActions(client, milkKey) : [];
    const actions = rows.map(actionSummary).filter((a) => a.action_type === "SortCow").map((a) => ({ ...a, status: actionStatus(a, now) }));
    return { ...base, ok: true, milk_setting_key: milkKey, delpro_number: animal.number, actions };
  } catch (err) {
    return { ...base, ok: false, error: `${err.code ? `${err.code}: ` : ""}${errText(err)}` };
  }
}

/**
 * Targeted DelPro -> GVET refresh: only the animals GVET names (cms_live_targets: batches / open jobs, GVET-written records,
 * animals with a live SortCow, and whatever someone asked for). `force` = the whole operational set now (paged: every animal not
 * read since this round started), otherwise one batch of what is due. `tags` = exactly those animals.
 * A failed animal is reported as such; GVET keeps (and shows as stale) what it had for it.
 */
export async function runCmsTargetedRefresh(client, {
  limit = config.cmsRefreshBatch,
  dueMinutes = config.cmsRefreshIntervalMin,
  force = false,
  allLinked = false,
  tags = null,
  concurrency = config.cmsConcurrency,
  maxRounds = 40,
} = {}) {
  const startedAt = new Date().toISOString();
  // interval 0 = only on request: nothing is ever "due" by age
  const due = dueMinutes > 0 ? dueMinutes : 10_000_000;
  const totals = { targets: 0, ok: 0, failed: 0, mismatched: 0, upserted: 0, removed: 0 };
  const all = [];
  for (let round = 1; round <= maxRounds; round += 1) {
    const body = tags?.length ? { tags } : { limit, due_minutes: due, all_linked: allLinked, ...(force ? { checked_before: startedAt } : {}) };
    const list = (await gvet.cmsLiveTargets(body)) ?? [];
    const final = tags?.length || !force || list.length < limit;
    if (!list.length && !(force && round === 1)) break;
    const results = await pool(list, Math.max(1, concurrency), (t) => readAnimalState(client, t));
    for (const r of results) {
      if (!r.ok) log.warn(`CMS būsena ${list.find((t) => t.animal_id === r.animal_id)?.orn ?? r.animal_id}: ${r.error}`);
    }
    totals.targets += list.length;
    for (let i = 0; i < Math.max(results.length, 1); i += 50) {
      const lastChunk = final && i + 50 >= results.length;
      const meta = { started_at: startedAt, targets: totals.targets, force, all_linked: allLinked };
      const res = await gvet.cmsLiveUploadAnimals({ worker_id: config.workerId, results: results.slice(i, i + 50), ...(lastChunk ? { round: meta } : {}) });
      for (const k of ["ok", "failed", "mismatched", "upserted", "removed"]) totals[k] += res?.[k] ?? 0;
    }
    all.push(...results.map((r) => ({ ...r, orn: list.find((t) => t.animal_id === r.animal_id)?.orn ?? null })));
    if (final) break;
  }
  if (totals.targets) log.info(`DelPro CMS būsena (tikslinė) → GVET: ${JSON.stringify(totals)}`);
  return { ...totals, results: all };
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (err) => String(err?.message ?? err).slice(0, 300);

/** Runs fn over items with at most `limit` in flight; results keep the input order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}

/** A read retried a limited number of times with backoff (reads only — never used for writes). */
async function readWithRetry(fn, attempts, backoffMs) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(backoffMs * attempt);
    }
  }
}

/**
 * One AnimalMilkSetting by Key -> { status, animal_guid?, error? }.
 *   resolved   = found, Animal is an ObjectGuid
 *   no_animal  = found, Animal empty               (a valid answer — the row just has no animal)
 *   invalid    = found, Animal is not a GUID
 *   absent     = DelPro has no record with this Key
 *   ambiguous  = several records came back for the Key
 *   error      = the read failed (after retries), e.g. System.NullReferenceException on this record
 */
export async function resolveMilkSetting(client, key, { attempts = 2, backoffMs = 500 } = {}) {
  try {
    const rows = await readWithRetry(
      async () => (await get(client, "AnimalMilkSetting", ["Key", "Animal"], [{ name: "Key", value: String(key) }], 2)).filter((o) => String(val(o, "Key")) === String(key)),
      attempts,
      backoffMs,
    );
    if (rows.length === 0) return { status: "absent" };
    if (rows.length > 1) return { status: "ambiguous", error: `${rows.length} įrašai su tuo pačiu Key` };
    return animalRef(val(rows[0], "Animal"));
  } catch (err) {
    return { status: "error", error: errText(err) };
  }
}

function animalRef(animal) {
  if (!animal) return { status: "no_animal" };
  if (!GUID_RE.test(String(animal).trim())) return { status: "invalid", error: `Animal="${String(animal).slice(0, 60)}"` };
  return { status: "resolved", animal_guid: String(animal).trim() };
}

/** Statuses after which the SortCow row's animal is unknown — a scan with such a row is never complete. */
const UNRESOLVED = new Set(["error", "ambiguous"]);

/**
 * OPTIONAL DIAGNOSTIC (`npm run cms:live`) — never part of the worker loop and never a condition for sending (0051).
 * DelPro's own SortCow settings + sort areas (read-only), for the whole DelPro database.
 *
 * Farm facts (DelPro 10.9, 2026-11):
 *   GetData AnimalMilkSetting [Key]            top 5000 -> 3478 rows, fine;
 *   GetData AnimalMilkSetting [Key, Animal]    top 1000 -> fine, top 2000 -> <Error ... System.NullReferenceException>;
 *   GetData AnimalActionSetting (all 4 types)  top 5000 -> exactly 5000 rows (truncated);
 *   GetData AnimalActionSetting ActionType=SortCow -> 3466 rows in one call.
 * There is no verified Gateway paging. So:
 *   1. all milk-setting keys (Key only, one read; complete only below `top` and below the known 1000 cap);
 *   2. Key -> Animal from one small bulk read (<= CMS_LIVE_MILK_BULK_TOP, every returned Key validated), the rest by Key,
 *      a few at a time, each read retried; a record that fails is recorded with its error, the others go on;
 *   3. SortCow only (ActionType filter, each row's type checked); if that read fails or may be truncated, per milk setting
 *      (the verified AnimalMilkSetting filter) instead.
 * complete=true only if 1 and 3 are complete and every SortCow row's milk setting was answered (found / no animal / absent).
 * A milk-setting key no SortCow row uses can fail without making the scan incomplete — it is reported.
 */
export async function readLiveState(client, {
  maxRows = config.cmsLiveMaxRows,
  rowCap = config.catalogGatewayRowCap,
  bulkTop = config.cmsLiveMilkBulkTop,
  concurrency = config.cmsLiveConcurrency,
  attempts = config.cmsLiveReadAttempts,
  backoffMs = 500,
  cache = null, // Map key -> { animal_guid, status, at } from earlier scans of this process (continuous mode only)
  cacheMaxAgeMs = 24 * 3600_000,
  now = Date.now(),
} = {}) {
  const errors = [];
  const warnings = [];
  const capped = (n) => n >= maxRows || (rowCap > 0 && n === rowCap);
  let complete = true;
  const incomplete = (msg) => {
    complete = false;
    errors.push(msg);
  };
  const opts = { attempts, backoffMs };

  // 1. every AnimalMilkSetting key
  let keyList = [];
  let keysComplete = false;
  try {
    const rows = await readWithRetry(() => get(client, "AnimalMilkSetting", ["Key"], [], maxRows), attempts, backoffMs);
    keyList = rows.map((o) => val(o, "Key")).filter(Boolean).map(String);
    keysComplete = !capped(rows.length);
    if (!keysComplete) incomplete(`AnimalMilkSetting raktų: grąžinta ${rows.length} (top ${maxRows}) — gali būti ne visi.`);
  } catch (err) {
    incomplete(`AnimalMilkSetting raktų sąrašas nenuskaitytas: ${errText(err)}`);
  }
  const keys = [...new Set(keyList)];
  if (keys.length !== keyList.length) warnings.push(`AnimalMilkSetting: ${keyList.length - keys.length} pasikartojantys raktai.`);
  const keySet = new Set(keys);

  // 2a. Key -> Animal, small bulk read (validated by Key, never by position)
  const refs = new Map(); // key -> { status, animal_guid?, error?, via }
  let fromCache = 0;
  if (cache) {
    for (const k of keys) {
      const c = cache.get(k);
      if (c && now - c.at < cacheMaxAgeMs && !UNRESOLVED.has(c.status)) {
        refs.set(k, { ...c, via: "cache" });
        fromCache += 1;
      }
    }
  }
  let bulkReturned = 0;
  let bulkError = null;
  if (bulkTop > 0 && refs.size < keys.length) {
    try {
      const rows = await readWithRetry(() => get(client, "AnimalMilkSetting", ["Key", "Animal"], [], bulkTop), attempts, backoffMs);
      bulkReturned = rows.length;
      const seen = new Map();
      for (const o of rows) {
        const k = val(o, "Key");
        if (!k) continue;
        const a = val(o, "Animal");
        seen.set(String(k), seen.has(String(k)) && seen.get(String(k)) !== a ? Symbol.for("conflict") : a);
      }
      for (const [k, a] of seen) {
        if (!keySet.has(k)) {
          // the key list did not have it: that list was not the whole table
          if (keysComplete) incomplete(`AnimalMilkSetting ${k} grąžintas su Animal, bet jo nebuvo raktų sąraše.`);
          keySet.add(k);
          keys.push(k);
        }
        if (a === Symbol.for("conflict")) continue; // resolved by Key below
        if (!refs.has(k)) refs.set(k, { ...animalRef(a), via: "bulk" });
      }
    } catch (err) {
      bulkError = errText(err);
      warnings.push(`AnimalMilkSetting [Key, Animal] top ${bulkTop}: ${bulkError} — visi raktai skaitomi po vieną.`);
    }
  }

  // 3. SortCow only
  let actionsRaw = null;
  let otherTypes = 0;
  let sortcowRead = "bulk";
  let sortcowReturned = 0;
  try {
    actionsRaw = await readWithRetry(() => get(client, ACTION_OBJECT, ACTION_READ_PROPS, [{ name: "ActionType", value: "SortCow" }], maxRows), attempts, backoffMs);
    sortcowReturned = actionsRaw.length;
    if (capped(actionsRaw.length)) {
      warnings.push(`AnimalActionSetting SortCow: grąžinta ${actionsRaw.length} (top ${maxRows}) — gali būti ne visi; skaitoma pagal melžimo nustatymą.`);
      actionsRaw = null;
    }
  } catch (err) {
    warnings.push(`AnimalActionSetting SortCow: ${errText(err)} — skaitoma pagal melžimo nustatymą.`);
    actionsRaw = null;
  }
  let perKeyActionFailures = 0;
  if (actionsRaw === null) {
    // fallback: one read per milk setting (the filter verified by the writer), every type, SortCow kept
    sortcowRead = "per_milk_setting";
    if (!keysComplete) incomplete("SortCow sąrašas negali būti pilnas: nepilnas melžimo nustatymų raktų sąrašas.");
    actionsRaw = [];
    const perKeyTop = 100;
    const results = await pool(keys, concurrency, async (k) => {
      try {
        const rows = await readWithRetry(() => get(client, ACTION_OBJECT, ACTION_READ_PROPS, [{ name: "AnimalMilkSetting", value: k }], perKeyTop), attempts, backoffMs);
        if (rows.length >= perKeyTop) return { key: k, error: `grąžinta ${rows.length} (top ${perKeyTop})` };
        return { key: k, rows: rows.filter((o) => String(val(o, "AnimalMilkSetting") ?? "") === k) };
      } catch (err) {
        return { key: k, error: errText(err) };
      }
    });
    for (const r of results) {
      if (r.error) {
        perKeyActionFailures += 1;
        if (perKeyActionFailures <= 20) errors.push(`AnimalActionSetting (AnimalMilkSetting ${r.key}): ${r.error}`);
      } else actionsRaw.push(...r.rows);
    }
    if (perKeyActionFailures > 0) incomplete(`SortCow nenuskaityti ${perKeyActionFailures} melžimo nustatymams.`);
    sortcowReturned = actionsRaw.length;
  }
  const actions = actionsRaw.map(actionSummary).filter((a) => a.key && a.action_type === "SortCow");
  otherTypes = actionsRaw.length - actions.length;
  const byKey = new Map();
  for (const a of actions) byKey.set(a.key, a); // the same action twice (fallback overlap) counts once

  // 2b. every key not answered yet — by Key, a few at a time; SortCow references outside the key list as well
  const referenced = new Set([...byKey.values()].map((a) => a.milk_setting_key).filter(Boolean).map(String));
  const outsideList = [...referenced].filter((k) => !keySet.has(k));
  const todo = [...keys, ...outsideList].filter((k) => !refs.has(k));
  const looked = await pool(todo, concurrency, async (k) => [k, await resolveMilkSetting(client, k, opts)]);
  for (const [k, r] of looked) refs.set(k, { ...r, via: "key" });
  const foundOutside = outsideList.filter((k) => refs.get(k)?.status !== "absent" && refs.get(k)?.status !== "error");
  if (foundOutside.length) incomplete(`AnimalMilkSetting raktų sąrašas buvo nepilnas (${foundOutside.length} rasta tik pagal raktą).`);

  if (cache) for (const [k, r] of refs) if (r.via !== "cache" && !UNRESOLVED.has(r.status)) cache.set(k, { status: r.status, animal_guid: r.animal_guid ?? null, error: r.error ?? null, at: now });

  const failures = [...refs].filter(([, r]) => r.status === "error" || r.status === "ambiguous");
  const failedReferenced = failures.filter(([k]) => referenced.has(k));
  if (failedReferenced.length) incomplete(`${failedReferenced.length} SortCow įrašų melžimo nustatymo gyvulys nenuskaitytas (žr. unresolved).`);

  const out = [];
  const unresolvedActions = [];
  for (const a of byKey.values()) {
    const r = refs.get(String(a.milk_setting_key)) ?? { status: a.milk_setting_key ? "error" : "no_animal", error: "nenuskaityta" };
    const row = { ...a, animal_guid: r.status === "resolved" ? r.animal_guid : null, animal_ref: r.status };
    (UNRESOLVED.has(r.status) ? unresolvedActions : out).push(row);
  }

  const count = (s, only) => [...refs].filter(([k, r]) => r.status === s && (!only || only.has(k))).length;
  const perAnimal = new Map();
  for (const r of refs.values()) if (r.animal_guid) perAnimal.set(r.animal_guid.toLowerCase(), (perAnimal.get(r.animal_guid.toLowerCase()) ?? 0) + 1);

  let sortAreas = [];
  try {
    sortAreas = (await get(client, "SortArea", ["Key", "SortAreaNumber", "SortAreaName"], [], 200))
      .map((o) => ({ key: val(o, "Key"), number: val(o, "SortAreaNumber"), name: val(o, "SortAreaName") })).filter((a) => a.key);
  } catch (err) {
    warnings.push(`SortArea: ${errText(err)}`);
  }

  return {
    complete,
    errors,
    warnings,
    stats: {
      milk_setting_keys: keys.length,
      milk_settings_resolved: count("resolved"),
      milk_settings_without_animal: count("no_animal"),
      milk_settings_invalid_animal: count("invalid"),
      milk_settings_absent: count("absent"),
      milk_settings_unresolved: failures.length,
      milk_settings_unresolved_used_by_sortcow: failedReferenced.length,
      milk_settings_from_bulk: [...refs.values()].filter((r) => r.via === "bulk").length,
      milk_settings_from_cache: fromCache,
      milk_settings_read_by_key: todo.length,
      milk_settings_found_outside_key_list: foundOutside.length,
      milk_bulk_top: bulkTop,
      milk_bulk_returned: bulkReturned,
      milk_bulk_failed: bulkError ? 1 : 0,
      sortcow_actions: byKey.size,
      sortcow_returned: sortcowReturned,
      sortcow_read_per_milk_setting: sortcowRead === "bulk" ? 0 : 1,
      sortcow_read_failures: perKeyActionFailures,
      other_action_types_dropped: otherTypes,
      sortcow_with_animal: out.filter((a) => a.animal_guid).length,
      animals_with_several_milk_settings: [...perAnimal.values()].filter((n) => n > 1).length,
      gateway_read_errors: failures.filter(([, r]) => r.status === "error").length + perKeyActionFailures,
      top: maxRows,
    },
    // first 50 unresolved keys with their Gateway error (all are counted in stats)
    unresolved: failures.slice(0, 50).map(([k, r]) => ({ key: k, status: r.status, error: r.error ?? null, used_by_sortcow: referenced.has(k) })),
    actions: out,
    // SortCow rows whose animal could not be read: GVET keeps the animal it already had for them (0050)
    actions_unresolved: unresolvedActions,
    sort_areas: sortAreas,
  };
}

const milkCache = new Map();

/** @param {{ useCache?: boolean }} [opts] continuous mode reuses Key -> Animal answers for 24 h; `npm run cms:live` reads everything. */
export async function runCmsLive(client, { useCache = false } = {}) {
  const state = await readLiveState(client, { cache: useCache ? milkCache : null });
  log.info(`DelPro CMS skaitymas: ${JSON.stringify({ complete: state.complete, ...state.stats })}`);
  for (const u of state.unresolved) log.warn(`AnimalMilkSetting ${u.key}: ${u.status}${u.error ? ` — ${u.error}` : ""}${u.used_by_sortcow ? " (naudoja SortCow)" : ""}`);
  const res = await gvet.cmsLiveUpload({ worker_id: config.workerId, ...state });
  log.info(`DelPro CMS būsena → GVET: ${JSON.stringify(res)}`);
  return res;
}

/**
 * `npm run cms:milk-diagnose` — read-only. Why does GetData AnimalMilkSetting [Key, Animal] fail between top `from` and `to`?
 * Bisects the smallest failing `top`, checks the bulk order against the Key-only list, then reads the record at that
 * position (and its neighbours) by Key and its Animal by ObjectGuid. Record-specific = that record fails alone too.
 */
export async function diagnoseMilkSettings(client, { from = 1000, to = 2000, maxRows = config.cmsLiveMaxRows } = {}) {
  const bulk = async (top) => {
    try {
      return { ok: true, keys: (await get(client, "AnimalMilkSetting", ["Key", "Animal"], [], top)).map((o) => String(val(o, "Key"))) };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  };
  const keys = (await get(client, "AnimalMilkSetting", ["Key"], [], maxRows)).map((o) => String(val(o, "Key")));
  const report = { milk_setting_keys: keys.length, from, to, steps: [] };
  const lo0 = await bulk(from);
  const hi0 = await bulk(to);
  report.steps.push({ top: from, ok: lo0.ok, error: lo0.error ?? null }, { top: to, ok: hi0.ok, error: hi0.error ?? null });
  if (!lo0.ok || hi0.ok) {
    report.conclusion = !lo0.ok ? `Jau top ${from} nepavyksta — riba žemiau.` : `top ${to} šiuo metu pavyksta — klaida neatkartota.`;
    return report;
  }
  let lo = from;
  let hi = to;
  let okKeys = lo0.keys;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await bulk(mid);
    report.steps.push({ top: mid, ok: r.ok, error: r.error ?? null });
    if (r.ok) {
      lo = mid;
      okKeys = r.keys;
    } else hi = mid;
  }
  report.last_ok_top = lo;
  report.first_failing_top = hi;
  report.order_matches_key_list = okKeys.every((k, i) => k === keys[i]);
  const candidate = report.order_matches_key_list ? keys[hi - 1] : null;
  report.candidate_key = candidate;
  if (candidate) {
    report.records = [];
    for (const k of keys.slice(Math.max(0, hi - 3), hi + 2)) {
      const r = await resolveMilkSetting(client, k, { attempts: 1 });
      let animal = null;
      if (r.status === "resolved") {
        try {
          const a = await get(client, "Animal", ["ObjectGuid", "Number"], [{ name: "ObjectGuid", value: r.animal_guid }], 2);
          animal = a.length ? { found: true, number: val(a[0], "Number") } : { found: false };
        } catch (err) {
          animal = { error: errText(err) };
        }
      }
      report.records.push({ key: k, position: keys.indexOf(k) + 1, ...r, animal });
    }
    const c = report.records.find((x) => x.key === candidate);
    report.conclusion =
      c?.status === "error"
        ? `Įrašas ${candidate} klaidingas ir skaitomas atskirai — konkretaus įrašo problema.`
        : c?.animal && c.animal.found === false
          ? `Įrašo ${candidate} Animal nurodo gyvulį, kurio DelPro nebėra — tikėtina, kad būtent jis lūžta bendrame skaityme.`
          : `Įrašas ${candidate} atskirai skaitomas gerai — tikėtina, kad tai bendro skaitymo dydžio problema.`;
  } else {
    report.conclusion = "Bendro skaitymo tvarka nesutampa su raktų sąrašu — konkretaus įrašo nustatyti negalima; visi raktai skaitomi po vieną.";
  }
  return report;
}

/** Cheap read-only Gateway check for the activation panel (one SortArea row). */
export async function pingGateway(client) {
  await get(client, "SortArea", ["Key"], [], 1);
  return true;
}

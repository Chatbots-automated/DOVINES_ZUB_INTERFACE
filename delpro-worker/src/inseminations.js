import { createHash } from "node:crypto";
import { config } from "./config.js";
import { buildRequestData, parseDdmData } from "./gateway.js";
import { gvet } from "./gvet.js";
import { log } from "./log.js";

// DelPro -> GVET inseminations (0053). READ-ONLY towards DelPro: this module only ever calls client.getDataXml (GetData).
//
// Verified on the farm Gateway:
//   InseminationEvent [ObjectGuid, Animal, Semen, Bull, Breeder, Comment, EventTime, InseminationNumber, InseminationMethod, HeatEvent]
//     filtered by Animal (= Animal.ObjectGuid). It has NO EventDate (the Gateway rejects that property).
//   AnimalEvent [ObjectGuid, Animal, EventDate] with the SAME ObjectGuid holds the event's instant (UTC).
//   HeatEvent is a reference to a different object — never used as the insemination's identity.
// Per animal: one InseminationEvent read (top INSEMINATION_EVENT_TOP; reaching it = re-read once with the max top, still full =
// incomplete), then one AnimalEvent read per event GVET doesn't have yet / that changed / is inside the overlap window.
// An event that fails any check is reported as invalid, never imported. A Gateway error fails the whole animal (retried later;
// what GVET already has stays). Semen (verified 2026-11: Semen [Key, SemenName, Comment]): InseminationEvent.Semen is resolved by
// Key, cached across rounds; INSEMINATION_SEMEN_PROPERTIES = "<name property>,<comment property>" (default "SemenName,Comment").
// SemenName is a catalog name, never an official bull KK number. A failed lookup sends no label, so GVET keeps the stored one.

export const EVENT_PROPS = ["ObjectGuid", "Animal", "Semen", "Bull", "Breeder", "Comment", "EventTime", "InseminationNumber", "InseminationMethod", "HeatEvent"];
export const BASE_PROPS = ["ObjectGuid", "Animal", "EventDate"];

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errText = (err) => String(err?.message ?? err).slice(0, 300);
const DAY = 86_400_000;

async function getRows(client, objectName, properties, where, top) {
  const rows = parseDdmData(await client.getDataXml(buildRequestData({ objectName, properties, where, top })));
  return rows.map((r) => r.properties);
}
function val(p, name) {
  const v = p?.[name]?.value;
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
const sameGuid = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** A DelPro EventDate -> ISO UTC string, or null. Only instants WITH a zone (Z / ±hh:mm) are accepted — never guessed. */
export function normalizeEventDate(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(String(v).trim())) return null;
  const t = Date.parse(String(v).trim());
  if (!Number.isFinite(t)) return null;
  const y = new Date(t).getUTCFullYear();
  return y >= 1990 && y <= 2100 ? new Date(t).toISOString() : null;
}

/** The Europe/Vilnius calendar date of an instant: 2014-06-08T21:00:00.020Z -> 2014-06-09 (never the UTC date). */
export function vilniusDate(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vilnius", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** Pure: the InseminationEvent part of one event (no date) + its problems. */
export function eventFromRow(p, animalGuid) {
  const raw = val(p, "ObjectGuid");
  const e = {
    guid: raw && GUID_RE.test(raw) ? raw.toLowerCase() : null,
    semen_key: val(p, "Semen"),
    bull: val(p, "Bull"),
    breeder: val(p, "Breeder"),
    comment: val(p, "Comment"),
    event_time: val(p, "EventTime"),
    insemination_number: null,
    method_code: val(p, "InseminationMethod"),
    heat_event_guid: null,
  };
  const problems = [];
  if (!e.guid) problems.push(raw ? "event_guid_invalid" : "event_guid_missing");
  if (!sameGuid(val(p, "Animal"), animalGuid)) problems.push("event_animal_mismatch");
  const n = val(p, "InseminationNumber");
  if (n != null) {
    if (/^\d+$/.test(n)) e.insemination_number = Number(n);
    else problems.push("insemination_number_invalid");
  }
  const heat = val(p, "HeatEvent");
  if (heat != null) {
    if (GUID_RE.test(heat)) e.heat_event_guid = heat.toLowerCase();
    else problems.push("heat_event_invalid");
  }
  if (e.heat_event_guid && e.heat_event_guid === e.guid) problems.push("heat_event_is_insemination");
  return { event: e, problems, rawGuid: raw };
}

/** Hash of the InseminationEvent fields — GVET re-reads the date only when this changes (or inside the overlap window). */
export function eventHash(e) {
  const keys = ["guid", "semen_key", "bull", "breeder", "comment", "event_time", "insemination_number", "method_code", "heat_event_guid"];
  return createHash("sha256").update(JSON.stringify(keys.map((k) => e[k] ?? null))).digest("hex").slice(0, 32);
}

/** AnimalEvent for one insemination GUID -> { event_at } or { error }. Exactly one record, same GUID, same animal, valid date. */
export async function readEventDate(client, guid, animalGuid) {
  const rows = await getRows(client, "AnimalEvent", BASE_PROPS, [{ name: "ObjectGuid", value: guid }], 2);
  if (rows.length === 0) return { error: "animal_event_missing" };
  if (rows.length > 1) return { error: "animal_event_ambiguous" };
  const r = rows[0];
  if (!sameGuid(val(r, "ObjectGuid"), guid)) return { error: "animal_event_guid_mismatch" };
  if (!sameGuid(val(r, "Animal"), animalGuid)) return { error: "animal_event_animal_mismatch" };
  const at = normalizeEventDate(val(r, "EventDate"));
  if (!at) return { error: `event_date_invalid (${val(r, "EventDate") ?? "tuščia"})` };
  return { event_at: at };
}

/** InseminationEvent rows of one animal -> { rows, complete, top }. Reaching `top` is never taken as "all of them". */
export async function readAnimalEvents(client, animalGuid, { top = config.inseminationEventTop, maxTop = config.inseminationEventMaxTop } = {}) {
  const where = [{ name: "Animal", value: animalGuid }];
  let rows = await getRows(client, "InseminationEvent", EVENT_PROPS, where, top);
  let used = top;
  if (rows.length >= top && maxTop > top) {
    used = maxTop;
    rows = await getRows(client, "InseminationEvent", EVENT_PROPS, where, maxTop);
  }
  return { rows, complete: rows.length < used, top: used };
}

const SEMEN_TTL_MS = 6 * 3_600_000;
const semenCache = new Map(); // key -> { at, value: { label, comment } } — shared by every round of this process

/** Test hook: forget cached Semen records. */
export function clearSemenCache() {
  semenCache.clear();
}

/**
 * Semen.Key -> { label: SemenName, comment: Comment } (either may be null when DelPro has none), or null when the lookup
 * failed / was ambiguous (then the caller sends no label and GVET keeps what it has). One GetData per key per 6 h.
 */
export function semenLabeler(client, properties = config.inseminationSemenProperties) {
  const [nameProp, commentProp] = properties ?? [];
  if (!nameProp) return async () => null;
  const inflight = new Map();
  return async (key) => {
    if (!key) return { label: null, comment: null };
    const hit = semenCache.get(key);
    if (hit && Date.now() - hit.at < SEMEN_TTL_MS) return hit.value;
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        try {
          const rows = await getRows(client, "Semen", ["Key", nameProp, ...(commentProp ? [commentProp] : [])], [{ name: "Key", value: key }], 2);
          if (rows.length !== 1 || val(rows[0], "Key") !== String(key)) {
            log.warn(`Semen ${key}: DelPro grąžino ${rows.length} įraš. — pavadinimas nenustatytas.`);
            return null;
          }
          const value = { label: val(rows[0], nameProp), comment: commentProp ? val(rows[0], commentProp) : null };
          semenCache.set(key, { at: Date.now(), value });
          return value;
        } catch (err) {
          log.warn(`Semen ${key}: ${errText(err)}`);
          return null;
        }
      })());
    }
    return inflight.get(key);
  };
}

/**
 * One GVET animal -> the upload result for delpro_insemination_upload (also used by the preview).
 * target: { animal_id, animal_guid, known: [{guid, hash, event_at}], skipped: [{guid, event_at, hash}] }
 */
export async function readAnimalInseminations(client, target, {
  now = new Date(),
  overlapDays = config.inseminationOverlapDays,
  backfillMonths = config.inseminationBackfillMonths,
  recheckDates = false,
  semen = async () => null,
  top,
  maxTop,
} = {}) {
  const base = { animal_id: target.animal_id, animal_guid: target.animal_guid, started_at: now.toISOString() };
  if (!target.animal_guid || !GUID_RE.test(target.animal_guid)) return { ...base, ok: false, error: "GVET gyvulys neturi DelPro ObjectGuid" };
  try {
    const read = await readAnimalEvents(client, target.animal_guid, { ...(top ? { top } : {}), ...(maxTop ? { maxTop } : {}) });
    const known = new Map((target.known ?? []).map((k) => [String(k.guid).toLowerCase(), k]));
    const skippedBefore = new Map((target.skipped ?? []).map((k) => [String(k.guid).toLowerCase(), k]));
    const cutoff = backfillMonths > 0 ? new Date(now.getTime() - backfillMonths * 30.44 * DAY) : null;
    const overlapFrom = now.getTime() - overlapDays * DAY;
    const events = [];
    const invalid = [];
    const skipped = [];
    const seen = new Set();
    for (const row of read.rows) {
      const { event, problems, rawGuid } = eventFromRow(row, target.animal_guid);
      if (event.guid && seen.has(event.guid)) problems.push("event_guid_duplicate");
      if (event.guid) seen.add(event.guid);
      if (problems.length) {
        invalid.push({ guid: event.guid ?? rawGuid, error: problems.join(", ") });
        continue;
      }
      const hash = eventHash(event);
      const k = known.get(event.guid);
      const s = skippedBefore.get(event.guid);
      let eventAt = null;
      const cached = k ?? (s?.hash === hash ? s : null);
      const cachedAt = cached?.event_at ? normalizeEventDate(new Date(cached.event_at).toISOString()) : null;
      const reuse = !recheckDates && cachedAt && (k ? k.hash === hash : true) && Date.parse(cachedAt) < overlapFrom;
      if (reuse) {
        eventAt = cachedAt;
      } else {
        const d = await readEventDate(client, event.guid, target.animal_guid);
        if (d.error) {
          invalid.push({ guid: event.guid, error: d.error });
          continue;
        }
        eventAt = d.event_at;
      }
      if (cutoff && Date.parse(eventAt) < cutoff.getTime() && !k) {
        skipped.push({ guid: event.guid, event_at: eventAt, hash });
        continue;
      }
      const sm = await semen(event.semen_key);
      // resolved (or no semen at all) -> send the name / comment (null clears); lookup failed -> leave them out, GVET keeps its own
      events.push({ ...event, event_at: eventAt, ...(sm ? { semen_label: sm.label, semen_comment: sm.comment } : {}), hash });
    }
    const complete = read.complete && invalid.length === 0;
    const error = !read.complete
      ? `InseminationEvent atsakymas pasiekė top=${read.top} — gali būti ne visi įvykiai`
      : invalid.length ? `${invalid.length} netinkam. įvyk.: ${invalid.map((i) => i.error).join("; ")}`.slice(0, 480) : null;
    return { ...base, ok: true, complete, error, events, invalid, skipped };
  } catch (err) {
    return { ...base, ok: false, error: errText(err) };
  }
}

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

/** Local new / changed / unchanged classification (preview only — GVET decides on upload). */
export function classify(result, target) {
  const known = new Map((target.known ?? []).map((k) => [String(k.guid).toLowerCase(), k]));
  return (result.events ?? []).map((e) => {
    const k = known.get(e.guid);
    const state = !k ? "new" : k.hash !== e.hash || Date.parse(k.event_at) !== Date.parse(e.event_at) ? "changed" : "unchanged";
    return { ...e, state, date_lt: vilniusDate(e.event_at) };
  });
}

/**
 * Rounds of GVET-chosen animals (delpro_insemination_targets) -> DelPro reads -> delpro_insemination_upload.
 *   automatic: due / requested / retry animals, one round of `limit`
 *   all:       every linked animal not attempted since this run started (paged)
 *   tags:      exactly those ORNs
 * upload=false = preview: nothing is written anywhere (targets is a read).
 */
export async function runInseminationSync(client, {
  limit = config.inseminationBatch,
  dueMinutes = config.inseminationIntervalMin,
  retryMinutes = config.inseminationRetryMin,
  concurrency = config.inseminationConcurrency,
  all = false,
  tags = null,
  upload = true,
  recheckDates = false,
  maxRounds = all ? 1000 : 1,
  now = () => new Date(),
} = {}) {
  const startedAt = now().toISOString();
  const semen = semenLabeler(client);
  const totals = { targets: 0, ok: 0, failed: 0, incomplete: 0, events: 0, invalid: 0, skipped: 0, inserted: 0, updated: 0, unchanged: 0, conflicts: 0, flagged_duplicates: 0, missing: 0, mismatched: 0 };
  const all_results = [];
  for (let round = 1; round <= maxRounds; round += 1) {
    const body = tags?.length ? { tags } : all ? { limit, checked_before: startedAt } : { limit, due_minutes: dueMinutes, retry_minutes: retryMinutes };
    const list = (await gvet.inseminationTargets(body)) ?? [];
    if (!list.length) break;
    const results = await pool(list, Math.max(1, concurrency), (t) => readAnimalInseminations(client, t, { now: now(), semen, recheckDates }));
    totals.targets += list.length;
    for (const [i, r] of results.entries()) {
      const t = list[i];
      if (!r.ok) {
        totals.failed += 1;
        log.warn(`Sėklinimai ${t.orn}: NENUSKAITYTA — ${r.error}`);
      } else {
        totals.ok += 1;
        if (!r.complete) totals.incomplete += 1;
        totals.events += r.events.length;
        totals.invalid += r.invalid.length;
        totals.skipped += r.skipped.length;
      }
    }
    const final = tags?.length || !all || list.length < limit;
    if (upload) {
      for (let i = 0; i < results.length; i += 50) {
        const res = await gvet.inseminationUpload({ worker_id: config.workerId, results: results.slice(i, i + 50) });
        for (const k of ["inserted", "updated", "unchanged", "conflicts", "flagged_duplicates", "missing", "mismatched"]) totals[k] += res?.[k] ?? 0;
        for (const c of res?.conflict_list ?? []) log.warn(`Sėklinimas ${c.guid}: GVET jau priskirtas kitam gyvuliui — nepakeista.`);
      }
    }
    all_results.push(...results.map((r, i) => ({ ...r, orn: list[i].orn, animal_no: list[i].animal_no, events: r.ok ? classify(r, list[i]) : [] })));
    if (final) break;
  }
  // the round summary for GVET / `-Action status`: the whole run's totals (one call after every chunk was stored)
  if (upload && totals.targets) {
    await gvet.inseminationUpload({ worker_id: config.workerId, results: [],
      round: { started_at: startedAt, mode: tags?.length ? "tags" : all ? "all" : "auto", targets: totals.targets, counts: { ...totals } } });
  }
  if (totals.targets) log.info(`DelPro sėklinimai → GVET${upload ? "" : " (PERŽIŪRA, niekas neįrašyta)"}: ${JSON.stringify(totals)}`);
  return { ...totals, results: all_results };
}

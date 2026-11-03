import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, config, requireConfig } from "./config.js";
import { gvet } from "./gvet.js";
import { readHerd, outboundReady, writeTreatment } from "./delpro.js";
import { createGatewayClient } from "./gateway.js";
import { previewCatalogSync, runCatalogSync } from "./catalog.js";
import { runCatalogWrites } from "./catalog-writer.js";
import { checkCatalogJob } from "./catalog-write-check.js";
import { TreatmentWriteError, liveChecks, treatmentProblems, writeTreatment as writeGatewayTreatment } from "./treatment-gateway.js";
import { loadTreatmentModel, validateModel } from "./treatment-model.js";
import { GatewayError } from "./gateway.js";
import { diagnoseMilkSettings, pingGateway, prepareJob, runCmsLive, runCmsOutbound, runCmsTargetedRefresh, snapshotProblems } from "./cms-separation.js";
import { runInseminationSync } from "./inseminations.js";
import { log } from "./log.js";

// Dovinės ŽŪB DelPro worker (Priedas §3-§4). Runs on the farm PC next to
// DelPro; see README.md in this folder for install/run-as-service steps.
//
//   inbound  (every INBOUND_INTERVAL_MIN):  DelPro herd -> upsert_animals_from_delpro
//   outbound (every OUTBOUND_INTERVAL_SEC): claim approved job -> write to
//            DelPro -> read back -> delpro_report_job_result
//   catalog  (every CATALOG_INTERVAL_MIN, or when an admin presses
//            "Sinchronizuoti dabar"): Gateway GetData -> delpro_catalog_* (read-only)
//   cms      (every CMS_POLL_INTERVAL_SEC): claim approved CMS jobs -> per-animal check -> SortCow write -> read back;
//            every CMS_REFRESH_POLL_SEC: DelPro state of GVET's CMS animals only (targeted, 0051) -> GVET
//   inseminations (every INSEMINATION_POLL_SEC, INSEMINATION_SOURCE=gateway, 0053): DelPro InseminationEvent + AnimalEvent of
//            GVET-linked animals -> Sėklinimas (read-only towards DelPro; its own tick, never delays treatments or CMS)
//
// Every step is independent and failure-tolerant: a DelPro or network
// outage is logged and retried on the next tick, never crashes the loop.

const MAX_JOBS_PER_TICK = 20;
const state = {
  lastInboundOk: null, lastCatalogOk: null, lastError: null,
  lastCmsLiveOk: null, lastCmsLive: null, lastCmsRefresh: null, gatewayOkAt: null, gatewayError: null, lastInseminationRound: null,
  // --service is passed only by the scheduled task (scripts/gvet-worker.ps1): "automatic worker running" in GVET
  startedBy: process.argv.includes("--service") ? "task" : "manual",
  startedAt: new Date().toISOString(),
};

function treatmentModelReady() {
  try {
    return validateModel(loadTreatmentModel()).length === 0;
  } catch {
    return false;
  }
}

async function heartbeat() {
  await gvet.heartbeat({
    worker_id: config.workerId,
    version: config.version,
    host: os.hostname(),
    source: config.source,
    outbound_mode: config.outboundMode,
    outbound_ready: config.outboundMode === "sql" ? outboundReady() : null,
    // 0045: GVET shows an approved treatment as blocked (not "waiting") while this is false
    treatment_model_ready: treatmentModelReady(),
    last_inbound_ok: state.lastInboundOk,
    catalog_source: config.catalogSource,
    catalog_write_enabled: config.catalogWriteEnabled,
    last_catalog_ok: state.lastCatalogOk,
    // 0048 CMS atskyrimai
    cms_outbound_mode: config.cmsOutboundMode,
    cms_default_sort_area_key: config.cmsDefaultSortAreaKey || null,
    cms_last_live_ok: state.lastCmsLiveOk,
    cms_last_live: state.lastCmsLive,
    // 0051: targeted refresh (its presence tells GVET this worker no longer needs the full scan)
    cms_refresh_interval_min: config.cmsRefreshIntervalMin,
    cms_last_refresh: state.lastCmsRefresh,
    cms_batch_limit: config.cmsBatchLimit,
    cms_concurrency: config.cmsConcurrency,
    // 0053 DelPro -> GVET inseminations
    insemination_source: config.inseminationSource,
    insemination_last_round: state.lastInseminationRound,
    gateway_ok_at: state.gatewayOkAt,
    gateway_error: state.gatewayError,
    started_by: state.startedBy,
    started_at: state.startedAt,
    pid: process.pid,
    node: process.version,
    root: ROOT,
    last_error: state.lastError,
  });
}

export async function runInbound() {
  // DELPRO_SOURCE=off: no herd sync (e.g. a catalog-only install before the SQL queries are discovered).
  if (config.source === "off") return null;
  const herd = await readHerd();
  if (herd.animals.length === 0) {
    // An empty snapshot would mark the whole herd inactive — never send it.
    log.warn("DelPro grąžino 0 gyvulių — sinchronizacija praleista.");
    return null;
  }
  const result = await gvet.upsertAnimals({
    worker_id: config.workerId,
    full_snapshot: true,
    groups: herd.groups,
    animals: herd.animals,
  });
  state.lastInboundOk = new Date().toISOString();
  log.info(`DelPro → GVET: ${JSON.stringify(result)}`);
  return result;
}

export async function runCatalog() {
  if (config.catalogSource === "off") return null;
  const result = await runCatalogSync(createGatewayClient());
  if (result?.status === "completed") state.lastCatalogOk = new Date().toISOString();
  return result;
}

/**
 * `npm run catalog:dry-run`: reads the DelPro catalog (GetData only, through a
 * client that has no write methods at all) and asks GVET what the sync WOULD
 * do (delpro_catalog_preview runs the real pipeline and rolls it back). No
 * heartbeat, no begin/upload/finish/ingest call, no outbound or catalog jobs.
 * The full report is saved under dry-run/ on this PC.
 */
export async function runCatalogDryRun() {
  if (config.catalogSource !== "gateway") throw new Error("CATALOG_SOURCE=gateway reikalingas sausam paleidimui.");
  const gw = createGatewayClient();
  const readOnly = { getDataXml: (xml) => gw.getDataXml(xml) };
  const { read, preview } = await previewCatalogSync(readOnly);

  const dir = path.join(ROOT, "dry-run");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `catalog-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ worker_id: config.workerId, read, preview }, null, 2));

  log.info("SAUSAS PALEIDIMAS — GVET ir DelPro nepakeisti (delpro_catalog_preview atšauktas).");
  for (const [name, t] of Object.entries(preview.run?.stats ?? {})) {
    if (name === "Animal") continue;
    const r = read.types[name] ?? {};
    log.info(
      `  ${name}: DelPro ${t.received ?? 0} (pagrindinė užklausa ${r.returned ?? "?"}${r.refFetched ? `, +${r.refFetched} pagal nuorodas` : ""}), ` +
        `nauji ${t.inserted ?? 0}, pakeisti ${t.changed ?? 0}, nepakeisti ${t.unchanged ?? 0}, netinkami ${t.invalid ?? 0}, ` +
        `pilnas=${t.complete ? "taip" : "NE"}${t.note ? ` (${t.note})` : ""}, būtų pažymėta pašalintais ${t.removed ?? 0}` +
        `${r.refMissing?.length ? `, nuorodų DelPro nerasta ${r.refMissing.length}` : ""}`,
    );
  }
  if (preview.animals) log.info(`  Animal: ${JSON.stringify({ ...preview.animals, conflict_samples: undefined })}`);
  log.info(`  Suderinimas: ${JSON.stringify(preview.run?.reconcile ?? {})}`);
  for (const [kind, v] of Object.entries(preview.new_issues ?? {})) log.info(`  Nauji klausimai ${kind}: ${v.count}`);
  for (const [table, v] of Object.entries(preview.gvet_changes ?? {})) {
    log.info(`  GVET ${table}: +${v.inserted} ~${v.updated} -${v.deleted}`);
  }
  log.info(`Ataskaita: ${file}`);
  return { read, preview, file };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function jobIdArg(flag) {
  const id = process.argv[process.argv.indexOf(flag) + 1];
  if (!id || !UUID.test(id)) throw new Error(`Nurodykite užduoties ID: npm run ${flag === "--write-one" ? "catalog:write-one" : "catalog:write-check"} -- <užduoties-id>`);
  return id.toLowerCase();
}

/**
 * `npm run catalog:write-check -- <job>`: read-only. Prints the exact ddmData
 * each step of the job will send and checks it against the live Gateway
 * (catalog-write-check.js). Writes nothing anywhere.
 */
export async function runCatalogWriteCheck(jobId) {
  if (config.catalogSource !== "gateway") throw new Error("CATALOG_SOURCE=gateway reikalingas.");
  const job = await gvet.catalogGetJob({ job_id: jobId });
  if (!job) throw new Error(`Užduotis ${jobId} nerasta.`);
  const gw = createGatewayClient();
  const check = await checkCatalogJob({ getDataXml: (xml) => gw.getDataXml(xml) }, job);
  log.info(`Užduotis ${job.job_id}: ${job.label ?? ""} (${job.object_type}.${job.operation}), būsena ${job.status}, ` +
    `leista tik jai: ${job.released ? "taip" : "ne"}, rašymas GVET: ${job.write_enabled ? "įjungtas" : "išjungtas"}`);
  for (const s of check.steps) log.info(`  ${s.id} ${s.object}.${s.operation}: ${s.xml}`);
  for (const n of check.notes) log.warn(`  ${n}`);
  for (const p of check.problems) log.error(`  ${p}`);
  log.info(check.ok ? "Patikra: OK — DelPro schema atitinka." : `Patikra: ${check.problems.length} problem(os) — rašyti negalima.`);
  return { job, check };
}

/**
 * `npm run catalog:write-one -- <job>`: executes exactly ONE catalog job.
 * Needs CATALOG_WRITE_ENABLED=true for this process only, the job released in
 * GVET (delpro_catalog_release_single_job), and a clean write check first.
 */
export async function runCatalogWriteOne(jobId) {
  if (!config.catalogWriteEnabled) {
    throw new Error("Rašymas išjungtas: šiai komandai nustatykite CATALOG_WRITE_ENABLED=true (tik šiam paleidimui).");
  }
  const stored = await gvet.catalogGetJob({ job_id: jobId });
  if (!stored) throw new Error(`Užduotis ${jobId} nerasta.`);
  if (stored.status !== "queued") {
    // success / review / cancelled: never sent again from here (a re-run cannot duplicate)
    log.info(`Užduotis jau ${stored.status}${stored.delpro_key ? ` (DelPro ${stored.delpro_key})` : ""} — nieko nesiunčiama.`);
    return { job: stored, result: null };
  }
  const { job, check } = await runCatalogWriteCheck(jobId);
  if (!check.ok) throw new Error("Patikra nepavyko — į DelPro nieko nesiųsta.");
  if (!job.released || !job.write_enabled) throw new Error("GVET neleido šios užduoties (Veterinarija → DelPro → „Leisti įrašyti tik šią užduotį“).");

  const result = await runCatalogWrites(createGatewayClient({ allowWrites: true }), { jobId });
  if (!result) throw new Error("GVET užduoties neišdavė (jau vykdoma kitur arba leidimas atšauktas) — į DelPro nieko nesiųsta.");
  const after = await gvet.catalogGetJob({ job_id: jobId });
  log.info(`Rezultatas: ${after.status}${after.delpro_key ? `, DelPro ${after.delpro_key}` : ""}${after.link_id ? `, susieta (${after.link_id})` : ""}.`);
  return { job: after, result };
}

// Catalog jobs need a write-enabled Gateway client — the only place one is made for the catalog.
export async function runCatalogOutbound() {
  if (config.catalogSource !== "gateway" || !config.catalogWriteEnabled) return 0;
  return runCatalogWrites(createGatewayClient({ allowWrites: true }));
}

// OUTBOUND_MODE=gateway: each treatment GVET queues (saving it is the trigger, 0044) becomes a
// DiagnosesAndTreatmentEvent + its medicine records, read back and verified (treatment-gateway.js).
// Without a farm-verified treatment-model.json nothing is claimed: the jobs wait in GVET, none is lost,
// and nothing is written that would only look like a treatment.
let modelWarnedAt = 0;
async function runOutboundGateway() {
  const model = loadTreatmentModel();
  const modelErrors = validateModel(model);
  if (modelErrors.length) {
    if (Date.now() - modelWarnedAt > 3600_000) {
      modelWarnedAt = Date.now();
      log.warn(`OUTBOUND_MODE=gateway, bet gydymai nesiunčiami: ${modelErrors.join(" ")} (npm run treatment-probe)`);
    }
    return 0;
  }
  const client = createGatewayClient({ allowWrites: true });
  let processed = 0;
  while (processed < MAX_JOBS_PER_TICK) {
    const job = await gvet.claimNextJob("gateway");
    if (!job) break;
    processed += 1;
    const plan = job.treatment_plan;
    try {
      const problems = [...treatmentProblems(plan, model), ...(await liveChecks(client, plan))];
      if (problems.length) {
        await gvet.reportJobResult({ sync_id: job.sync_id, worker_id: config.workerId, success: false,
          error_message: problems.map((p) => p.message).join("; "), error_details: { problems } });
        log.warn(`GVET → DelPro: ${plan.animal.orn} — nesiunčiama: ${problems.map((p) => p.message).join("; ")}`);
        continue;
      }
      const actual = await writeGatewayTreatment(client, plan, model);
      const res = await gvet.reportJobResult({ sync_id: job.sync_id, worker_id: config.workerId, success: true, actual_result: actual,
        error_message: actual.medication.verified ? null : "Vaistų įrašai DelPro nepatvirtinti nuskaitymu — patikrinkite ranka." });
      log.info(`GVET → DelPro: ${plan.animal.orn} ${plan.treatment.reg_date} → ${res?.status} (įvykis ${actual.object_guid}, vaistai ` +
        `${actual.medication.usages.map((u) => `${u.drug_code}${u.verified ? "✓" : "✗"}`).join(", ")})`);
    } catch (err) {
      const e = err instanceof TreatmentWriteError ? err : null;
      const gw = err instanceof GatewayError ? err : null;
      log.error(`GVET → DelPro nepavyko (${job.sync_id}):`, err.message);
      await gvet.reportJobResult({
        sync_id: job.sync_id,
        worker_id: config.workerId,
        success: false,
        error_message: err.message,
        // the next attempt looks the GVET:<id> marker up before writing anything
        outcome_unknown: e ? e.outcomeUnknown : gw ? gw.outcomeUnknown : false,
        retryable: gw ? gw.retryable : e ? e.outcomeUnknown : false,
        error_details: e?.details ?? { code: err.code ?? null },
      });
    }
  }
  return processed;
}

export async function runOutbound() {
  if (config.outboundMode === "off") return 0;
  if (config.outboundMode === "gateway") {
    await gvet.releaseStaleJobs();
    return runOutboundGateway();
  }
  if (config.outboundMode === "dry-run") {
    log.info("OUTBOUND_MODE=dry-run — gydymai į DelPro nesiunčiami (užduotys paliekamos eilėje).");
    return 0;
  }
  if (!outboundReady()) {
    log.warn("OUTBOUND_MODE=sql, bet queries/insert-treatment.sql ar readback-treatment.sql dar neužpildytos — siuntimas praleistas.");
    return 0;
  }

  await gvet.releaseStaleJobs();
  let processed = 0;
  while (processed < MAX_JOBS_PER_TICK) {
    const job = await gvet.claimNextJob("ui_script");
    if (!job) break;
    processed += 1;
    try {
      const actual = await writeTreatment(job);
      const res = await gvet.reportJobResult({ sync_id: job.sync_id, worker_id: config.workerId, success: true, actual_result: actual });
      log.info(`GVET → DelPro: gyvulys ${job.animal.animal_no ?? job.animal.tag_no}, ${job.delpro.event_date} → ${res?.status}`);
    } catch (err) {
      log.error(`GVET → DelPro nepavyko (${job.sync_id}):`, err.message);
      await gvet.reportJobResult({
        sync_id: job.sync_id,
        worker_id: config.workerId,
        success: false,
        error_message: err.message,
        error_details: { stack: String(err.stack ?? "").slice(0, 2000) },
      });
    }
  }
  return processed;
}

// ---------------------------------------------------------------------------
// CMS atskyrimai (0048). Reads are always allowed with CATALOG_SOURCE=gateway; a write-enabled Gateway client is
// made only with CMS_OUTBOUND_MODE=gateway, and GVET still decides which job (if any) may be written.
// ---------------------------------------------------------------------------

// Gateway reads (CMS state, ping) work whenever this PC talks to the Gateway at all — for the catalog or for CMS.
const gatewayReadable = () => config.catalogSource === "gateway" || config.cmsOutboundMode === "gateway";

export async function runCms() {
  if (config.cmsOutboundMode !== "gateway") return 0;
  return runCmsOutbound(createGatewayClient({ allowWrites: true }));
}

/** OPTIONAL diagnostic: the old full DelPro scan (`npm run cms:live`). Never run by the loop, never a condition for sending. */
export async function runCmsFullScan() {
  const res = await runCmsLive(createGatewayClient(), { useCache: false });
  state.lastCmsLive = { at: new Date().toISOString(), complete: !!res?.complete, received: res?.received ?? null };
  if (res?.complete) state.lastCmsLiveOk = state.lastCmsLive.at;
  return res;
}

let cmsRefreshAt = 0;
/** Targeted DelPro -> GVET state (GVET's CMS animals only). Due every CMS_REFRESH_POLL_SEC; "Atnaujinti iš DelPro" forces a full operational round. */
export async function runCmsRefreshIfDue({ force = false } = {}) {
  if (!gatewayReadable()) return null;
  if (!force && Date.now() - cmsRefreshAt < config.cmsRefreshPollSec * 1000) return null;
  cmsRefreshAt = Date.now();
  const requested = force || (await gvet.cmsLiveRequested());
  const res = await runCmsTargetedRefresh(createGatewayClient(), { force: requested });
  if (res.targets || requested) {
    state.lastCmsRefresh = { at: new Date().toISOString(), targets: res.targets, ok: res.ok, failed: res.failed };
    // a read that worked is evidence the Gateway answers
    if (res.ok) {
      state.gatewayOkAt = state.lastCmsRefresh.at;
      state.gatewayError = null;
    }
  }
  return res;
}

// Read-only Gateway reachability for the activation checks (every 10 min).
let gatewayPingAt = 0;
export async function pingGatewayIfDue() {
  if (!gatewayReadable() || Date.now() - gatewayPingAt < 600_000) return;
  gatewayPingAt = Date.now();
  try {
    await pingGateway(createGatewayClient());
    state.gatewayOkAt = new Date().toISOString();
    state.gatewayError = null;
  } catch (err) {
    state.gatewayError = `${new Date().toISOString()} ${err.message}`;
  }
}

const LOCK_STALE_MS = 120_000;

/** Is `pid` a running node.exe / node process? Windows reuses PIDs quickly, so "some process has this PID" is not enough. */
export function isNodeProcess(pid, { platform = process.platform, exec = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== "EPERM") return false; // ESRCH = no such process
  }
  if (platform !== "win32") return true;
  try {
    const run = exec ?? ((cmd, args) => execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 }));
    const out = run("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    return /^"node(\.exe)?"/im.test(String(out).trim());
  } catch {
    return true; // can't tell -> assume it is (never run beside a possibly real worker)
  }
}

/**
 * One continuous worker per folder: logs\worker.lock holds {pid, started_at, host} and is touched every 30 s. A second
 * `npm start` / task instance exits (code 3) instead of running beside the first. The lock is taken over only when it is
 * stale — not touched for 2 min, or its PID is not a running node process (crash, power cut, closed console, PID reused by
 * another program). Nothing is ever killed here.
 */
export function acquireSingleInstanceLock({ dir = path.join(ROOT, "logs"), now = Date.now, alive = isNodeProcess } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "worker.lock");
  const mine = JSON.stringify({ pid: process.pid, started_at: new Date(now()).toISOString(), host: os.hostname() });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, mine, { flag: "wx" });
      const release = () => {
        try {
          if (readLockPid(file) === process.pid) fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
      process.on("exit", release);
      const touch = setInterval(() => {
        try {
          const t = new Date();
          fs.utimesSync(file, t, t);
        } catch {
          /* ignore */
        }
      }, 30_000);
      touch.unref();
      return { ok: true, file, release };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let pid = null;
      let ageMs = Infinity;
      try {
        pid = readLockPid(file);
        ageMs = now() - fs.statSync(file).mtimeMs;
      } catch {
        continue; // removed meanwhile -> try again
      }
      if (ageMs < LOCK_STALE_MS && alive(pid)) {
        log.error(`Darbininkas jau veikia (PID ${pid}, užraktas atnaujintas prieš ${Math.round(ageMs / 1000)} s, ${file}) — antras nepaleidžiamas.`);
        return { ok: false, file, pid };
      }
      log.warn(`Senas užraktas (PID ${pid ?? "?"}, ${Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)} s` : "?"}) — perimamas.`);
      try {
        fs.unlinkSync(file);
      } catch {
        /* someone else took it over */
      }
    }
  }
  return { ok: false, file, pid: null };
}

function readLockPid(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (/^\d+$/.test(text)) return Number(text); // 0.3.0 lock: just the PID
  try {
    const pid = Number(JSON.parse(text).pid);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function cmsJobArg(flag) {
  const id = process.argv[process.argv.indexOf(flag) + 1];
  if (!id || !UUID.test(id)) throw new Error(`Nurodykite CMS užduoties ID: npm run ${flag.slice(2)} -- <užduoties-id>`);
  return id.toLowerCase();
}

/**
 * `npm run cms:dry-run -- <job>`: read-only. Resolves the animal, its AnimalMilkSetting and existing action settings
 * through the Gateway and prints the exact CreateData document the job WOULD send. Changes nothing anywhere.
 */
export async function runCmsDryRun(jobId) {
  const job = await gvet.cmsGetJob({ job_id: jobId });
  if (!job) throw new Error(`CMS užduotis ${jobId} nerasta.`);
  const s = job.snapshot;
  log.info(`CMS užduotis ${jobId}: ${s.orn} (DelPro Nr. ${s.animal_no ?? "—"}), būsena ${job.status}, režimas ${s.mode}, ` +
    `${s.start_at} → ${s.end_at ?? "be pabaigos"}, sesijos ${(s.sessions ?? []).join(", ") || "—"}`);
  for (const p of job.problems ?? []) log.warn(`  GVET: ${p.message}`);
  const report = { job, checked_at: new Date().toISOString() };
  const local = snapshotProblems(s);
  if (local.length) {
    for (const p of local) log.warn(`  ${p}`);
    report.problems = local;
  } else {
    const gw = createGatewayClient();
    try {
      const prep = await prepareJob({ getDataXml: (xml) => gw.getDataXml(xml) }, { ...job, job_id: jobId });
      Object.assign(report, { milk_setting_key: prep.milkKey, delpro_animal: prep.animal, existing: prep.actions.length, active_sortcow: prep.active, xml: prep.xml });
      log.info(`  AnimalMilkSetting: ${prep.milkKey}; esami veiksmai: ${prep.actions.length}; aktyvūs SortCow: ${prep.active.map((a) => a.key).join(", ") || "nėra"}`);
      if (prep.active.length) log.warn("  DelPro jau turi aktyvų SortCow — ši užduotis nebūtų siunčiama.");
      log.info(`  CreateData (SIŪLOMA forma, nepatikrinta): ${prep.xml}`);
    } catch (err) {
      report.error = err.message;
      log.error(`  ${err.message}`);
    }
  }
  const dir = path.join(ROOT, "dry-run");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cms-${jobId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  log.info(`SAUSAS PALEIDIMAS — nieko neįrašyta. Ataskaita: ${file}`);
  return report;
}

/** `npm run cms:write-one -- <job>`: the supervised single-animal write. GVET must have released exactly this job. */
export async function runCmsWriteOne(jobId) {
  if (config.cmsOutboundMode !== "gateway") {
    throw new Error("Rašymas išjungtas: šiai komandai nustatykite CMS_OUTBOUND_MODE=gateway (tik šiam paleidimui).");
  }
  const before = await gvet.cmsGetJob({ job_id: jobId });
  if (!before) throw new Error(`CMS užduotis ${jobId} nerasta.`);
  if (!before.single_released) throw new Error("GVET neišleido šios užduoties (CMS atskyrimai → „Leisti siųsti tik šią“) — nieko nesiųsta.");
  await runCmsDryRun(jobId);
  const n = await runCmsOutbound(createGatewayClient({ allowWrites: true }), { jobId });
  if (!n) throw new Error("GVET užduoties neišdavė — į DelPro nieko nesiųsta.");
  const after = await gvet.cmsGetJob({ job_id: jobId });
  log.info(`Rezultatas: ${after.status}. Patikrinkite DelPro ir ar karvė realiai atskiriama.`);
  return after;
}

/** `npm run cms:milk-diagnose`: read-only — which AnimalMilkSetting record (if any) breaks the [Key, Animal] bulk read. */
export async function runCmsMilkDiagnose() {
  const report = await diagnoseMilkSettings(createGatewayClient());
  const dir = path.join(ROOT, "discovery");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cms-milk-diagnose-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  log.info(JSON.stringify(report, null, 2));
  log.info(`Išsaugota: ${file}`);
  return report;
}

/** `npm run cms:inspect`: saves GetMetadata answers + a few raw rows of the CMS objects to discovery/ (read-only). */
export async function runCmsInspect() {
  const gw = createGatewayClient();
  const dir = path.join(ROOT, "discovery");
  fs.mkdirSync(dir, { recursive: true });
  for (const objectName of ["AnimalActionSetting", "AnimalMilkSetting", "SortArea"]) {
    try {
      fs.writeFileSync(path.join(dir, `cms-${objectName}.metadata.xml`), await gw.getMetadata({ objectName }));
      log.info(`${objectName}: GetMetadata išsaugota.`);
    } catch (err) {
      log.warn(`${objectName}: GetMetadata nepavyko (${err.message}) — parametrų pavadinimus patikrinkite WSDL.`);
    }
  }
  const { ACTION_READ_PROPS } = await import("./cms-separation.js");
  const { buildRequestData } = await import("./gateway.js");
  for (const [objectName, props] of [["AnimalActionSetting", ACTION_READ_PROPS], ["SortArea", ["Key", "SortAreaNumber", "SortAreaName"]]]) {
    try {
      fs.writeFileSync(path.join(dir, `cms-${objectName}.sample.xml`), await gw.getDataXml(buildRequestData({ objectName, properties: props, top: 20 })));
      log.info(`${objectName}: pavyzdžiai išsaugoti.`);
    } catch (err) {
      log.warn(`${objectName}: ${err.message}`);
    }
  }
  log.info(`Failai: ${dir}`);
}

/**
 * `npm run cms:refresh` — read-only towards DelPro. The operational set now (`-- --all-linked`: every DelPro-linked GVET animal;
 * `-- --tag LT000007300337 [--tag …]`: exactly those). Prints each animal's SortCow records with their effective status and
 * uploads the result to GVET ("Aktyvūs atskyrimai").
 */
export async function runCmsRefresh(argv = process.argv) {
  const tags = argv.flatMap((a, i) => (a === "--tag" && argv[i + 1] ? [argv[i + 1]] : []));
  const res = await runCmsTargetedRefresh(createGatewayClient(), { force: true, allLinked: argv.includes("--all-linked"), tags: tags.length ? tags : null });
  for (const r of res.results) {
    if (!r.ok) {
      log.error(`  ${r.orn ?? r.animal_id}: NENUSKAITYTA — ${r.error}`);
      continue;
    }
    const acts = r.actions.map((a) => `${a.key} ${a.status} ${a.start_at ?? "?"}→${a.end_at ?? "be pabaigos"} s[${a.sessions.join(",")}]`);
    log.info(`  ${r.orn ?? r.animal_id} (DelPro Nr. ${r.delpro_number ?? "—"}, AnimalMilkSetting ${r.milk_setting_key ?? "nėra"}): ${acts.join("; ") || "SortCow nėra"}`);
  }
  if (tags.length && res.results.length < tags.length) log.warn(`Rasta ${res.results.length} iš ${tags.length}: kiti GVET neturi DelPro ObjectGuid arba ORN nerastas.`);
  log.info(`Tikslinis nuskaitymas: ${JSON.stringify({ ...res, results: undefined })}`);
  return { ...res, tags };
}

/** A Gateway client that can only read (GetData): the insemination import never gets CreateData / UpdateData at all. */
function readOnlyGateway() {
  const gw = createGatewayClient();
  return { getDataXml: (xml) => gw.getDataXml(xml) };
}

/** Automatic round (INSEMINATION_SOURCE=gateway): due / requested / retry animals, INSEMINATION_BATCH at most. */
export async function runInseminations(client = null) {
  if (config.inseminationSource !== "gateway") return null;
  const res = await runInseminationSync(client ?? readOnlyGateway());
  if (res.targets) {
    state.lastInseminationRound = { at: new Date().toISOString(), ...res, results: undefined };
  }
  return res;
}

const tagArgs = (argv) => argv.flatMap((a, i) => (a === "--tag" && argv[i + 1] ? [argv[i + 1]] : []));

/**
 * `npm run insemination:preview -- --tag LT…` (read-only everywhere), `insemination:sync-one -- --tag LT…`,
 * `insemination:sync-all` (both write to GVET only). Prints every event with its Lithuanian date. Exit 2 when an animal
 * could not be read completely, an event was invalid, or a tag was not found / not DelPro-linked.
 */
export async function runInseminationCommand(argv = process.argv, client = null) {
  const tags = tagArgs(argv);
  const preview = argv.includes("--insemination-preview");
  const all = argv.includes("--insemination-sync-all");
  if (argv.includes("--insemination-sync-one") && !tags.length) throw new Error("Nurodykite gyvulį: npm run insemination:sync-one -- --tag LT000009526299");
  const res = await runInseminationSync(client ?? readOnlyGateway(), {
    tags: tags.length ? tags : null,
    all,
    upload: !preview,
    recheckDates: argv.includes("--recheck-dates"),
  });
  for (const r of res.results) {
    const who = `${r.orn} (DelPro Nr. ${r.animal_no ?? "—"})`;
    if (!r.ok) {
      log.error(`  ${who}: NENUSKAITYTA — ${r.error}`);
      continue;
    }
    log.info(`  ${who}: ${r.events.length} sėklinim.${r.skipped.length ? `, ${r.skipped.length} senesni nei INSEMINATION_BACKFILL_MONTHS (neimportuojami)` : ""}` +
      `${r.complete ? "" : ` — NEPILNA: ${r.error}`}`);
    for (const e of r.events) {
      log.info(`    ${e.date_lt} (${e.event_at}) ${e.guid} Nr.${e.insemination_number ?? "—"} metodas ${e.method_code ?? "—"} ` +
        `sperma ${e.semen_label ?? e.semen_key ?? "—"}${e.bull ? ` bulius ${e.bull}` : ""}${e.breeder ? ` sėklintojas ${e.breeder}` : ""} → ${e.state}`);
    }
    for (const i of r.invalid) log.warn(`    NETINKAMAS ${i.guid ?? "?"}: ${i.error}`);
  }
  const missingTags = tags.length && res.results.length < tags.length;
  if (missingTags) log.warn(`Rasta ${res.results.length} iš ${tags.length}: kiti GVET nerasti arba neturi DelPro ObjectGuid.`);
  if (tags.length && res.results.length === 0) log.warn("Nėra ką skaityti.");
  log.info(preview ? "PERŽIŪRA — niekas neįrašyta nei į GVET, nei į DelPro." : "Įrašyta tik į GVET (DelPro tik skaitytas).");
  return { ...res, tags, exitCode: res.failed || res.incomplete || missingTags ? 2 : 0 };
}

/** `npm run insemination:inspect`: GetMetadata + a few raw rows of InseminationEvent / AnimalEvent / Semen to discovery/ (read-only). */
export async function runInseminationInspect() {
  const gw = createGatewayClient();
  const dir = path.join(ROOT, "discovery");
  fs.mkdirSync(dir, { recursive: true });
  const { buildRequestData } = await import("./gateway.js");
  const { EVENT_PROPS, BASE_PROPS } = await import("./inseminations.js");
  for (const [objectName, props] of [["InseminationEvent", EVENT_PROPS], ["AnimalEvent", BASE_PROPS], ["Semen", ["Key", ...config.inseminationSemenProperties]]]) {
    try {
      fs.writeFileSync(path.join(dir, `insemination-${objectName}.metadata.xml`), await gw.getMetadata({ objectName }));
      log.info(`${objectName}: GetMetadata išsaugota.`);
    } catch (err) {
      log.warn(`${objectName}: GetMetadata nepavyko (${err.message}) — savybių pavadinimus patikrinkite WSDL / schema failuose.`);
    }
    try {
      fs.writeFileSync(path.join(dir, `insemination-${objectName}.sample.xml`), await gw.getDataXml(buildRequestData({ objectName, properties: props, top: 5 })));
      log.info(`${objectName}: pavyzdžiai išsaugoti.`);
    } catch (err) {
      log.warn(`${objectName}: ${err.message}`);
    }
  }
  log.info(`Failai: ${dir}. Semen savybes, kurias rodo metadata, galima įrašyti į INSEMINATION_SEMEN_PROPERTIES.`);
}

async function safely(name, fn) {
  try {
    return await fn();
  } catch (err) {
    state.lastError = `${new Date().toISOString()} ${name}: ${err.message}`;
    log.error(`${name}:`, err.message);
    return null;
  }
}

async function main() {
  requireConfig();
  const dryRun = process.argv.includes("--dry-run");
  if (process.argv.includes("--write-check")) {
    const { check } = await runCatalogWriteCheck(jobIdArg("--write-check"));
    if (!check.ok) process.exitCode = 2;
    return;
  }
  if (process.argv.includes("--cms-dry-run")) {
    const r = await runCmsDryRun(cmsJobArg("--cms-dry-run"));
    if (r.error || r.problems?.length || r.active_sortcow?.length) process.exitCode = 2;
    return;
  }
  if (process.argv.includes("--cms-write-one")) {
    const job = await runCmsWriteOne(cmsJobArg("--cms-write-one"));
    if (job.status !== "success") process.exitCode = 2;
    return;
  }
  if (process.argv.includes("--cms-live")) {
    // OPTIONAL diagnostic of the whole DelPro database; nonzero unless it completed. Sending never depends on it.
    if (!gatewayReadable()) throw new Error("CMS būsena nenuskaityta: reikia CATALOG_SOURCE=gateway arba CMS_OUTBOUND_MODE=gateway.");
    const res = await runCmsFullScan();
    if (!res.complete) {
      log.warn(`Pilnas DelPro nuskaitymas NEPILNAS (tai tik diagnostika — siuntimo neblokuoja): ${(res.errors ?? []).join(" ") || "žr. aukščiau"}`);
      process.exitCode = 2;
    }
    return;
  }
  if (process.argv.includes("--cms-refresh")) {
    if (!gatewayReadable()) throw new Error("Reikia CATALOG_SOURCE=gateway arba CMS_OUTBOUND_MODE=gateway.");
    const res = await runCmsRefresh();
    if (res.failed || (res.tags?.length && res.results.length < res.tags.length)) process.exitCode = 2;
    return;
  }
  if (["--insemination-preview", "--insemination-sync-one", "--insemination-sync-all"].some((f) => process.argv.includes(f))) {
    if (!config.gateway.user) throw new Error("Reikia DELPRO_GATEWAY_USER (.env).");
    const res = await runInseminationCommand();
    process.exitCode = res.exitCode;
    return;
  }
  if (process.argv.includes("--insemination-inspect")) {
    await runInseminationInspect();
    return;
  }
  if (process.argv.includes("--cms-inspect")) {
    await runCmsInspect();
    return;
  }
  if (process.argv.includes("--cms-milk-diagnose")) {
    await runCmsMilkDiagnose();
    return;
  }
  if (process.argv.includes("--write-one")) {
    const { job } = await runCatalogWriteOne(jobIdArg("--write-one"));
    if (job.status !== "success") process.exitCode = 2;
    return;
  }
  if (dryRun && !process.argv.includes("--catalog")) throw new Error("--dry-run veikia tik su --catalog (npm run catalog:dry-run).");
  log.info(
    `DelPro darbininkas v${config.version} (${config.workerId}), šaltinis=${config.source}, outbound=${config.outboundMode}, ` +
      `katalogas=${config.catalogSource}, katalogo rašymas=${config.catalogWriteEnabled ? "ĮJUNGTAS" : "išjungtas"}, CMS=${config.cmsOutboundMode}` +
      ` (po ${config.cmsBatchLimit}, lygiagrečiai ${config.cmsConcurrency}), sėklinimai=${config.inseminationSource}`,
  );

  if (dryRun) {
    // Errors exit non-zero here: a failed dry run must not look like a clean one.
    await runCatalogDryRun();
    return;
  }
  if (process.argv.includes("--catalog")) {
    await safely("catalog", runCatalog);
    await safely("heartbeat", heartbeat);
    return;
  }
  if (process.argv.includes("--once")) {
    await safely("inbound", runInbound);
    await safely("catalog", runCatalog);
    await safely("outbound", runOutbound);
    await safely("catalog outbound", runCatalogOutbound);
    await safely("cms", runCms);
    await safely("inseminations", () => runInseminations());
    await safely("heartbeat", heartbeat);
    return;
  }

  if (!acquireSingleInstanceLock().ok) {
    process.exitCode = 3;
    return;
  }
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => process.exit(0));
  // A bug in one tick must not take the treatment queue down silently: log it; an uncaught exception exits non-zero
  // so the supervisor (scripts\gvet-worker.ps1 -Action run) starts a clean process.
  process.on("unhandledRejection", (err) => {
    state.lastError = `${new Date().toISOString()} unhandledRejection: ${err?.message ?? err}`;
    log.error("unhandledRejection:", err?.stack ?? err);
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException:", err?.stack ?? err);
    process.exit(1);
  });
  let inboundBusy = false;
  let outboundBusy = false;
  let catalogBusy = false;
  let cmsBusy = false;
  let inseminationBusy = false;
  const inseminationTick = async () => {
    if (inseminationBusy || config.inseminationSource !== "gateway") return;
    inseminationBusy = true;
    await safely("inseminations", () => runInseminations());
    inseminationBusy = false;
  };
  const cmsTick = async () => {
    if (cmsBusy) return;
    cmsBusy = true;
    // sending first; the targeted state read and the ping can fail without affecting it (or treatments, a separate tick)
    await safely("cms", runCms);
    await safely("cms refresh", () => runCmsRefreshIfDue());
    await safely("gateway ping", pingGatewayIfDue);
    cmsBusy = false;
  };
  const catalogTick = async () => {
    if (catalogBusy || config.catalogSource === "off") return;
    catalogBusy = true;
    await safely("catalog", runCatalog);
    catalogBusy = false;
  };
  const inboundTick = async () => {
    if (inboundBusy) return;
    inboundBusy = true;
    await safely("inbound", runInbound);
    inboundBusy = false;
  };
  const outboundTick = async () => {
    if (outboundBusy) return;
    outboundBusy = true;
    await safely("outbound", runOutbound);
    await safely("catalog outbound", runCatalogOutbound);
    await safely("heartbeat", heartbeat);
    // Manual "Sinchronizuoti dabar" from the admin screen; runs alongside, not blocking the queue.
    if (config.catalogSource !== "off" && !catalogBusy && (await safely("catalog request", () => gvet.catalogSyncRequested()))) {
      void catalogTick();
    }
    outboundBusy = false;
  };

  await inboundTick();
  await outboundTick();
  void catalogTick();
  setInterval(inboundTick, config.inboundIntervalMin * 60_000);
  setInterval(catalogTick, config.catalogIntervalMin * 60_000);
  setInterval(outboundTick, config.outboundIntervalSec * 1000);
  setInterval(cmsTick, config.cmsPollIntervalSec * 1000);
  setInterval(inseminationTick, config.inseminationPollSec * 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.error(err.message);
    process.exit(1);
  });
}

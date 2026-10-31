import fs from "node:fs";
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
import { log } from "./log.js";

// Dovinės ŽŪB DelPro worker (Priedas §3-§4). Runs on the farm PC next to
// DelPro; see README.md in this folder for install/run-as-service steps.
//
//   inbound  (every INBOUND_INTERVAL_MIN):  DelPro herd -> upsert_animals_from_delpro
//   outbound (every OUTBOUND_INTERVAL_SEC): claim approved job -> write to
//            DelPro -> read back -> delpro_report_job_result
//   catalog  (every CATALOG_INTERVAL_MIN, or when an admin presses
//            "Sinchronizuoti dabar"): Gateway GetData -> delpro_catalog_* (read-only)
//
// Every step is independent and failure-tolerant: a DelPro or network
// outage is logged and retried on the next tick, never crashes the loop.

const MAX_JOBS_PER_TICK = 20;
const state = { lastInboundOk: null, lastCatalogOk: null, lastError: null };

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
  if (process.argv.includes("--write-one")) {
    const { job } = await runCatalogWriteOne(jobIdArg("--write-one"));
    if (job.status !== "success") process.exitCode = 2;
    return;
  }
  if (dryRun && !process.argv.includes("--catalog")) throw new Error("--dry-run veikia tik su --catalog (npm run catalog:dry-run).");
  log.info(
    `DelPro darbininkas v${config.version} (${config.workerId}), šaltinis=${config.source}, outbound=${config.outboundMode}, ` +
      `katalogas=${config.catalogSource}, katalogo rašymas=${config.catalogWriteEnabled ? "ĮJUNGTAS" : "išjungtas"}`,
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
    await safely("heartbeat", heartbeat);
    return;
  }

  let inboundBusy = false;
  let outboundBusy = false;
  let catalogBusy = false;
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.error(err.message);
    process.exit(1);
  });
}

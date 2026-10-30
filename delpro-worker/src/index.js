import os from "node:os";
import { pathToFileURL } from "node:url";
import { config, requireConfig } from "./config.js";
import { gvet } from "./gvet.js";
import { readHerd, outboundReady, writeTreatment } from "./delpro.js";
import { createGatewayClient } from "./gateway.js";
import { runCatalogSync } from "./catalog.js";
import { runCatalogWrites } from "./catalog-writer.js";
import { writeTreatmentEvent } from "./treatment-gateway.js";
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

async function heartbeat() {
  await gvet.heartbeat({
    worker_id: config.workerId,
    version: config.version,
    host: os.hostname(),
    source: config.source,
    outbound_mode: config.outboundMode,
    outbound_ready: config.outboundMode === "sql" ? outboundReady() : null,
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

// Catalog jobs need a write-enabled Gateway client — the only place one is made for the catalog.
export async function runCatalogOutbound() {
  if (config.catalogSource !== "gateway" || !config.catalogWriteEnabled) return 0;
  return runCatalogWrites(createGatewayClient({ allowWrites: true }));
}

// OUTBOUND_MODE=gateway: treatments as DelPro DiagnosesAndTreatmentEvent records (0037).
async function runOutboundGateway() {
  const client = createGatewayClient({ allowWrites: true });
  let processed = 0;
  while (processed < MAX_JOBS_PER_TICK) {
    const job = await gvet.claimNextJob("gateway");
    if (!job) break;
    processed += 1;
    try {
      const actual = await writeTreatmentEvent(client, job);
      const res = await gvet.reportJobResult({ sync_id: job.sync_id, worker_id: config.workerId, success: true, actual_result: actual });
      log.info(`GVET → DelPro (Gateway): gyvulys ${job.gateway.animal_no ?? job.animal.tag_no}, ${job.gateway.event_date_local} → ${res?.status}`);
    } catch (err) {
      log.error(`GVET → DelPro (Gateway) nepavyko (${job.sync_id}):`, err.message);
      await gvet.reportJobResult({
        sync_id: job.sync_id,
        worker_id: config.workerId,
        success: false,
        error_message: err.message,
        // the next attempt must look for the marker before writing again
        outcome_unknown: err instanceof GatewayError ? err.outcomeUnknown : false,
        error_details: { code: err.code ?? null },
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
  log.info(
    `DelPro darbininkas v${config.version} (${config.workerId}), šaltinis=${config.source}, outbound=${config.outboundMode}, ` +
      `katalogas=${config.catalogSource}, katalogo rašymas=${config.catalogWriteEnabled ? "ĮJUNGTAS" : "išjungtas"}`,
  );

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

import os from "node:os";
import { pathToFileURL } from "node:url";
import { config, requireConfig } from "./config.js";
import { gvet } from "./gvet.js";
import { readHerd, outboundReady, writeTreatment } from "./delpro.js";
import { log } from "./log.js";

// Dovinės ŽŪB DelPro worker (Priedas §3-§4). Runs on the farm PC next to
// DelPro; see README.md in this folder for install/run-as-service steps.
//
//   inbound  (every INBOUND_INTERVAL_MIN):  DelPro herd -> upsert_animals_from_delpro
//   outbound (every OUTBOUND_INTERVAL_SEC): claim approved job -> write to
//            DelPro -> read back -> delpro_report_job_result
//
// Every step is independent and failure-tolerant: a DelPro or network
// outage is logged and retried on the next tick, never crashes the loop.

const MAX_JOBS_PER_TICK = 20;
const state = { lastInboundOk: null, lastError: null };

async function heartbeat() {
  await gvet.heartbeat({
    worker_id: config.workerId,
    version: config.version,
    host: os.hostname(),
    source: config.source,
    outbound_mode: config.outboundMode,
    outbound_ready: config.outboundMode === "sql" ? outboundReady() : null,
    last_inbound_ok: state.lastInboundOk,
    last_error: state.lastError,
  });
}

export async function runInbound() {
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

export async function runOutbound() {
  if (config.outboundMode === "off") return 0;
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
    const job = await gvet.claimNextJob();
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
  log.info(`DelPro darbininkas v${config.version} (${config.workerId}), šaltinis=${config.source}, outbound=${config.outboundMode}`);

  if (process.argv.includes("--once")) {
    await safely("inbound", runInbound);
    await safely("outbound", runOutbound);
    await safely("heartbeat", heartbeat);
    return;
  }

  let inboundBusy = false;
  let outboundBusy = false;
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
    await safely("heartbeat", heartbeat);
    outboundBusy = false;
  };

  await inboundTick();
  await outboundTick();
  setInterval(inboundTick, config.inboundIntervalMin * 60_000);
  setInterval(outboundTick, config.outboundIntervalSec * 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.error(err.message);
    process.exit(1);
  });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (no dependency): KEY=VALUE lines, # comments.
function loadDotEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
};

export const config = {
  version: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
  supabaseUrl: env("SUPABASE_URL"),
  serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  workerId: env("WORKER_ID", "dovines-delpro-pc"),
  source: env("DELPRO_SOURCE", "mssql"),
  jsonFile: path.resolve(ROOT, env("DELPRO_JSON_FILE", "./test/fixtures/herd.json")),
  sql: {
    server: env("DELPRO_SQL_SERVER", "localhost"),
    instance: env("DELPRO_SQL_INSTANCE"),
    database: env("DELPRO_SQL_DATABASE", "DDM"),
    user: env("DELPRO_SQL_USER"),
    password: env("DELPRO_SQL_PASSWORD"),
  },
  inboundIntervalMin: Number(env("INBOUND_INTERVAL_MIN", "30")),
  // GVET queues a treatment the moment it is saved (0044); the worker picks it up on this poll.
  outboundIntervalSec: Number(env("OUTBOUND_INTERVAL_SEC", "5")),
  outboundMode: env("OUTBOUND_MODE", "dry-run"),

  // DelPro Gateway SOAP service (local to the farm PC). Credentials stay in .env;
  // the password may legitimately be empty, so it is read raw.
  gateway: {
    url: env("DELPRO_GATEWAY_URL", "http://127.0.0.1:28080/GatewaySoapService"),
    user: env("DELPRO_GATEWAY_USER"),
    password: process.env.DELPRO_GATEWAY_PASSWORD ?? "",
    // any GUID is accepted; a fresh one per process when unset
    clientId: env("DELPRO_GATEWAY_CLIENT_ID"),
    timeoutMs: Number(env("DELPRO_GATEWAY_TIMEOUT_MS", "30000")),
    readRetries: Number(env("DELPRO_GATEWAY_READ_RETRIES", "2")),
    // Animal property holding the official registration number (ORN, e.g. LT000007300337).
    // Used to link GVET animals without a short DelPro Number. Empty = match by Number only.
    animalOrnProperty: env("DELPRO_GATEWAY_ANIMAL_ORN_PROPERTY", "OfficialRegNumber"),
  },
  // off | gateway — DelPro catalog (Drug, DrugParameters, Diagnosis, Treatment,
  // TreatmentDrugUsage) + Animal ObjectGuid -> GVET. Read-only towards DelPro.
  catalogSource: env("CATALOG_SOURCE", "off"),
  // daily DelPro -> GVET catalog sync (plus "Sinchronizuoti dabar" in GVET)
  catalogIntervalMin: Number(env("CATALOG_INTERVAL_MIN", "1440")),
  // `top` per GetData; a read returning this many rows is treated as truncated.
  catalogMaxRows: Number(env("CATALOG_MAX_ROWS", "5000")),
  // Rows a single GetData is assumed to be able to return at most (the farm's Gateway
  // returned exactly 1000). A read reaching it is treated as truncated, never as the whole catalog.
  catalogGatewayRowCap: Number(env("CATALOG_GATEWAY_ROW_CAP", "1000")),
  // GVET -> DelPro catalog writes (catalog-writer.js). Even when true, GVET only
  // hands out jobs while its own switch is on and the operation was validated
  // with a test job on the farm's Gateway.
  catalogWriteEnabled: env("CATALOG_WRITE_ENABLED", "false") === "true",
  // CMS atskyrimai (0048), separate from the treatment OUTBOUND_MODE:
  //   off | dry-run (nothing claimed) | gateway (claims what GVET releases: one supervised job, or verified modes)
  cmsOutboundMode: env("CMS_OUTBOUND_MODE", "off"),
  cmsPollIntervalSec: Number(env("CMS_POLL_INTERVAL_SEC", "5")),
  // Known DelPro SortArea. Reported in the heartbeat only — NOT sent with an AnimalActionSetting and NOT proven to route the cow.
  cmsDefaultSortAreaKey: env("CMS_DEFAULT_SORT_AREA_KEY", ""),
  // 0051: jobs claimed per CMS tick (at most) and how many are processed at once — kept small so DelPro is never flooded.
  cmsBatchLimit: Number(env("CMS_BATCH_LIMIT", "10")),
  cmsConcurrency: Number(env("CMS_CONCURRENCY", "2")),
  // Targeted DelPro SortCow state -> GVET "Aktyvūs atskyrimai": only GVET's CMS animals, each re-read when older than
  // CMS_LIVE_INTERVAL_MIN (0 = only on request), at most CMS_REFRESH_BATCH animals per round, rounds every CMS_REFRESH_POLL_SEC
  // (requests from "Atnaujinti iš DelPro" are picked up on the next round). The full-herd scan is `npm run cms:live` only.
  cmsRefreshIntervalMin: Number(env("CMS_LIVE_INTERVAL_MIN", "60")),
  cmsRefreshBatch: Number(env("CMS_REFRESH_BATCH", "50")),
  cmsRefreshPollSec: Number(env("CMS_REFRESH_POLL_SEC", "30")),
  // Diagnostic full scan (`npm run cms:live`) only:
  cmsLiveMaxRows: Number(env("CMS_LIVE_MAX_ROWS", "20000")),
  // AnimalMilkSetting [Key, Animal]: one bulk read of at most this many rows (top 2000 -> NullReferenceException on the
  // farm, 1000 fine); every other key is read by Key, CMS_LIVE_CONCURRENCY at a time, each read tried CMS_LIVE_READ_ATTEMPTS times.
  cmsLiveMilkBulkTop: Number(env("CMS_LIVE_MILK_BULK_TOP", "1000")),
  cmsLiveConcurrency: Number(env("CMS_LIVE_CONCURRENCY", "3")),
  cmsLiveReadAttempts: Number(env("CMS_LIVE_READ_ATTEMPTS", "2")),
  // 0053: DelPro -> GVET inseminations (read-only towards DelPro), independent of treatments and CMS:
  //   off (default) | gateway. The insemination:* commands work in either mode (they need only the Gateway login).
  inseminationSource: env("INSEMINATION_SOURCE", "off"),
  inseminationPollSec: Number(env("INSEMINATION_POLL_SEC", "60")),
  // animals per automatic round; an animal is re-read when its last complete read is older than INSEMINATION_INTERVAL_MIN,
  // a failed / incomplete one after INSEMINATION_RETRY_MIN; "Atnaujinti iš DelPro" requests go first
  inseminationBatch: Number(env("INSEMINATION_BATCH", "20")),
  inseminationConcurrency: Number(env("INSEMINATION_CONCURRENCY", "3")),
  inseminationIntervalMin: Number(env("INSEMINATION_INTERVAL_MIN", "360")),
  inseminationRetryMin: Number(env("INSEMINATION_RETRY_MIN", "30")),
  // InseminationEvent rows per animal read; reaching it -> one re-read with the max; still full -> the animal is incomplete
  inseminationEventTop: Number(env("INSEMINATION_EVENT_TOP", "100")),
  inseminationEventMaxTop: Number(env("INSEMINATION_EVENT_MAX_TOP", "1000")),
  // AnimalEvent (the date) is re-read for events this recent even when GVET has them (late corrections)
  inseminationOverlapDays: Number(env("INSEMINATION_OVERLAP_DAYS", "14")),
  // events older than this are not imported (0 = everything); applied to the Vilnius-normalized EventDate
  inseminationBackfillMonths: Number(env("INSEMINATION_BACKFILL_MONTHS", "24")),
  // Semen catalog: "<name property>,<comment property>", verified on the farm Gateway (Semen [Key, SemenName, Comment]).
  // The name is shown in "Bulius / sperma"; the comment is supporting text only. Empty value in .env = this default.
  inseminationSemenProperties: env("INSEMINATION_SEMEN_PROPERTIES", "SemenName,Comment").split(",").map((s) => s.trim()).filter(Boolean),
};

export function requireConfig() {
  const missing = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!["mssql", "json", "off"].includes(config.source)) missing.push("DELPRO_SOURCE (mssql|json|off)");
  if (!["off", "dry-run", "sql", "gateway"].includes(config.outboundMode)) missing.push("OUTBOUND_MODE (off|dry-run|sql|gateway)");
  if (config.outboundMode === "gateway" && !config.gateway.user) missing.push("DELPRO_GATEWAY_USER");
  if (config.catalogWriteEnabled && config.catalogSource !== "gateway") missing.push("CATALOG_SOURCE=gateway (CATALOG_WRITE_ENABLED=true)");
  if (!["off", "gateway"].includes(config.catalogSource)) missing.push("CATALOG_SOURCE (off|gateway)");
  if (config.catalogSource === "gateway" && !config.gateway.user) missing.push("DELPRO_GATEWAY_USER");
  if (!(config.catalogMaxRows > 0)) missing.push("CATALOG_MAX_ROWS");
  if (!(config.catalogGatewayRowCap > 0)) missing.push("CATALOG_GATEWAY_ROW_CAP");
  if (!["off", "dry-run", "gateway"].includes(config.cmsOutboundMode)) missing.push("CMS_OUTBOUND_MODE (off|dry-run|gateway)");
  if (config.cmsOutboundMode === "gateway" && !config.gateway.user) missing.push("DELPRO_GATEWAY_USER");
  if (!(config.cmsPollIntervalSec >= 1)) missing.push("CMS_POLL_INTERVAL_SEC");
  if (!(config.cmsLiveMaxRows > 0)) missing.push("CMS_LIVE_MAX_ROWS");
  if (!(config.cmsBatchLimit >= 1 && config.cmsBatchLimit <= 50)) missing.push("CMS_BATCH_LIMIT (1-50)");
  if (!(config.cmsConcurrency >= 1 && config.cmsConcurrency <= 4)) missing.push("CMS_CONCURRENCY (1-4)");
  if (!(config.cmsRefreshIntervalMin >= 0)) missing.push("CMS_LIVE_INTERVAL_MIN");
  if (!(config.cmsRefreshBatch >= 1 && config.cmsRefreshBatch <= 200)) missing.push("CMS_REFRESH_BATCH (1-200)");
  if (!(config.cmsRefreshPollSec >= 5)) missing.push("CMS_REFRESH_POLL_SEC (>= 5)");
  if (!(config.cmsLiveMilkBulkTop >= 0 && config.cmsLiveMilkBulkTop <= 1000)) missing.push("CMS_LIVE_MILK_BULK_TOP (0-1000)");
  if (!(config.cmsLiveConcurrency >= 1 && config.cmsLiveConcurrency <= 8)) missing.push("CMS_LIVE_CONCURRENCY (1-8)");
  if (!(config.cmsLiveReadAttempts >= 1 && config.cmsLiveReadAttempts <= 5)) missing.push("CMS_LIVE_READ_ATTEMPTS (1-5)");
  if (!["off", "gateway"].includes(config.inseminationSource)) missing.push("INSEMINATION_SOURCE (off|gateway)");
  if (config.inseminationSource === "gateway" && !config.gateway.user) missing.push("DELPRO_GATEWAY_USER");
  if (!(config.inseminationPollSec >= 10)) missing.push("INSEMINATION_POLL_SEC (>= 10)");
  if (!(config.inseminationBatch >= 1 && config.inseminationBatch <= 200)) missing.push("INSEMINATION_BATCH (1-200)");
  if (!(config.inseminationConcurrency >= 1 && config.inseminationConcurrency <= 6)) missing.push("INSEMINATION_CONCURRENCY (1-6)");
  if (!(config.inseminationIntervalMin >= 5)) missing.push("INSEMINATION_INTERVAL_MIN (>= 5)");
  if (!(config.inseminationRetryMin >= 1)) missing.push("INSEMINATION_RETRY_MIN (>= 1)");
  if (!(config.inseminationEventTop >= 1 && config.inseminationEventTop <= 1000)) missing.push("INSEMINATION_EVENT_TOP (1-1000)");
  if (!(config.inseminationEventMaxTop >= config.inseminationEventTop && config.inseminationEventMaxTop <= 1000)) missing.push("INSEMINATION_EVENT_MAX_TOP (TOP-1000)");
  if (!(config.inseminationOverlapDays >= 0)) missing.push("INSEMINATION_OVERLAP_DAYS");
  if (!(config.inseminationBackfillMonths >= 0)) missing.push("INSEMINATION_BACKFILL_MONTHS");
  if (config.inseminationSemenProperties.length > 2 || config.inseminationSemenProperties.some((p) => !/^[A-Za-z_][\w.-]*$/.test(p))) {
    missing.push("INSEMINATION_SEMEN_PROPERTIES (<pavadinimas>,<komentaras>, pvz. SemenName,Comment)");
  }
  if (missing.length) throw new Error(`Trūksta / neteisinga konfigūracija: ${missing.join(", ")}`);
}

export function readQuery(name) {
  return fs.readFileSync(path.join(ROOT, "queries", name), "utf8");
}

/** Query files ship as placeholders until DelPro discovery fills them in. */
export function isPlaceholder(sqlText) {
  return /--\s*TODO\(discovery\)/.test(sqlText);
}

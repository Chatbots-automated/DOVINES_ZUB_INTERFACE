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
  if (missing.length) throw new Error(`Trūksta / neteisinga konfigūracija: ${missing.join(", ")}`);
}

export function readQuery(name) {
  return fs.readFileSync(path.join(ROOT, "queries", name), "utf8");
}

/** Query files ship as placeholders until DelPro discovery fills them in. */
export function isPlaceholder(sqlText) {
  return /--\s*TODO\(discovery\)/.test(sqlText);
}

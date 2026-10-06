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
  outboundIntervalSec: Number(env("OUTBOUND_INTERVAL_SEC", "60")),
  outboundMode: env("OUTBOUND_MODE", "dry-run"),
};

export function requireConfig() {
  const missing = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!["mssql", "json"].includes(config.source)) missing.push("DELPRO_SOURCE (mssql|json)");
  if (!["off", "dry-run", "sql"].includes(config.outboundMode)) missing.push("OUTBOUND_MODE (off|dry-run|sql)");
  if (missing.length) throw new Error(`Trūksta / neteisinga konfigūracija: ${missing.join(", ")}`);
}

export function readQuery(name) {
  return fs.readFileSync(path.join(ROOT, "queries", name), "utf8");
}

/** Query files ship as placeholders until DelPro discovery fills them in. */
export function isPlaceholder(sqlText) {
  return /--\s*TODO\(discovery\)/.test(sqlText);
}

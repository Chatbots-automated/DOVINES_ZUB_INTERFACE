// POST /.netlify/functions/delpro-report-upload
//
// Receives one DelPro daily XLSX report from the farm PC uploader, parses it
// and imports it in ONE database transaction (delpro_report_ingest, 0042).
// A 2xx is returned only after the import is committed.
//
// Request (contract of the farm's Windows uploader)
//   Authorization: Bearer <farm report-upload token>     (created in GVET → DelPro)
//   Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
//   X-GVET-Report-Filename: Gvet_20261030 121001.xlsx    (may be percent-encoded)
//   X-GVET-Report-SHA256: <hex SHA-256 of the body>
//   X-GVET-Report-Type: daily-health
//   body: the raw XLSX bytes
//
// Responses
//   201 {"status":"processed","import_id","rows_received","matched","created","updated","conflicts"}
//   200 {"status":"duplicate","import_id"}                     same farm + same SHA-256 already imported
//   4xx/5xx {"status":"error","error":"<code>","message":"..."}  nothing was imported; safe to retry
//     400 bad_request / sha256_mismatch   401 unauthorized   403 forbidden   405 method_not_allowed
//     411 length_required   413 too_large   415 unsupported_media_type   422 invalid_xlsx / no_orn_column / invalid_report
//     500 server_error / server_not_configured   503 database_unavailable
//
// The farm is derived from the token in the database; nothing the client sends
// selects the farm. Server-only secrets: SUPABASE_SERVICE_ROLE_KEY (+ SUPABASE_URL
// or NEXT_PUBLIC_SUPABASE_URL) in the Netlify environment.

import crypto from "node:crypto";
import { ReportError, parseReport } from "../lib/delpro-report.mjs";

export const MAX_BYTES = 10 * 1024 * 1024;
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const REPORT_TYPES = new Set(["daily-health"]);

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (status, error, message) => json(status, { status: "error", error, message });

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

function decodeFilename(value) {
  let name = String(value ?? "").trim();
  if (/%[0-9a-f]{2}/i.test(name)) {
    try {
      name = decodeURIComponent(name);
    } catch {
      return null;
    }
  }
  name = name.split(/[\\/]/).pop();
  if (!name || name.length > 255 || /[\u0000-\u001f]/.test(name) || !/\.xlsx$/i.test(name)) return null;
  return name;
}

// PostgREST error -> HTTP. The ingest raises GV401 / GV403 / GV422 for its own refusals.
const DB_STATUS = { GV401: [401, "unauthorized"], GV403: [403, "forbidden"], GV422: [422, "invalid_report"] };

async function rpc(env, fn, body) {
  let res;
  try {
    res = await fetch(`${env.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { error: [503, "database_unavailable", `Duomenų bazė nepasiekiama: ${err.message}`] };
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const [status, code] = DB_STATUS[data?.code] ?? [res.status >= 500 ? 503 : 500, res.status >= 500 ? "database_unavailable" : "server_error"];
    return { error: [status, code, data?.message ?? `Duomenų bazės klaida (HTTP ${res.status}).`] };
  }
  return { data };
}

export function serverEnv(source = process.env) {
  const url = (source.SUPABASE_URL || source.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = source.SUPABASE_SERVICE_ROLE_KEY || "";
  return url && key ? { url, key } : null;
}

export async function handleUpload(req, env = serverEnv()) {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Naudokite POST.");
  if (!env) return fail(500, "server_not_configured", "Serveryje nenustatyti SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
  if (!token || token.length < 20 || token.length > 200) return fail(401, "unauthorized", "Trūksta arba neteisingas Authorization: Bearer raktas.");

  const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== XLSX_TYPE && contentType !== "application/octet-stream") {
    return fail(415, "unsupported_media_type", `Laukiamas ${XLSX_TYPE}.`);
  }
  const filename = decodeFilename(req.headers.get("x-gvet-report-filename"));
  if (!filename) return fail(400, "bad_request", "Neteisingas X-GVET-Report-Filename (laukiamas .xlsx failo vardas).");
  const declaredSha = (req.headers.get("x-gvet-report-sha256") ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(declaredSha)) return fail(400, "bad_request", "Neteisingas X-GVET-Report-SHA256 (64 šešioliktainiai simboliai).");
  const reportType = (req.headers.get("x-gvet-report-type") ?? "").trim();
  if (!REPORT_TYPES.has(reportType)) return fail(400, "bad_request", `Nežinomas X-GVET-Report-Type „${reportType}“.`);
  const declaredLength = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) return fail(413, "too_large", `Failas didesnis nei ${MAX_BYTES} B.`);

  const tokenHash = sha256(token);
  // the token first: an unknown token gets 401 before the body is even read
  const authRes = await rpc(env, "delpro_report_auth", { token_hash: tokenHash });
  if (authRes.error) return fail(...authRes.error);

  const body = Buffer.from(await req.arrayBuffer());
  if (body.length === 0) return fail(400, "bad_request", "Tuščias failas.");
  if (body.length > MAX_BYTES) return fail(413, "too_large", `Failas didesnis nei ${MAX_BYTES} B.`);
  const actualSha = sha256(body);
  if (actualSha !== declaredSha) {
    await rpc(env, "delpro_report_log_failure", { token_hash: tokenHash, filename, sha256: declaredSha, stage: "sha256", error: `Gautas SHA-256 ${actualSha}` });
    return fail(400, "sha256_mismatch", "Failo SHA-256 nesutampa su X-GVET-Report-SHA256 (failas gautas nepilnas?).");
  }

  let parsed;
  try {
    parsed = parseReport(body, { filename, receivedAt: new Date() });
  } catch (err) {
    const code = err instanceof ReportError ? err.code : "invalid_xlsx";
    await rpc(env, "delpro_report_log_failure", { token_hash: tokenHash, filename, sha256: actualSha, stage: "parse", error: err.message });
    return fail(code === "too_large" ? 413 : 422, code, err.message);
  }

  const ingest = await rpc(env, "delpro_report_ingest", {
    token_hash: tokenHash,
    report_type: reportType,
    filename,
    sha256: actualSha,
    size_bytes: body.length,
    ...parsed,
  });
  if (ingest.error) {
    await rpc(env, "delpro_report_log_failure", { token_hash: tokenHash, filename, sha256: actualSha, stage: "import", error: ingest.error[2] });
    return fail(...ingest.error);
  }
  const r = ingest.data;
  if (r?.status === "duplicate") return json(200, { status: "duplicate", import_id: r.import_id });
  if (r?.status !== "processed") return fail(500, "server_error", "Netikėtas importo atsakymas.");
  return json(201, {
    status: "processed",
    import_id: r.import_id,
    rows_received: r.rows_received,
    matched: r.matched,
    created: r.created,
    updated: r.updated,
    conflicts: r.conflicts,
  });
}

const handler = async (req) => {
  try {
    return await handleUpload(req);
  } catch (err) {
    console.error("[delpro-report-upload]", err);
    return fail(500, "server_error", "Serverio klaida — failas neimportuotas.");
  }
};

export default handler;

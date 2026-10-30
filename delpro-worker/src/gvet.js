import { config } from "./config.js";

// Thin PostgREST RPC client (service role). Outbound HTTPS only — the farm
// PC never has to accept incoming connections.
export async function rpc(fn, body) {
  const res = await fetch(`${config.supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RPC ${fn} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

export const gvet = {
  heartbeat: (info) => rpc("delpro_worker_heartbeat", info),
  upsertAnimals: (payload) => rpc("upsert_animals_from_delpro", payload),
  // Named params: PostgREST maps {"p_worker_id": ..., "p_channel": ...} to the arguments.
  // p_channel makes GVET hand out nothing when the farm is set to the other write channel.
  claimNextJob: (channel) =>
    rpc("delpro_claim_next_job", channel ? { p_worker_id: config.workerId, p_channel: channel } : { p_worker_id: config.workerId }),
  reportJobResult: (result) => rpc("delpro_report_job_result", result),
  releaseStaleJobs: () => rpc("delpro_release_stale_jobs", {}),
  // DelPro catalog (0036) — all unnamed jsonb bodies.
  catalogBeginRun: (body) => rpc("delpro_catalog_begin_run", body),
  catalogUpload: (body) => rpc("delpro_catalog_upload", body),
  catalogFinishRun: (body) => rpc("delpro_catalog_finish_run", body),
  catalogSyncRequested: () => rpc("delpro_catalog_sync_requested", {}),
  // 0038: dry run — runs the real pipeline in GVET and rolls it back.
  catalogPreview: (body) => rpc("delpro_catalog_preview", body),
  ingestAnimalIds: (body) => rpc("delpro_ingest_animal_ids", body),
  // GVET -> DelPro catalog jobs (0037)
  catalogClaimJob: (body) => rpc("delpro_catalog_claim_job", body),
  catalogJobStep: (body) => rpc("delpro_catalog_job_step", body),
  catalogJobResult: (body) => rpc("delpro_catalog_job_result", body),
  // 0039: one job as stored (read-only) — for the write check / one-shot write
  catalogGetJob: (body) => rpc("delpro_catalog_get_job", body),
};

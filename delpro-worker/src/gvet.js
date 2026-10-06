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
  // Named param: PostgREST maps {"p_worker_id": ...} to the argument.
  claimNextJob: () => rpc("delpro_claim_next_job", { p_worker_id: config.workerId }),
  reportJobResult: (result) => rpc("delpro_report_job_result", result),
  releaseStaleJobs: () => rpc("delpro_release_stale_jobs", {}),
};

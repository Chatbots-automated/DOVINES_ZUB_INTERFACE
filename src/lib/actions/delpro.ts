"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { DelproOutboundMode } from "@/lib/supabase/types";

// DelPro integration admin actions (Priedas §3-§4). All are form-bound
// (useActionState + <form action>), the pattern AGENTS.md confirms is safe
// on Netlify. Authorization lives in the database: the delpro_* RPCs check
// fn_is_admin(), and the tables are admin-write by RLS.

export type DelproActionResult = { ok: true; message?: string } | { ok: false; error: string };

function done(message?: string): DelproActionResult {
  revalidatePath("/veterinarija/delpro");
  revalidatePath("/veterinarija");
  return { ok: true, message };
}

export async function approveDelproJobs(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  let ids: string[] = [];
  try {
    ids = JSON.parse(String(formData.get("job_ids") ?? "[]"));
  } catch {
    ids = [];
  }
  if (ids.length === 0) return { ok: false, error: "Nepasirinktas nė vienas įrašas." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_approve_jobs", { p_job_ids: ids });
  if (error) return { ok: false, error: error.message };
  return done(`Patvirtinta: ${data ?? 0}`);
}

export async function rejectDelproJob(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const jobId = String(formData.get("job_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const supabase = await createClient();
  const { error } = await supabase.rpc("delpro_reject_job", { p_job_id: jobId, p_reason: reason || undefined });
  if (error) return { ok: false, error: error.message };
  return done();
}

export async function retryDelproJob(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const jobId = String(formData.get("job_id") ?? "");
  const refresh = formData.get("refresh") === "1";
  const supabase = await createClient();
  const { error } = await supabase.rpc("delpro_retry_job", { p_job_id: jobId, p_refresh: refresh });
  if (error) return { ok: false, error: error.message };
  return done();
}

const MODES: DelproOutboundMode[] = ["approval", "auto", "off"];

export async function updateDelproSettings(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const mode = String(formData.get("delpro_outbound_mode") ?? "") as DelproOutboundMode;
  if (!MODES.includes(mode)) return { ok: false, error: "Neteisingas režimas." };
  const delay = Math.max(0, Math.round(Number(formData.get("delpro_auto_delay_minutes") ?? 10) || 0));
  const defaultCode = String(formData.get("delpro_default_treatment_code") ?? "").trim() || null;

  const supabase = await createClient();
  const updates: Array<[string, string | null]> = [
    ["delpro_outbound_mode", mode],
    ["delpro_auto_delay_minutes", String(delay)],
    ["delpro_default_treatment_code", defaultCode],
  ];
  for (const [key, value] of updates) {
    const { error } = await supabase.from("system_settings").update({ setting_value: value }).eq("setting_key", key);
    if (error) return { ok: false, error: error.message };
  }
  return done("Nustatymai išsaugoti.");
}

// One row per GVET disease/product; empty code + name deletes the mapping.
export async function saveDelproMapping(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const kind = String(formData.get("kind") ?? "");
  const localId = String(formData.get("local_id") ?? "");
  if ((kind !== "disease" && kind !== "product") || !localId) return { ok: false, error: "Neteisingi duomenys." };
  const delpro_code = String(formData.get("delpro_code") ?? "").trim() || null;
  const delpro_name = String(formData.get("delpro_name") ?? "").trim() || null;

  const supabase = await createClient();
  const { error } =
    delpro_code || delpro_name
      ? await supabase
          .from("delpro_mappings")
          .upsert({ kind, local_id: localId, delpro_code, delpro_name }, { onConflict: "kind,local_id" })
      : await supabase.from("delpro_mappings").delete().eq("kind", kind).eq("local_id", localId);
  if (error) return { ok: false, error: error.message };
  return done("Išsaugota.");
}

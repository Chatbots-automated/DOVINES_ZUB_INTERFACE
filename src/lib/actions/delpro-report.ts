"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { DelproActionResult } from "@/lib/actions/delpro";

// DelPro Excel report admin (0042). Called through /api/delpro/action (src/lib/delpro-ops.ts);
// every rule (admin only, token hashing) lives in the delpro_report_* RPCs.

function done(message?: string): DelproActionResult {
  revalidatePath("/veterinarija/delpro");
  return { ok: true, message };
}

/** Returns the new token as the message — shown once, only its SHA-256 is stored. */
export async function createReportUploadToken(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const label = String(formData.get("label") ?? "").trim();
  if (!label) return { ok: false, error: "Nurodykite rakto pavadinimą (pvz. DAU-DOV-KDV-002)." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_report_create_token", { p_label: label });
  if (error) return { ok: false, error: error.message };
  return done(data?.token);
}

export async function revokeReportUploadToken(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const id = String(formData.get("token_id") ?? "");
  if (!id) return { ok: false, error: "Nenurodytas raktas." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_report_revoke_token", { p_id: id });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

export async function resolveReportReview(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const id = String(formData.get("review_id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || (status !== "resolved" && status !== "dismissed")) return { ok: false, error: "Neteisingi duomenys." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_report_resolve_review", { p_id: id, p_status: status });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

export async function updateReportField(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const key = String(formData.get("key") ?? "");
  if (!key) return { ok: false, error: "Nenurodytas laukas." };
  const visible = formData.get("visible");
  const order = String(formData.get("sort_order") ?? "").trim();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_report_update_field", {
    p_key: key,
    p_label: String(formData.get("label") ?? "").trim() || null,
    p_visible: visible === null ? null : visible === "1",
    p_sort_order: order && Number.isFinite(Number(order)) ? Math.trunc(Number(order)) : null,
  });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

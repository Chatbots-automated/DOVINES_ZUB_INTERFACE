"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  CATALOG_INBOUND_MODES,
  CATALOG_OUTBOUND_MODES,
  CATALOG_WRITE_OPERATIONS,
  type CatalogInboundMode,
  type CatalogOutboundMode,
} from "@/lib/delpro-catalog";
import type { DelproActionResult } from "@/lib/actions/delpro";
import type { DelproCatalogIssueAction } from "@/lib/supabase/types";

// DelPro catalog sync admin actions (0036). Form-bound like the rest of the
// DelPro screen. Authorization and every rule live in the database: the
// delpro_catalog_* RPCs check fn_is_admin() and the catalog tables have no
// client write policies.

const ISSUE_ACTIONS: DelproCatalogIssueAction[] = ["confirm", "take_delpro", "keep_gvet", "send", "unlink", "reviewed", "dismiss"];
const LINKABLE = ["Diagnosis", "Drug", "Treatment"];

function done(message?: string): DelproActionResult {
  revalidatePath("/veterinarija/delpro");
  return { ok: true, message };
}

export async function requestCatalogSync(): Promise<DelproActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("delpro_catalog_request_sync");
  if (error) return { ok: false, error: error.message };
  return done("Prašymas išsiųstas — ūkio kompiuteris pradės per minutę.");
}

export async function confirmCatalogSuggestions(): Promise<DelproActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_confirm_suggestions");
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

export async function resolveCatalogIssue(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const issueId = String(formData.get("issue_id") ?? "");
  const action = String(formData.get("action") ?? "") as DelproCatalogIssueAction;
  if (!issueId || !ISSUE_ACTIONS.includes(action)) return { ok: false, error: "Neteisingi duomenys." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_resolve_issue", { p_issue_id: issueId, p_action: action });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/apskaita/produktai");
  return done(data?.message);
}

export async function linkCatalogRecord(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const objectType = String(formData.get("object_type") ?? "");
  const delproKey = String(formData.get("delpro_key") ?? "");
  const gvetId = String(formData.get("gvet_id") ?? "");
  if (!LINKABLE.includes(objectType) || !delproKey || !gvetId) {
    return { ok: false, error: "Pasirinkite DelPro ir GVET įrašus." };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_link", { p_object_type: objectType, p_delpro_key: delproKey, p_gvet_id: gvetId });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

export async function unlinkCatalogRecord(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const linkId = String(formData.get("link_id") ?? "");
  if (!linkId) return { ok: false, error: "Nenurodytas susiejimas." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_unlink", { p_link_id: linkId });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

// Creates GVET diseases / products from unlinked DelPro records (keys as a JSON array).
export async function importCatalogRecords(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const objectType = String(formData.get("object_type") ?? "");
  let keys: string[] = [];
  try {
    keys = JSON.parse(String(formData.get("delpro_keys") ?? "[]"));
  } catch {
    keys = [];
  }
  if (!LINKABLE.includes(objectType) || !Array.isArray(keys) || keys.length === 0) {
    return { ok: false, error: "Nepasirinktas nė vienas įrašas." };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_import", {
    p_object_type: objectType as "Diagnosis" | "Drug" | "Treatment",
    p_delpro_keys: keys.map(String),
  });
  if (error) return { ok: false, error: error.message };
  if (data && data.created === 0 && data.skipped.length > 0) {
    return { ok: false, error: data.skipped.map((s) => `${s.name ?? s.key}: ${s.reason}`).join("; ") };
  }
  revalidatePath("/apskaita/produktai");
  return done(data?.message);
}

// 0039: applies exactly the rows the admin approved in the import preview (each with the fingerprint it was shown).
export async function applyCatalogImport(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  let items: { object_type: string; delpro_key: string; action: "create" | "link"; fingerprint: string }[] = [];
  try {
    items = JSON.parse(String(formData.get("items") ?? "[]"));
  } catch {
    items = [];
  }
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "Nepasirinktas nė vienas įrašas." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_import_apply", { p_items: items });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/apskaita/produktai");
  if (data && data.created + data.linked === 0 && data.skipped.length > 0) {
    return { ok: false, error: data.skipped.slice(0, 5).map((s) => `${s.name ?? s.key}: ${s.reason}`).join("; ") };
  }
  const skipped = data?.skipped.length ? ` ${data.skipped.slice(0, 3).map((s) => `${s.name ?? s.key}: ${s.reason}`).join("; ")}` : "";
  return done(`${data?.message ?? ""}${skipped}`);
}

export async function createPilotDrug(): Promise<DelproActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_create_pilot_drug");
  if (error) return { ok: false, error: error.message };
  revalidatePath("/apskaita/produktai");
  return done(data?.message);
}

export async function releaseSingleCatalogJob(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const jobId = String(formData.get("job_id") ?? "");
  if (!jobId) return { ok: false, error: "Nenurodyta užduotis." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_release_single_job", { p_job_id: jobId });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

export async function updateCatalogInboundMode(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const mode = String(formData.get("delpro_catalog_inbound_mode") ?? "") as CatalogInboundMode;
  if (!CATALOG_INBOUND_MODES.includes(mode)) return { ok: false, error: "Neteisingas režimas." };
  const supabase = await createClient();
  const { error } = await supabase.from("system_settings").update({ setting_value: mode }).eq("setting_key", "delpro_catalog_inbound_mode");
  if (error) return { ok: false, error: error.message };
  return done("Išsaugota.");
}

// --- GVET -> DelPro catalog writes (0037) ------------------------------------

export async function enqueueCatalogCreate(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const objectType = String(formData.get("object_type") ?? "");
  const gvetId = String(formData.get("gvet_id") ?? "");
  if (!LINKABLE.includes(objectType) || !gvetId) return { ok: false, error: "Neteisingi duomenys." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_enqueue_create", { p_object_type: objectType, p_gvet_id: gvetId });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

export async function createCatalogTestJob(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const op = String(formData.get("operation") ?? "");
  if (!(CATALOG_WRITE_OPERATIONS as readonly string[]).includes(op)) return { ok: false, error: "Neteisinga operacija." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_create_test_job", { p_operation_key: op });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

export async function markCatalogValidated(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const jobId = String(formData.get("job_id") ?? "");
  if (!jobId) return { ok: false, error: "Nenurodyta užduotis." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_mark_validated", { p_job_id: jobId });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

export async function unvalidateCatalogOperation(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const op = String(formData.get("operation") ?? "");
  if (!(CATALOG_WRITE_OPERATIONS as readonly string[]).includes(op)) return { ok: false, error: "Neteisinga operacija." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_unvalidate", { p_operation_key: op });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

export async function setCatalogWriteEnabled(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const enabled = formData.get("enabled") === "1";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_set_write_enabled", { p_enabled: enabled });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

export async function catalogJobAction(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const jobId = String(formData.get("job_id") ?? "");
  const action = String(formData.get("action") ?? "");
  if (!jobId || !(["cancel", "retry", "adopt", "resend"] as const).includes(action as never)) return { ok: false, error: "Neteisingi duomenys." };
  // adopt / resend decide a step whose earlier write has an unknown outcome (the database checks which steps qualify)
  const step = String(formData.get("step") ?? "").trim() || undefined;
  const key = String(formData.get("key") ?? "").trim() || undefined;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_catalog_job_action", {
    p_job_id: jobId,
    p_action: action as "cancel" | "retry" | "adopt" | "resend",
    p_step: step,
    p_key: key,
  });
  if (error) return { ok: false, error: error.message };
  return done(data?.message);
}

export async function updateCatalogOutboundMode(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const mode = String(formData.get("delpro_catalog_outbound_mode") ?? "") as CatalogOutboundMode;
  if (!CATALOG_OUTBOUND_MODES.includes(mode)) return { ok: false, error: "Neteisingas režimas." };
  const supabase = await createClient();
  const { error } = await supabase.from("system_settings").update({ setting_value: mode }).eq("setting_key", "delpro_catalog_outbound_mode");
  if (error) return { ok: false, error: error.message };
  return done("Išsaugota.");
}

// --- GVET treatment templates (0037) ----------------------------------------

// The form posts the whole template as JSON (`template`); every rule is in save_treatment_template().
export async function saveTreatmentTemplate(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  let template: Record<string, unknown>;
  try {
    template = JSON.parse(String(formData.get("template") ?? "{}"));
  } catch {
    return { ok: false, error: "Neteisingi duomenys." };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_treatment_template", { p_data: template });
  if (error) return { ok: false, error: error.message };
  return done("Šablonas išsaugotas.");
}

export async function deleteTreatmentTemplate(_prev: DelproActionResult | null, formData: FormData): Promise<DelproActionResult> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: "Nenurodytas šablonas." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_treatment_template", { p_id: id });
  if (error) return { ok: false, error: error.message };
  return done("Šablonas ištrintas.");
}

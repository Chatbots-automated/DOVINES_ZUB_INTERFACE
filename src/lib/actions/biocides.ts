"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";

export type ActionResult = { ok: true } | { ok: false; error: string };

// "Naujas biocido panaudojimas" (Priedas §2.8 biocidinių produktų žurnalas)
// — log entry + FEFO deduction in one transaction (create_biocide_usage, 0004).
export async function createBiocideUsage(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();

  const product_id = String(formData.get("product_id") ?? "").trim();
  if (!product_id) return { ok: false, error: "Pasirinkite produktą." };

  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;

  const { error } = await supabase.rpc("create_biocide_usage", {
    p_data: {
      product_id,
      use_date: field("use_date"),
      purpose: field("purpose"),
      work_scope: field("work_scope"),
      qty: field("qty"),
      unit: field("unit"),
      used_by_name: field("used_by_name"),
    },
  });

  if (error) {
    console.error("[biocidai] create_biocide_usage failed:", error);
    return { ok: false, error: error.message || "Nepavyko įrašyti biocido panaudojimo." };
  }

  revalidateUsageViews();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Biocidų planas (0057, farm's request — billed separately). Planned days are
// written off only when someone confirms them; each confirmed day goes into the
// journal on its own (planned) date, all selected days in one transaction.
// ---------------------------------------------------------------------------

export type PlanActionResult = { ok: true; message: string } | { ok: false; error: string };

export async function createBiocidePlan(_prev: PlanActionResult | null, formData: FormData): Promise<PlanActionResult> {
  const supabase = await createClient();
  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const { error } = await supabase.rpc("create_biocide_usage_plan", {
    p_data: {
      product_id: field("product_id"),
      qty_per_day: field("qty_per_day"),
      start_date: field("start_date"),
      end_date: field("end_date"),
      purpose: field("purpose"),
      work_scope: field("work_scope"),
      used_by_name: field("used_by_name"),
      notes: field("notes"),
    },
  });
  if (error) {
    console.error("[biocidai] create_biocide_usage_plan failed:", error);
    return { ok: false, error: error.message || "Nepavyko sukurti plano." };
  }
  revalidateUsageViews();
  return { ok: true, message: "Planas sukurtas." };
}

function parseItems(value: FormDataEntryValue | null): { id: string; qty?: number }[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.id === "string") : [];
  } catch {
    return [];
  }
}

/** One form, three buttons: confirm / skip (by `intent`). */
export async function decideBiocidePlannedUsages(_prev: PlanActionResult | null, formData: FormData): Promise<PlanActionResult> {
  const items = parseItems(formData.get("items"));
  if (items.length === 0) return { ok: false, error: "Pažymėkite bent vieną dieną." };
  const supabase = await createClient();

  if (formData.get("intent") === "skip") {
    const { data, error } = await supabase.rpc("skip_biocide_planned_usages", { p_ids: items.map((i) => i.id) });
    if (error) return { ok: false, error: error.message || "Nepavyko pažymėti." };
    revalidateUsageViews();
    return { ok: true, message: `Pažymėta kaip nenaudota: ${data ?? 0}.` };
  }

  const { data, error } = await supabase.rpc("confirm_biocide_planned_usages", { p_data: { items } });
  if (error) {
    console.error("[biocidai] confirm_biocide_planned_usages failed:", error);
    return { ok: false, error: error.message || "Nepavyko patvirtinti." };
  }
  revalidateUsageViews();
  return { ok: true, message: `Patvirtinta ir įrašyta į žurnalą: ${data ?? 0}.` };
}

export async function cancelBiocidePlan(_prev: PlanActionResult | null, formData: FormData): Promise<PlanActionResult> {
  const id = String(formData.get("plan_id") ?? "").trim();
  if (!id) return { ok: false, error: "Planas nenurodytas." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_biocide_usage_plan", { p_plan_id: id });
  if (error) return { ok: false, error: error.message || "Nepavyko atšaukti plano." };
  revalidateUsageViews();
  return { ok: true, message: `Planas atšauktas (atšaukta dienų: ${data ?? 0}).` };
}

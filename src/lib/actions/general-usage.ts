"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";

export type GeneralUsageActionResult = { ok: true; count?: number } | { ok: false; error: string };

// "Sunaudojimas be gyvulio" — medžiagos, priedai, nagų vonelė... All rows go
// to create_general_usage (0012) in one call, so a month-end count saves
// all-or-nothing (FEFO + stock shortfall roll the whole batch back).
export async function createGeneralUsage(
  _prev: GeneralUsageActionResult | null,
  formData: FormData,
): Promise<GeneralUsageActionResult> {
  let items: Record<string, unknown>[] = [];
  try {
    items = JSON.parse(String(formData.get("items") ?? "[]"));
  } catch {
    return { ok: false, error: "Neteisingi duomenys." };
  }
  if (items.length === 0) return { ok: false, error: "Įveskite bent vieno produkto kiekį arba likutį." };

  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_general_usage", {
    p_data: { use_date: field("use_date"), notes: field("notes"), items },
  });

  if (error) {
    console.error("[sunaudojimas] create_general_usage failed:", error);
    return { ok: false, error: error.message || "Nepavyko įrašyti sunaudojimo." };
  }

  revalidateUsageViews();
  return { ok: true, count: data ?? 0 };
}

// Deleting restores stock (usage_items cascade → fn_usage_items_restore_stock).
// The DB refuses if the usage is already on a nurašymo aktas.
export async function deleteGeneralUsage(
  _prev: GeneralUsageActionResult | null,
  formData: FormData,
): Promise<GeneralUsageActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, error: "Įrašas nerastas." };

  const supabase = await createClient();
  const { error } = await supabase.from("general_usage").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidateUsageViews();
  return { ok: true };
}

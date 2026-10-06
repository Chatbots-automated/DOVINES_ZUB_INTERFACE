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

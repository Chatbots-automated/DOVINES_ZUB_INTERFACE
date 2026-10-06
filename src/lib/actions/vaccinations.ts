"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";

export type ActionResult =
  { ok: true; count?: number } | { ok: false; error: string };

// "Nauja vakcinacija" (Priedas §2.6) — one animal or a whole group. A group
// vaccination is one row per animal sharing a session_id (withdrawal and
// stock stay per-animal); create_vaccinations() (0004) does it all in one
// transaction, dose_amount being the per-animal dose.
export async function createVaccination(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createClient();

  let animalIds: string[] = [];
  try {
    animalIds = JSON.parse(String(formData.get("animal_ids") ?? "[]"));
  } catch {
    animalIds = [];
  }
  const single = String(formData.get("animal_id") ?? "").trim();
  if (single) animalIds = [single];
  if (animalIds.length === 0)
    return { ok: false, error: "Pasirinkite gyvūną arba grupę." };

  const product_id = String(formData.get("product_id") ?? "").trim();
  if (!product_id) return { ok: false, error: "Pasirinkite vakciną." };

  const field = (name: string) =>
    String(formData.get(name) ?? "").trim() || null;

  // Opened from a visit card: link to the visit in the same transaction.
  const visit_id = field("visit_id");
  const payload = {
    animal_ids: animalIds,
    target_group_name: field("target_group_name"),
    product_id,
    vaccination_date: field("vaccination_date"),
    dose_amount: field("dose_amount"),
    unit: field("unit"),
    administration_route: field("administration_route"),
    is_revaccination: formData.get("is_revaccination") === "on",
    next_booster_date: field("next_booster_date"),
    vet_name: field("vet_name"),
    notes: field("notes"),
  };
  const { data, error } = visit_id
    ? await supabase.rpc("create_vaccination_for_visit", {
        p_visit_id: visit_id,
        p_data: payload,
      })
    : await supabase.rpc("create_vaccinations", { p_data: payload });

  if (error) {
    console.error("[vakcinacijos] create_vaccinations failed:", error);
    return {
      ok: false,
      error: error.message || "Nepavyko sukurti vakcinacijos įrašo.",
    };
  }

  revalidateUsageViews();
  return { ok: true, count: data ?? animalIds.length };
}

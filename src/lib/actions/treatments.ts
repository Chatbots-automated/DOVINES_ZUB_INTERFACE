"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";

export type ActionResult = { ok: true } | { ok: false; error: string };

function parseJsonArray(value: FormDataEntryValue | null): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// "Naujas gydymo įrašas" (Priedas §2.3/§2.4). The whole save — treatment,
// FEFO stock deduction for day 1, course plan for days 2..N — runs inside
// one Postgres transaction (create_treatment(), 0004), so a stock shortfall
// can never leave a half-saved treatment behind (or send one to DelPro).
export async function createTreatment(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const supabase = await createClient();

  const animal_id = String(formData.get("animal_id") ?? "").trim();
  if (!animal_id) return { ok: false, error: "Pasirinkite gyvūną." };

  const field = (name: string) =>
    String(formData.get(name) ?? "").trim() || null;

  // Opened from a visit card: same payload, but through the wrapper that links
  // the treatment to the visit (and advances its status) in one transaction.
  const visit_id = field("visit_id");
  const payload = {
    animal_id,
    disease_id: field("disease_id"),
    procedure_type: field("procedure_type") ?? "gydymas",
    reg_date: field("reg_date"),
    diagnosis: field("diagnosis"),
    outcome: field("outcome"),
    outcome_date: field("outcome_date"),
    vet_name: field("vet_name"),
    notes: field("notes"),
    medications: parseJsonArray(formData.get("medications")),
    course_days: parseJsonArray(formData.get("course_days")),
  };
  const { error } = visit_id
    ? await supabase.rpc("create_treatment_for_visit", {
        p_visit_id: visit_id,
        p_data: payload,
      })
    : await supabase.rpc("create_treatment", { p_data: payload });

  if (error) {
    console.error("[gydymai] create_treatment failed:", error);
    return {
      ok: false,
      error: error.message || "Nepavyko sukurti gydymo įrašo.",
    };
  }

  revalidateUsageViews();
  return { ok: true };
}

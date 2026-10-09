"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";

export type ActionResult = { ok: true } | { ok: false; error: string };

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim() || null;

// "Naujas sėklinimas" — create_insemination() (0017) writes the record and
// deducts semen + gloves FEFO in one transaction; a stock shortfall rolls the
// whole save back. pažymėjimo Nr. is generated there when left empty.
export async function createInsemination(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();

  const animal_id = field(formData, "animal_id");
  if (!animal_id) return { ok: false, error: "Pasirinkite gyvūną." };

  // Opened from a visit card (Vizitai / sinchronizacijos protokolo sėklinimo žingsnis): same
  // payload through the wrapper that links the record to the visit and closes it (0029).
  const visit_id = field(formData, "visit_id");
  const payload = {
      animal_id,
      insemination_date: field(formData, "insemination_date"),
      sperm_product_id: field(formData, "sperm_product_id"),
      sperm_quantity: field(formData, "sperm_quantity"),
      glove_product_id: field(formData, "glove_product_id"),
      glove_quantity: field(formData, "glove_quantity"),
      pazymejimo_nr: field(formData, "pazymejimo_nr"),
      seklintojo_kodas: field(formData, "seklintojo_kodas"),
      inseminator_name: field(formData, "inseminator_name"),
      imones_kodas: field(formData, "imones_kodas"),
      bull_name: field(formData, "bull_name"),
      reproduktoriaus_id: field(formData, "reproduktoriaus_id"),
      reproduktoriaus_kk_kodas: field(formData, "reproduktoriaus_kk_kodas"),
      sp_savininkas: field(formData, "sp_savininkas"),
      next_pregnancy_check_date: field(formData, "next_pregnancy_check_date"),
      notes: field(formData, "notes"),
  };
  const { error } = visit_id
    ? await supabase.rpc("create_insemination_for_visit", { p_visit_id: visit_id, p_data: payload })
    : await supabase.rpc("create_insemination", { p_data: payload });

  if (error) {
    console.error("[sekinimas] create_insemination failed:", error);
    return { ok: false, error: error.message || "Nepavyko sukurti sėklinimo įrašo." };
  }

  revalidateUsageViews();
  return { ok: true };
}

// Nėštumo patikra: result = "confirmed" | "not_confirmed" | "pending" (clear).
// Plain update — no stock involved.
export async function setPregnancyResult(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();

  const id = field(formData, "id");
  const result = field(formData, "result");
  if (!id || !result) return { ok: false, error: "Trūksta duomenų." };

  const confirmed = result === "confirmed" ? true : result === "not_confirmed" ? false : null;
  const { error } = await supabase
    .from("insemination_records")
    .update({
      pregnancy_confirmed: confirmed,
      pregnancy_check_date: confirmed === null ? null : field(formData, "check_date") ?? new Date().toISOString().slice(0, 10),
      pregnancy_notes: confirmed === null ? null : field(formData, "pregnancy_notes"),
    })
    .eq("id", id);

  if (error) {
    console.error("[sekinimas] pregnancy update failed:", error);
    return { ok: false, error: "Nepavyko atnaujinti nėštumo rezultato." };
  }

  revalidateUsageViews();
  return { ok: true };
}

// Deleting cascades to the record's usage_items; the stock-restore trigger
// puts semen/gloves back. Refused (guard trigger) once on a nurašymo aktas.
export async function deleteInsemination(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();

  const id = field(formData, "id");
  if (!id) return { ok: false, error: "Trūksta įrašo." };

  const { error } = await supabase.from("insemination_records").delete().eq("id", id);
  if (error) {
    console.error("[sekinimas] delete failed:", error);
    return { ok: false, error: error.message || "Nepavyko ištrinti įrašo." };
  }

  revalidateUsageViews();
  return { ok: true };
}

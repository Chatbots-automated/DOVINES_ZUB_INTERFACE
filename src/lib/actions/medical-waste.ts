"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

// Manual entry for the Veterinarinių medicininių atliekų žurnalas (Priedas
// §2.8): waste not tied to one depleted batch, or a hand-over to the waste
// handler (vežėjas / tvarkytojas + document number).
export async function createMedicalWaste(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const num = (name: string) => (field(name) ? Number(field(name)) : null);
  const name = field("name");
  if (!name) return { ok: false, error: "Įveskite atliekų pavadinimą." };

  const supabase = await createClient();
  const { error } = await supabase.from("medical_waste").insert({
    name,
    waste_code: field("waste_code"),
    waste_date: field("waste_date") ?? new Date().toISOString().slice(0, 10),
    qty_generated: num("qty_generated"),
    qty_transferred: num("qty_transferred"),
    transfer_date: field("transfer_date"),
    carrier: field("carrier"),
    processor: field("processor"),
    doc_no: field("doc_no"),
    responsible: field("responsible"),
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/apskaita/ataskaitos");
  return { ok: true };
}

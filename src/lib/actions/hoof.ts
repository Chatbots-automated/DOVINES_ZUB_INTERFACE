"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";

export type ActionResult = { ok: true } | { ok: false; error: string };

// "Nagų apžiūra" — one visit, several findings, products consumed FEFO, all
// in one transaction (create_hoof_exam, 0019): a stock shortfall rolls the
// whole visit back, and the usage reaches nurašymo aktai.
export async function createHoofExam(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const animal_id = String(formData.get("animal_id") ?? "").trim();
  if (!animal_id) return { ok: false, error: "Pasirinkite gyvūną." };

  let findings: unknown;
  try {
    findings = JSON.parse(String(formData.get("findings") ?? "[]"));
  } catch {
    findings = [];
  }
  if (!Array.isArray(findings) || findings.length === 0) return { ok: false, error: "Pridėkite bent vieną radinį." };

  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_hoof_exam", {
    p_data: { animal_id, exam_date: field("exam_date"), performed_by: field("performed_by"), notes: field("notes"), findings },
  });

  if (error) {
    console.error("[nagos] create_hoof_exam failed:", error);
    return { ok: false, error: error.message || "Nepavyko išsaugoti nagų apžiūros." };
  }

  revalidateUsageViews();
  return { ok: true };
}

// Deleting a visit returns its products to stock (usage_items cascade +
// restore trigger); refused once they sit on a nurašymo aktas.
export async function deleteHoofExam(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, error: "Įrašas nerastas." };

  const supabase = await createClient();
  const { error } = await supabase.from("hoof_exams").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidateUsageViews();
  return { ok: true };
}

export async function completeHoofFollowup(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, error: "Įrašas nerastas." };

  const supabase = await createClient();
  const { error } = await supabase.from("hoof_findings").update({ followup_completed: true }).eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidateUsageViews();
  return { ok: true };
}

"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";

export type MassActionResult = { ok: true; message: string } | { ok: false; error: string };

function parseJsonArray(value: FormDataEntryValue | null): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Masinis gydymas (0056, farm's request — not in Priedas Nr. 1, billed separately).
// create_mass_treatment() runs create_treatment_with_visits() once per animal in ONE
// transaction: a stock shortfall for any animal saves nothing. Every gydymas then has
// its own ordinary DelPro job, so the farm-PC worker needs no change.
export async function createMassTreatment(_prev: MassActionResult | null, formData: FormData): Promise<MassActionResult> {
  const supabase = await createClient();

  const animal_ids = parseJsonArray(formData.get("animal_ids")).filter((x): x is string => typeof x === "string" && x !== "");
  if (animal_ids.length === 0) return { ok: false, error: "Pasirinkite bent vieną gyvūną." };

  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const payload = {
    animal_ids,
    procedure_type: field("procedure_type") ?? "gydymas",
    disease_id: field("disease_id"),
    reg_date: field("reg_date"),
    diagnosis: field("diagnosis"),
    vet_name: field("vet_name"),
    notes: field("notes"),
    medications: parseJsonArray(formData.get("medications")),
  };

  const { data, error } = await supabase.rpc("create_mass_treatment", { p_data: payload });
  if (error) {
    console.error("[masinis-gydymas] create_mass_treatment failed:", error);
    return { ok: false, error: error.message || "Nepavyko išsaugoti masinio gydymo." };
  }

  revalidateUsageViews();
  const count = data?.count ?? animal_ids.length;
  return {
    ok: true,
    message:
      payload.procedure_type === "gydymas"
        ? `Išsaugota gyvūnų: ${count}. Kiekvienas gydymas įtrauktas į DelPro eilę.`
        : `Išsaugota gyvūnų: ${count}.`,
  };
}

// "Siųsti į DelPro" for every waiting job of one mass treatment. Same per-job
// rules as the DelPro queue (delpro_approve_jobs: validation, 0045 admin gate,
// frozen payload). Approved = released to the worker, not yet written in DelPro.
export async function approveMassTreatment(_prev: MassActionResult | null, formData: FormData): Promise<MassActionResult> {
  const id = String(formData.get("mass_treatment_id") ?? "").trim();
  if (!id) return { ok: false, error: "Masinis gydymas nenurodytas." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_approve_mass_treatment", { p_mass_treatment_id: id });
  if (error) {
    console.error("[masinis-gydymas] delpro_approve_mass_treatment failed:", error);
    return { ok: false, error: error.message || "Nepavyko išsiųsti į DelPro." };
  }

  revalidateUsageViews();
  const waiting = data?.waiting ?? 0;
  const approved = data?.approved ?? 0;
  if (waiting === 0) return { ok: true, message: "Nėra laukiančių siuntimo." };
  const skipped = waiting - approved;
  return {
    ok: true,
    message:
      skipped > 0
        ? `Išsiųsta: ${approved}. Praleista: ${skipped} (priežastys — Gydymų istorijoje / DelPro eilėje).`
        : `Išsiųsta į DelPro eilę: ${approved}.`,
  };
}

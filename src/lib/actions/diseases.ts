"use server";

import { createClient } from "@/lib/supabase/server";

export type CreatedDisease = { id: string; name: string };
export type DiseaseActionResult = { ok: true; disease: CreatedDisease } | { ok: false; error: string };

export async function createDisease(_prev: DiseaseActionResult | null, formData: FormData): Promise<DiseaseActionResult> {
  const supabase = await createClient();

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Įveskite ligos pavadinimą." };
  const code = String(formData.get("code") ?? "").trim() || null;

  const { data, error } = await supabase.from("diseases").insert({ name, code }).select("id, name").single();

  if (error || !data) {
    if (error?.code === "23505") {
      return { ok: false, error: `Liga „${name}“ jau egzistuoja.` };
    }
    return { ok: false, error: error?.message ?? "Nepavyko sukurti ligos įrašo." };
  }

  return { ok: true, disease: data };
}

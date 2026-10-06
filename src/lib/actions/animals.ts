"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { OTHER_OPTION } from "@/lib/animal-options";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function createAnimal(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();

  const tag_no = String(formData.get("tag_no") ?? "").trim();
  if (!tag_no) return { ok: false, error: "Įveskite ausies įsagą (ženklo numerį)." };

  const animal_no = String(formData.get("animal_no") ?? "").trim() || null;
  // Rūšis / lytis are dropdowns; "Kita" reveals a free-text field (species_other / sex_other).
  const speciesChoice = String(formData.get("species") ?? "").trim();
  const species =
    (speciesChoice === OTHER_OPTION ? String(formData.get("species_other") ?? "").trim().toLowerCase() : speciesChoice.toLowerCase()) || "galvijas";
  const sexChoice = String(formData.get("sex") ?? "").trim();
  const sex = (sexChoice === OTHER_OPTION ? String(formData.get("sex_other") ?? "").trim() : sexChoice) || null;
  const breed = String(formData.get("breed") ?? "").trim() || null;
  const birth_date = String(formData.get("birth_date") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  // Manual entry is for animals DelPro doesn't know yet; the next DelPro
  // sync adopts the row by tag_no (upsert_animals_from_delpro, 0006).
  const { error } = await supabase.from("animals").insert({
    tag_no,
    animal_no,
    species,
    sex,
    breed,
    birth_date,
    notes,
    source: "manual",
  });

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: `Gyvūnas su numeriu "${tag_no}" jau egzistuoja.` };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/veterinarija/gyvunai");
  return { ok: true };
}

export async function updateAnimalNotes(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, error: "Nenurodytas gyvūnas." };
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const supabase = await createClient();
  const { error } = await supabase.from("animals").update({ notes }).eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/veterinarija/gyvunai");
  revalidatePath(`/veterinarija/gyvunai/${id}`);
  return { ok: true };
}

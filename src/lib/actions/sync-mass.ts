"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";

export type SyncMassResult = { ok: true; message: string } | { ok: false; error: string };

function parseIds(value: FormDataEntryValue | null): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && x !== "") : [];
  } catch {
    return [];
  }
}

// Sinchronizacijos tab (0059, farm's request — billed with Sinchronizacijos protokolai).
// apply_sync_protocol_mass() = apply_sync_protocol() per animal in ONE transaction;
// no stock is used until a step is recorded.
export async function applySyncProtocolMass(_prev: SyncMassResult | null, formData: FormData): Promise<SyncMassResult> {
  const animal_ids = parseIds(formData.get("animal_ids"));
  if (animal_ids.length === 0) return { ok: false, error: "Pasirinkite bent vieną gyvūną." };
  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;
  const protocol_id = field("sync_protocol_id");
  if (!protocol_id) return { ok: false, error: "Pasirinkite sinchronizacijos protokolą." };
  const start_date = field("start_date");
  if (!start_date) return { ok: false, error: "Įveskite pradžios datą." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("apply_sync_protocol_mass", {
    p_data: { protocol_id, animal_ids, start_date, start_time: field("start_time") ?? "09:00", vet_name: field("vet_name"), notes: field("notes") },
  });
  if (error) {
    console.error("[sinchronizacijos] apply_sync_protocol_mass failed:", error);
    return { ok: false, error: error.message || "Nepavyko pritaikyti protokolo." };
  }
  revalidateUsageViews();
  return { ok: true, message: `Protokolas pritaikytas gyvūnų: ${data?.animals ?? animal_ids.length}. Suplanuota vizitų: ${data?.visits ?? 0}.` };
}

// Records many due steps at once (complete_sync_steps): planned medicine → a
// 'sinchronizacija' treatment per animal (FEFO, karencija), all or nothing.
export async function completeSyncSteps(_prev: SyncMassResult | null, formData: FormData): Promise<SyncMassResult> {
  const visit_ids = parseIds(formData.get("visit_ids"));
  if (visit_ids.length === 0) return { ok: false, error: "Pasirinkite bent vieną žingsnį." };
  const vet_name = String(formData.get("vet_name") ?? "").trim() || null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("complete_sync_steps", { p_data: { visit_ids, vet_name } });
  if (error) {
    console.error("[sinchronizacijos] complete_sync_steps failed:", error);
    return { ok: false, error: error.message || "Nepavyko įrašyti žingsnių." };
  }
  revalidateUsageViews();
  const treatments = data?.treatments ?? 0;
  return {
    ok: true,
    message: `Įrašyta žingsnių: ${data?.steps ?? visit_ids.length}${treatments > 0 ? ` (su vaistais: ${treatments}, nurašyta iš atsargų)` : ""}.`,
  };
}

export async function cancelSyncApplications(_prev: SyncMassResult | null, formData: FormData): Promise<SyncMassResult> {
  const ids = parseIds(formData.get("application_ids"));
  if (ids.length === 0) return { ok: false, error: "Pasirinkite bent vieną protokolą." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_sync_applications", { p_ids: ids });
  if (error) {
    console.error("[sinchronizacijos] cancel_sync_applications failed:", error);
    return { ok: false, error: error.message || "Nepavyko nutraukti protokolų." };
  }
  revalidateUsageViews();
  return { ok: true, message: `Nutraukta protokolų: ${ids.length}, atšaukta žingsnių: ${data ?? 0}.` };
}

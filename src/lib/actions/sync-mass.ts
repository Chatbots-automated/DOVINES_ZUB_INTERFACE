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

// 0066 — change planned steps after applying: date / time (optionally moving the animal's later
// steps by the same number of days), planned medicine, title. Recorded steps are never touched.
export async function editSyncSteps(_prev: SyncMassResult | null, formData: FormData): Promise<SyncMassResult> {
  const visit_ids = parseIds(formData.get("visit_ids"));
  if (visit_ids.length === 0) return { ok: false, error: "Pažymėkite bent vieną gyvūną." };
  const field = (name: string) => String(formData.get(name) ?? "").trim();
  let medications: unknown = undefined;
  if (formData.get("medications") !== null) {
    try {
      medications = JSON.parse(String(formData.get("medications")));
    } catch {
      return { ok: false, error: "Netinkami vaistų duomenys." };
    }
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("edit_sync_steps", {
    p_data: {
      visit_ids,
      date: field("date") || null,
      time: field("time") || null,
      shift_following: formData.get("shift_following") === "1",
      title: field("title") || null,
      ...(medications !== undefined ? { medications } : {}),
    },
  });
  if (error) {
    console.error("[sinchronizacijos] edit_sync_steps failed:", error);
    return { ok: false, error: error.message || "Nepavyko išsaugoti pakeitimų." };
  }
  revalidateUsageViews();
  const moved = data?.moved_following ?? 0;
  return { ok: true, message: `Pakeista žingsnių: ${data?.steps ?? visit_ids.length}${moved > 0 ? `, kartu perkelta vėlesnių: ${moved}` : ""}.` };
}

export async function skipSyncSteps(_prev: SyncMassResult | null, formData: FormData): Promise<SyncMassResult> {
  const ids = parseIds(formData.get("visit_ids"));
  if (ids.length === 0) return { ok: false, error: "Pažymėkite bent vieną gyvūną." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("skip_sync_steps", { p_visit_ids: ids });
  if (error) {
    console.error("[sinchronizacijos] skip_sync_steps failed:", error);
    return { ok: false, error: error.message || "Nepavyko praleisti žingsnių." };
  }
  revalidateUsageViews();
  return { ok: true, message: `Žingsnis praleistas gyvūnų: ${data ?? ids.length}. Kiti jų žingsniai liko.` };
}

export async function addSyncAnimals(_prev: SyncMassResult | null, formData: FormData): Promise<SyncMassResult> {
  const animal_ids = parseIds(formData.get("animal_ids"));
  if (animal_ids.length === 0) return { ok: false, error: "Pasirinkite bent vieną gyvūną." };
  const mass_application_id = String(formData.get("mass_application_id") ?? "");
  const start_date = String(formData.get("start_date") ?? "").trim() || null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_sync_animals", { p_data: { mass_application_id, animal_ids, start_date } });
  if (error) {
    console.error("[sinchronizacijos] add_sync_animals failed:", error);
    return { ok: false, error: error.message || "Nepavyko pridėti gyvūnų." };
  }
  revalidateUsageViews();
  return { ok: true, message: `Pridėta gyvūnų: ${data?.animals ?? animal_ids.length}. Suplanuota vizitų: ${data?.visits ?? 0}.` };
}

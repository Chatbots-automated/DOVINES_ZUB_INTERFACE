"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";

export type ActionResult = { ok: true; /** Set by saveSyncProtocol — lets the picker select the protocol just saved. */ id?: string } | { ok: false; error: string };

// "Sinchronizacijos protokolai" (0025) — the farm's own templates, created and
// edited from the protocol picker in Naujas vizitas / the animal panel. The whole
// protocol (header + every step + medicine lines) is saved by one RPC, so a
// validation error can never leave a protocol half-written.
export async function saveSyncProtocol(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();
  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;

  let steps: unknown = [];
  try {
    steps = JSON.parse(String(formData.get("steps") ?? "[]"));
  } catch {
    steps = [];
  }

  const { data, error } = await supabase.rpc("save_sync_protocol", {
    p_data: {
      id: field("id"),
      name: field("name"),
      description: field("description"),
      steps,
    },
  });

  if (error) {
    console.error("[sinchronizacijos] save_sync_protocol failed:", error);
    return { ok: false, error: error.message || "Nepavyko išsaugoti protokolo." };
  }

  revalidateUsageViews();
  return { ok: true, id: data };
}

// Visits already generated from the protocol keep their own copy of the steps.
export async function deleteSyncProtocol(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { ok: false, error: "Protokolas nerastas." };

  const supabase = await createClient();
  const { error } = await supabase.from("sync_protocols").delete().eq("id", id);
  if (error) {
    console.error("[sinchronizacijos] delete failed:", error);
    return { ok: false, error: "Nepavyko pašalinti protokolo." };
  }

  revalidateUsageViews();
  return { ok: true };
}

// Stops a running protocol: its still-open step visits become "Atšauktas".
export async function cancelSyncApplication(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const id = String(formData.get("application_id") ?? "").trim();
  if (!id) return { ok: false, error: "Netinkama užklausa." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_sync_application", { p_application_id: id });
  if (error) {
    console.error("[sinchronizacijos] cancel failed:", error);
    return { ok: false, error: error.message || "Nepavyko nutraukti protokolo." };
  }

  revalidateUsageViews();
  return { ok: true };
}

// Applies a protocol to one animal: one planned visit per step (apply_sync_protocol,
// 0025). Reads the same fields as the Naujas vizitas form — animal_id, visit_date
// (protocol day 0), visit_time, vet_name, sync_protocol_id — so both the visit
// dialog and the animal panel's "Sinchronizacija" button use it. No stock is
// touched; medicine is consumed later, when each step is recorded.
export async function applySyncProtocol(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;

  const animal_id = field("animal_id");
  if (!animal_id) return { ok: false, error: "Pasirinkite gyvūną." };
  const protocol_id = field("sync_protocol_id");
  if (!protocol_id) return { ok: false, error: "Pasirinkite sinchronizacijos protokolą." };
  const start_date = field("visit_date");
  if (!start_date) return { ok: false, error: "Įveskite pradžios datą." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("apply_sync_protocol", {
    p_protocol_id: protocol_id,
    p_animal_id: animal_id,
    p_start_date: start_date,
    p_start_time: field("visit_time") ?? "09:00",
    p_vet_name: field("vet_name"),
  });
  if (error) {
    console.error("[sinchronizacijos] apply_sync_protocol failed:", error);
    return { ok: false, error: error.message || "Nepavyko pritaikyti protokolo." };
  }

  revalidateUsageViews();
  return { ok: true };
}

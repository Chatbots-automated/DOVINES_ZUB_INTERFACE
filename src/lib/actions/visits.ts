"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";
import { applySyncProtocol } from "@/lib/actions/sync-protocols";
import type { VisitStatus } from "@/lib/supabase/types";

export type ActionResult = { ok: true } | { ok: false; error: string };

const STATUSES: VisitStatus[] = ["planuojamas", "vykdomas", "baigtas", "atsauktas", "neivykes"];

// "Naujas vizitas" — schedules a check on an animal without implying that
// medicine is (or will be) given. create_visit() (0018) also inserts the
// follow-up visit in the same transaction. The clinical records are created
// later, from the visit card, through create_treatment_for_visit() /
// create_vaccination_for_visit() (via the normal treatment / vaccination
// dialogs) — stock is consumed there, never here.
export async function createVisit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();
  const field = (name: string) => String(formData.get(name) ?? "").trim() || null;

  const animal_id = field("animal_id");
  if (!animal_id) return { ok: false, error: "Pasirinkite gyvūną." };
  const visit_date = field("visit_date");
  if (!visit_date) return { ok: false, error: "Įveskite datą." };
  const visit_time = field("visit_time") ?? "09:00";

  let procedures: unknown = [];
  try {
    procedures = JSON.parse(String(formData.get("procedures") ?? "[]"));
  } catch {
    procedures = [];
  }
  if (!Array.isArray(procedures) || procedures.length === 0) return { ok: false, error: "Pasirinkite bent vieną procedūrą." };

  // "Sinchronizacija" applies a protocol (0025): one planned visit per protocol
  // step, starting on the chosen date. It is not combined with other procedures.
  if (procedures.includes("sinchronizacija")) {
    if (procedures.length > 1) return { ok: false, error: "Sinchronizacijos negalima derinti su kitomis procedūromis." };
    return applySyncProtocol(null, formData);
  }

  const status = field("status") ?? "planuojamas";
  if (!STATUSES.includes(status as VisitStatus)) return { ok: false, error: "Netinkama būsena." };
  const next_visit_required = formData.get("next_visit_required") === "on";
  if (next_visit_required && !field("next_visit_date")) return { ok: false, error: "Nurodykite kito vizito datą." };

  const { error } = await supabase.rpc("create_visit", {
    p_data: {
      animal_id,
      // Wall-clock time in the farm's timezone, with its UTC offset for that date.
      visit_datetime: `${visit_date}T${visit_time}:00${vilniusOffset(visit_date)}`,
      procedures,
      status,
      temperature: field("temperature"),
      vet_name: field("vet_name"),
      notes: field("notes"),
      next_visit_required,
      next_visit_date: next_visit_required ? field("next_visit_date") : null,
    },
  });

  if (error) {
    console.error("[vizitai] create_visit failed:", error);
    return { ok: false, error: error.message || "Nepavyko sukurti vizito." };
  }

  revalidateUsageViews();
  return { ok: true };
}

// UTC offset of Europe/Vilnius on a given date, as "+02:00" / "+03:00".
function vilniusOffset(day: string): string {
  const probe = new Date(`${day}T12:00:00Z`);
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Vilnius", timeZoneName: "shortOffset" })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")?.value; // e.g. "GMT+3"
  const hours = Number(part?.replace("GMT", "") || 2);
  const sign = hours < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(hours)).padStart(2, "0")}:00`;
}

export async function updateVisitStatus(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();
  const id = String(formData.get("visit_id") ?? "");
  const status = String(formData.get("status") ?? "") as VisitStatus;
  if (!id || !STATUSES.includes(status)) return { ok: false, error: "Netinkama užklausa." };

  const { error } = await supabase.from("animal_visits").update({ status }).eq("id", id);
  if (error) {
    console.error("[vizitai] status update failed:", error);
    return { ok: false, error: "Nepavyko atnaujinti vizito būsenos." };
  }
  revalidateUsageViews();
  return { ok: true };
}

// Deleting a visit never deletes its treatments / vaccinations (visit_id is
// set null) — those are legal journal records with stock behind them.
export async function deleteVisit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();
  const id = String(formData.get("visit_id") ?? "");
  if (!id) return { ok: false, error: "Netinkama užklausa." };

  const { error } = await supabase.from("animal_visits").delete().eq("id", id);
  if (error) {
    console.error("[vizitai] delete failed:", error);
    return { ok: false, error: "Nepavyko pašalinti vizito." };
  }
  revalidateUsageViews();
  return { ok: true };
}

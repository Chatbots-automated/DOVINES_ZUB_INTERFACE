import type { DelproSyncJobStatus, DelproTransferProblem } from "@/lib/supabase/types";

// One vocabulary for a treatment's DelPro transfer, used by the treatment card,
// the confirmation dialog and the /veterinarija/delpro queue. "Approved" is
// NOT "done": only the farm-PC worker's verified read-back sets `success`.
// A treatment with no job yet (or a pending one) is waiting to be sent (0044: auto mode — saving queues it).

export type DelproStatusTone = "neutral" | "info" | "success" | "danger" | "warning";

export const DELPRO_STATUS_LABEL: Record<DelproSyncJobStatus, string> = {
  pending_approval: "Laukia siuntimo",
  approved: "Laukia perdavimo",
  processing: "Perduodama į DelPro",
  success: "Perduota į DelPro",
  error: "Perdavimo klaida",
  verification_failed: "Nepavyko patvirtinti įrašo",
  rejected: "Atmesta",
};

export const DELPRO_STATUS_TONE: Record<DelproSyncJobStatus, DelproStatusTone> = {
  pending_approval: "warning",
  approved: "info",
  processing: "info",
  success: "success",
  error: "danger",
  verification_failed: "danger",
  rejected: "neutral",
};

export function delproStatusLabel(status: DelproSyncJobStatus | null | undefined): string {
  return DELPRO_STATUS_LABEL[status ?? "pending_approval"];
}

export function delproStatusTone(status: DelproSyncJobStatus | null | undefined): DelproStatusTone {
  return DELPRO_STATUS_TONE[status ?? "pending_approval"];
}

/** Statuses from which a person may still release the treatment to the worker. */
export const DELPRO_CONFIRMABLE: ReadonlyArray<DelproSyncJobStatus | null> = [null, "pending_approval"];

const PROBLEM_SHORT: Record<string, string> = {
  animal_number: "Nėra DelPro nr.",
  diagnosis_missing: "Nėra diagnozės",
  diagnosis_name_invalid: "Netinkamas diagnozės pavadinimas",
  no_medicine: "Nėra vaisto",
  multi_medicine: "Keli vaistai",
  medicine_name_invalid: "Netinkamas vaisto pavadinimas",
  dose_missing: "Nėra dozės",
  course_variants: "Kurso dozės skiriasi",
  course_days: "Netinkama kurso trukmė",
  integration_off: "Perdavimas išjungtas",
  not_gydymas: "Ne gydymas",
  treatment_missing: "Gydymas nerastas",
  // Gateway channel (0037)
  animal_guid: "Nėra DelPro ObjectGuid",
  diagnosis_link: "Diagnozė nesusieta su DelPro",
};

/** Short label for a blocking problem (the database message is the fallback). */
export function problemLabel(p: DelproTransferProblem): string {
  return PROBLEM_SHORT[p.code] ?? p.message;
}

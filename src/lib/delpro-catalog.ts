import type {
  DelproCatalogIssueAction,
  DelproCatalogIssueType,
  DelproCatalogJobStatus,
  DelproCatalogObjectType,
  DelproTemplateUsageValue,
} from "@/lib/supabase/types";

// Labels for the DelPro catalog sync section (0036). The allowed actions per
// issue type mirror delpro_catalog_resolve_issue() — the database enforces them.

export const CATALOG_OBJECT_LABEL: Record<DelproCatalogObjectType, string> = {
  Diagnosis: "Diagnozės",
  Drug: "Vaistai",
  DrugParameters: "Vaistų parametrai",
  Treatment: "Gydymo šablonai",
  TreatmentDrugUsage: "Šablonų vaistai",
};

export const CATALOG_ISSUE_LABEL: Record<DelproCatalogIssueType, string> = {
  suggested_match: "Pasiūlomas susiejimas",
  ambiguous_match: "Neaiškus atitikmuo",
  field_difference: "Skiriasi reikšmės",
  inbound_change: "Pakeista DelPro",
  outbound_pending: "Laukia siuntimo į DelPro",
  conflict: "Konfliktas",
  removed_in_delpro: "Pašalinta iš DelPro",
  broken_reference: "Trūksta susijusio įrašo",
  clinical_review: "Patikrinkite karenciją",
};

export const CATALOG_ISSUE_TONE: Record<DelproCatalogIssueType, "neutral" | "info" | "warning" | "danger" | "accent"> = {
  suggested_match: "info",
  ambiguous_match: "warning",
  field_difference: "warning",
  inbound_change: "info",
  outbound_pending: "accent",
  conflict: "danger",
  removed_in_delpro: "danger",
  broken_reference: "danger",
  clinical_review: "warning",
};

/** Issue types counted as "Klaidos / konfliktai" on the summary. */
export const CATALOG_PROBLEM_TYPES: DelproCatalogIssueType[] = ["conflict", "removed_in_delpro", "broken_reference"];

export const CATALOG_ISSUE_ACTIONS: Record<DelproCatalogIssueType, DelproCatalogIssueAction[]> = {
  suggested_match: ["confirm", "dismiss"],
  ambiguous_match: ["dismiss"],
  field_difference: ["take_delpro", "keep_gvet", "dismiss"],
  inbound_change: ["take_delpro", "keep_gvet", "dismiss"],
  conflict: ["take_delpro", "keep_gvet", "dismiss"],
  outbound_pending: ["send", "take_delpro", "dismiss"],
  removed_in_delpro: ["unlink", "dismiss"],
  broken_reference: ["dismiss"],
  clinical_review: ["reviewed"],
};

export const CATALOG_ACTION_LABEL: Record<DelproCatalogIssueAction, string> = {
  confirm: "Susieti",
  take_delpro: "Imti iš DelPro",
  keep_gvet: "Palikti GVET",
  send: "Siųsti į DelPro",
  unlink: "Atsieti",
  reviewed: "Patikrinta",
  dismiss: "Atmesti",
};

/** Actions that change GVET data or a link get a confirmation prompt. */
export const CATALOG_ACTION_CONFIRM: Partial<Record<DelproCatalogIssueAction, string>> = {
  take_delpro: "GVET įrašas bus pakeistas DelPro reikšmėmis. Tęsti?",
  unlink: "Panaikinti susiejimą? (Istorija išsaugoma.)",
};

export const CATALOG_FIELD_LABEL: Record<string, string> = {
  name: "Pavadinimas",
  active_substance: "Veiklioji medžiaga",
  active: "Aktyvus",
  uom: "Mat. vnt.",
  milk_days: "Karencija pienui, d.",
  meat_days: "Karencija mėsai, d.",
  recommended_treatment: "Rekomenduojamas gydymas",
  treatment_type: "Gydymo tipas",
  usages: "Vaistai (dozė × kartai × d.)",
};

/** Withdrawal days / units: never applied automatically (clinical data). */
export const CATALOG_CLINICAL_FIELDS = new Set(["uom", "milk_days", "meat_days", "usages"]);

export const CATALOG_INBOUND_MODES = ["review", "auto"] as const;
export type CatalogInboundMode = (typeof CATALOG_INBOUND_MODES)[number];

export function catalogValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (v === true) return "Taip";
  if (v === false) return "Ne";
  return String(v);
}

export const CATALOG_OUTBOUND_MODES = ["manual", "auto"] as const;
export type CatalogOutboundMode = (typeof CATALOG_OUTBOUND_MODES)[number];

/** Operations a test job can validate (mirrors delpro_catalog_create_test_job). */
export const CATALOG_WRITE_OPERATIONS = [
  "Diagnosis.create",
  "Diagnosis.update",
  "Drug.create",
  "Drug.update",
  "Treatment.create",
  "Treatment.update",
] as const;

export const CATALOG_JOB_STATUS_LABEL: Record<DelproCatalogJobStatus, string> = {
  queued: "Laukia",
  processing: "Vykdoma",
  success: "Įrašyta ir patikrinta",
  failed: "Nepavyko",
  verification_failed: "DelPro įrašas nesutampa",
  needs_review: "Reikia patikrinti ranka",
  cancelled: "Atšaukta",
};

export const CATALOG_JOB_STATUS_TONE: Record<DelproCatalogJobStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  queued: "info",
  processing: "info",
  success: "success",
  failed: "danger",
  verification_failed: "danger",
  needs_review: "warning",
  cancelled: "neutral",
};

/** "Penicilinas 20 ml × 1 × 3 d. (pienas 4 d., mėsa 10 d.)" per template line; drug codes resolved via `drugNames`. */
export function formatUsages(value: unknown, drugNames: Record<string, string> = {}): string[] {
  if (!Array.isArray(value)) return [catalogValue(value)];
  return (value as DelproTemplateUsageValue[]).map((u) => {
    const drug = u.drug?.startsWith("gvet:") ? "nesusietas vaistas" : (drugNames[u.drug] ?? `Drug ${u.drug}`);
    return `${drug} ${catalogValue(u.dosage)} ${u.uom ?? ""} × ${catalogValue(u.frequency)} × ${catalogValue(u.treat_cow_days)} d. (pienas ${catalogValue(u.milk_days)} d., mėsa ${catalogValue(u.meat_days)} d.)`;
  });
}

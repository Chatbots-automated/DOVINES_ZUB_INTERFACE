// DelPro daily Excel reports (0042) — display helpers shared by the animal card
// and the DelPro admin screen. Field keys and labels come from the database
// (delpro_report_fields), so a new report column needs nothing here.
import type { Database, DelproReportValue } from "@/lib/supabase/types";

type Tables = Database["public"]["Tables"];
export type ReportState = Tables["delpro_report_animal_state"]["Row"];
export type ReportRow = Tables["delpro_report_rows"]["Row"];
export type ReportField = Tables["delpro_report_fields"]["Row"];
export type ReportImport = Tables["delpro_report_imports"]["Row"];
export type ReportReview = Tables["delpro_report_reviews"]["Row"];
export type ReportFailure = Tables["delpro_report_failures"]["Row"];
export type ReportToken = Tables["delpro_report_upload_tokens"]["Row"];

/** Keys with their own place on the card; every other visible field is listed generically. */
export const REPORT_HEADLINE_KEYS = [
  "orn",
  "health_event_date",
  "animal_type",
  "birth_date",
  "latest_diagnosis",
  "latest_medicines",
  "milk_withdrawal_until",
  "meat_withdrawal_until",
  "latest_comment",
] as const;

const dateFmt = new Intl.DateTimeFormat("lt-LT", { dateStyle: "medium", timeZone: "Europe/Vilnius" });
const dateTimeFmt = new Intl.DateTimeFormat("lt-LT", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Vilnius" });

/** A stored report value as text: dates / times in Vilnius time, numbers in lt-LT. */
export function formatReportValue(v: DelproReportValue | null | undefined): string | null {
  if (!v || v.type === "empty" || v.value === null || v.value === "") return null;
  switch (v.type) {
    case "date":
      return dateFmt.format(new Date(`${String(v.value).slice(0, 10)}T12:00:00Z`));
    case "timestamp":
      return dateTimeFmt.format(new Date(String(v.value)));
    case "number":
      return new Intl.NumberFormat("lt-LT", { maximumFractionDigits: 3 }).format(Number(v.value));
    case "boolean":
      return v.value ? "Taip" : "Ne";
    default:
      return String(v.value);
  }
}

/**
 * A value is CURRENT when it came from the animal's newest report. A value from
 * an older report is kept (the column disappeared from newer reports) but is
 * shown as historical.
 */
export function isCurrent(v: DelproReportValue | undefined, state: Pick<ReportState, "latest_report_at">): boolean {
  return !!v?.report_at && new Date(v.report_at).getTime() >= new Date(state.latest_report_at).getTime();
}

/** Whole days until a report deadline (negative = passed); null when there is none. */
export function daysLeft(v: DelproReportValue | undefined, now = Date.now()): number | null {
  if (!v || v.type === "empty" || v.value === null) return null;
  const t = v.type === "date" ? new Date(`${String(v.value).slice(0, 10)}T23:59:59`).getTime() : new Date(String(v.value)).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now) / 86_400_000);
}

export const REPORT_OUTCOME_LABEL: Record<ReportRow["outcome"], string> = {
  created: "Sukurtas gyvūnas",
  updated: "Atnaujinta",
  unchanged: "Be pakeitimų",
  stale: "Senesnė ataskaita — tik istorijai",
  conflict: "Konfliktas",
  duplicate: "Pasikartojanti eilutė",
  invalid: "Netinkamas ORN",
};

export const REPORT_REVIEW_LABEL: Record<ReportReview["kind"], string> = {
  ambiguous_animal: "Keli GVET gyvūnai su tuo pačiu ORN",
  birth_date_conflict: "Nesutampa gimimo data",
  duplicate_orn_row: "Tas pats ORN kelis kartus su skirtingais duomenimis",
  invalid_orn: "Netinkamas ORN",
};

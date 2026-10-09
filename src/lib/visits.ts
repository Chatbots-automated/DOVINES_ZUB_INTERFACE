import type { ProcedureType, VisitProcedure, VisitStatus } from "@/lib/supabase/types";

// Vizitai (0018_visits.sql). "Sinchronizacija" (0025) is a protocol, not a
// single check: picking it in "Naujas vizitas" applies a sync protocol, which
// creates one such visit per protocol step. Nagos have their own screen.
export const VISIT_PROCEDURE_OPTIONS: { value: VisitProcedure; label: string }[] = [
  { value: "apziura", label: "Apžiūra" },
  { value: "temperatura", label: "Temperatūra" },
  { value: "gydymas", label: "Gydymas" },
  { value: "profilaktika", label: "Profilaktika" },
  { value: "vakcina", label: "Vakcina" },
  { value: "sinchronizacija", label: "Sinchronizacija" },
  { value: "sekinimas", label: "Sėklinimas" },
  { value: "kita", label: "Kita" },
];

export const VISIT_PROCEDURE_LABELS = Object.fromEntries(VISIT_PROCEDURE_OPTIONS.map((p) => [p.value, p.label])) as Record<VisitProcedure, string>;

/** treatments.procedure_type — what a linked treatment record is called. */
export const TREATMENT_TYPE_LABELS: Record<ProcedureType, string> = {
  apziura: "Apžiūra",
  gydymas: "Gydymas",
  profilaktika: "Profilaktika",
  sinchronizacija: "Sinchronizacija",
};

export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  planuojamas: "Planuojamas",
  vykdomas: "Vykdomas",
  baigtas: "Baigtas",
  atsauktas: "Atšauktas",
  neivykes: "Neįvykęs",
};

export const VISIT_STATUS_TONE: Record<VisitStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  planuojamas: "info",
  vykdomas: "warning",
  baigtas: "success",
  atsauktas: "neutral",
  neivykes: "danger",
};

export const OPEN_VISIT_STATUSES: VisitStatus[] = ["planuojamas", "vykdomas"];

const VILNIUS_DAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vilnius" });

/** YYYY-MM-DD of an instant in the farm's timezone (server and browser agree). */
export function vilniusDay(value: string | Date): string {
  return VILNIUS_DAY.format(typeof value === "string" ? new Date(value) : value);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

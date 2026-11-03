// Sėklinimas helpers shared by the page, the table and the animal card.

/** Cattle gestation, days (insemination date + 283 = numatomas apsiveršiavimas). */
export const GESTATION_DAYS = 283;

export function expectedCalvingDate(inseminationDate: string): string {
  const d = new Date(`${inseminationDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + GESTATION_DAYS);
  return d.toISOString().slice(0, 10);
}

/** Pregnancy check suggestion shown in the form: ~35 days after insemination. */
export const DEFAULT_PREGNANCY_CHECK_DAYS = 35;

export function addDays(date: string, days: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type PregnancyStatus = "pending" | "confirmed" | "not_confirmed";

export function pregnancyStatus(confirmed: boolean | null): PregnancyStatus {
  return confirmed === true ? "confirmed" : confirmed === false ? "not_confirmed" : "pending";
}

export const PREGNANCY_LABELS: Record<PregnancyStatus, string> = {
  pending: "Laukiama",
  confirmed: "Patvirtinta",
  not_confirmed: "Nepatvirtinta",
};

/** Journal row as the Sėklinimas page/table/animal card reads it. */
export type InseminationRow = {
  id: string;
  animal_id: string;
  insemination_date: string;
  pazymejimo_nr: string | null;
  seklintojo_kodas: string | null;
  inseminator_name: string | null;
  karves_id: string | null;
  imones_kodas: string | null;
  bull_name: string | null;
  reproduktoriaus_id: string | null;
  reproduktoriaus_kk_kodas: string | null;
  sp_savininkas: string | null;
  sperm_quantity: number | null;
  glove_quantity: number | null;
  pregnancy_confirmed: boolean | null;
  pregnancy_check_date: string | null;
  next_pregnancy_check_date: string | null;
  pregnancy_notes: string | null;
  notes: string | null;
  animals: { tag_no: string; animal_no: string | null } | null;
  sperm: { name: string } | null;
  glove: { name: string } | null;
  // 0053 DelPro import
  source: "gvet" | "delpro";
  delpro_event_guid: string | null;
  delpro_event_at: string | null;
  delpro_semen_key: string | null;
  delpro_semen_label: string | null;
  delpro_semen_comment: string | null;
  delpro_bull: string | null;
  delpro_breeder: string | null;
  delpro_insemination_number: number | null;
  delpro_method_code: string | null;
  delpro_synced_at: string | null;
  delpro_missing_at: string | null;
  delpro_possible_duplicate_of: string | null;
};

/**
 * A Postgres timestamptz as text ("2026-11-03 21:20:12.123456+00", what system_settings / now()::text hold) or ISO -> epoch ms.
 * Date.parse can't read the "+00" offset or a space separator, which made the heartbeat look missing.
 */
export function parsePgTimestamp(v: string | null | undefined): number {
  if (!v) return NaN;
  const t = v.trim().replace(" ", "T");
  if (!t.includes("T")) return Date.parse(t);
  const iso = t
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/([+-]\d{2})$/, "$1:00")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return Date.parse(iso);
}

/** Europe/Vilnius wall clock of a DelPro instant ("2014-06-09 00:00"). */
export function vilniusDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("lt-LT", { timeZone: "Europe/Vilnius", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

/** Semen / bull text of an imported row: DelPro SemenName (0054), else DelPro Bull, else "Sperma #<Semen.Key>"; null = no semen at all. */
export function delproSemenText(r: Pick<InseminationRow, "delpro_bull" | "delpro_semen_label" | "delpro_semen_key">): string | null {
  return r.delpro_semen_label ?? r.delpro_bull ?? (r.delpro_semen_key ? `Sperma #${r.delpro_semen_key}` : null);
}

/** "Bulius / sperma" cell: GVET semen product, then the journal's bull name (a GVET edit wins), then the DelPro semen text. */
export function semenColumnText(r: InseminationRow): string {
  return r.sperm?.name ?? r.bull_name ?? (r.source === "delpro" ? delproSemenText(r) : null) ?? "—";
}

export const INSEMINATION_SELECT =
  "id, animal_id, insemination_date, pazymejimo_nr, seklintojo_kodas, inseminator_name, karves_id, imones_kodas, bull_name, reproduktoriaus_id, reproduktoriaus_kk_kodas, sp_savininkas, sperm_quantity, glove_quantity, pregnancy_confirmed, pregnancy_check_date, next_pregnancy_check_date, pregnancy_notes, notes, source, delpro_event_guid, delpro_event_at, delpro_semen_key, delpro_semen_label, delpro_semen_comment, delpro_bull, delpro_breeder, delpro_insemination_number, delpro_method_code, delpro_synced_at, delpro_missing_at, delpro_possible_duplicate_of, animals(tag_no, animal_no), sperm:products!insemination_records_sperm_product_id_fkey(name), glove:products!insemination_records_glove_product_id_fkey(name)";

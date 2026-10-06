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
};

export const INSEMINATION_SELECT =
  "id, animal_id, insemination_date, pazymejimo_nr, seklintojo_kodas, inseminator_name, karves_id, imones_kodas, bull_name, reproduktoriaus_id, reproduktoriaus_kk_kodas, sp_savininkas, sperm_quantity, glove_quantity, pregnancy_confirmed, pregnancy_check_date, next_pregnancy_check_date, pregnancy_notes, notes, animals(tag_no, animal_no), sperm:products!insemination_records_sperm_product_id_fkey(name), glove:products!insemination_records_glove_product_id_fkey(name)";

import type { AdministrationRoute, ProcedureType, Unit } from "@/lib/supabase/types";

// Gydymų istorija: vw_treated_animals has one row per medicine line (direct use +
// every administered course dose). The screen shows one card per treatment, so the
// rows are folded back together here (server side, plain serializable data).

export type TreatmentHistoryLine = {
  product: string;
  qty: number | null;
  unit: Unit | null;
  route: AdministrationRoute | null;
  lot: string | null;
  /** Day the dose was given / scheduled; differs from the treatment date for course doses. */
  usedOn: string;
};

export type TreatmentHistoryCard = {
  id: string;
  regDate: string;
  animalId: string;
  animalNo: string | null;
  tagNo: string;
  group: string | null;
  procedureType: ProcedureType;
  disease: string | null;
  diagnosis: string | null;
  lines: TreatmentHistoryLine[];
  milkUntil: string | null;
  meatUntil: string | null;
  outcome: string | null;
  outcomeDate: string | null;
  vet: string | null;
};

export type TreatedRow = {
  treatment_id: string;
  reg_date: string;
  used_on: string;
  animal_id: string;
  tag_no: string;
  animal_no: string | null;
  animal_group: string | null;
  disease_name: string | null;
  diagnosis: string | null;
  administration_route: AdministrationRoute | null;
  product_name: string | null;
  batch_number: string | null;
  qty: number | null;
  unit: Unit | null;
  withdrawal_until_meat: string | null;
  withdrawal_until_milk: string | null;
  outcome: string | null;
  outcome_date: string | null;
  vet_name: string | null;
  procedure_type: ProcedureType;
};

/** Folds journal rows into one card per treatment, newest first (input order is kept). */
export function groupTreatments(rows: TreatedRow[]): TreatmentHistoryCard[] {
  const byId = new Map<string, TreatmentHistoryCard>();
  for (const r of rows) {
    let card = byId.get(r.treatment_id);
    if (!card) {
      card = {
        id: r.treatment_id,
        regDate: r.reg_date,
        animalId: r.animal_id,
        animalNo: r.animal_no,
        tagNo: r.tag_no,
        group: r.animal_group,
        procedureType: r.procedure_type,
        disease: r.disease_name,
        diagnosis: r.diagnosis,
        lines: [],
        milkUntil: r.withdrawal_until_milk,
        meatUntil: r.withdrawal_until_meat,
        outcome: r.outcome,
        outcomeDate: r.outcome_date,
        vet: r.vet_name,
      };
      byId.set(r.treatment_id, card);
    }
    if (r.product_name) {
      card.lines.push({ product: r.product_name, qty: r.qty, unit: r.unit, route: r.administration_route, lot: r.batch_number, usedOn: r.used_on });
    }
  }
  for (const c of byId.values()) c.lines.sort((a, b) => a.usedOn.localeCompare(b.usedOn) || a.product.localeCompare(b.product, "lt"));
  return Array.from(byId.values());
}

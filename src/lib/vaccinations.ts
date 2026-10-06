import type { Product } from "@/components/gyvunai/new-treatment-dialog";

// Shared by the Vakcinacijos tab (page + client components). Plain data
// shapes only — kept outside the page file (pages may only export Next's API).

export type PickerAnimal = {
  id: string;
  tag_no: string;
  animal_no: string | null;
  group_name: string | null;
  sex: string | null;
  birth_date: string | null;
  lactation_no: number | null;
  milk_active: boolean;
  meat_active: boolean;
};

export type VaccProduct = Product & { is_active: boolean };

export type VaccRow = {
  id: string;
  session_id: string | null;
  target_group_name: string | null;
  animal_group_snapshot: string | null;
  animal_id: string;
  product_id: string;
  vaccination_date: string;
  dose_amount: number | null;
  unit: string | null;
  administration_route: string | null;
  is_revaccination: boolean;
  next_booster_date: string | null;
  withdrawal_until_milk: string | null;
  withdrawal_until_meat: string | null;
  vet_name: string | null;
  notes: string | null;
  animals: { tag_no: string; animal_no: string | null } | null;
};

export type BoosterPrefill = { key: number; animalIds: string[]; productId: string };

export function rowAnimalLabel(r: Pick<VaccRow, "animals">) {
  return r.animals ? (r.animals.animal_no ? `Nr. ${r.animals.animal_no}` : r.animals.tag_no) : "—";
}

export function rowGroupLabel(r: Pick<VaccRow, "target_group_name" | "animal_group_snapshot">) {
  return r.target_group_name ?? r.animal_group_snapshot ?? null;
}

/** Whole months between an ISO birth date and an ISO "today". */
export function ageInMonths(birth: string, today: string) {
  const b = new Date(birth);
  const t = new Date(today);
  return (t.getFullYear() - b.getFullYear()) * 12 + (t.getMonth() - b.getMonth()) - (t.getDate() < b.getDate() ? 1 : 0);
}

export function daysBetween(fromIso: string, toIso: string) {
  return Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000);
}

export function addDaysIso(iso: string, days: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export type BoosterEntry = {
  key: string;
  productId: string;
  due: string;
  group: string | null;
  animalIds: string[];
  labels: string[];
};

/**
 * Pending boosters: for every (animal, vaccine) the LATEST vaccination decides —
 * if it carries a next_booster_date the booster is still due; a later
 * vaccination with the same product supersedes it. Only active animals count.
 * Animals vaccinated together (same session + date) are one entry.
 */
export function pendingBoosters(vaccinations: VaccRow[], activeIds: Set<string>): BoosterEntry[] {
  const latest = new Map<string, VaccRow>();
  for (const v of vaccinations) {
    if (!activeIds.has(v.animal_id)) continue;
    const k = `${v.animal_id}|${v.product_id}`;
    const cur = latest.get(k);
    if (!cur || v.vaccination_date > cur.vaccination_date) latest.set(k, v);
  }
  const out = new Map<string, BoosterEntry>();
  for (const v of latest.values()) {
    if (!v.next_booster_date) continue;
    const key = `${v.product_id}|${v.next_booster_date}|${v.session_id ?? v.id}`;
    const e = out.get(key);
    if (e) {
      e.animalIds.push(v.animal_id);
      e.labels.push(rowAnimalLabel(v));
    } else {
      out.set(key, { key, productId: v.product_id, due: v.next_booster_date, group: rowGroupLabel(v), animalIds: [v.animal_id], labels: [rowAnimalLabel(v)] });
    }
  }
  return [...out.values()].sort((a, b) => a.due.localeCompare(b.due));
}

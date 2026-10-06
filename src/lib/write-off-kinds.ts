import type { ProductCategory, WriteOffKind } from "@/lib/supabase/types";

// The farm's three nurašymo akto templates (0012_write_off_templates.sql).
export const WRITE_OFF_KINDS: Record<WriteOffKind, { label: string; title: string; itemHeader: string }> = {
  vaistai: {
    label: "Vaistai, biocidai",
    title: "Sunaudotų veterinarinių vaistų, biocidų ir kt. panaudojimo aktas",
    itemHeader: "Veterinarinio vaisto, biocido pavadinimas",
  },
  priedai: {
    label: "Veterinariniai priedai",
    title: "Sunaudotų veterinarinių priedų panaudojimo aktas",
    itemHeader: "Veterinarinio priedo, biocido pavadinimas",
  },
  medziagos: {
    label: "Medžiagos, MGSD",
    title: "Medžiagų, MGSD ir kt. vertybių panaudojimo aktas",
    itemHeader: "Medžiagų pavadinimas",
  },
};

export const WRITE_OFF_KIND_OPTIONS = (Object.keys(WRITE_OFF_KINDS) as WriteOffKind[]).map((value) => ({
  value,
  label: WRITE_OFF_KINDS[value].label,
}));

// Mirrors fn_product_write_off_kind() (0012, hoof_care added in 0023).
export function productWriteOffKind(category: ProductCategory, explicit: WriteOffKind | null): WriteOffKind {
  if (explicit) return explicit;
  if (category === "treatment_materials" || category === "hoof_care") return "medziagos";
  if (category === "priedas") return "priedai";
  return "vaistai";
}

export const WRITE_OFF_RULE_FIELDS = {
  delpro_group: "DelPro grupė",
  animal_sex: "Lytis (DelPro)",
} as const;

const LT_MONTHS_GENITIVE = [
  "sausio", "vasario", "kovo", "balandžio", "gegužės", "birželio",
  "liepos", "rugpjūčio", "rugsėjo", "spalio", "lapkričio", "gruodžio",
];

/** "Per 2026 m. liepos mėn." for a whole calendar month, else the explicit range. */
export function writeOffPeriodLabel(start: string, end: string): string {
  const [ys, ms, ds] = start.split("-").map(Number);
  const [ye, me, de] = end.split("-").map(Number);
  const lastDay = new Date(ye, me, 0).getDate();
  if (ys === ye && ms === me && ds === 1 && de === lastDay) {
    return `Per ${ys} m. ${LT_MONTHS_GENITIVE[ms - 1]} mėn.`;
  }
  return `Per laikotarpį ${start} – ${end}`;
}

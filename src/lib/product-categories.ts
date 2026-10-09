import type { ProductCategory } from "@/lib/supabase/types";

// Priedas §2.1 "produkto tipas".
export const PRODUCT_CATEGORY_LABELS: Record<ProductCategory, string> = {
  medicines: "Vaistai",
  vakcina: "Vakcina",
  profilaktika: "Profilaktika",
  boliusai: "Boliusai",
  biocide: "Biocidas",
  priedas: "Veterinarinis priedas",
  reproduction: "Reprodukcija (sperma)",
  hoof_care: "Nagų priežiūra",
  treatment_materials: "Gydymo medžiagos",
  other: "Kita",
};

/** Drugs: need serija + galiojimas on pajamavimas and sit in the veterinary drug journal. Mirrors fn_is_drug_category() (0027). */
export const DRUG_CATEGORIES: ProductCategory[] = ["medicines", "vakcina", "profilaktika", "boliusai"];

/** Products the Profilaktika treatment may use (farm's request, 2026-10). */
export const PROPHYLAXIS_CATEGORIES: ProductCategory[] = ["profilaktika", "boliusai"];

/** Categories whose karencija (milk / meat days) must be entered on a new product. */
export const WITHDRAWAL_REQUIRED_CATEGORIES: ProductCategory[] = ["medicines", "profilaktika", "boliusai"];

export const PRODUCT_CATEGORY_OPTIONS = (Object.keys(PRODUCT_CATEGORY_LABELS) as ProductCategory[]).map((value) => ({
  value,
  label: PRODUCT_CATEGORY_LABELS[value],
}));

import type { ProductCategory } from "@/lib/supabase/types";

// Priedas §2.1 "produkto tipas".
export const PRODUCT_CATEGORY_LABELS: Record<ProductCategory, string> = {
  medicines: "Vaistai",
  vakcina: "Vakcina",
  biocide: "Biocidas",
  priedas: "Veterinarinis priedas",
  reproduction: "Reprodukcija (sperma)",
  hoof_care: "Nagų priežiūra",
  treatment_materials: "Gydymo medžiagos",
  other: "Kita",
};

export const PRODUCT_CATEGORY_OPTIONS = (Object.keys(PRODUCT_CATEGORY_LABELS) as ProductCategory[]).map((value) => ({
  value,
  label: PRODUCT_CATEGORY_LABELS[value],
}));

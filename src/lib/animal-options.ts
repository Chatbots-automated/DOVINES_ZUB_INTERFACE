// Dropdown options for "Naujas gyvūnas" (Rūšis / Lytis). Page files and
// "use server" files may only export their own API, so shared constants live here.

/** Select value that reveals a free-text field. */
export const OTHER_OPTION = "__other";

/** Rūšis — stored lower-case in animals.species (default 'galvijas'). */
export const SPECIES_OPTIONS = [
  { value: "galvijas", label: "Galvijas" },
  { value: "avis", label: "Avis" },
  { value: "ožka", label: "Ožka" },
  { value: "arklys", label: "Arklys" },
  { value: "kiaulė", label: "Kiaulė" },
] as const;

/**
 * Lytis / kategorija — the farm's lifecycle categories as DelPro reports them
 * (animals.sex is a lifecycle category, not a binary sex; see 0001 and
 * the write-off group rules that match on it).
 */
export const SEX_OPTIONS = [
  { value: "Karvė", label: "Karvė" },
  { value: "Telyčia", label: "Telyčia" },
  { value: "Telyčaitė", label: "Telyčaitė" },
  { value: "Bulius", label: "Bulius" },
  { value: "Buliukas", label: "Buliukas" },
  { value: "Veršelis", label: "Veršelis" },
  { value: "Veršelė", label: "Veršelė" },
] as const;

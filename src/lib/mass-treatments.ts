import type { PickerAnimal } from "@/lib/vaccinations";
import type { Database } from "@/lib/supabase/types";

// Masinis gydymas (0056). Shared types for the page and its client components.

export type MassAnimal = PickerAnimal & { delpro_object_guid: string | null };

export type MassHistoryRow = Database["public"]["Views"]["vw_mass_treatments"]["Row"];

export type MassDelproInfo = {
  /** delpro_outbound_mode is not "off". */
  enabled: boolean;
  /** delpro_write_channel = gateway: the job needs the animal's ObjectGuid + catalog links. */
  gateway: boolean;
  linkedDiseaseIds: string[];
  linkedProductIds: string[];
  /** 0045 admin gate — the database re-checks; this only shows the button. */
  canApprove: boolean;
};

export const MASS_PROCEDURE_OPTIONS = [
  { value: "gydymas", label: "Gydymas" },
  { value: "profilaktika", label: "Profilaktika" },
] as const;
export type MassProcedureType = (typeof MASS_PROCEDURE_OPTIONS)[number]["value"];

/** Same per-animal limit as create_mass_treatment(). */
export const MASS_TREATMENT_MAX_ANIMALS = 2000;

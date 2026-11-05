import type { PickerAnimal } from "@/lib/vaccinations";

// Sinchronizacijos tab (0059). Shared types for the page and its client components.

export type SyncAnimal = Omit<PickerAnimal, "milk_active" | "meat_active"> & {
  open_protocol_name: string | null;
  last_insemination_date: string | null;
  last_pregnancy_confirmed: boolean | null;
};

/** Same per-batch limit as apply_sync_protocol_mass(). */
export const SYNC_MASS_MAX_ANIMALS = 2000;

export const SYNC_STATUS_LABELS = {
  aktyvus: "Vykdomas",
  baigtas: "Baigtas",
  nutrauktas: "Nutrauktas",
} as const;

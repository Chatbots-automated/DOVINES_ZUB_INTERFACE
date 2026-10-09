import type { SyncStepKind, SyncStepMedication } from "@/lib/supabase/types";

// Sinchronizacijos protokolai (0025_sync_protocols.sql).
export type SyncProtocolStep = {
  day_offset: number;
  title: string;
  notes: string | null;
  kind: SyncStepKind;
  medications: SyncStepMedication[];
};

export type SyncProtocolData = {
  id: string;
  name: string;
  description: string | null;
  steps: SyncProtocolStep[];
};

/** A product a protocol step may use (no biocides / hoof-care materials). */
export type SyncProductOption = { id: string; name: string; unit: string };

export function stepDayLabel(dayOffset: number): string {
  return dayOffset === 0 ? "0 d." : `+${dayOffset} d.`;
}

import type { HoofClaw, HoofLeg, HoofZoneSelection } from "@/lib/supabase/types";

export type { HoofClaw, HoofLeg };
export type ZoneSelection = HoofZoneSelection;

export const HOOF_LEG_LABELS: Record<HoofLeg, string> = {
  FL: "Priekinė kairė",
  FR: "Priekinė dešinė",
  HL: "Galinė kairė",
  HR: "Galinė dešinė",
};

export const HOOF_CLAW_LABELS: Record<HoofClaw, string> = {
  inner: "vidinis nagas",
  outer: "išorinis nagas",
};

/** "Z4·V" = zona 4, vidinis nagas; "Z2·I" = išorinis. */
export function formatZones(zones: ZoneSelection[]): string {
  return zones.map((z) => `Z${z.zone}·${z.claw === "inner" ? "V" : "I"}`).join(", ");
}

export function severityTone(severity: number): "success" | "warning" | "danger" {
  return severity >= 3 ? "danger" : severity >= 1 ? "warning" : "success";
}

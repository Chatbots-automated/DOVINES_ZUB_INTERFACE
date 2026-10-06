"use client";

import * as React from "react";
import { HOOF_SELECTOR_DATA } from "@/components/hoof/hoofSelectorData";
import { HOOF_ZONE_DATA } from "@/components/hoof/hoofZoneData";
import { HOOF_LEG_LABELS, type HoofClaw, type HoofLeg, type ZoneSelection } from "@/lib/hoof";

const HOOF_LEG_MAP: Record<string, HoofLeg> = {
  "Front Left": "FL",
  "Front Right": "FR",
  "Back Left": "HL",
  "Back Right": "HR",
};


// Ported from Monika's HoofInterfaceNew.tsx — the real production hoof
// zone-selection UI (HoofSelector.tsx/HoofZoneDiagram.tsx there are dead
// legacy fallbacks, not this). Two screens: click one of 4 legs on the
// reference photo, then click one or more zones (multi-select) on the
// anatomical sole diagram for that leg. `left_*` zone keys are the inner
// claw, `right_*` are the outer claw, `center_*` are shared/interdigital
// zones (stored as inner, matching the reference project's convention).
function pointsToString(points: readonly (readonly number[])[]) {
  return points.map((p) => `${p[0]},${p[1]}`).join(" ");
}

function parseZoneKey(zoneKey: string): { zone: number; claw: HoofClaw } {
  const [side, num] = zoneKey.split("_");
  return { zone: parseInt(num, 10), claw: side === "right" ? "outer" : "inner" };
}

export function HoofZonePicker({
  leg,
  onLegChange,
  zones,
  onZonesChange,
}: {
  leg: HoofLeg | null;
  onLegChange: (leg: HoofLeg) => void;
  zones: ZoneSelection[];
  onZonesChange: (zones: ZoneSelection[]) => void;
}) {
  const [screen, setScreen] = React.useState<"legs" | "zones">(leg ? "zones" : "legs");

  function handleLegClick(next: HoofLeg) {
    onLegChange(next);
    onZonesChange([]);
    setScreen("zones");
  }

  function handleZoneClick(zoneKey: string) {
    const picked = parseZoneKey(zoneKey);
    const exists = zones.some((z) => z.zone === picked.zone && z.claw === picked.claw);
    onZonesChange(exists ? zones.filter((z) => !(z.zone === picked.zone && z.claw === picked.claw)) : [...zones, picked]);
  }

  if (screen === "legs") {
    return (
      <div className="space-y-3">
        <p className="text-center text-[13px] font-semibold text-text-primary">1 žingsnis iš 2 · Pasirinkite nagą</p>
        <div className="relative mx-auto w-full max-w-md overflow-hidden rounded-panel border border-border bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element -- SVG overlay needs exact pixel-mapped natural size, next/image's layout wrapper fights that */}
          <img src="/hoof/hoof-leg-selector.png" alt="Nagų pasirinkimas" className="block h-auto w-full select-none" draggable={false} />
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 1000" preserveAspectRatio="none">
            {Object.entries(HOOF_SELECTOR_DATA).map(([key, hoof]) => {
              const hoofLeg = HOOF_LEG_MAP[hoof.group];
              const isSelected = leg === hoofLeg;
              return (
                <polygon
                  key={key}
                  points={pointsToString(hoof.points)}
                  fill={isSelected ? "rgba(255, 125, 45, 0.34)" : "rgba(0, 140, 255, 0)"}
                  stroke={isSelected ? "#ff7d2d" : "transparent"}
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                  style={{ cursor: "pointer", transition: "fill 0.12s ease, stroke 0.12s ease", vectorEffect: "non-scaling-stroke" }}
                  onClick={() => handleLegClick(hoofLeg)}
                  onMouseEnter={(e) => {
                    if (!isSelected) {
                      e.currentTarget.setAttribute("fill", "rgba(0, 140, 255, 0.16)");
                      e.currentTarget.setAttribute("stroke", "rgba(0, 140, 255, 0.82)");
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) {
                      e.currentTarget.setAttribute("fill", "rgba(0, 140, 255, 0)");
                      e.currentTarget.setAttribute("stroke", "transparent");
                    }
                  }}
                />
              );
            })}
          </svg>
        </div>
        {leg && <p className="text-center text-[13px] font-medium text-text-secondary">Pasirinkta: {HOOF_LEG_LABELS[leg]}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setScreen("legs")} className="rounded-control border border-border px-3 py-1.5 text-[13px] font-medium hover:bg-surface-secondary">
          ← Grįžti
        </button>
        <p className="text-[13px] font-semibold text-text-primary">2 žingsnis iš 2 · {leg ? HOOF_LEG_LABELS[leg] : ""}</p>
        <span className="w-16" />
      </div>
      <div className="relative mx-auto w-full max-w-md overflow-hidden rounded-panel border border-border bg-white">
        {/* eslint-disable-next-line @next/next/no-img-element -- see note above */}
        <img src="/hoof/hoof-zones-reference.png" alt="Nagos zonos" className="block h-auto w-full select-none" draggable={false} />
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 1000" preserveAspectRatio="none">
          {Object.entries(HOOF_ZONE_DATA).map(([zoneKey, points]) => {
            const parsed = parseZoneKey(zoneKey);
            const isSelected = zones.some((z) => z.zone === parsed.zone && z.claw === parsed.claw);
            return (
              <polygon
                key={zoneKey}
                points={pointsToString(points)}
                fill={isSelected ? "rgba(255, 80, 60, 0.30)" : "rgba(0, 140, 255, 0)"}
                stroke={isSelected ? "#ff513d" : "transparent"}
                strokeWidth="2.1"
                strokeLinejoin="round"
                style={{ cursor: "pointer", transition: "fill 0.12s ease, stroke 0.12s ease", vectorEffect: "non-scaling-stroke" }}
                onClick={() => handleZoneClick(zoneKey)}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    e.currentTarget.setAttribute("fill", "rgba(0, 140, 255, 0.16)");
                    e.currentTarget.setAttribute("stroke", "rgba(0, 140, 255, 0.8)");
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    e.currentTarget.setAttribute("fill", "rgba(0, 140, 255, 0)");
                    e.currentTarget.setAttribute("stroke", "transparent");
                  }
                }}
              />
            );
          })}
        </svg>
      </div>
      <p className="text-center text-[12px] text-text-muted">
        Paspauskite zonas, kad jas pasirinktumėte — galite pasirinkti keletą vienu metu.{" "}
        {zones.length > 0 && <span className="font-semibold text-danger">Pasirinkta: {zones.length}</span>}
      </p>
    </div>
  );
}

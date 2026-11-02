"use client";

import * as React from "react";
import { Input, Label, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CMS_MODE_LABEL, SESSION_NUMBERS, addDaysLocal, describeSchedule, settingsProblems, toggleSession, type CmsMode, type CmsSettings } from "@/lib/cms/separation";
import type { CmsSortAreaRow } from "@/lib/supabase/types";

const DURATIONS = [1, 2, 3, 5, 7];

/** One CMS separation configuration — used for Bendri nustatymai and inline per-animal editing. */
export function CmsSettingsFields({
  value,
  onChange,
  sortAreas,
  nowLocal,
  idPrefix,
}: {
  value: CmsSettings;
  onChange: (patch: Partial<CmsSettings>) => void;
  sortAreas: CmsSortAreaRow[];
  nowLocal?: string;
  idPrefix: string;
}) {
  const problems = settingsProblems(value, nowLocal);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Label htmlFor={`${idPrefix}-mode`}>Režimas</Label>
          <Select
            id={`${idPrefix}-mode`}
            value={value.mode}
            onChange={(e) => {
              const mode = e.target.value as CmsMode;
              onChange(mode === "ongoing" ? { mode, end_local: "" } : { mode });
            }}
          >
            {(Object.keys(CMS_MODE_LABEL) as CmsMode[]).map((m) => (
              <option key={m} value={m}>
                {CMS_MODE_LABEL[m]}
                {m === "once" ? " — nesiunčiamas" : ""}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-start`}>Pradžia (Vilniaus laikas)</Label>
          <Input id={`${idPrefix}-start`} type="datetime-local" value={value.start_local} onChange={(e) => onChange({ start_local: e.target.value })} />
        </div>
        {value.mode !== "ongoing" && (
          <div>
            <Label htmlFor={`${idPrefix}-end`}>Pabaiga (Vilniaus laikas)</Label>
            <Input id={`${idPrefix}-end`} type="datetime-local" value={value.end_local} onChange={(e) => onChange({ end_local: e.target.value })} />
            <div className="mt-1 flex flex-wrap gap-1">
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  disabled={!value.start_local}
                  onClick={() => onChange({ end_local: addDaysLocal(value.start_local, d) })}
                  className="rounded-control border border-border px-1.5 py-0.5 text-[11px] text-text-secondary hover:bg-surface-secondary disabled:opacity-40"
                >
                  +{d} d.
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <Label htmlFor={`${idPrefix}-area`}>Rūšiavimo vieta</Label>
          <Select id={`${idPrefix}-area`} value={value.sort_area_key} onChange={(e) => onChange({ sort_area_key: e.target.value })}>
            <option value="">Nevaldoma iš GVET (DelPro nustatymas)</option>
            {sortAreas.map((a) => (
              <option key={a.area_key} value={a.area_key}>
                {a.area_name ?? `Vieta ${a.area_number ?? a.area_key}`} — nepatikrinta
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <Label>Melžimo sesijos</Label>
        <div className="flex flex-wrap gap-1.5">
          {SESSION_NUMBERS.map((n) => {
            const on = value.sessions.includes(n);
            return (
              <button
                key={n}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ sessions: toggleSession(value.sessions, n) })}
                className={cn(
                  "h-8 min-w-8 rounded-control border px-2 text-[13px] font-medium transition-colors",
                  on ? "border-accent bg-accent text-white" : "border-border-strong bg-surface text-text-secondary hover:bg-surface-secondary",
                )}
              >
                {n}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-note`}>Pastaba / priežastis (tik GVET)</Label>
        <Input id={`${idPrefix}-note`} value={value.note} maxLength={500} onChange={(e) => onChange({ note: e.target.value })} />
      </div>
      <div className="rounded-control bg-surface-secondary px-3 py-2 text-[12px]">
        <span className="text-text-muted">Grafikas: </span>
        <span className="font-medium text-text-primary">{describeSchedule(value)}</span>
        {problems.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-danger">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

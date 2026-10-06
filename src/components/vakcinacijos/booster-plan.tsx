"use client";

import * as React from "react";
import { CalendarClock, Download, Syringe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { downloadCsv } from "@/lib/export";
import { daysBetween, pendingBoosters, type BoosterEntry, type PickerAnimal, type VaccRow } from "@/lib/vaccinations";
import { formatDate } from "@/lib/utils";

// Vaccination plan: pending boosters (see pendingBoosters()) — overdue / due soon / later.
type Entry = BoosterEntry & { productName: string };

export function BoosterPlan({
  vaccinations,
  animals,
  productNames,
  today,
  onVaccinate,
}: {
  vaccinations: VaccRow[];
  animals: PickerAnimal[];
  productNames: Record<string, string>;
  today: string;
  onVaccinate: (animalIds: string[], productId: string) => void;
}) {
  const [horizon, setHorizon] = React.useState("30");

  const entries = React.useMemo(
    () => pendingBoosters(vaccinations, new Set(animals.map((a) => a.id))).map((e) => ({ ...e, productName: productNames[e.productId] ?? "—" })),
    [vaccinations, animals, productNames],
  );

  const h = Number(horizon);
  const overdue = entries.filter((e) => e.due < today);
  const soon = entries.filter((e) => e.due >= today && daysBetween(today, e.due) <= h);
  const later = entries.filter((e) => e.due >= today && daysBetween(today, e.due) > h);

  function exportCsv() {
    const rows: string[][] = [];
    for (const e of entries) {
      const status = e.due < today ? "Pradelsta" : daysBetween(today, e.due) <= h ? "Artėja" : "Vėliau";
      rows.push([formatDate(e.due), status, e.productName, e.group ?? "", String(e.animalIds.length), e.labels.join(", ")]);
    }
    downloadCsv(`vakcinaciju-planas-${today}`, ["Data", "Būsena", "Vakcina", "Grupė", "Gyvūnų sk.", "Gyvūnai"], rows);
  }

  if (entries.length === 0) {
    return <EmptyState icon={CalendarClock} title="Suplanuotų pakartotinių vakcinacijų nėra" />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13px] text-text-secondary">
          Artėjančios per
          <Select className="w-28" value={horizon} onChange={(e) => setHorizon(e.target.value)}>
            <option value="14">14 d.</option>
            <option value="30">30 d.</option>
            <option value="60">60 d.</option>
            <option value="90">90 d.</option>
          </Select>
        </label>
        <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={exportCsv}>
          <Download className="size-4" /> CSV
        </Button>
      </div>
      <Section title="Pradelsta" tone="danger" entries={overdue} today={today} onVaccinate={onVaccinate} />
      <Section title={`Artėja (${horizon} d.)`} tone="warning" entries={soon} today={today} onVaccinate={onVaccinate} />
      <Section title="Vėliau" tone="neutral" entries={later} today={today} onVaccinate={onVaccinate} />
    </div>
  );
}

function Section({
  title,
  tone,
  entries,
  today,
  onVaccinate,
}: {
  title: string;
  tone: "danger" | "warning" | "neutral";
  entries: Entry[];
  today: string;
  onVaccinate: (animalIds: string[], productId: string) => void;
}) {
  if (entries.length === 0) return null;
  const total = entries.reduce((n, e) => n + e.animalIds.length, 0);
  return (
    <div className="overflow-hidden rounded-panel border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border bg-surface-secondary px-4 py-2.5 text-[13px] font-bold text-text-primary">
        {title} <Badge tone={tone}>{total} gyv.</Badge>
      </div>
      <ul className="divide-y divide-border">
        {entries.map((e) => {
          const diff = daysBetween(today, e.due);
          return (
            <li key={e.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[14px]">
              <span className="w-24 font-medium text-text-primary">{formatDate(e.due)}</span>
              <Badge tone={tone}>{diff < 0 ? `vėluoja ${-diff} d.` : diff === 0 ? "šiandien" : `už ${diff} d.`}</Badge>
              <span className="text-text-primary">{e.productName}</span>
              <span className="text-text-secondary" title={e.labels.join(", ")}>
                {e.group ? `${e.group} · ` : ""}
                {e.animalIds.length === 1 ? e.labels[0] : `${e.animalIds.length} gyv.`}
              </span>
              <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => onVaccinate(e.animalIds, e.productId)}>
                <Syringe className="size-3.5" /> Vakcinuoti
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

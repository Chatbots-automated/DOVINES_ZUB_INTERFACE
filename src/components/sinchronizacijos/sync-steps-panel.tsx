"use client";

import * as React from "react";
import { useActionState } from "react";
import Link from "next/link";
import { CheckCheck, Dna, Pill, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { completeSyncSteps, type SyncMassResult } from "@/lib/actions/sync-mass";
import { addDays } from "@/lib/visits";
import { formatDate, formatQty } from "@/lib/utils";
import type { SyncOpenStepRow } from "@/lib/supabase/types";

type Range = "due" | "today" | "tomorrow" | "week" | "all";
const RANGE_LABELS: Record<Range, string> = {
  due: "Vėluojantys ir šiandienos",
  today: "Šiandien",
  tomorrow: "Rytoj",
  week: "Artimiausios 7 d.",
  all: "Visi atviri",
};

type Group = { key: string; date: string; protocol: string; title: string; rows: SyncOpenStepRow[] };

// Every open protocol step of every animal (vw_sync_open_steps), grouped by day +
// protocol + step. Ticked due steps are recorded at once by complete_sync_steps():
// planned medicine → one 'sinchronizacija' treatment per animal (FEFO, karencija),
// a step without medicine is closed; all in one transaction. Insemination steps
// need the semen picked, so they are recorded from the visit (Vizitai).
export function SyncStepsPanel({
  steps,
  products,
  currentVetName,
  today,
  canWrite,
}: {
  steps: SyncOpenStepRow[];
  products: { id: string; name: string; unit: string }[];
  currentVetName?: string | null;
  today: string;
  canWrite: boolean;
}) {
  const [state, formAction, pending] = useActionState<SyncMassResult | null, FormData>(completeSyncSteps, null);
  const [range, setRange] = React.useState<Range>("due");
  const [q, setQ] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) setSelected(new Set());
  }

  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 7);
  const tokens = q.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const filtered = steps.filter((s) => {
    if (range === "due" && s.step_date > today) return false;
    if (range === "today" && s.step_date !== today) return false;
    if (range === "tomorrow" && s.step_date !== tomorrow) return false;
    if (range === "week" && s.step_date > weekEnd) return false;
    if (tokens.length) {
      const hay = `${s.animal_no ?? ""} ${s.tag_no} ${s.protocol_name} ${s.sync_step_title ?? ""}`.toLowerCase();
      if (!tokens.some((t) => hay.includes(t))) return false;
    }
    return true;
  });

  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const s of filtered) {
    const key = `${s.step_date}|${s.protocol_name}|${s.sync_step_no}|${s.sync_step_title}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, date: s.step_date, protocol: s.protocol_name, title: s.sync_step_title ?? "—", rows: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(s);
  }
  groups.sort((a, b) => a.date.localeCompare(b.date) || a.protocol.localeCompare(b.protocol, "lt") || a.title.localeCompare(b.title, "lt"));

  const isSelectable = (s: SyncOpenStepRow) => canWrite && s.step_date <= today && !s.procedures.includes("sekinimas");
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setGroup = (g: Group, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of g.rows) {
        if (!isSelectable(s)) continue;
        if (on) next.add(s.visit_id);
        else next.delete(s.visit_id);
      }
      return next;
    });

  // What the selection will write off (dose × animals), by product.
  const need = new Map<string, number>();
  for (const s of steps) {
    if (!selected.has(s.visit_id)) continue;
    for (const m of s.planned_medications) need.set(m.product_id, (need.get(m.product_id) ?? 0) + Number(m.qty));
  }
  const overdue = steps.filter((s) => s.step_date < today).length;
  const dueToday = steps.filter((s) => s.step_date === today).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-panel border border-border bg-surface p-4">
        <div>
          <Label htmlFor="ss_range">Rodyti</Label>
          <Select id="ss_range" value={range} onChange={(e) => setRange(e.target.value as Range)}>
            {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
              <option key={r} value={r}>
                {RANGE_LABELS[r]}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-[220px] flex-1">
          <Label htmlFor="ss_q">Paieška</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-text-muted" />
            <Input id="ss_q" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Gyvūno Nr., protokolas, žingsnis" />
          </div>
        </div>
        <div className="flex gap-2 text-[13px]">
          {overdue > 0 && <Badge tone="danger">Vėluoja: {overdue}</Badge>}
          <Badge tone="warning">Šiandien: {dueToday}</Badge>
        </div>
      </div>

      {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
      {state?.ok && <p className="rounded-control bg-success-soft px-3 py-2 text-[13px] text-success">{state.message}</p>}

      {groups.length === 0 ? (
        <EmptyState icon={CheckCheck} title="Atvirų žingsnių nėra" className="rounded-panel border border-border bg-surface py-10" />
      ) : (
        groups.map((g) => {
          const selectableRows = g.rows.filter(isSelectable);
          const allOn = selectableRows.length > 0 && selectableRows.every((s) => selected.has(s.visit_id));
          const late = g.date < today;
          const meds = g.rows[0]?.planned_medications ?? [];
          const insemination = g.rows[0]?.procedures.includes("sekinimas");
          return (
            <div key={g.key} className="rounded-panel border border-border bg-surface">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                {selectableRows.length > 0 && (
                  <input type="checkbox" className="size-4" checked={allOn} onChange={() => setGroup(g, !allOn)} aria-label="Pažymėti visą grupę" />
                )}
                <span className={`font-semibold tabular-nums ${late ? "text-danger" : g.date === today ? "text-warning" : "text-text-primary"}`}>
                  {formatDate(g.date)}
                </span>
                <span className="font-semibold text-text-primary">{g.title}</span>
                <span className="text-[12px] text-text-muted">{g.protocol}</span>
                <Badge tone="neutral">{g.rows.length} gyv.</Badge>
                {insemination && (
                  <Badge tone="accent">
                    <Dna className="size-3" /> Sėklinimas — įrašykite{" "}
                    <Link href="/veterinarija/vizitai" className="underline">
                      Vizituose
                    </Link>
                  </Badge>
                )}
                {meds.map((m, i) => (
                  <span key={i} className="flex items-center gap-1 text-[12px] text-text-secondary">
                    <Pill className="size-3" /> {productById.get(m.product_id)?.name ?? "?"} {formatQty(Number(m.qty), m.unit)}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5 px-4 py-2.5">
                {g.rows.map((s) => {
                  const can = isSelectable(s);
                  const on = selected.has(s.visit_id);
                  return (
                    <label
                      key={s.visit_id}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-control border px-2 py-1 text-[12.5px] ${
                        on ? "border-accent bg-accent-soft" : "border-border"
                      } ${can ? "" : "cursor-default opacity-70"}`}
                      title={`${s.tag_no} · ${s.sync_step_no}/${s.sync_step_total}`}
                    >
                      {can && <input type="checkbox" className="size-3.5" checked={on} onChange={() => toggle(s.visit_id)} />}
                      <span className="font-medium text-text-primary">{s.animal_no ?? s.tag_no}</span>
                      {s.group_name && <span className="text-text-muted">{s.group_name}</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })
      )}

      {canWrite && (
        <form action={formAction} className="sticky bottom-0 flex flex-wrap items-end gap-3 rounded-panel border border-border bg-surface p-4 shadow-elevated">
          <input type="hidden" name="visit_ids" value={JSON.stringify([...selected])} />
          <div>
            <Label htmlFor="ss_vet">Veterinarijos gydytojas</Label>
            <Input id="ss_vet" name="vet_name" defaultValue={currentVetName ?? undefined} />
          </div>
          <div className="min-w-[200px] flex-1 text-[12.5px] text-text-secondary">
            Pažymėta žingsnių: <strong className="text-accent">{selected.size}</strong>
            {need.size > 0 && (
              <span>
                {" "}
                · Bus nurašyta:{" "}
                {[...need].map(([id, q2]) => `${productById.get(id)?.name ?? "?"} ${formatQty(Math.round(q2 * 1e6) / 1e6, productById.get(id)?.unit)}`).join(", ")}
              </span>
            )}
            <p className="text-[11.5px] text-text-muted">
              Kiekvienas žingsnis įrašomas jo suplanuotą dieną. Vaistai nurašomi FEFO, skaičiuojama karencija; nepakankant likučio neįrašomas nė vienas.
            </p>
          </div>
          <Button
            type="submit"
            disabled={pending || selected.size === 0}
            onClick={(e) => {
              if (!window.confirm(`Įrašyti ${selected.size} žingsn. kaip atliktus?`)) e.preventDefault();
            }}
          >
            <CheckCheck className="size-4" /> {pending ? "Saugoma..." : "Atlikta pažymėtiems"}
          </Button>
        </form>
      )}
    </div>
  );
}

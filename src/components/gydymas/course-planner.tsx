"use client";

import * as React from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { MedicinePicker } from "@/components/gydymas/medicine-picker";
import { RouteSelect } from "@/components/gydymas/medicine-line";
import {
  SCHEDULE_MODE_OPTIONS,
  addDays,
  assignDayNumbers,
  generateCourseRows,
  modeStep,
  type CatalogProduct,
  type CourseRow,
  type MedLine,
  type PlanSummary,
  type ScheduleMode,
} from "@/lib/treatments/planner";
import { formatDate, formatQty } from "@/lib/utils";

export type CoursePlan = {
  enabled: boolean;
  /** Calendar span in days, day 1 = treatment date. */
  days: number;
  mode: ScheduleMode;
  interval: number;
  rows: CourseRow[];
};

export const EMPTY_COURSE_PLAN: CoursePlan = { enabled: false, days: 5, mode: "daily", interval: 3, rows: [] };

const DAY_PRESETS = [3, 5, 7, 10];

// "Kurso planavimas" (Priedas §2.4). Today's medicine lines are the template;
// the schedule for the following days is generated from it and stays fully
// editable (date, product, dose, route per row). Day 1 is deducted from stock
// on save; days 2..N only when each dose is given (Gydymo kursai).
export function CoursePlanner({
  plan,
  onChange,
  lines,
  regDate,
  catalog,
  productById,
  loading,
}: {
  plan: CoursePlan;
  onChange: (next: CoursePlan) => void;
  lines: MedLine[];
  regDate: string;
  catalog: CatalogProduct[];
  productById: Map<string, CatalogProduct>;
  loading: boolean;
}) {
  const regenerate = (patch: Partial<CoursePlan>): CoursePlan => {
    const next = { ...plan, ...patch };
    return { ...next, rows: generateCourseRows(lines, regDate, next.days, next.mode, next.interval) };
  };

  const dayNumbers = assignDayNumbers(regDate, plan.rows);
  const sortedRows = [...plan.rows].sort((a, b) => a.date.localeCompare(b.date));
  const hasTemplate = lines.some((l) => l.product_id && Number(l.qty) > 0);

  function updateRow(key: string, patch: Partial<CourseRow>) {
    onChange({ ...plan, rows: plan.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  }
  function addRow() {
    const last = sortedRows[sortedRows.length - 1];
    const base = last?.date ?? regDate;
    onChange({
      ...plan,
      rows: [
        ...plan.rows,
        {
          key: crypto.randomUUID(),
          date: addDays(base, modeStep(plan.mode, plan.interval)),
          product_id: last?.product_id ?? lines[0]?.product_id ?? "",
          qty: last?.qty ?? lines[0]?.qty ?? "",
          route: last?.route ?? lines[0]?.route ?? "",
        },
      ],
    });
  }

  return (
    <div className="rounded-panel border border-border bg-surface-secondary p-4">
      <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-text-primary">
        <input
          type="checkbox"
          checked={plan.enabled}
          onChange={(e) => onChange(e.target.checked ? { ...regenerate({}), enabled: true } : { ...plan, enabled: false })}
          className="size-4 rounded border-border-strong"
        />
        <CalendarClock className="size-4 text-accent" /> Tęsti kursu (gydymo kursas)
      </label>

      {plan.enabled && (
        <div className="mt-3 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="mb-1">Kurso trukmė (dienos)</Label>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={2}
                  max={60}
                  value={plan.days}
                  onChange={(e) => onChange(regenerate({ days: Math.max(2, Math.min(60, Number(e.target.value) || 2)) }))}
                  className="w-20"
                />
                {DAY_PRESETS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => onChange(regenerate({ days: n }))}
                    className={`rounded-badge px-2.5 py-1 text-[12px] font-semibold ${
                      plan.days === n ? "bg-accent text-white" : "bg-surface text-text-secondary hover:bg-accent-soft"
                    }`}
                  >
                    {n} d.
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="mb-1">Dozavimo dažnis</Label>
              <Select value={plan.mode} onChange={(e) => onChange(regenerate({ mode: e.target.value as ScheduleMode }))} className="w-44">
                {SCHEDULE_MODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            {plan.mode === "interval" && (
              <div>
                <Label className="mb-1">Kas kiek dienų</Label>
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={plan.interval}
                  onChange={(e) => onChange(regenerate({ interval: Math.max(1, Math.min(30, Number(e.target.value) || 1)) }))}
                  className="w-20"
                />
              </div>
            )}
            <div>
              <Label className="mb-1">Pradžia</Label>
              <p className="flex h-9 items-center rounded-control bg-surface px-3 text-[13px] font-medium text-text-primary">{formatDate(regDate)}</p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => onChange(regenerate({}))} disabled={!hasTemplate}>
              <RefreshCw className="size-4" /> Sugeneruoti iš vaistų
            </Button>
          </div>

          {!hasTemplate && (
            <p className="rounded-control bg-warning-soft px-3 py-2 text-[12px] text-warning">
              Pirmiausia pridėkite šiandienos vaistus (produktas + dozė) — jie naudojami kaip kurso šablonas.
            </p>
          )}

          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-control bg-surface px-3 py-2">
              <Badge tone="success">Diena 1</Badge>
              <span className="text-[12.5px] text-text-secondary">
                {formatDate(regDate)} · šiandienos vaistai (atsargos nurašomos išsaugojus)
              </span>
            </div>
            {sortedRows.map((row) => {
              const p = productById.get(row.product_id);
              const dayNo = dayNumbers.get(row.date);
              return (
                <div key={row.key} className="rounded-control border border-border bg-surface p-2.5">
                  <div className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[88px_140px_minmax(0,1.5fr)_100px_minmax(0,1fr)_36px]">
                    <Badge tone={dayNo ? "info" : "danger"} className="justify-center">
                      {dayNo ? `Diena ${dayNo}` : "Per anksti"}
                    </Badge>
                    <Input type="date" min={addDays(regDate, 1)} value={row.date} onChange={(e) => updateRow(row.key, { date: e.target.value })} className="h-8" />
                    <div className="col-span-2 sm:col-span-1">
                      <MedicinePicker compact catalog={catalog} value={row.product_id} onChange={(id) => updateRow(row.key, { product_id: id })} loading={loading} />
                    </div>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder={p ? p.unit : "Dozė"}
                      value={row.qty}
                      onChange={(e) => updateRow(row.key, { qty: e.target.value })}
                      className="h-8"
                    />
                    <RouteSelect value={row.route} onChange={(v) => updateRow(row.key, { route: v })} className="h-8" />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      onClick={() => onChange({ ...plan, rows: plan.rows.filter((r) => r.key !== row.key) })}
                      aria-label="Pašalinti eilutę"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
            {plan.rows.length === 0 && hasTemplate && <p className="text-[12.5px] text-text-muted">Papildomų dozių nėra — padidinkite kurso trukmę.</p>}
          </div>

          <Button type="button" size="sm" variant="outline" onClick={addRow}>
            <Plus className="size-4" /> Pridėti dozę
          </Button>
        </div>
      )}
    </div>
  );
}

// Totals per product (now / later / stock) and the resulting karencija end.
export function PlanSummaryPanel({ summary, hasCourse }: { summary: PlanSummary; hasCourse: boolean }) {
  if (summary.totals.length === 0) return null;
  const anyNowShort = summary.totals.some((t) => t.nowShort);
  const anyCourseShort = summary.totals.some((t) => t.courseShort && !t.nowShort);
  return (
    <div className="rounded-panel border border-accent-border bg-accent-soft/50 p-4">
      <p className="mb-2 text-[13px] font-semibold text-text-primary">{hasCourse ? "Kurso suvestinė" : "Suvestinė"}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-text-muted">
              <th className="py-1 pr-3 font-semibold">Produktas</th>
              <th className="py-1 pr-3 text-right font-semibold">Dabar</th>
              {hasCourse && <th className="py-1 pr-3 text-right font-semibold">Vėliau</th>}
              {hasCourse && <th className="py-1 pr-3 text-right font-semibold">Iš viso</th>}
              <th className="py-1 pr-3 text-right font-semibold">Likutis</th>
              <th className="py-1 text-right font-semibold">Būklė</th>
            </tr>
          </thead>
          <tbody>
            {summary.totals.map((t) => (
              <tr key={t.product.id} className="border-t border-accent-border/60">
                <td className="py-1.5 pr-3 font-medium text-text-primary">{t.product.name}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatQty(t.now, t.product.unit)}</td>
                {hasCourse && <td className="py-1.5 pr-3 text-right tabular-nums">{formatQty(t.later, t.product.unit)}</td>}
                {hasCourse && <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">{formatQty(Math.round(t.total * 1000) / 1000, t.product.unit)}</td>}
                <td className="py-1.5 pr-3 text-right tabular-nums text-text-secondary">
                  {t.product.usable_qty === null ? "—" : formatQty(t.product.usable_qty, t.product.unit)}
                </td>
                <td className="py-1.5 text-right">
                  {t.product.usable_qty === null ? (
                    <Badge>Nežinoma</Badge>
                  ) : t.nowShort ? (
                    <Badge tone="danger">Trūksta šiandien</Badge>
                  ) : t.courseShort ? (
                    <Badge tone="warning">Kursui nepakaks</Badge>
                  ) : (
                    <Badge tone="success">
                      <CheckCircle2 className="size-3" /> Pakanka
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {anyNowShort && (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-danger">
          <AlertTriangle className="size-3.5" /> Šiandienos dozės viršija galiojančias atsargas — išsaugoti negalima.
        </p>
      )}
      {anyCourseShort && (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-warning">
          <AlertTriangle className="size-3.5" /> Visam kursui atsargų nepakaks — vėlesnių dienų dozių nepavyks suteikti, kol nebus papildytos atsargos.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-accent-border/60 pt-3">
        <span className="text-[12px] font-semibold text-text-secondary">
          {hasCourse ? `Paskutinė kurso diena: ${formatDate(summary.lastDate)} (${summary.doseDays} d.) · ` : ""}Karencija:
        </span>
        {summary.milkUntil ? <Badge tone="warning">🥛 pienas iki {formatDate(summary.milkUntil)}</Badge> : <Badge tone="success">🥛 pienui karencijos nėra</Badge>}
        {summary.meatUntil ? <Badge tone="danger">🥩 mėsa iki {formatDate(summary.meatUntil)}</Badge> : <Badge tone="success">🥩 mėsai karencijos nėra</Badge>}
      </div>
    </div>
  );
}

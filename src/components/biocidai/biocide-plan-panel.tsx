"use client";

import * as React from "react";
import { useActionState } from "react";
import { AlertTriangle, Check, CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { cancelBiocidePlan, decideBiocidePlannedUsages, type PlanActionResult } from "@/lib/actions/biocides";
import type { BiocideProduct } from "@/components/biocidai/new-biocide-dialog";
import type { Database } from "@/lib/supabase/types";
import { formatDate, formatQty } from "@/lib/utils";

export type PlannedDayRow = Database["public"]["Views"]["vw_biocide_planned_usages"]["Row"];

const round = (n: number) => Math.round(n * 1000) / 1000;

function CancelPlanButton({ planId }: { planId: string }) {
  const [state, formAction, pending] = useActionState<PlanActionResult | null, FormData>(cancelBiocidePlan, null);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm("Atšaukti likusias šio plano dienas? Patvirtintos dienos liks žurnale.")) e.preventDefault();
      }}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="plan_id" value={planId} />
      <Button type="submit" size="sm" variant="ghost" disabled={pending}>
        {pending ? "..." : "Atšaukti planą"}
      </Button>
      {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
    </form>
  );
}

// Biocidų planas (0057): every planned day up to today waits here. All are ticked by
// default — coming back after 5 days, one press confirms them all, each written off and
// journaled on its own date (one transaction). The amount can be corrected per day;
// a day that didn't happen is marked "Nenaudota" (nothing written off).
export function BiocidePlanPanel({ rows, products, today }: { rows: PlannedDayRow[]; products: BiocideProduct[]; today: string }) {
  const [state, formAction, pending] = useActionState<PlanActionResult | null, FormData>(decideBiocidePlannedUsages, null);

  const due = React.useMemo(
    () => rows.filter((r) => r.status === "planned" && r.use_date <= today).sort((a, b) => a.use_date.localeCompare(b.use_date) || a.product_name.localeCompare(b.product_name, "lt")),
    [rows, today],
  );
  const dueKey = due.map((r) => r.id).join(",");

  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(due.map((r) => r.id)));
  const [qty, setQty] = React.useState<Record<string, string>>({});
  // New due days (after a save / refresh) start ticked; decided ones drop out.
  const [handledKey, setHandledKey] = React.useState(dueKey);
  if (dueKey !== handledKey) {
    setHandledKey(dueKey);
    setSelected(new Set(due.map((r) => r.id)));
    setQty({});
  }

  const plans = React.useMemo(() => {
    const m = new Map<string, { first: PlannedDayRow; confirmed: number; skipped: number; open: number; next: string | null }>();
    for (const r of rows) {
      if (r.cancelled_at) continue;
      const e = m.get(r.plan_id) ?? { first: r, confirmed: 0, skipped: 0, open: 0, next: null };
      if (r.status === "confirmed") e.confirmed++;
      else if (r.status === "skipped") e.skipped++;
      else if (r.status === "planned") {
        e.open++;
        if (r.use_date > today && (!e.next || r.use_date < e.next)) e.next = r.use_date;
      }
      m.set(r.plan_id, e);
    }
    return [...m.values()].filter((p) => p.open > 0).sort((a, b) => a.first.product_name.localeCompare(b.first.product_name, "lt"));
  }, [rows, today]);

  const qtyOf = (r: PlannedDayRow) => (qty[r.id] ?? String(r.qty)).trim();
  const chosen = due.filter((r) => selected.has(r.id));
  const badQty = chosen.some((r) => !(Number(qtyOf(r)) > 0));
  const byProduct = new Map<string, number>();
  for (const r of chosen) byProduct.set(r.product_id, round((byProduct.get(r.product_id) ?? 0) + (Number(qtyOf(r)) || 0)));
  const shortages = [...byProduct]
    .map(([id, need]) => ({ p: products.find((x) => x.id === id), need }))
    .filter((x) => x.p && x.need > x.p.on_hand + 1e-9);

  const items = JSON.stringify(chosen.map((r) => ({ id: r.id, qty: Number(qtyOf(r)) })));
  const allTicked = due.length > 0 && chosen.length === due.length;

  if (due.length === 0 && plans.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <CalendarClock className="size-4 text-accent" />
          <h2 className="text-[14px] font-bold text-text-primary">Biocidų planas — laukia patvirtinimo</h2>
          {due.length > 0 && <Badge tone={due.some((r) => r.use_date < today) ? "warning" : "accent"}>{due.length}</Badge>}
        </div>

        {state && !state.ok && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
        {state?.ok && <p className="rounded-control bg-success-soft px-3 py-2 text-[13px] text-success">{state.message}</p>}

        {due.length === 0 ? (
          <p className="text-[13px] text-text-muted">Šiandien tvirtinti nėra ką.</p>
        ) : (
          <form action={formAction} className="space-y-3">
            <input type="hidden" name="items" value={items} />
            <div className="overflow-auto rounded-control border border-border">
              <table className="w-full min-w-[620px] text-left text-[13px]">
                <thead className="border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th className="w-9 px-3 py-2">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={allTicked}
                        onChange={() => setSelected(allTicked ? new Set() : new Set(due.map((r) => r.id)))}
                        aria-label="Pažymėti visas"
                      />
                    </th>
                    <th className="px-2 py-2">Data</th>
                    <th className="px-2 py-2">Produktas</th>
                    <th className="px-2 py-2">Tikslas</th>
                    <th className="w-[150px] px-2 py-2">Kiekis</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {due.map((r) => (
                    <tr key={r.id} className={selected.has(r.id) ? "bg-accent-soft/40" : undefined}>
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={selected.has(r.id)}
                          onChange={() =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(r.id)) next.delete(r.id);
                              else next.add(r.id);
                              return next;
                            })
                          }
                          aria-label={`Pažymėti ${r.use_date}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {formatDate(r.use_date)} {r.use_date === today ? <Badge tone="accent">Šiandien</Badge> : <Badge tone="warning">Praleista</Badge>}
                      </td>
                      <td className="px-2 py-1.5 font-medium text-text-primary">{r.product_name}</td>
                      <td className="px-2 py-1.5 text-text-secondary">{r.purpose ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            className="h-8 w-24"
                            value={qty[r.id] ?? String(r.qty)}
                            onChange={(e) => setQty((q) => ({ ...q, [r.id]: e.target.value }))}
                            aria-label="Kiekis"
                          />
                          <span className="text-text-muted">{r.unit}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {shortages.length > 0 && (
              <p className="flex items-start gap-1.5 rounded-control bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {shortages.map((s) => `${s.p!.name}: reikia ${formatQty(s.need, s.p!.unit)}, yra ${formatQty(s.p!.on_hand, s.p!.unit)}`).join("; ")} — nepakankant likučio
                neįrašoma nė viena diena. Pirmiausia užpajamuokite atsargas.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" name="intent" value="confirm" disabled={pending || chosen.length === 0 || badQty || shortages.length > 0}>
                <Check className="size-4" /> {pending ? "Saugoma..." : `Patvirtinti (${chosen.length})`}
              </Button>
              <Button
                type="submit"
                name="intent"
                value="skip"
                variant="outline"
                disabled={pending || chosen.length === 0}
                onClick={(e) => {
                  if (!window.confirm(`Pažymėti ${chosen.length} d. kaip nenaudotas? Niekas nebus nurašyta.`)) e.preventDefault();
                }}
              >
                Nenaudota
              </Button>
              <span className="text-[12px] text-text-secondary">
                {badQty ? <span className="text-danger">Kiekis turi būti didesnis už 0.</span> : "Kiekviena diena įrašoma į žurnalą savo data, nurašoma FEFO."}
              </span>
            </div>
          </form>
        )}

        {plans.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3">
            <h3 className="text-[12px] font-bold uppercase tracking-wide text-text-secondary">Aktyvūs planai</h3>
            {plans.map(({ first: p, confirmed, skipped, open, next }) => (
              <div key={p.plan_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                <span className="font-medium text-text-primary">{p.product_name}</span>
                <span className="text-text-secondary">
                  {formatQty(p.qty_per_day, p.unit)} / d. · {formatDate(p.start_date)} – {formatDate(p.end_date)}
                  {p.purpose ? ` · ${p.purpose}` : ""}
                </span>
                <span className="text-[12px] text-text-muted">
                  patvirtinta {confirmed}
                  {skipped > 0 ? `, nenaudota ${skipped}` : ""}, liko {open}
                  {next ? ` · kita ${formatDate(next)}` : ""}
                </span>
                <div className="ml-auto">
                  <CancelPlanButton planId={p.plan_id} />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Merge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";
import { formatDate, formatQty } from "@/lib/utils";
import type { Database } from "@/lib/supabase/types";

type Row = Database["public"]["Views"]["vw_product_duplicates"]["Row"];

/** The product the merge should keep by default: DelPro-linked, then most used, then oldest. */
function defaultKeep(rows: Row[]): string {
  return [...rows].sort(
    (a, b) =>
      Number(!!b.delpro_key) - Number(!!a.delpro_key) ||
      b.usage_count - a.usage_count ||
      a.created_at.localeCompare(b.created_at),
  )[0].id;
}

// Produktai → Sujungti dublikatus (0062). Products with the same name split the
// stock (FEFO only sees one of them) — merge_products() moves everything onto one.
export function DuplicateProducts({ rows, canMerge }: { rows: Row[]; canMerge: boolean }) {
  const router = useRouter();
  const groups = React.useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) m.set(r.group_key, [...(m.get(r.group_key) ?? []), r]);
    return [...m.values()];
  }, [rows]);
  const [keep, setKeep] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  if (groups.length === 0) return null;

  async function merge(group: Row[]) {
    const key = group[0].group_key;
    const keepId = keep[key] ?? defaultKeep(group);
    const kept = group.find((r) => r.id === keepId);
    const others = group.filter((r) => r.id !== keepId);
    if (!kept) return;
    if (others.some((o) => o.unit !== kept.unit)) {
      setError(`„${kept.name}“: skirtingi matavimo vienetai — tokių sujungti negalima.`);
      return;
    }
    if (!window.confirm(`Sujungti ${others.length} produkt. į „${kept.name}“? Atsargos, istorija ir protokolai bus perkelti, dublikatas ištrintas.`)) return;
    setBusy(key);
    setError(null);
    for (const o of others) {
      try {
        const res = await fetch("/api/produktai/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keep: keepId, remove: o.id }),
        });
        const result: { error: string | null } = await res.json();
        if (result.error) {
          setError(result.error);
          break;
        }
      } catch {
        setError("Nepavyko sujungti — patikrinkite ryšį.");
        break;
      }
    }
    setBusy(null);
    router.refresh();
  }

  return (
    <div className="mb-4 rounded-panel border border-warning/40 bg-warning-soft/40 p-4">
      <h2 className="flex items-center gap-2 text-[14px] font-bold text-warning">
        <AlertTriangle className="size-4" /> Produktai tuo pačiu pavadinimu ({groups.length})
      </h2>
      <p className="mt-1 text-[12.5px] text-text-secondary">
        Atsargos išsiskirsto tarp dublikatų — gydant ir įrašant protokolo žingsnius matomas tik vieno produkto likutis.
        {canMerge ? " Pažymėkite, kurį palikti, ir sujunkite." : " Sujungti gali administratorius."}
      </p>
      {error && <p className="mt-2 rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
      <div className="mt-3 space-y-3">
        {groups.map((g) => {
          const key = g[0].group_key;
          const keepId = keep[key] ?? defaultKeep(g);
          return (
            <div key={key} className="overflow-x-auto rounded-control border border-border bg-surface">
              <table className="w-full min-w-[760px] text-left text-[13px]">
                <tbody className="divide-y divide-border">
                  {g.map((r) => (
                    <tr key={r.id} className={r.id === keepId ? "bg-accent-soft/40" : undefined}>
                      <td className="w-24 px-3 py-2">
                        {canMerge && (
                          <label className="flex items-center gap-1.5 text-[12px]">
                            <input type="radio" name={`keep-${key}`} checked={r.id === keepId} onChange={() => setKeep({ ...keep, [key]: r.id })} />
                            Palikti
                          </label>
                        )}
                      </td>
                      <td className="px-3 py-2 font-medium text-text-primary">
                        {r.name} {!r.is_active && <Badge tone="neutral">Neaktyvus</Badge>}
                      </td>
                      <td className="px-3 py-2 text-text-secondary">
                        {PRODUCT_CATEGORY_LABELS[r.category]} · {r.unit}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-text-secondary">Likutis {formatQty(Number(r.stock_qty), r.unit)}</td>
                      <td className="px-3 py-2 tabular-nums text-text-secondary">Naudota {r.usage_count} k.</td>
                      <td className="px-3 py-2 text-text-secondary">
                        Karencija {r.withdrawal_days_milk}/{r.withdrawal_days_meat} d.
                      </td>
                      <td className="px-3 py-2">{r.delpro_key ? <Badge tone="success">DelPro {r.delpro_key}</Badge> : <span className="text-text-muted">—</span>}</td>
                      <td className="px-3 py-2 text-text-muted">sukurta {formatDate(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {canMerge && (
                <div className="flex justify-end border-t border-border p-2">
                  <Button type="button" size="sm" disabled={busy !== null} onClick={() => merge(g)}>
                    <Merge className="size-4" /> {busy === key ? "Jungiama..." : "Sujungti į pažymėtą"}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

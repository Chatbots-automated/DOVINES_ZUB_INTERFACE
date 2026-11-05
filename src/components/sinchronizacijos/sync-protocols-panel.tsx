"use client";

import * as React from "react";
import { Dna, Pencil, Pill, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ProtocolDialog } from "@/components/sinchronizacijos/protocol-dialog";
import { stepDayLabel, type SyncProductOption, type SyncProtocolData } from "@/lib/sync-protocols";
import { formatQty } from "@/lib/utils";

// The farm's protocol templates (0025) — the same ProtocolDialog the picker uses.
// Editing a protocol never changes visits that were already planned from it.
export function SyncProtocolsPanel({
  protocols,
  products,
  usage,
  canWrite,
}: {
  protocols: SyncProtocolData[];
  products: SyncProductOption[];
  /** protocol id → running applications */
  usage: Record<string, number>;
  canWrite: boolean;
}) {
  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-text-secondary">
          Pakeitus ar pašalinus protokolą, jau suplanuoti vizitai nesikeičia — jie turi savo žingsnių kopiją.
        </p>
        {canWrite && <ProtocolDialog products={products} />}
      </div>
      {protocols.length === 0 ? (
        <EmptyState icon={Repeat} title="Protokolų dar nėra" className="rounded-panel border border-border bg-surface py-10" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {protocols.map((p) => (
            <div key={p.id} className="rounded-panel border border-border bg-surface">
              <div className="flex items-start gap-2 border-b border-border px-4 py-3">
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold text-text-primary">{p.name}</h3>
                  {p.description && <p className="text-[12px] text-text-secondary">{p.description}</p>}
                  <p className="text-[11.5px] text-text-muted">
                    {p.steps.length} žingsn. · trukmė {Math.max(0, ...p.steps.map((s) => s.day_offset))} d.
                    {usage[p.id] ? ` · vykdomas ${usage[p.id]} gyv.` : ""}
                  </p>
                </div>
                {canWrite && (
                  <ProtocolDialog
                    protocol={p}
                    products={products}
                    trigger={
                      <Button type="button" size="sm" variant="outline">
                        <Pencil className="size-4" /> Redaguoti
                      </Button>
                    }
                  />
                )}
              </div>
              <ol className="divide-y divide-border">
                {p.steps.map((s, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-1.5 text-[13px]">
                    <span className="w-12 shrink-0 font-semibold tabular-nums text-text-primary">{stepDayLabel(s.day_offset)}</span>
                    <span className="min-w-0 flex-1">{s.title}</span>
                    {s.kind === "sekinimas" && (
                      <span className="flex items-center gap-1 text-[12px] text-accent-alt">
                        <Dna className="size-3" /> Sėklinimas
                      </span>
                    )}
                    {s.medications.map((m, j) => (
                      <span key={j} className="flex items-center gap-1 text-[12px] text-text-muted">
                        <Pill className="size-3" /> {productById.get(m.product_id)?.name ?? "?"} {formatQty(Number(m.qty), m.unit)}
                      </span>
                    ))}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

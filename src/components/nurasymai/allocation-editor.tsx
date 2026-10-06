"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { saveAllocations, type WriteOffActionResult } from "@/lib/actions/write-offs";
import { formatEur, formatQty } from "@/lib/utils";

export type AllocationInput = {
  write_off_group_id: string | null;
  label: string;
  quantity: number;
  animal_count: number | null;
  suggested: boolean;
};
export type AllocationTarget = { id: string; label: string };
type Row = { key: string; groupId: string; quantity: string; animal_count: string };

const TOLERANCE = 0.001;

function toRows(allocations: AllocationInput[]): Row[] {
  return allocations.map((a) => ({
    key: crypto.randomUUID(),
    groupId: a.write_off_group_id ?? "",
    quantity: String(a.quantity),
    animal_count: a.animal_count == null ? "" : String(a.animal_count),
  }));
}

/**
 * One nurašymo akto line (product, total quantity) + its paskirstymas into
 * the template's group columns (Priedas §2.9). The split must add up to the
 * total and nothing may stay "Nepriskirta" before the act can be approved;
 * "Likusį priskirti" puts the remainder on a row so the user never has to
 * do the arithmetic.
 */
export function AllocationEditor({
  actId,
  itemId,
  lineNo,
  productName,
  nomenclatureNo,
  lots,
  unit,
  quantity,
  unitPrice,
  totalPrice,
  allocations,
  targets,
  editable,
}: {
  actId: string;
  itemId: string;
  lineNo: number;
  productName: string;
  nomenclatureNo: string | null;
  lots: string | null;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  allocations: AllocationInput[];
  targets: AllocationTarget[];
  editable: boolean;
}) {
  const [rows, setRows] = React.useState<Row[]>(() => toRows(allocations));
  const [dirty, setDirty] = React.useState(false);
  const [state, formAction, pending] = useActionState<WriteOffActionResult | null, FormData>(saveAllocations, null);

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) setDirty(false);
  }

  const allocated = rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
  const diff = quantity - allocated;
  const balanced = Math.abs(diff) <= TOLERANCE;
  const unassigned = rows.some((r) => !r.groupId && (Number(r.quantity) || 0) > 0);

  function update(key: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  }
  function addRow(prefillRemainder = false) {
    const used = new Set(rows.map((r) => r.groupId));
    const nextGroup = targets.find((t) => !used.has(t.id))?.id ?? "";
    setRows((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        groupId: nextGroup,
        quantity: prefillRemainder && diff > 0 ? String(Number(diff.toFixed(4))) : "",
        animal_count: "",
      },
    ]);
    setDirty(true);
  }
  function remove(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
    setDirty(true);
  }

  const payload = JSON.stringify(
    rows.map((r) => ({
      write_off_group_id: r.groupId || null,
      quantity: Number(r.quantity) || 0,
      animal_count: r.animal_count ? Number(r.animal_count) : null,
    })),
  );

  return (
    <div className="rounded-panel border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-text-primary">
            {lineNo}. {productName}
            {nomenclatureNo && <span className="ml-2 text-[12px] font-normal text-text-muted">Nom. Nr. {nomenclatureNo}</span>}
          </p>
          <p className="text-[12px] text-text-muted">
            {lots ? `Serija: ${lots} · ` : ""}
            {formatQty(quantity, unit)} × {formatEur(unitPrice)} = <span className="font-medium text-text-secondary">{formatEur(totalPrice)}</span>
          </p>
        </div>
        <Badge tone={balanced && !unassigned ? "success" : "danger"}>
          {!balanced
            ? diff > 0
              ? `Nepaskirstyta ${formatQty(Number(diff.toFixed(4)), unit)}`
              : `Viršyta ${formatQty(Number((-diff).toFixed(4)), unit)}`
            : unassigned
              ? "Yra nepriskirto kiekio"
              : "Paskirstyta"}
        </Badge>
      </div>

      <form action={formAction} className="px-4 py-3">
        <input type="hidden" name="item_id" value={itemId} />
        <input type="hidden" name="act_id" value={actId} />
        <input type="hidden" name="rows" value={payload} />

        <div className="grid grid-cols-[minmax(0,1fr)_110px_90px_36px] gap-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
          <span>Grupė</span>
          <span>Kiekis ({unit ?? "vnt"})</span>
          <span>Gyv. sk.</span>
          <span />
        </div>
        <div className="mt-1 space-y-1.5">
          {rows.map((r) => (
            <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_110px_90px_36px] gap-2">
              <Select
                value={r.groupId}
                onChange={(e) => update(r.key, { groupId: e.target.value })}
                disabled={!editable}
                className={`h-8 ${!r.groupId ? "border-danger text-danger" : ""}`}
              >
                <option value="">Nepriskirta grupei</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
              <Input
                type="number"
                step="any"
                min="0"
                value={r.quantity}
                onChange={(e) => update(r.key, { quantity: e.target.value })}
                disabled={!editable}
                className="h-8"
              />
              <Input
                type="number"
                min="0"
                value={r.animal_count}
                onChange={(e) => update(r.key, { animal_count: e.target.value })}
                disabled={!editable}
                className="h-8"
              />
              {editable ? (
                <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => remove(r.key)}>
                  <Trash2 className="size-4" />
                </Button>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>

        {editable && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => addRow(false)}>
              <Plus className="size-4" /> Eilutė
            </Button>
            {diff > TOLERANCE && (
              <Button type="button" size="sm" variant="ghost" onClick={() => addRow(true)}>
                Likusį priskirti
              </Button>
            )}
            <Button type="submit" size="sm" disabled={pending || !dirty} className="ml-auto">
              {pending ? "Saugoma..." : dirty ? "Išsaugoti paskirstymą" : "Išsaugota"}
            </Button>
            {state && !state.ok && <span className="w-full text-right text-[12px] text-danger">{state.error}</span>}
          </div>
        )}
      </form>
    </div>
  );
}

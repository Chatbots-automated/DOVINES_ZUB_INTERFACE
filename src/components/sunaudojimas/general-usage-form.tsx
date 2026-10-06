"use client";

import * as React from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createGeneralUsage, type GeneralUsageActionResult } from "@/lib/actions/general-usage";
import { WRITE_OFF_KIND_OPTIONS } from "@/lib/write-off-kinds";
import { formatQty } from "@/lib/utils";
import type { WriteOffKind } from "@/lib/supabase/types";

export type UsageProduct = {
  id: string;
  name: string;
  unit: string;
  kind: WriteOffKind;
  stock: number;
  default_group_id: string | null;
};
export type UsageGroup = { id: string; name: string; act_kinds: WriteOffKind[] };

type Mode = "qty" | "remaining";
type RowState = { value: string; groupId: string };

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Sunaudojimas be gyvulio: one row per product in stock, filtered by act
 * template. "Likutis" mode is the farm's Excel stock count (=161-4): the
 * user enters what is left on the shelf and create_general_usage() books
 * apskaitinis likutis − suskaičiuotas likutis as used.
 */
export function GeneralUsageForm({ products, groups }: { products: UsageProduct[]; groups: UsageGroup[] }) {
  const [kind, setKind] = React.useState<WriteOffKind>("medziagos");
  const [mode, setMode] = React.useState<Mode>("qty");
  const [rows, setRows] = React.useState<Record<string, RowState>>({});
  const [state, formAction, pending] = useActionState<GeneralUsageActionResult | null, FormData>(createGeneralUsage, null);

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) setRows({});
  }

  const kindProducts = products.filter((p) => p.kind === kind);
  const kindGroups = groups.filter((g) => g.act_kinds.includes(kind));

  const rowFor = (p: UsageProduct): RowState => rows[p.id] ?? { value: "", groupId: p.default_group_id ?? "" };
  function update(p: UsageProduct, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [p.id]: { ...rowFor(p), ...patch } }));
  }

  // Usage implied by each row, for the preview column + payload.
  function usedQty(p: UsageProduct): number | null {
    const raw = rowFor(p).value.trim();
    if (raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return mode === "qty" ? n : Number((p.stock - n).toFixed(4));
  }

  // Rows of every tab are submitted, so switching tabs doesn't drop input.
  const filled = products.filter((p) => (rows[p.id]?.value ?? "").trim() !== "");
  const payload = JSON.stringify(
    filled.map((p) => {
      const r = rowFor(p);
      const groupValid = groups.some((g) => g.id === r.groupId && g.act_kinds.includes(p.kind));
      return {
        product_id: p.id,
        [mode === "qty" ? "qty" : "remaining"]: Number(r.value),
        write_off_group_id: groupValid ? r.groupId : null,
      };
    }),
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="items" value={payload} />

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="use_date">Data</Label>
          <Input id="use_date" name="use_date" type="date" defaultValue={today()} className="w-[170px]" />
        </div>
        <div className="min-w-[220px] flex-1">
          <Label htmlFor="notes">Pastabos</Label>
          <Input id="notes" name="notes" placeholder="pvz. mėnesio inventorizacija" />
        </div>
        <div>
          <Label>Įvesti</Label>
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList>
              <TabsTrigger value="qty">Sunaudotą kiekį</TabsTrigger>
              <TabsTrigger value="remaining">Likutį (inventorizacija)</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <p className="text-[12px] text-text-muted">
        {mode === "qty"
          ? "Įveskite, kiek produkto sunaudota. Kiekis nurašomas iš atsargų pagal galiojimą (FEFO)."
          : "Įveskite suskaičiuotą likutį lentynoje. Sunaudota = apskaitinis likutis − suskaičiuotas likutis (kaip Excel lentelėje, pvz. 161 − 4)."}
      </p>

      <Tabs value={kind} onValueChange={(v) => setKind(v as WriteOffKind)}>
        <TabsList>
          {WRITE_OFF_KIND_OPTIONS.map((o) => {
            const n = products.filter((p) => p.kind === o.value && (rows[p.id]?.value ?? "").trim() !== "").length;
            return (
              <TabsTrigger key={o.value} value={o.value}>
                {o.label}
                {n > 0 && ` (${n})`}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {kindProducts.length === 0 ? (
        <p className="rounded-panel border border-border bg-surface px-4 py-8 text-center text-[13px] text-text-muted">
          Šio tipo produktų su likučiu nėra.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-border bg-surface">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-4 py-2.5 font-medium">Produktas</th>
                <th className="px-4 py-2.5 font-medium">Apskaitinis likutis</th>
                <th className="px-4 py-2.5 font-medium">{mode === "qty" ? "Sunaudota" : "Suskaičiuota"}</th>
                <th className="px-4 py-2.5 font-medium">{mode === "qty" ? "Liks" : "Sunaudota"}</th>
                <th className="px-4 py-2.5 font-medium">Grupė</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {kindProducts.map((p) => {
                const r = rowFor(p);
                const used = usedQty(p);
                const bad = used !== null && (used < 0 || used > p.stock + 0.0001);
                return (
                  <tr key={p.id}>
                    <td className="px-4 py-2 font-medium text-text-primary">{p.name}</td>
                    <td className="px-4 py-2 tabular-nums text-text-secondary">{formatQty(p.stock, p.unit)}</td>
                    <td className="px-4 py-2">
                      <Input
                        type="number"
                        step="any"
                        min="0"
                        value={r.value}
                        onChange={(e) => update(p, { value: e.target.value })}
                        className="h-8 w-[120px]"
                        aria-label={`${p.name} kiekis`}
                      />
                    </td>
                    <td className={`px-4 py-2 tabular-nums ${bad ? "text-danger" : "text-text-secondary"}`}>
                      {used === null ? "—" : mode === "qty" ? formatQty(Number((p.stock - used).toFixed(4)), p.unit) : formatQty(used, p.unit)}
                    </td>
                    <td className="px-4 py-2">
                      <Select
                        value={kindGroups.some((g) => g.id === r.groupId) ? r.groupId : ""}
                        onChange={(e) => update(p, { groupId: e.target.value })}
                        className="h-8 w-[200px]"
                        aria-label={`${p.name} grupė`}
                      >
                        <option value="">Nepriskirta</option>
                        {kindGroups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {state && !state.ok && <span className="text-[13px] text-danger">{state.error}</span>}
        {state?.ok && <span className="text-[13px] text-success">Įrašyta: {state.count ?? 0}</span>}
        <span className="text-[12px] text-text-muted">Užpildyta eilučių: {filled.length}</span>
        <Button type="submit" disabled={pending || filled.length === 0}>
          {pending ? "Saugoma..." : "Įrašyti sunaudojimą"}
        </Button>
      </div>
    </form>
  );
}

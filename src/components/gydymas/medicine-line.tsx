"use client";

import * as React from "react";
import { AlertTriangle, Info, ShieldAlert, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { MedicinePicker } from "@/components/gydymas/medicine-picker";
import { ADMINISTRATION_ROUTES, getRouteWithdrawalDays } from "@/lib/administration-routes";
import { addDays, previewFefo, type CatalogProduct, type MedLine } from "@/lib/treatments/planner";
import { formatDate, formatQty } from "@/lib/utils";
import type { AdministrationRoute } from "@/lib/supabase/types";

export function RouteSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">Būdas nepasirinktas</option>
      {ADMINISTRATION_ROUTES.map((r) => (
        <option key={r.code} value={r.code}>
          {r.fullLabel}
        </option>
      ))}
      <option value="kita">Kita</option>
    </Select>
  );
}

/** Karencija chips (milk / meat) for a product + route, as days and end date. */
export function WithdrawalChips({ product, route, fromDate }: { product: CatalogProduct; route: string; fromDate: string }) {
  const r = (route || null) as AdministrationRoute | null;
  const milk = getRouteWithdrawalDays(product, r, "milk");
  const meat = getRouteWithdrawalDays(product, r, "meat");
  return (
    <>
      <Badge tone="warning" title={`Pienas — karencija iki ${formatDate(addDays(fromDate, milk + 1))}`}>
        🥛 {milk} d. · iki {formatDate(addDays(fromDate, milk + 1))}
      </Badge>
      <Badge tone="danger" title={`Mėsa — karencija iki ${formatDate(addDays(fromDate, meat + 1))}`}>
        🥩 {meat} d. · iki {formatDate(addDays(fromDate, meat + 1))}
      </Badge>
    </>
  );
}

// One medicine given today (day 1 of the treatment): product, dose, route,
// plus live stock / FEFO lot / karencija / antimicrobial feedback.
export function MedicineLine({
  line,
  catalog,
  productById,
  loading,
  regDate,
  nowByProduct,
  courseDoses,
  onChange,
  onRemove,
}: {
  line: MedLine;
  catalog: CatalogProduct[];
  productById: Map<string, CatalogProduct>;
  loading: boolean;
  regDate: string;
  /** Total day-1 quantity per product across all lines (several lines may share one product). */
  nowByProduct: Map<string, number>;
  /** Doses in the planned course incl. today (1 = no course). */
  courseDoses: number;
  onChange: (patch: Partial<MedLine>) => void;
  onRemove: () => void;
}) {
  const product = productById.get(line.product_id);
  const qty = Number(line.qty);
  const needed = product ? (nowByProduct.get(product.id) ?? 0) : 0;
  const short = !!product && product.usable_qty !== null && needed > product.usable_qty + 1e-9;
  const fefo = product && product.usable_qty !== null && qty > 0 && !short ? previewFefo(product, needed) : [];

  return (
    <div className={`rounded-control border bg-surface p-3 ${short ? "border-danger/50" : "border-border"}`}>
      <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1.6fr)_130px_minmax(0,1fr)_36px]">
        <div>
          <Label className="mb-1">Produktas</Label>
          <MedicinePicker catalog={catalog} value={line.product_id} onChange={(id) => onChange({ product_id: id })} loading={loading} />
        </div>
        <div>
          <Label className="mb-1">Dozė {product ? `(${product.unit})` : ""}</Label>
          <Input type="number" step="0.01" min="0" value={line.qty} onChange={(e) => onChange({ qty: e.target.value })} placeholder="0" />
        </div>
        <div>
          <Label className="mb-1">Skyrimo būdas</Label>
          <RouteSelect value={line.route} onChange={(v) => onChange({ route: v })} />
        </div>
        <Button type="button" size="icon" variant="outline" onClick={onRemove} aria-label="Pašalinti vaistą">
          <Trash2 className="size-4" />
        </Button>
      </div>

      {product && (
        <div className="mt-2.5 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {product.usable_qty !== null && (
              <Badge tone={short ? "danger" : product.usable_qty > 0 ? "success" : "danger"}>
                Likutis: {formatQty(product.usable_qty, product.unit)}
              </Badge>
            )}
            {product.is_antimicrobial && (
              <Badge tone="danger">
                <ShieldAlert className="size-3" /> Antimikrobinis vaistas
              </Badge>
            )}
            <WithdrawalChips product={product} route={line.route} fromDate={regDate} />
            {courseDoses > 1 && qty > 0 && (
              <Badge tone="accent" title="Dozė × dozių skaičius kurse">
                {formatQty(qty, product.unit)} × {courseDoses} = {formatQty(Math.round(qty * courseDoses * 1000) / 1000, product.unit)}
              </Badge>
            )}
          </div>

          {short && product.usable_qty !== null && (
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-danger">
              <AlertTriangle className="size-3.5" /> Nepakanka atsargų: reikia {formatQty(needed, product.unit)}, yra {formatQty(product.usable_qty, product.unit)}.
            </p>
          )}
          {fefo.length > 0 && (
            <p className="text-[11.5px] text-text-secondary">
              FEFO nurašys:{" "}
              {fefo.map((f, i) => (
                <span key={f.lot.id}>
                  {i > 0 && " + "}
                  <span className="font-medium text-text-primary">
                    {f.lot.lot ?? "—"} {formatQty(f.take, product.unit)}
                  </span>{" "}
                  (iki {formatDate(f.lot.expiry_date)})
                </span>
              ))}
            </p>
          )}
          {product.expired_qty > 0 && (
            <p className="text-[11.5px] text-warning">Pasibaigusio galiojimo partijų ({formatQty(product.expired_qty, product.unit)}) nenaudojame.</p>
          )}
          {product.dosage_notes && (
            <p className="flex items-start gap-1.5 text-[11.5px] text-text-muted">
              <Info className="mt-0.5 size-3 shrink-0" /> {product.dosage_notes}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

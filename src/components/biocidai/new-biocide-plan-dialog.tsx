"use client";

import * as React from "react";
import { useActionState } from "react";
import { CalendarPlus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { createBiocidePlan, type PlanActionResult } from "@/lib/actions/biocides";
import type { BiocideProduct } from "@/components/biocidai/new-biocide-dialog";
import { addDaysIso, daysBetween } from "@/lib/vaccinations";
import { formatDate, formatQty } from "@/lib/utils";

const PURPOSE_SUGGESTIONS = ["Dezinfekcija", "Dezinsekcija (muses)", "Deratizacija", "Nagų vonelė", "Spenų dezinfekcija", "Patalpų plovimas ir dezinfekcija"];
const PERIODS = [
  { label: "7 d.", days: 7 },
  { label: "14 d.", days: 14 },
  { label: "1 mėn.", days: 30 },
  { label: "2 mėn.", days: 61 },
];

// Biocidų planas (0057, farm's request — billed separately): e.g. 10 l every day for a
// month. Creates one planned day per date; nothing is written off until it is confirmed.
export function NewBiocidePlanDialog({ products, today }: { products: BiocideProduct[]; today: string }) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<PlanActionResult | null, FormData>(createBiocidePlan, null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const [productId, setProductId] = React.useState<string | null>(null);
  const [qty, setQty] = React.useState("");
  const [start, setStart] = React.useState(today);
  const [end, setEnd] = React.useState(addDaysIso(today, 29));

  const productOptions: ComboboxOption[] = React.useMemo(
    () => products.map((p) => ({ value: p.id, label: p.name, sublabel: `likutis ${formatQty(p.on_hand, p.unit)}` })),
    [products],
  );
  const product = products.find((p) => p.id === productId);
  const days = start && end && end >= start ? daysBetween(start, end) + 1 : 0;
  const total = Number(qty) > 0 ? Math.round(Number(qty) * days * 1000) / 1000 : 0;

  function reset() {
    setProductId(null);
    setQty("");
    setStart(today);
    setEnd(addDaysIso(today, 29));
  }

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) {
      setOpen(false);
      reset();
    }
  }
  React.useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const problem =
    !productId ? "Pasirinkite produktą." :
    !(Number(qty) > 0) ? "Nurodykite kiekį per dieną." :
    days === 0 ? "Pabaiga negali būti ankstesnė už pradžią." :
    days > 93 ? "Planas — ne ilgiau kaip 3 mėnesiai." :
    null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset();
          formRef.current?.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <CalendarPlus className="size-4" /> Naujas planas
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Biocido naudojimo planas</DialogTitle>
        </DialogHeader>
        <form ref={formRef} action={formAction}>
          <DialogBody className="space-y-4">
            {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
            <input type="hidden" name="product_id" value={productId ?? ""} />

            <div>
              <Label>Produktas *</Label>
              <Combobox options={productOptions} value={productId} onChange={setProductId} placeholder="Pasirinkite biocidą..." />
            </div>

            <div>
              <Label htmlFor="qty_per_day">Kiekis per dieną {product ? `(${product.unit})` : ""} *</Label>
              <Input id="qty_per_day" name="qty_per_day" type="number" step="0.01" min="0" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="plan_start">Nuo</Label>
                <Input id="plan_start" name="start_date" type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="plan_end">Iki (imtinai)</Label>
                <Input id="plan_end" name="end_date" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} required />
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {PERIODS.map((p) => (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => setEnd(addDaysIso(start || today, p.days - 1))}
                  className="rounded-control bg-surface-secondary px-2 py-0.5 text-[12px] text-text-secondary hover:bg-border"
                >
                  {p.label}
                </button>
              ))}
            </div>

            {product && days > 0 && Number(qty) > 0 && (
              <p className="text-[12px] text-text-secondary">
                {days} d. × {formatQty(Number(qty), product.unit)} = <span className="font-semibold">{formatQty(total, product.unit)}</span>
                {" "}({formatDate(start)} – {formatDate(end)}).{" "}
                {total > product.on_hand && (
                  <span className="text-warning">
                    Dabartinio likučio ({formatQty(product.on_hand, product.unit)}) visam planui neužtenka — dienas bus galima patvirtinti, kai bus atsargų.
                  </span>
                )}
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="plan_purpose">Tikslas</Label>
                <Input id="plan_purpose" name="purpose" list="biocide-plan-purposes" placeholder="Nagų vonelė, dezinfekcija..." />
                <datalist id="biocide-plan-purposes">
                  {PURPOSE_SUGGESTIONS.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
              <div>
                <Label htmlFor="plan_used_by">Atliko</Label>
                <Input id="plan_used_by" name="used_by_name" placeholder="Vardas, pavardė" />
              </div>
            </div>
            <div>
              <Label htmlFor="plan_scope">Darbų apimtis</Label>
              <Textarea id="plan_scope" name="work_scope" rows={2} placeholder="Kur ir kokia apimtimi" />
            </div>
            <p className="text-[11.5px] text-text-muted">
              Kiekviena plano diena nurašoma tik ją patvirtinus skiltyje „Laukia patvirtinimo“. Praleistas dienas galima patvirtinti vėliau — į žurnalą jos įrašomos savo datomis.
            </p>
          </DialogBody>
          <DialogFooter>
            <div className="mr-auto self-center text-[12px] text-danger">{problem && productId ? problem : null}</div>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Atšaukti
            </Button>
            <Button type="submit" disabled={pending || !!problem}>
              {pending ? "Saugoma..." : "Sukurti planą"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

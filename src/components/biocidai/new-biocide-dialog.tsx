"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { createBiocideUsage, type ActionResult } from "@/lib/actions/biocides";
import { formatDate, formatQty } from "@/lib/utils";

export type BiocideProduct = {
  id: string;
  name: string;
  unit: string;
  /** Usable (non-expired) stock — what FEFO can actually consume. */
  on_hand: number;
  expired: number;
  next_lot: { lot: string | null; expiry_date: string | null } | null;
};

const PURPOSE_SUGGESTIONS = ["Dezinfekcija", "Dezinsekcija (muses)", "Deratizacija", "Nagų vonelė", "Spenų dezinfekcija", "Patalpų plovimas ir dezinfekcija"];

export function NewBiocideDialog({ products, today }: { products: BiocideProduct[]; today: string }) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createBiocideUsage, null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const [productId, setProductId] = React.useState<string | null>(null);
  const productOptions: ComboboxOption[] = React.useMemo(
    () => products.map((p) => ({ value: p.id, label: p.name, sublabel: `likutis ${formatQty(p.on_hand, p.unit)}` })),
    [products],
  );
  const selectedProduct = products.find((p) => p.id === productId);
  const [qty, setQty] = React.useState("");
  const overStock = !!selectedProduct && Number(qty) > selectedProduct.on_hand;

  function resetOwnState() {
    setProductId(null);
    setQty("");
  }

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) {
      setOpen(false);
      resetOwnState();
    }
  }

  React.useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          resetOwnState();
          formRef.current?.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Naujas panaudojimas
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Naujas biocido panaudojimas</DialogTitle>
        </DialogHeader>
        <form ref={formRef} action={formAction}>
          <DialogBody className="space-y-4">
            {state && !state.ok && state.error && (
              <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>
            )}

            <input type="hidden" name="product_id" value={productId ?? ""} />
            <input type="hidden" name="unit" value={selectedProduct?.unit ?? ""} />

            <div>
              <Label>Produktas *</Label>
              <Combobox options={productOptions} value={productId} onChange={setProductId} placeholder="Pasirinkite biocidą..." />
              {selectedProduct && (
                <p className="mt-1.5 text-[12px] text-text-secondary">
                  Likutis: <span className="font-semibold">{formatQty(selectedProduct.on_hand, selectedProduct.unit)}</span>
                  {selectedProduct.next_lot &&
                    ` · bus nurašyta iš partijos ${selectedProduct.next_lot.lot ?? "—"}${selectedProduct.next_lot.expiry_date ? ` (iki ${formatDate(selectedProduct.next_lot.expiry_date)})` : ""} (FEFO)`}
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="use_date">Data</Label>
                <Input id="use_date" name="use_date" type="date" defaultValue={today} />
              </div>
              <div>
                <Label htmlFor="qty">Kiekis {selectedProduct ? `(${selectedProduct.unit})` : ""}</Label>
                <Input id="qty" name="qty" type="number" step="0.01" min="0" value={qty} onChange={(e) => setQty(e.target.value)} />
                {overStock && selectedProduct && (
                  <p className="mt-1 text-[12px] text-danger">Viršija likutį ({formatQty(selectedProduct.on_hand, selectedProduct.unit)}) — išsaugoti nepavyks.</p>
                )}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="purpose">Tikslas</Label>
                <Input id="purpose" name="purpose" list="biocide-purposes" placeholder="Dezinfekcija, kenkėjų kontrolė..." />
                <datalist id="biocide-purposes">
                  {PURPOSE_SUGGESTIONS.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
              <div>
                <Label htmlFor="used_by_name">Atliko</Label>
                <Input id="used_by_name" name="used_by_name" placeholder="Vardas, pavardė" />
              </div>
            </div>

            <div>
              <Label htmlFor="work_scope">Darbų apimtis</Label>
              <Textarea id="work_scope" name="work_scope" rows={2} placeholder="Kur ir kokia apimtimi atlikta" />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Atšaukti
            </Button>
            <Button type="submit" disabled={pending || !productId || overStock}>
              {pending ? "Saugoma..." : "Sukurti"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

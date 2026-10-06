"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus, Tags } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { createSubcategory, saveSubcategory, type SubcategoryActionResult } from "@/lib/actions/product-subcategories";
import { PRODUCT_CATEGORY_LABELS, PRODUCT_CATEGORY_OPTIONS } from "@/lib/product-categories";
import type { SubcategoryOption } from "@/lib/product-subcategories";

function SubcategoryRow({ sub, productCount }: { sub: SubcategoryOption; productCount: number }) {
  const [state, formAction, pending] = useActionState<SubcategoryActionResult | null, FormData>(saveSubcategory, null);
  return (
    <form action={formAction} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
      <input type="hidden" name="id" value={sub.id} />
      <Input name="name" defaultValue={sub.name} required aria-label={`Subkategorijos pavadinimas ${sub.name}`} />
      <label className="flex items-center gap-1.5 text-[12px] font-medium">
        <input type="checkbox" name="active" defaultChecked={sub.active} className="size-4 rounded border-border-strong" />
        Aktyvi
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "..." : "Išsaugoti"}
      </Button>
      <p className="col-span-3 -mt-1 text-[11px] text-text-muted">
        {productCount} prod.
        {state && !state.ok && <span className="ml-2 text-danger">{state.error}</span>}
        {state?.ok && <span className="ml-2 text-success">{state.message}</span>}
      </p>
    </form>
  );
}

// Produktų subkategorijų valdymas (pervadinti, išjungti, sukurti naują).
export function SubcategoryManager({ subcategories, counts }: { subcategories: SubcategoryOption[]; counts: Record<string, number> }) {
  const [createState, createAction, creating] = useActionState<SubcategoryActionResult | null, FormData>(createSubcategory, null);
  const formRef = React.useRef<HTMLFormElement>(null);
  React.useEffect(() => {
    if (createState?.ok) formRef.current?.reset();
  }, [createState]);

  const categories = PRODUCT_CATEGORY_OPTIONS.map((c) => c.value).filter((c) => subcategories.some((s) => s.category === c));

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Tags className="size-4" /> Subkategorijos
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Produktų subkategorijos</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {categories.length === 0 && <p className="text-[13px] text-text-muted">Subkategorijų dar nėra.</p>}
          {categories.map((c) => (
            <div key={c} className="space-y-2">
              <p className="text-[12px] font-bold uppercase tracking-wide text-text-secondary">{PRODUCT_CATEGORY_LABELS[c]}</p>
              {subcategories
                .filter((s) => s.category === c)
                .map((s) => (
                  <SubcategoryRow key={`${s.id}-${s.name}-${s.active}`} sub={s} productCount={counts[s.id] ?? 0} />
                ))}
            </div>
          ))}

          <form ref={formRef} action={createAction} className="space-y-2 rounded-panel border border-border bg-surface-secondary p-3">
            <p className="text-[13px] font-semibold text-text-primary">Nauja subkategorija</p>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
              <Select name="category" defaultValue="hoof_care" aria-label="Kategorija">
                {PRODUCT_CATEGORY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
              <Input name="name" required placeholder="Pavadinimas" aria-label="Pavadinimas" />
              <Button type="submit" size="sm" disabled={creating}>
                <Plus className="size-4" /> Sukurti
              </Button>
            </div>
            {createState && !createState.ok && <p className="text-[12px] text-danger">{createState.error}</p>}
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

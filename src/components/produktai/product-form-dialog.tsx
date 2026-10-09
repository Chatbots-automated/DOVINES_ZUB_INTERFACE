"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createProduct, updateProduct, type ProductActionResult, type ProductRow } from "@/lib/actions/products";
import { WithdrawalRouteFields } from "@/components/produktai/withdrawal-route-fields";
import { PRODUCT_CATEGORY_OPTIONS as CATEGORY_OPTIONS, WITHDRAWAL_REQUIRED_CATEGORIES } from "@/lib/product-categories";
import { WRITE_OFF_KINDS, WRITE_OFF_KIND_OPTIONS, productWriteOffKind } from "@/lib/write-off-kinds";
import type { ProductCategory, WriteOffKind } from "@/lib/supabase/types";
import type { SubcategoryOption } from "@/lib/product-subcategories";
import type { CreateSubcategoryResult } from "@/lib/actions/product-subcategories";

const UNIT_OPTIONS = [
  { value: "ml", label: "ml" },
  { value: "l", label: "l" },
  { value: "g", label: "g" },
  { value: "kg", label: "kg" },
  { value: "pcs", label: "vnt. (pcs)" },
  { value: "vnt", label: "vnt." },
  { value: "tablet", label: "tabletė" },
  { value: "dose", label: "dozė" },
];

export type WriteOffGroupOption = { id: string; name: string; act_kinds: WriteOffKind[] };

/**
 * Create (default) or edit (`product` given) a product card (Priedas §2.1),
 * including the nurašymo akto settings from 0012: which act it lands on,
 * Nom. Nr., the act unit (packages) and a default group for usage that has
 * no animal. `groups` is optional — callers that only need a quick create
 * (pajamavimas) can omit it and the group select is hidden. `defaults`
 * prefills a new product from an invoice line (unit, pack size) and shows
 * what the PDF said, so the user doesn't retype it.
 */
export type ProductFormDefaults = {
  unit?: string;
  packSize?: number | null;
  invoice?: { packageSize?: number | null; packageCount?: number | null; qty?: number | null };
};

export function ProductFormDialog({
  trigger,
  defaultName,
  defaults,
  product,
  groups,
  subcategories,
  open: openProp,
  onOpenChange,
  onCreated,
}: {
  trigger?: React.ReactNode;
  defaultName?: string;
  defaults?: ProductFormDefaults;
  product?: ProductRow;
  groups?: WriteOffGroupOption[];
  /** Existing subcategories; omit (pajamavimas quick-create) to hide the field. */
  subcategories?: SubcategoryOption[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCreated?: (product: ProductRow) => void;
}) {
  const editing = !!product;
  const [openState, setOpenState] = React.useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;

  const [state, formAction, pending] = useActionState<ProductActionResult | null, FormData>(
    editing ? updateProduct : createProduct,
    null,
  );
  const formRef = React.useRef<HTMLFormElement>(null);

  const initialCategory = (product?.category ?? "medicines") as ProductCategory;
  const [category, setCategory] = React.useState<ProductCategory>(initialCategory);
  const initialUnit = product?.unit ?? defaults?.unit ?? "vnt";
  const [unit, setUnit] = React.useState<string>(initialUnit);
  const [writeOffKind, setWriteOffKind] = React.useState<string>(product?.write_off_kind ?? "");
  const [groupId, setGroupId] = React.useState<string>(product?.default_write_off_group_id ?? "");

  const [subcategoryId, setSubcategoryId] = React.useState<string>(product?.subcategory_id ?? "");
  const [extraSubcategories, setExtraSubcategories] = React.useState<SubcategoryOption[]>([]);
  const [newSubName, setNewSubName] = React.useState("");
  const [subBusy, setSubBusy] = React.useState(false);
  const [subError, setSubError] = React.useState<string | null>(null);

  const categorySubcategories = [...(subcategories ?? []), ...extraSubcategories].filter(
    (s) => s.category === category && (s.active || s.id === product?.subcategory_id),
  );
  const showSubcategory = !!subcategories && (category === "hoof_care" || categorySubcategories.length > 0);
  // Only submit a subcategory that belongs to the chosen category.
  const submittedSubcategoryId = categorySubcategories.some((s) => s.id === subcategoryId) ? subcategoryId : "";

  async function createSubcategoryInline() {
    const name = newSubName.trim();
    if (!name) return;
    setSubBusy(true);
    setSubError(null);
    try {
      const res = await fetch("/api/produktai/subcategories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, name }),
      });
      const json = (await res.json()) as CreateSubcategoryResult;
      if (json.ok) {
        setExtraSubcategories((prev) => [...prev, json.subcategory]);
        setSubcategoryId(json.subcategory.id);
        setNewSubName("");
      } else {
        setSubError(json.error);
      }
    } catch {
      setSubError("Nepavyko sukurti subkategorijos.");
    } finally {
      setSubBusy(false);
    }
  }

  function resetOwnState() {
    setSubcategoryId(product?.subcategory_id ?? "");
    setNewSubName("");
    setSubError(null);
    setCategory(initialCategory);
    setUnit(initialUnit);
    setWriteOffKind(product?.write_off_kind ?? "");
    setGroupId(product?.default_write_off_group_id ?? "");
  }

  const onCreatedRef = React.useRef(onCreated);
  React.useEffect(() => {
    onCreatedRef.current = onCreated;
  }, [onCreated]);

  const setOpenRef = React.useRef(setOpen);
  React.useEffect(() => {
    setOpenRef.current = setOpen;
  }, [setOpen]);

  // Own local state resets safely during render (create mode only — in edit
  // mode the saved values are the new defaults).
  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok && !editing) {
      setCategory("medicines");
      setUnit("vnt");
      setWriteOffKind("");
      setGroupId("");
      setSubcategoryId("");
    }
  }

  // Closing on success has to happen in an effect, not during render: in
  // controlled mode (an `onOpenChange` prop passed in, e.g. from
  // InvoiceUpload) `setOpen` IS that prop, so calling it during this
  // component's own render updates a different component's state mid-render
  // — React 19 treats that as an error, not just a warning.
  React.useEffect(() => {
    if (state?.ok) {
      if (!editing) formRef.current?.reset();
      onCreatedRef.current?.(state.product);
      setOpenRef.current(false);
    }
  }, [state, editing]);

  const autoKind = productWriteOffKind(category, null);
  const effectiveKind = (writeOffKind || autoKind) as WriteOffKind;
  const kindGroups = (groups ?? []).filter((g) => g.act_kinds.includes(effectiveKind));
  // A default group from another template would be ignored by
  // fn_resolve_write_off_group — don't submit it.
  const submittedGroupId = kindGroups.some((g) => g.id === groupId) ? groupId : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          formRef.current?.reset();
          resetOwnState();
        }
      }}
    >
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      {!trigger && !openProp && (
        <DialogTrigger asChild>
          <Button size="sm">
            <Plus className="size-4" /> Naujas produktas
          </Button>
        </DialogTrigger>
      )}
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{editing ? `Redaguoti: ${product.name}` : "Naujas produktas"}</DialogTitle>
        </DialogHeader>
        <form ref={formRef} action={formAction}>
          {editing && <input type="hidden" name="id" value={product.id} />}
          <DialogBody className="space-y-5">
            {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}

            {!editing && defaults?.invoice && (
              <div className="rounded-control border border-border bg-surface-secondary px-3 py-2 text-[12px] text-text-secondary">
                <p className="font-semibold text-text-primary">Duomenys iš sąskaitos</p>
                {defaults.invoice.packageSize && defaults.invoice.packageCount ? (
                  <p>
                    {defaults.invoice.packageCount} pak. × {defaults.invoice.packageSize} = {defaults.invoice.qty} viso
                  </p>
                ) : (
                  <p>Pakuotės informacija iš PDF neišskaityta — nurodykite pakuotės dydį žemiau.</p>
                )}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="name">Pavadinimas *</Label>
                <Input id="name" name="name" required autoFocus defaultValue={product?.name ?? defaultName} key={product?.id ?? defaultName} />
              </div>

              <div>
                <Label htmlFor="category">Kategorija *</Label>
                <Select id="category" name="category" required value={category} onChange={(e) => setCategory(e.target.value as ProductCategory)}>
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </div>

              {showSubcategory && (
                <div className="sm:col-span-2">
                  <Label htmlFor="subcategory_id">Subkategorija</Label>
                  <input type="hidden" name="subcategory_id" value={submittedSubcategoryId} />
                  <Select id="subcategory_id" value={submittedSubcategoryId} onChange={(e) => setSubcategoryId(e.target.value)}>
                    <option value="">— Nėra —</option>
                    {categorySubcategories.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                  <div className="mt-2 flex gap-2">
                    <Input
                      value={newSubName}
                      onChange={(e) => setNewSubName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void createSubcategoryInline();
                        }
                      }}
                      placeholder="Nauja subkategorija (pvz. Paduka)"
                      aria-label="Nauja subkategorija"
                    />
                    <Button type="button" size="sm" variant="outline" disabled={subBusy || !newSubName.trim()} onClick={() => void createSubcategoryInline()}>
                      <Plus className="size-4" /> Sukurti
                    </Button>
                  </div>
                  {subError && <p className="mt-1 text-[12px] text-danger">{subError}</p>}
                </div>
              )}

              <div>
                <Label htmlFor="unit">Vienetas *</Label>
                <Select id="unit" name="unit" required value={unit} onChange={(e) => setUnit(e.target.value)}>
                  {UNIT_OPTIONS.map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </Select>
              </div>

              <div>
                <Label htmlFor="pack_size">Pakuotės dydis ({unit})</Label>
                <Input
                  id="pack_size"
                  name="pack_size"
                  type="number"
                  step="0.001"
                  min="0"
                  defaultValue={product?.pack_size ?? defaults?.packSize ?? ""}
                  key={`pack-${product?.id ?? defaultName}`}
                />
                <p className="mt-1 text-[11px] text-text-muted">Pvz. 100 (ml). Pajamuojant užsipildo automatiškai; nurašymo akte vaistai rodomi pakuotėmis (vnt.).</p>
              </div>

              {category === "hoof_care" && (
                <div>
                  <Label htmlFor="standard_amount">Standartinis kiekis ({unit})</Label>
                  <Input
                    id="standard_amount"
                    name="standard_amount"
                    type="number"
                    step="0.001"
                    min="0"
                    defaultValue={product?.standard_amount ?? ""}
                    key={`std-${product?.id ?? defaultName}`}
                  />
                  <p className="mt-1 text-[11px] text-text-muted">Nagų apžiūroje pasirinkus produktą kiekis užsipildo automatiškai (pvz. 1 vnt. paduka).</p>
                </div>
              )}

              <div>
                <Label htmlFor="active_substance">Veiklioji medžiaga</Label>
                <Input id="active_substance" name="active_substance" defaultValue={product?.active_substance ?? ""} />
              </div>
              <div>
                <Label htmlFor="registration_code">Registracijos kodas</Label>
                <Input id="registration_code" name="registration_code" defaultValue={product?.registration_code ?? ""} />
              </div>

              <div>
                <Label htmlFor="package_weight_g">Tuščios pakuotės svoris (g)</Label>
                <Input id="package_weight_g" name="package_weight_g" type="number" step="0.1" min="0" defaultValue={product?.package_weight_g ?? ""} />
                <p className="mt-1 text-[11px] text-text-muted">Naudojama medicininių atliekų žurnalui — palikite tuščią, jei neaktualu.</p>
              </div>
              <div>
                <Label htmlFor="min_stock_alert">Minimalus atsargų likutis</Label>
                <Input id="min_stock_alert" name="min_stock_alert" type="number" step="0.01" min="0" defaultValue={product?.min_stock_alert ?? ""} />
              </div>

              <div className="flex items-center gap-2 pt-6">
                <input
                  id="is_antimicrobial"
                  name="is_antimicrobial"
                  type="checkbox"
                  defaultChecked={product?.is_antimicrobial ?? false}
                  className="size-4 rounded border-border-strong"
                />
                <Label htmlFor="is_antimicrobial" className="mb-0">
                  Antimikrobinis vaistas
                </Label>
              </div>
            </div>

            <div className="space-y-4 rounded-panel border border-border bg-surface-secondary p-4">
              <div>
                <p className="mb-3 text-[13px] font-semibold text-text-primary">Karencija</p>
                {!editing && WITHDRAWAL_REQUIRED_CATEGORIES.includes(category) && (
                  <p className="-mt-2 mb-3 text-[11px] text-text-muted">Vaistams, profilaktikai ir boliusams būtina nurodyti (įrašykite 0, jei karencijos nėra).</p>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="withdrawal_days_milk">Pienui, d.</Label>
                    <Input
                      id="withdrawal_days_milk"
                      name="withdrawal_days_milk"
                      type="number"
                      min="0"
                      required={!editing && WITHDRAWAL_REQUIRED_CATEGORIES.includes(category)}
                      defaultValue={product?.withdrawal_days_milk ?? (WITHDRAWAL_REQUIRED_CATEGORIES.includes(category) ? "" : 0)}
                      key={`milk-${category}`}
                    />
                  </div>
                  <div>
                    <Label htmlFor="withdrawal_days_meat">Mėsai, d.</Label>
                    <Input
                      id="withdrawal_days_meat"
                      name="withdrawal_days_meat"
                      type="number"
                      min="0"
                      required={!editing && WITHDRAWAL_REQUIRED_CATEGORIES.includes(category)}
                      defaultValue={product?.withdrawal_days_meat ?? (WITHDRAWAL_REQUIRED_CATEGORIES.includes(category) ? "" : 0)}
                      key={`meat-${category}`}
                    />
                  </div>
                </div>
              </div>

              <WithdrawalRouteFields defaults={product} />
            </div>

            <div className="rounded-panel border border-border bg-surface-secondary p-4">
              <p className="mb-3 text-[13px] font-semibold text-text-primary">Nurašymo aktas</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="write_off_kind">Aktas</Label>
                  <Select id="write_off_kind" name="write_off_kind" value={writeOffKind} onChange={(e) => setWriteOffKind(e.target.value)}>
                    <option value="">Pagal kategoriją ({WRITE_OFF_KINDS[autoKind].label})</option>
                    {WRITE_OFF_KIND_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="nomenclature_no">Nom. Nr.</Label>
                  <Input id="nomenclature_no" name="nomenclature_no" defaultValue={product?.nomenclature_no ?? ""} placeholder="pvz. 3101" />
                </div>
                {groups && (
                  <div className="sm:col-span-2">
                    <Label htmlFor="default_write_off_group_id">Numatytoji nurašymo grupė</Label>
                    <input type="hidden" name="default_write_off_group_id" value={submittedGroupId} />
                    <Select id="default_write_off_group_id" value={submittedGroupId} onChange={(e) => setGroupId(e.target.value)}>
                      <option value="">— Nėra —</option>
                      {kindGroups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </Select>
                    <p className="mt-1 text-[11px] text-text-muted">
                      Naudojama, kai sunaudojimas nesusietas su gyvuliu (pvz. nagų vonelė → Melžiamos karvės).
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div>
              <Label htmlFor="dosage_notes">Dozavimo pastabos</Label>
              <Textarea id="dosage_notes" name="dosage_notes" rows={2} defaultValue={product?.dosage_notes ?? ""} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Atšaukti
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saugoma..." : editing ? "Išsaugoti" : "Sukurti"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

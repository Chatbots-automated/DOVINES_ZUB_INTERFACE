"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { createClient } from "@/lib/supabase/client";
import { PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";
import { formatEur, formatQty } from "@/lib/utils";
import type { Database, ReceiptEditLine } from "@/lib/supabase/types";
import type { ReceiptEditOp } from "@/lib/pajamavimas/batch-impl";

// Pajamavimas → Redagavimas (0058). The dialogs only collect the edit; the
// database (update_invoice / update_receipt_batch) checks everything again in
// one transaction: quantity never below what was used, a used line keeps its
// product and can't be removed, drugs/biocides need serija + galiojimas.

type Product = Database["public"]["Tables"]["products"]["Row"];
type Supplier = Database["public"]["Tables"]["suppliers"]["Row"];

// Mirrors receive_invoice() / fn_receipt_save_line(): these need serija + galiojimo terminas.
const LOT_REQUIRED = new Set<string>(["medicines", "vakcina", "profilaktika", "boliusai", "biocide"]);

type LineState = {
  key: string;
  batch_id: string | null;
  product_id: string;
  description: string;
  sku: string;
  lot: string;
  expiry_date: string;
  package_size: string;
  package_count: string;
  qty: string;
  line_total: string;
  used_qty: number;
  on_act: boolean;
  original_expiry: string;
};

const str = (v: number | string | null | undefined) => (v == null ? "" : String(v));

function fromDetail(l: ReceiptEditLine): LineState {
  return {
    key: l.batch_id,
    batch_id: l.batch_id,
    product_id: l.product_id,
    description: l.description ?? "",
    sku: l.sku ?? "",
    lot: l.lot ?? "",
    expiry_date: l.expiry_date ?? "",
    package_size: str(l.package_size),
    package_count: str(l.package_count),
    qty: str(l.received_qty),
    line_total: l.line_total == null ? "" : String(Number(l.line_total)),
    used_qty: Number(l.used_qty) || 0,
    on_act: l.on_act,
    original_expiry: l.expiry_date ?? "",
  };
}

const emptyLine = (): LineState => ({
  key: crypto.randomUUID(),
  batch_id: null,
  product_id: "",
  description: "",
  sku: "",
  lot: "",
  expiry_date: "",
  package_size: "",
  package_count: "",
  qty: "",
  line_total: "",
  used_qty: 0,
  on_act: false,
  original_expiry: "",
});

function lineQty(l: LineState): number {
  const size = Number(l.package_size) || 0;
  const count = Number(l.package_count) || 0;
  return size > 0 && count > 0 ? Number((size * count).toFixed(4)) : Number(l.qty) || 0;
}

function toPayload(l: LineState) {
  const packaged = (Number(l.package_size) || 0) > 0 && (Number(l.package_count) || 0) > 0;
  return {
    batch_id: l.batch_id,
    product_id: l.product_id,
    description: l.description.trim() || null,
    sku: l.sku.trim() || null,
    qty: packaged ? null : l.qty,
    package_size: packaged ? l.package_size : null,
    package_count: packaged ? l.package_count : null,
    line_total: l.line_total === "" ? null : l.line_total,
    lot: l.lot.trim() || null,
    expiry_date: l.expiry_date || null,
  };
}

/** Client-side mirror of the database checks — only for instant feedback. */
function lineProblem(l: LineState, products: Map<string, Product>, today: string): string | null {
  const p = products.get(l.product_id);
  if (!p) return "Pasirinkite produktą.";
  const qty = lineQty(l);
  if (qty <= 0) return `„${p.name}“: įveskite kiekį.`;
  if (qty < l.used_qty) return `„${p.name}“: jau sunaudota ${l.used_qty} ${p.unit} — kiekis negali būti mažesnis.`;
  if (LOT_REQUIRED.has(p.category) && (!l.lot.trim() || !l.expiry_date)) return `„${p.name}“: nurodykite seriją ir galiojimo terminą.`;
  if (l.expiry_date && l.expiry_date < today && l.expiry_date !== l.original_expiry) return `„${p.name}“: galiojimo terminas jau pasibaigęs.`;
  return null;
}

async function postEdit(op: ReceiptEditOp, data: Record<string, unknown>): Promise<string | null> {
  try {
    const response = await fetch("/api/pajamavimas/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, data }),
    });
    const result: { error: string | null } = await response.json();
    return result.error;
  } catch {
    return "Nepavyko išsaugoti — patikrinkite ryšį.";
  }
}
export { postEdit as postReceiptEdit };

function LineEditor({
  line,
  products,
  productOptions,
  onChange,
  onRemove,
  canRemove,
}: {
  line: LineState;
  products: Map<string, Product>;
  productOptions: ComboboxOption[];
  onChange: (patch: Partial<LineState>) => void;
  onRemove?: () => void;
  canRemove: boolean;
}) {
  const p = products.get(line.product_id);
  const used = line.used_qty > 0;
  const qty = lineQty(line);
  const total = Number(line.line_total) || 0;
  const packaged = (Number(line.package_size) || 0) > 0 && (Number(line.package_count) || 0) > 0;
  const lotRequired = !!p && LOT_REQUIRED.has(p.category);

  return (
    <div className="rounded-panel border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {line.batch_id ? <Badge tone="neutral">Esama eilutė</Badge> : <Badge tone="accent">Nauja eilutė</Badge>}
        {used && (
          <Badge tone="warning">
            Sunaudota {formatQty(line.used_qty, p?.unit)} — produkto keisti ir šalinti negalima
          </Badge>
        )}
        {line.on_act && <Badge tone="info">Yra nurašymo akte — aktas savo reikšmių nekeis</Badge>}
        <div className="ml-auto">
          {onRemove && (
            <Button type="button" size="icon" variant="ghost" className="h-8 w-8" disabled={!canRemove || used} onClick={onRemove} title="Pašalinti eilutę">
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-6">
        <div className="sm:col-span-3">
          <Label>Produktas *</Label>
          <Combobox
            options={productOptions}
            value={line.product_id || null}
            disabled={used}
            onChange={(id) => {
              const np = products.get(id);
              onChange({ product_id: id, package_size: line.package_size || (np?.pack_size ? String(np.pack_size) : "") });
            }}
          />
        </div>
        <div className="sm:col-span-3">
          <Label>Aprašymas sąskaitoje</Label>
          <Input value={line.description} onChange={(e) => onChange({ description: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <Label>Serija {lotRequired && "*"}</Label>
          <Input value={line.lot} onChange={(e) => onChange({ lot: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <Label>Galiojimo terminas {lotRequired && "*"}</Label>
          <Input type="date" value={line.expiry_date} onChange={(e) => onChange({ expiry_date: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <Label>Prekės kodas</Label>
          <Input value={line.sku} onChange={(e) => onChange({ sku: e.target.value })} />
        </div>
        <div>
          <Label>Pak. dydis</Label>
          <Input type="number" min="0" step="any" value={line.package_size} onChange={(e) => onChange({ package_size: e.target.value })} />
        </div>
        <div>
          <Label>Pak. sk.</Label>
          <Input type="number" min="0" step="any" value={line.package_count} onChange={(e) => onChange({ package_count: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <Label>Kiekis{p ? ` (${p.unit})` : ""} *</Label>
          <Input
            type="number"
            min={line.used_qty || 0}
            step="any"
            value={packaged ? String(qty) : line.qty}
            disabled={packaged}
            onChange={(e) => onChange({ qty: e.target.value })}
          />
          {used && <p className="mt-1 text-[11.5px] text-text-muted">Ne mažiau nei {formatQty(line.used_qty, p?.unit)}</p>}
        </div>
        <div className="sm:col-span-2">
          <Label>Eilutės suma be PVM (€)</Label>
          <Input type="number" min="0" step="0.01" value={line.line_total} onChange={(e) => onChange({ line_total: e.target.value })} />
          <p className="mt-1 text-[11.5px] text-text-muted">
            Vieneto kaina: {qty > 0 && total > 0 ? formatEur(total / qty) : "—"}
            {line.batch_id && qty > 0 ? ` · Likutis po pakeitimo: ${formatQty(Number((qty - line.used_qty).toFixed(4)), p?.unit)}` : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

function useProductOptions(products: Product[], lines: LineState[]) {
  return React.useMemo(() => {
    const inUse = new Set(lines.map((l) => l.product_id));
    return products
      .filter((p) => p.is_active || inUse.has(p.id))
      .map((p) => ({ value: p.id, label: p.is_active ? p.name : `${p.name} (neaktyvus)`, sublabel: PRODUCT_CATEGORY_LABELS[p.category] }));
  }, [products, lines]);
}

function SupplierField({
  suppliers,
  supplierId,
  onChange,
  newName,
  onNewName,
}: {
  suppliers: Supplier[];
  supplierId: string;
  onChange: (id: string) => void;
  newName: string;
  onNewName: (v: string) => void;
}) {
  const options: ComboboxOption[] = [
    { value: "", label: "— Be tiekėjo —" },
    { value: "__new__", label: "+ Naujas tiekėjas" },
    ...suppliers.map((s) => ({ value: s.id, label: s.name, sublabel: s.vat_code ?? s.code ?? undefined })),
  ];
  return (
    <div>
      <Label>Tiekėjas</Label>
      <Combobox options={options} value={supplierId} onChange={onChange} placeholder="Pasirinkite tiekėją" />
      {supplierId === "__new__" && (
        <Input className="mt-2" placeholder="Naujo tiekėjo pavadinimas" value={newName} onChange={(e) => onNewName(e.target.value)} />
      )}
    </div>
  );
}

function supplierPayload(supplierId: string, newName: string) {
  if (supplierId === "__new__") return { supplier: { name: newName.trim() } };
  return { supplier_id: supplierId || null };
}

function vilniusToday() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vilnius" }).format(new Date());
}

// ---------------------------------------------------------------------------
// Invoice: header + all lines
// ---------------------------------------------------------------------------

export function InvoiceEditDialog({
  invoiceId,
  open,
  onOpenChange,
  products,
  suppliers,
}: {
  invoiceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: Product[];
  suppliers: Supplier[];
}) {
  const router = useRouter();
  const productMap = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  // Mounted per invoice (key) — starts loading, nothing to reset.
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const [number, setNumber] = React.useState("");
  const [date, setDate] = React.useState("");
  const [supplierId, setSupplierId] = React.useState("");
  const [newSupplier, setNewSupplier] = React.useState("");
  const [currency, setCurrency] = React.useState("EUR");
  const [totalNet, setTotalNet] = React.useState("");
  const [totalVat, setTotalVat] = React.useState("");
  const [totalGross, setTotalGross] = React.useState("");
  const [lines, setLines] = React.useState<LineState[]>([]);
  const [removed, setRemoved] = React.useState<string[]>([]);
  const [pdf, setPdf] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !invoiceId) return;
    let cancelled = false;
    createClient()
      .rpc("receipt_edit_detail", { p_invoice_id: invoiceId })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        setLoading(false);
        if (err || !data?.invoice) {
          setError(err?.message ?? "Sąskaita nerasta.");
          return;
        }
        const inv = data.invoice;
        setNumber(inv.invoice_number ?? "");
        setDate(inv.invoice_date ?? "");
        setSupplierId(inv.supplier_id ?? "");
        setNewSupplier("");
        setCurrency(inv.currency || "EUR");
        setTotalNet(str(inv.total_net));
        setTotalVat(str(inv.total_vat));
        setTotalGross(str(inv.total_gross));
        setPdf(inv.pdf_filename);
        setLines(data.lines.map(fromDetail));
      });
    return () => {
      cancelled = true;
    };
  }, [open, invoiceId]);

  const productOptions = useProductOptions(products, lines);
  const today = vilniusToday();
  const linesSum = lines.reduce((s, l) => s + (Number(l.line_total) || 0), 0);
  const problem = lines.map((l) => lineProblem(l, productMap, today)).find(Boolean) ?? (lines.length === 0 ? "Sąskaitoje turi likti bent viena eilutė." : null);

  function patch(key: string, p: Partial<LineState>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }

  async function save() {
    if (!invoiceId) return;
    if (problem) {
      setError(problem);
      return;
    }
    if (supplierId === "__new__" && !newSupplier.trim()) {
      setError("Įveskite naujo tiekėjo pavadinimą.");
      return;
    }
    setSaving(true);
    setError(null);
    const err = await postEdit("update_invoice", {
      invoice_id: invoiceId,
      ...supplierPayload(supplierId, newSupplier),
      invoice: {
        number: number.trim() || null,
        date: date || null,
        currency: currency.trim() || "EUR",
        total_net: totalNet === "" ? null : totalNet,
        total_vat: totalVat === "" ? null : totalVat,
        total_gross: totalGross === "" ? null : totalGross,
      },
      items: lines.map(toPayload),
      removed_batch_ids: removed,
    });
    setSaving(false);
    if (err) setError(err);
    else {
      onOpenChange(false);
      router.refresh();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>Redaguoti sąskaitą {number && `Nr. ${number}`}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
          {loading ? (
            <p className="text-[13px] text-text-muted">Kraunama...</p>
          ) : (
            <>
              {pdf && <p className="text-[12px] text-text-muted">PDF: {pdf}</p>}
              <div className="grid gap-3 sm:grid-cols-4">
                <div>
                  <Label>Sąskaitos Nr.</Label>
                  <Input value={number} onChange={(e) => setNumber(e.target.value)} />
                </div>
                <div>
                  <Label>Sąskaitos data</Label>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
                <div className="sm:col-span-2">
                  <SupplierField suppliers={suppliers} supplierId={supplierId} onChange={setSupplierId} newName={newSupplier} onNewName={setNewSupplier} />
                </div>
                <div>
                  <Label>Suma be PVM</Label>
                  <Input type="number" step="0.01" value={totalNet} onChange={(e) => setTotalNet(e.target.value)} />
                  <button type="button" className="mt-1 text-[11.5px] font-semibold text-accent-hover hover:underline" onClick={() => setTotalNet(linesSum.toFixed(2))}>
                    Pagal eilutes: {formatEur(linesSum)}
                  </button>
                </div>
                <div>
                  <Label>PVM</Label>
                  <Input type="number" step="0.01" value={totalVat} onChange={(e) => setTotalVat(e.target.value)} />
                </div>
                <div>
                  <Label>Suma su PVM</Label>
                  <Input type="number" step="0.01" value={totalGross} onChange={(e) => setTotalGross(e.target.value)} />
                </div>
                <div>
                  <Label>Valiuta</Label>
                  <Input value={currency} onChange={(e) => setCurrency(e.target.value)} />
                </div>
              </div>

              <div className="space-y-3">
                {lines.map((l) => (
                  <LineEditor
                    key={l.key}
                    line={l}
                    products={productMap}
                    productOptions={productOptions}
                    onChange={(p) => patch(l.key, p)}
                    canRemove={lines.length > 1}
                    onRemove={() => {
                      if (l.batch_id) setRemoved((r) => [...r, l.batch_id as string]);
                      setLines((prev) => prev.filter((x) => x.key !== l.key));
                    }}
                  />
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
                  <Plus className="size-4" /> Pridėti eilutę
                </Button>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Atšaukti
          </Button>
          <Button type="button" disabled={saving || loading || !!problem} onClick={save}>
            {saving ? "Saugoma..." : "Išsaugoti pakeitimus"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Stock received without an invoice — one batch
// ---------------------------------------------------------------------------

export function BatchEditDialog({
  batchId,
  open,
  onOpenChange,
  products,
  suppliers,
}: {
  batchId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: Product[];
  suppliers: Supplier[];
}) {
  const router = useRouter();
  const productMap = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  // Mounted per batch (key) — starts loading, nothing to reset.
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [line, setLine] = React.useState<LineState | null>(null);
  const [supplierId, setSupplierId] = React.useState("");
  const [newSupplier, setNewSupplier] = React.useState("");
  const [receivedDate, setReceivedDate] = React.useState("");

  React.useEffect(() => {
    if (!open || !batchId) return;
    let cancelled = false;
    createClient()
      .rpc("receipt_edit_detail", { p_batch_id: batchId })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        setLoading(false);
        const l = data?.lines?.[0];
        if (err || !l) {
          setError(err?.message ?? "Partija nerasta.");
          return;
        }
        setLine(fromDetail(l));
        setSupplierId(l.supplier_id ?? "");
        setNewSupplier("");
        setReceivedDate(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vilnius" }).format(new Date(l.received_at)));
      });
    return () => {
      cancelled = true;
    };
  }, [open, batchId]);

  const productOptions = useProductOptions(products, line ? [line] : []);
  const problem = line ? lineProblem(line, productMap, vilniusToday()) : null;

  async function save() {
    if (!line || !batchId) return;
    if (problem) {
      setError(problem);
      return;
    }
    if (supplierId === "__new__" && !newSupplier.trim()) {
      setError("Įveskite naujo tiekėjo pavadinimą.");
      return;
    }
    setSaving(true);
    setError(null);
    const err = await postEdit("update_batch", {
      ...toPayload(line),
      batch_id: batchId,
      ...supplierPayload(supplierId, newSupplier),
      received_date: receivedDate || null,
    });
    setSaving(false);
    if (err) setError(err);
    else {
      onOpenChange(false);
      router.refresh();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Redaguoti pajamavimą be sąskaitos</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
          {loading || !line ? (
            <p className="text-[13px] text-text-muted">{loading ? "Kraunama..." : ""}</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <SupplierField suppliers={suppliers} supplierId={supplierId} onChange={setSupplierId} newName={newSupplier} onNewName={setNewSupplier} />
                </div>
                <div>
                  <Label>Priėmimo data</Label>
                  <Input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} />
                </div>
              </div>
              <LineEditor line={line} products={productMap} productOptions={productOptions} onChange={(p) => setLine({ ...line, ...p })} canRemove={false} />
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Atšaukti
          </Button>
          <Button type="button" disabled={saving || loading || !line || !!problem} onClick={save}>
            {saving ? "Saugoma..." : "Išsaugoti pakeitimus"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

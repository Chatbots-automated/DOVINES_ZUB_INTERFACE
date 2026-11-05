"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BatchEditDialog, InvoiceEditDialog, postReceiptEdit } from "@/components/pajamavimas/receipt-edit-dialogs";
import { formatDate, formatEur, formatQty } from "@/lib/utils";
import type { Database } from "@/lib/supabase/types";

type Product = Database["public"]["Tables"]["products"]["Row"];
type Supplier = Database["public"]["Tables"]["suppliers"]["Row"];

export type EditInvoiceRow = {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier_name: string | null;
  total_net: number | null;
  pdf_filename: string | null;
  lines: number;
  /** Product names of its lines — for search. */
  products: string;
};

export type EditBatchRow = {
  id: string;
  product_name: string;
  unit: string;
  supplier_name: string | null;
  lot: string | null;
  expiry_date: string | null;
  received_qty: number;
  qty_left: number;
  purchase_price: number | null;
  received_at: string;
};

const PAGE = 50;
const norm = (s: string | null | undefined) => (s ?? "").toLocaleLowerCase("lt");

// Pajamavimas → Redagavimas (0058, farm's request — billed separately).
export function ReceiptEditSection({
  invoices,
  batches,
  products,
  suppliers,
}: {
  invoices: EditInvoiceRow[];
  batches: EditBatchRow[];
  products: Product[];
  suppliers: Supplier[];
}) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [limit, setLimit] = React.useState(PAGE);
  const [invoiceId, setInvoiceId] = React.useState<string | null>(null);
  const [batchId, setBatchId] = React.useState<string | null>(null);
  const [supplier, setSupplier] = React.useState<Supplier | "new" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const needle = norm(q.trim());
  const filteredInvoices = invoices.filter(
    (i) =>
      (!needle || norm(i.invoice_number).includes(needle) || norm(i.supplier_name).includes(needle) || norm(i.products).includes(needle) || norm(i.pdf_filename).includes(needle)) &&
      (!from || (i.invoice_date ?? "") >= from) &&
      (!to || (i.invoice_date ?? "") <= to),
  );
  const filteredBatches = batches.filter((b) => {
    const day = b.received_at.slice(0, 10);
    return (
      (!needle || norm(b.product_name).includes(needle) || norm(b.lot).includes(needle) || norm(b.supplier_name).includes(needle)) &&
      (!from || day >= from) &&
      (!to || day <= to)
    );
  });
  const filteredSuppliers = suppliers.filter((s) => !needle || norm(s.name).includes(needle) || norm(s.vat_code).includes(needle) || norm(s.code).includes(needle));

  async function deleteBatch(b: EditBatchRow) {
    if (!window.confirm(`Ištrinti „${b.product_name}“ pajamavimą (${formatQty(b.received_qty, b.unit)})?`)) return;
    setBusy(b.id);
    setError(null);
    const err = await postReceiptEdit("delete_batch", { batch_id: b.id });
    setBusy(null);
    if (err) setError(err);
    else router.refresh();
  }

  async function deleteInvoice(inv: EditInvoiceRow) {
    if (!window.confirm(`Ištrinti sąskaitą ${inv.invoice_number ?? ""} ir jos priimtas atsargas?`)) return;
    setBusy(inv.id);
    setError(null);
    try {
      const response = await fetch("/api/pajamavimas/delete-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: inv.id }),
      });
      const result: { error: string | null } = await response.json();
      if (result.error) setError(result.error);
      else router.refresh();
    } catch {
      setError("Nepavyko ištrinti sąskaitos.");
    } finally {
      setBusy(null);
    }
  }

  const th = "px-4 py-3 font-medium";
  const thead = "border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary";

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <Label htmlFor="re_q">Paieška</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
              <Input id="re_q" className="pl-9" placeholder="Sąskaitos Nr., tiekėjas, produktas, serija..." value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
            </div>
          </div>
          <div>
            <Label htmlFor="re_from">Nuo</Label>
            <Input id="re_from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="re_to">Iki</Label>
            <Input id="re_to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <p className="text-[12px] text-text-muted sm:col-span-4">
            Galima keisti viską: sąskaitos numerį, datą, tiekėją, sumas ir kiekvieną eilutę (produktą, kiekį, kainą, seriją, galiojimą), pridėti ar pašalinti eilutes.
            Jau sunaudotos prekės kiekis negali būti mažesnis už sunaudotą, o jos produkto keisti ar eilutės šalinti negalima. Likučiai, žurnalai ir analitika
            persiskaičiuoja iš karto; jau suformuoti nurašymo aktai lieka tokie, kokie buvo atspausdinti.
          </p>
          {error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger sm:col-span-4">{error}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sąskaitos ({filteredInvoices.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {filteredInvoices.length === 0 ? (
            <EmptyState icon={Search} title="Sąskaitų nerasta" className="py-10" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[14px]">
                <thead className={thead}>
                  <tr>
                    <th className={th}>Sąskaita</th>
                    <th className={th}>Data</th>
                    <th className={th}>Tiekėjas</th>
                    <th className={th}>Eilučių</th>
                    <th className={th}>Suma be PVM</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredInvoices.slice(0, limit).map((inv) => (
                    <tr key={inv.id}>
                      <td className="px-4 py-3 font-medium text-text-primary">
                        {inv.invoice_number ?? "—"}
                        {inv.pdf_filename && <span className="ml-2 text-[11px] font-normal text-text-muted">{inv.pdf_filename}</span>}
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{formatDate(inv.invoice_date)}</td>
                      <td className="px-4 py-3 text-text-secondary">{inv.supplier_name ?? "—"}</td>
                      <td className="px-4 py-3 tabular-nums text-text-secondary">{inv.lines}</td>
                      <td className="px-4 py-3 tabular-nums text-text-secondary">{inv.total_net != null ? formatEur(inv.total_net) : "—"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <Button type="button" size="sm" variant="outline" onClick={() => setInvoiceId(inv.id)}>
                          <Pencil className="size-4" /> Redaguoti
                        </Button>
                        <Button type="button" size="icon" variant="ghost" className="ml-1 h-8 w-8" disabled={busy === inv.id} onClick={() => deleteInvoice(inv)} title="Ištrinti sąskaitą">
                          <Trash2 className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredInvoices.length > limit && (
                <div className="p-3 text-center">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
                    Rodyti daugiau ({filteredInvoices.length - limit})
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pajamavimai be sąskaitos ({filteredBatches.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {filteredBatches.length === 0 ? (
            <EmptyState icon={Search} title="Nėra pajamavimų be sąskaitos" className="py-10" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[14px]">
                <thead className={thead}>
                  <tr>
                    <th className={th}>Produktas</th>
                    <th className={th}>Priimta</th>
                    <th className={th}>Tiekėjas</th>
                    <th className={th}>Serija / galioja</th>
                    <th className={th}>Kiekis / likutis</th>
                    <th className={th}>Vnt. kaina</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredBatches.slice(0, limit).map((b) => (
                    <tr key={b.id}>
                      <td className="px-4 py-3 font-medium text-text-primary">{b.product_name}</td>
                      <td className="px-4 py-3 text-text-secondary">{formatDate(b.received_at)}</td>
                      <td className="px-4 py-3 text-text-secondary">{b.supplier_name ?? "—"}</td>
                      <td className="px-4 py-3 text-text-secondary">
                        {b.lot ?? "—"} {b.expiry_date && <span className="text-text-muted">· {formatDate(b.expiry_date)}</span>}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-text-secondary">
                        {formatQty(b.received_qty, b.unit)} / {formatQty(b.qty_left, b.unit)}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-text-secondary">{b.purchase_price != null ? formatEur(b.purchase_price) : "—"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <Button type="button" size="sm" variant="outline" onClick={() => setBatchId(b.id)}>
                          <Pencil className="size-4" /> Redaguoti
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="ml-1 h-8 w-8"
                          disabled={busy === b.id || b.qty_left < b.received_qty}
                          title={b.qty_left < b.received_qty ? "Jau naudota — ištrinti negalima" : "Ištrinti"}
                          onClick={() => deleteBatch(b)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Tiekėjai ({filteredSuppliers.length})</CardTitle>
          <Button type="button" size="sm" variant="outline" onClick={() => setSupplier("new")}>
            <Plus className="size-4" /> Naujas tiekėjas
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[14px]">
              <thead className={thead}>
                <tr>
                  <th className={th}>Pavadinimas</th>
                  <th className={th}>Įmonės kodas</th>
                  <th className={th}>PVM kodas</th>
                  <th className={th}>Kontaktai</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredSuppliers.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-3 font-medium text-text-primary">{s.name}</td>
                    <td className="px-4 py-3 text-text-secondary">{s.code ?? "—"}</td>
                    <td className="px-4 py-3 text-text-secondary">{s.vat_code ?? "—"}</td>
                    <td className="px-4 py-3 text-text-secondary">{[s.phone, s.email].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="px-4 py-3 text-right">
                      <Button type="button" size="sm" variant="outline" onClick={() => setSupplier(s)}>
                        <Pencil className="size-4" /> Redaguoti
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {invoiceId && (
        <InvoiceEditDialog
          key={invoiceId}
          invoiceId={invoiceId}
          open
          onOpenChange={(o) => !o && setInvoiceId(null)}
          products={products}
          suppliers={suppliers}
        />
      )}
      {batchId && (
        <BatchEditDialog key={batchId} batchId={batchId} open onOpenChange={(o) => !o && setBatchId(null)} products={products} suppliers={suppliers} />
      )}
      {supplier && <SupplierDialog key={supplier === "new" ? "new" : supplier.id} supplier={supplier} onClose={() => setSupplier(null)} />}
    </div>
  );
}

// Mounted per supplier (key), so the form starts from that supplier's values.
function SupplierDialog({ supplier, onClose }: { supplier: Supplier | "new"; onClose: () => void }) {
  const router = useRouter();
  const editing = supplier !== "new" ? supplier : null;
  const [form, setForm] = React.useState(() => ({
    name: editing?.name ?? "",
    code: editing?.code ?? "",
    vat_code: editing?.vat_code ?? "",
    phone: editing?.phone ?? "",
    email: editing?.email ?? "",
  }));
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    const err = await postReceiptEdit("update_supplier", { id: editing?.id ?? null, ...form });
    setSaving(false);
    if (err) setError(err);
    else {
      onClose();
      router.refresh();
    }
  }

  const field = (key: keyof typeof form, label: string) => (
    <div>
      <Label htmlFor={`sup_${key}`}>{label}</Label>
      <Input id={`sup_${key}`} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Redaguoti tiekėją" : "Naujas tiekėjas"}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
          {field("name", "Pavadinimas *")}
          <div className="grid gap-3 sm:grid-cols-2">
            {field("code", "Įmonės kodas")}
            {field("vat_code", "PVM kodas")}
            {field("phone", "Telefonas")}
            {field("email", "El. paštas")}
          </div>
          {editing && <p className="text-[12px] text-text-muted">Pakeitus pavadinimą, jis atsinaujins ir visose šio tiekėjo sąskaitose.</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Atšaukti
          </Button>
          <Button type="button" disabled={saving || !form.name.trim()} onClick={save}>
            {saving ? "Saugoma..." : "Išsaugoti"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

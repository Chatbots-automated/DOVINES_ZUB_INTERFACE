"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { PackagePlus } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductFormDialog } from "@/components/produktai/product-form-dialog";
import type { SimpleResult } from "@/lib/pajamavimas/batch-impl";
import { PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";
import { formatDate, formatEur } from "@/lib/utils";

// Mirrors receive_invoice() (0015): drugs, vaccines and biocides need serija + galiojimo terminas.
const LOT_REQUIRED = new Set<string>(["medicines", "vakcina", "biocide"]);
import type { Database } from "@/lib/supabase/types";

type Product = Database["public"]["Tables"]["products"]["Row"];
type Supplier = Database["public"]["Tables"]["suppliers"]["Row"];
type BatchWithRefs = Database["public"]["Tables"]["batches"]["Row"] & {
  products: { name: string; unit: string } | null;
  suppliers: { name: string } | null;
};

export function ReceiveStockView({
  products,
  suppliers,
  recentBatches,
}: {
  products: Product[];
  suppliers: Supplier[];
  recentBatches: BatchWithRefs[];
}) {
  const router = useRouter();
  const [localProducts, setLocalProducts] = React.useState(products);
  const [productId, setProductId] = React.useState("");
  const [supplierId, setSupplierId] = React.useState("");
  const [lotNumber, setLotNumber] = React.useState("");
  const [expiryDate, setExpiryDate] = React.useState("");
  const [packageSize, setPackageSize] = React.useState("");
  const [packageCount, setPackageCount] = React.useState("");
  const [qty, setQty] = React.useState("");
  const [total, setTotal] = React.useState("");
  const [invoiceNumber, setInvoiceNumber] = React.useState("");
  const [invoiceDate, setInvoiceDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [productDialogOpen, setProductDialogOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const productOptions: ComboboxOption[] = localProducts.map((p) => ({ value: p.id, label: p.name, sublabel: PRODUCT_CATEGORY_LABELS[p.category] }));
  const supplierOptions: ComboboxOption[] = suppliers.map((s) => ({ value: s.id, label: s.name }));
  const product = localProducts.find((p) => p.id === productId);
  const lotRequired = !!product && LOT_REQUIRED.has(product.category);

  const sizeNum = Number(packageSize) || 0;
  const countNum = Number(packageCount) || 0;
  const packaged = sizeNum > 0 && countNum > 0;
  const qtyNum = packaged ? Number((sizeNum * countNum).toFixed(4)) : Number(qty) || 0;
  const totalNum = Number(total) || 0;
  const unitPrice = qtyNum > 0 && totalNum > 0 ? totalNum / qtyNum : 0;

  function pickProduct(id: string) {
    setProductId(id);
    const p = localProducts.find((x) => x.id === id);
    // The product's standard pack size prefills "Pak. dydis".
    if (p?.pack_size && !packageSize) setPackageSize(String(p.pack_size));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (!productId) {
      setError("Pasirinkite produktą.");
      return;
    }
    if (qtyNum <= 0) {
      setError("Nurodykite kiekį.");
      return;
    }
    if (lotRequired && (!lotNumber.trim() || !expiryDate)) {
      setError("Vaistams, vakcinoms ir biocidams būtina serija ir galiojimo terminas.");
      return;
    }

    setSaving(true);
    const payload = {
      supplier_id: supplierId || undefined,
      invoice: { number: invoiceNumber.trim() || undefined, date: invoiceDate || undefined },
      items: [
        {
          product_id: productId,
          qty: qtyNum,
          package_size: packaged ? sizeNum : undefined,
          package_count: packaged ? countNum : undefined,
          line_total: totalNum > 0 ? totalNum : undefined,
          lot: lotNumber || undefined,
          expiry_date: expiryDate || undefined,
        },
      ],
    };

    // Plain Route Handler + fetch, not a Server Action — see batch-impl.ts
    // for why (Netlify was silently dropping the Server Action POST).
    try {
      const response = await fetch("/api/pajamavimas/receive-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSaving(false);

      if (!response.ok && response.status !== 400 && response.status !== 500) {
        throw new Error(`Serveris atsakė ${response.status}. Bandykite dar kartą arba susisiekite su administratoriumi.`);
      }

      const result: SimpleResult = await response.json();
      if (result.error) {
        setError(result.error);
        return;
      }

      setSuccess(true);
      setLotNumber("");
      setExpiryDate("");
      setPackageSize("");
      setPackageCount("");
      setQty("");
      setTotal("");
      router.refresh();
    } catch (err) {
      setSaving(false);
      console.error("[Pajamavimas] receive-stock request failed:", err);
      setError(err instanceof Error ? err.message : "Nepavyko priimti atsargų. Bandykite dar kartą.");
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[420px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Rankinis įvedimas</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <Label className="mb-0">Produktas *</Label>
                <button type="button" onClick={() => setProductDialogOpen(true)} className="text-[12px] text-accent-hover hover:underline">
                  + Naujas produktas
                </button>
              </div>
              <Combobox options={productOptions} value={productId || null} onChange={pickProduct} placeholder="Pasirinkite produktą" />
            </div>
            <div>
              <Label>Tiekėjas</Label>
              <Combobox options={supplierOptions} value={supplierId || null} onChange={setSupplierId} placeholder="Pasirinkite tiekėją" />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="invoice">Sąskaitos Nr.</Label>
                <Input id="invoice" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="invoice_date">Sąskaitos data</Label>
                <Input id="invoice_date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="lot">Serija{lotRequired ? " *" : ""}</Label>
                <Input id="lot" value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="expiry">Galioja iki{lotRequired ? " *" : ""}</Label>
                <Input id="expiry" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="pack_size">Pak. dydis{product ? ` (${product.unit})` : ""}</Label>
                <Input id="pack_size" type="number" min="0" step="0.001" value={packageSize} onChange={(e) => setPackageSize(e.target.value)} placeholder="pvz. 100" />
              </div>
              <div>
                <Label htmlFor="pack_count">Kiek pak.</Label>
                <Input id="pack_count" type="number" min="0" step="1" value={packageCount} onChange={(e) => setPackageCount(e.target.value)} placeholder="pvz. 6" />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="qty">Viso kiekis{product ? ` (${product.unit})` : ""} *</Label>
                <Input
                  id="qty"
                  type="number"
                  min="0"
                  step="0.001"
                  value={packaged ? String(qtyNum) : qty}
                  onChange={(e) => setQty(e.target.value)}
                  readOnly={packaged}
                  required
                  className={packaged ? "bg-success-soft/40 font-semibold" : ""}
                />
              </div>
              <div>
                <Label htmlFor="price">Kaina viso (€, be PVM)</Label>
                <Input id="price" type="number" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} />
                {unitPrice > 0 && <p className="mt-1 text-[11px] text-text-muted">{formatEur(unitPrice)} / {product?.unit ?? "vnt."}</p>}
              </div>
            </div>

            {error && <p className="text-[13px] text-danger">{error}</p>}
            {success && <p className="text-[13px] text-success">Atsargos priimtos sėkmingai.</p>}

            <Button type="submit" className="w-full" disabled={saving}>
              <PackagePlus className="size-4" /> {saving ? "Saugoma..." : "Priimti atsargas"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Paskutiniai priėmimai</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recentBatches.length === 0 ? (
            <EmptyState icon={PackagePlus} title="Priėmimų nėra" className="py-10" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[14px]">
                <thead className="border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th className="px-4 py-3 font-medium">Produktas</th>
                    <th className="px-4 py-3 font-medium">Tiekėjas</th>
                    <th className="px-4 py-3 font-medium">Kiekis</th>
                    <th className="px-4 py-3 font-medium">Kaina</th>
                    <th className="px-4 py-3 font-medium">Priimta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recentBatches.map((b) => (
                    <tr key={b.id}>
                      <td className="px-4 py-3 font-medium text-text-primary">{b.products?.name}</td>
                      <td className="px-4 py-3 text-text-secondary">{b.suppliers?.name || "—"}</td>
                      <td className="px-4 py-3 text-text-secondary">
                        {b.received_qty} {b.products?.unit}
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{formatEur(b.purchase_price)}</td>
                      <td className="px-4 py-3 text-text-secondary">{formatDate(b.received_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ProductFormDialog
        open={productDialogOpen}
        onOpenChange={setProductDialogOpen}
        onCreated={(p) => {
          setLocalProducts((prev) => [...prev, p]);
          setProductId(p.id);
          if (p.pack_size && !packageSize) setPackageSize(String(p.pack_size));
        }}
      />
    </div>
  );
}

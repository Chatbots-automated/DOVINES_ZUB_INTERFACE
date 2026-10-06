"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FileUp, FileText, Loader2, Trash2, CheckCircle2, PackageCheck, PlusCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { ProductFormDialog } from "@/components/produktai/product-form-dialog";
import { parseInvoicePdf } from "@/lib/invoice-parse-client";
import type { SimpleResult } from "@/lib/pajamavimas/batch-impl";
import type { ProductRow } from "@/lib/actions/products";
import { formatEur, cn } from "@/lib/utils";

interface ReviewItem {
  key: string;
  description: string;
  sku: string;
  qty: number;
  unit: string;
  lineTotal: number;
  lotNumber: string;
  expiryDate: string;
  packageSize: string;
  packageCount: string;
  productId: string | null;
  isNewProduct: boolean;
  newProductName: string;
  include: boolean;
}

interface ParsedHeader {
  supplierName: string;
  supplierCode: string;
  supplierVat: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  totalNet: number | null;
  totalVat: number | null;
  totalGross: number | null;
}

type Stage = "idle" | "uploading" | "review" | "saving" | "done";

function sanitizeFilename(filename: string) {
  return filename.replace(/[()]/g, "").replace(/[^\w\s.-]/g, "_").replace(/\s+/g, "_");
}

// Drugs, vaccines and biocides must carry a lot + expiry (journals, §2.8);
// mirrors receive_invoice() in 0015.
const LOT_REQUIRED = new Set<string>(["medicines", "vakcina", "biocide"]);

const MAX_RAW_RESPONSE_STRING = 4000;

// Some n8n document-AI templates echo back a base64 page image/PDF snippet
// alongside the extracted fields, purely for the workflow's own debugging.
// We only ever use raw_response as an audit trail (stored in
// invoices.raw_parsed), so strip anything that large before it ever enters
// state or gets sent to confirmParsedInvoice — it was blowing past the
// Server Action request-size ceiling when deployed (works locally against
// a dev server with no such limit, 403s on Netlify).
function stripLargeStrings(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === "string") {
    return value.length > MAX_RAW_RESPONSE_STRING ? `[omitted: ${value.length} chars]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripLargeStrings(v, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripLargeStrings(v, depth + 1)]));
  }
  return value;
}

function toNumber(value: unknown): number {
  const n = typeof value === "string" ? parseFloat(value.replace(",", ".")) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

const norm = (v: string) =>
  v
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Exact (normalized) name wins, then one name containing the other (the
// shorter side must be a real word, >= 4 chars), then >= 60% shared words.
// An empty/very short name never matches — Monika's plain substring match
// would hit everything on an empty product name.
function findProductMatch(description: string, products: ProductRow[]): ProductRow | null {
  const term = norm(description);
  if (term.length < 3) return null;
  const termWords = new Set(term.split(" "));
  let best: { product: ProductRow; score: number } | null = null;
  for (const p of products) {
    const name = norm(p.name);
    if (name.length < 3) continue;
    let score = 0;
    if (name === term) score = 1;
    else if (Math.min(name.length, term.length) >= 4 && (name.includes(term) || term.includes(name))) {
      score = 0.8 * (Math.min(name.length, term.length) / Math.max(name.length, term.length)) + 0.1;
    } else {
      const words = name.split(" ").filter((w) => w.length >= 3);
      const shared = words.filter((w) => termWords.has(w)).length;
      if (words.length > 0 && shared / words.length >= 0.6) score = 0.5 * (shared / words.length);
    }
    if (score > 0 && (!best || score > best.score)) best = { product: p, score };
  }
  return best && best.score >= 0.3 ? best.product : null;
}

function itemUnitCost(item: ReviewItem) {
  return item.qty > 0 ? item.lineTotal / item.qty : 0;
}

// Recomputes qty from pakuotės dydis × kiek pakuočių whenever either is set;
// leaves qty as a plain editable number otherwise (matches VAIDA_VET_INTERFACE's
// ReceiveStock.tsx package_size/package_count behavior).
function withRecomputedQty(item: ReviewItem): ReviewItem {
  const size = toNumber(item.packageSize);
  const count = toNumber(item.packageCount);
  if (size > 0 && count > 0) {
    return { ...item, qty: Number((size * count).toFixed(4)) };
  }
  return item;
}

export function InvoiceUpload({ products }: { products: ProductRow[] }) {
  const router = useRouter();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [stage, setStage] = React.useState<Stage>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [header, setHeader] = React.useState<ParsedHeader | null>(null);
  const [items, setItems] = React.useState<ReviewItem[]>([]);
  const [rawResponse, setRawResponse] = React.useState<unknown>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = React.useState<string | null>(null);
  // Products created inline via ProductFormDialog during this session, kept
  // separately from the `products` prop (which only refreshes after a
  // server revalidation) so we never need an effect to "sync" derived state.
  const [extraProducts, setExtraProducts] = React.useState<ProductRow[]>([]);
  const [productFormKey, setProductFormKey] = React.useState<string | null>(null);

  const localProducts: ProductRow[] = React.useMemo(() => {
    const knownIds = new Set(products.map((p) => p.id));
    return [...products, ...extraProducts.filter((p) => !knownIds.has(p.id))];
  }, [products, extraProducts]);

  const productOptions: ComboboxOption[] = React.useMemo(
    () => localProducts.map((p) => ({ value: p.id, label: p.name, sublabel: p.category })),
    [localProducts],
  );

  React.useEffect(() => {
    // Revoke the blob URL on unmount / whenever it's replaced, so we don't
    // leak memory across repeated uploads.
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf") {
      setError("Prašome pasirinkti PDF failą.");
      return;
    }

    setError(null);
    setStage("uploading");
    setFileName(file.name);
    setPdfUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });

    try {
      const result = await parseInvoicePdf(file, sanitizeFilename(file.name));

      if ("error" in result) {
        throw new Error(result.error);
      }

      const invoiceObject = result.data;
      const supplier = (invoiceObject.supplier as Record<string, unknown>) ?? {};
      const invoiceMeta = (invoiceObject.invoice as Record<string, unknown>) ?? {};
      const rawItems = (invoiceObject.items as Record<string, unknown>[]) ?? [];

      setHeader({
        supplierName: String(supplier.name ?? ""),
        supplierCode: String(supplier.code ?? ""),
        supplierVat: String(supplier.vat_code ?? ""),
        invoiceNumber: String(invoiceMeta.number ?? ""),
        invoiceDate: String(invoiceMeta.date ?? new Date().toISOString().slice(0, 10)).slice(0, 10),
        currency: String(invoiceMeta.currency ?? "EUR"),
        totalNet: invoiceMeta.total_net != null ? toNumber(invoiceMeta.total_net) : null,
        totalVat: invoiceMeta.total_vat != null ? toNumber(invoiceMeta.total_vat) : null,
        totalGross: invoiceMeta.total_gross != null ? toNumber(invoiceMeta.total_gross) : null,
      });

      setItems(
        rawItems.map((raw, idx) => {
          const description = String(raw.description ?? raw.name ?? `Prekė ${idx + 1}`);
          const match = findProductMatch(description, localProducts);
          let qty = toNumber(raw.qty ?? raw.quantity ?? 1) || 1;
          let size = toNumber(raw.package_size);
          let count = toNumber(raw.package_count);
          // The parser did not read a pack size: use the product's standard
          // one. A quantity smaller than one pack can only be a pack count.
          if (!(size > 0) && match?.pack_size) {
            size = match.pack_size;
            if (qty < size) count = qty;
          }
          if (size > 0 && count > 0) qty = Number((size * count).toFixed(4));
          const net = raw.net != null ? toNumber(raw.net) : toNumber(raw.unit_price) * qty;
          return {
            key: `${idx}-${description}`,
            description,
            sku: String(raw.sku ?? ""),
            qty,
            unit: String(match?.unit ?? "vnt"),
            lineTotal: Number(net.toFixed(2)),
            lotNumber: String(raw.batch ?? raw.lot ?? ""),
            expiryDate: String(raw.expiry ?? "").slice(0, 10),
            packageSize: size > 0 ? String(size) : "",
            packageCount: count > 0 ? String(count) : "",
            productId: match?.id ?? null,
            isNewProduct: !match,
            newProductName: match ? "" : description,
            include: true,
          };
        }),
      );
      setRawResponse(stripLargeStrings(invoiceObject));
      setStage("review");
    } catch (err) {
      console.error("[Invoice Upload] Error:", err);
      setError(err instanceof Error ? err.message : "Nepavyko apdoroti sąskaitos.");
      setStage("idle");
    }
  }

  function updateItem(key: string, patch: Partial<ReviewItem>) {
    setItems((prev) => prev.map((it) => (it.key === key ? withRecomputedQty({ ...it, ...patch }) : it)));
  }
  function removeItem(key: string) {
    setItems((prev) => prev.filter((it) => it.key !== key));
  }

  function handleProductCreated(product: ProductRow) {
    setExtraProducts((prev) => [...prev, product]);
    if (productFormKey) {
      const line = items.find((it) => it.key === productFormKey);
      const patch: Partial<ReviewItem> = { productId: product.id, isNewProduct: false, unit: product.unit };
      if (line && !line.packageSize && product.pack_size) {
        patch.packageSize = String(product.pack_size);
        if (line.qty < product.pack_size) patch.packageCount = String(line.qty);
      }
      updateItem(productFormKey, patch);
    }
    setProductFormKey(null);
  }

  function reset() {
    setStage("idle");
    setHeader(null);
    setItems([]);
    setError(null);
    setRawResponse(null);
    setFileName(null);
    setPdfUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  async function handleConfirm() {
    if (!header) return;
    const included = items.filter((it) => it.include);
    if (included.length === 0) {
      setError("Pasirinkite bent vieną prekės eilutę.");
      return;
    }
    for (const item of included) {
      if (!item.productId) {
        setError(`Sukurkite arba pasirinkite produktą eilutei „${item.description}“.`);
        return;
      }
      if (item.qty <= 0) {
        setError(`Patikrinkite kiekį eilutei „${item.description}“.`);
        return;
      }
      const product = localProducts.find((p) => p.id === item.productId);
      if (product && LOT_REQUIRED.has(product.category) && (!item.lotNumber.trim() || !item.expiryDate)) {
        setError(`„${product.name}“: nurodykite serijos numerį ir galiojimo terminą.`);
        return;
      }
    }

    setError(null);
    setStage("saving");

    const payload = {
      supplier: { name: header.supplierName, code: header.supplierCode, vat_code: header.supplierVat },
      invoice: {
        number: header.invoiceNumber,
        date: header.invoiceDate,
        currency: header.currency,
        total_net: header.totalNet,
        total_vat: header.totalVat,
        total_gross: header.totalGross,
      },
      pdf_filename: fileName ?? undefined,
      raw_parsed: rawResponse,
      items: included.map((it) => ({
        product_id: it.productId,
        description: it.description,
        sku: it.sku || undefined,
        qty: it.qty,
        package_size: it.packageSize ? toNumber(it.packageSize) : undefined,
        package_count: it.packageCount ? toNumber(it.packageCount) : undefined,
        line_total: it.lineTotal,
        lot: it.lotNumber || undefined,
        expiry_date: it.expiryDate || undefined,
      })),
    };
    console.log("[Invoice Upload] confirm-invoice payload size (bytes):", JSON.stringify(payload).length, payload);

    // Plain Route Handler + fetch, not a Server Action — Netlify was
    // silently dropping the Server Action version of this POST (empty-body
    // 403, request never reached our code — see batch-impl.ts).
    try {
      const response = await fetch("/api/pajamavimas/confirm-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok && response.status !== 400 && response.status !== 500) {
        throw new Error(`Serveris atsakė ${response.status}. Bandykite dar kartą arba susisiekite su administratoriumi.`);
      }

      const result: SimpleResult = await response.json();
      console.log("[Invoice Upload] confirm-invoice result:", result);

      if (result.error) {
        console.error("[Invoice Upload] confirm-invoice returned error:", result.error);
        setError(result.error);
        setStage("review");
        return;
      }

      setStage("done");
      router.refresh();
    } catch (err) {
      console.error("[Invoice Upload] confirm-invoice request failed:", err);
      setError(err instanceof Error ? err.message : "Nepavyko išsaugoti sąskaitos. Bandykite dar kartą.");
      setStage("review");
    }
  }

  const dialogItem = items.find((it) => it.key === productFormKey);
  const computedTotal = items.filter((i) => i.include).reduce((s, i) => s + i.lineTotal, 0);
  const showSplitView = (stage === "review" || stage === "saving") && !!pdfUrl;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sąskaitos nuskaitymas (PDF)</CardTitle>
      </CardHeader>
      <CardContent>
        {stage === "idle" && (
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-panel border-2 border-dashed border-border-strong bg-surface-secondary/40 px-6 py-10 text-center transition-colors hover:border-accent hover:bg-surface-secondary">
            <input ref={fileInputRef} type="file" accept="application/pdf" onChange={handleFileChange} className="hidden" />
            <FileUp className="size-7 text-text-secondary" />
            <p className="text-[14px] font-semibold text-text-primary">Įkelkite tiekėjo sąskaitos PDF</p>
            <p className="text-[12px] text-text-secondary">Prekės, kiekiai ir kainos bus nuskaitytos automatiškai — jas galėsite peržiūrėti prieš patvirtinant.</p>
          </label>
        )}

        {stage === "uploading" && (
          <div className="flex flex-col items-center gap-3 rounded-panel border border-border bg-surface-secondary/40 px-6 py-10 text-center">
            <Loader2 className="size-6 animate-spin text-accent" />
            <p className="text-[14px] font-semibold text-text-primary">Skenuojama „{fileName}“...</p>
            <p className="text-[12px] text-text-secondary">Tai gali užtrukti iki minutės.</p>
          </div>
        )}

        {(stage === "review" || stage === "saving") && header && (
          <div className={cn("gap-5", showSplitView ? "flex flex-col lg:flex-row lg:items-start" : "block")}>
            {showSplitView && (
              <div className="shrink-0 lg:sticky lg:top-4 lg:w-[38%]">
                <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-text-secondary">
                  <FileText className="size-4" />
                  {fileName}
                </div>
                <iframe
                  src={pdfUrl ?? undefined}
                  title="Sąskaitos PDF"
                  className="h-[70vh] w-full rounded-panel border border-border lg:h-[calc(100vh-11rem)]"
                />
              </div>
            )}

            <div className="min-w-0 flex-1 space-y-4">
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <Label className="text-[11px]">Tiekėjas</Label>
                  <Input value={header.supplierName} onChange={(e) => setHeader({ ...header, supplierName: e.target.value })} className="h-8 text-[13px]" />
                </div>
                <div>
                  <Label className="text-[11px]">Tiekėjo kodas</Label>
                  <Input value={header.supplierCode} onChange={(e) => setHeader({ ...header, supplierCode: e.target.value })} className="h-8 text-[13px]" />
                </div>
                <div>
                  <Label className="text-[11px]">PVM kodas</Label>
                  <Input value={header.supplierVat} onChange={(e) => setHeader({ ...header, supplierVat: e.target.value })} className="h-8 text-[13px]" />
                </div>
                <div>
                  <Label className="text-[11px]">Sąskaitos Nr.</Label>
                  <Input value={header.invoiceNumber} onChange={(e) => setHeader({ ...header, invoiceNumber: e.target.value })} className="h-8 text-[13px]" />
                </div>
                <div>
                  <Label className="text-[11px]">Data</Label>
                  <Input type="date" value={header.invoiceDate} onChange={(e) => setHeader({ ...header, invoiceDate: e.target.value })} className="h-8 text-[13px]" />
                </div>
                <div>
                  <Label className="text-[11px]">Valiuta</Label>
                  <Input value={header.currency} onChange={(e) => setHeader({ ...header, currency: e.target.value })} className="h-8 text-[13px]" />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-[12px] text-text-secondary">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[2px] bg-success" /> Prekė jau yra sistemoje
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[2px] bg-warning" /> Nauja prekė — bus sukurta
                </span>
              </div>

              <div className="space-y-2.5">
                {items.map((item) => {
                  const packaged = !!(item.packageSize && item.packageCount);
                  const itemProduct = localProducts.find((p) => p.id === item.productId);
                  const lotRequired = !!itemProduct && LOT_REQUIRED.has(itemProduct.category);
                  return (
                    <div
                      key={item.key}
                      className={cn(
                        "rounded-panel border-l-[3px] border border-border p-3",
                        !item.include ? "border-l-transparent opacity-40" : item.isNewProduct ? "border-l-warning bg-warning-soft" : "border-l-success bg-success-soft/25",
                      )}
                    >
                      <div className="mb-2.5 flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={item.include}
                          onChange={(e) => updateItem(item.key, { include: e.target.checked })}
                          className="mt-0.5 size-4 shrink-0 rounded accent-[var(--accent)]"
                        />
                        <Input
                          value={item.description}
                          onChange={(e) => updateItem(item.key, { description: e.target.value })}
                          className="h-7 flex-1 text-[13px] font-semibold"
                        />
                        <Input
                          value={item.sku}
                          onChange={(e) => updateItem(item.key, { sku: e.target.value })}
                          placeholder="SKU"
                          className="h-7 w-20 shrink-0 text-[12px]"
                        />
                        <button type="button" onClick={() => removeItem(item.key)} className="shrink-0 p-1 text-text-muted hover:text-danger">
                          <Trash2 className="size-4" />
                        </button>
                      </div>

                      <div className="mb-2.5">
                        {item.isNewProduct ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone="warning">Nauja</Badge>
                            <span className="text-[13px] text-text-primary" title={item.newProductName}>
                              {item.newProductName}
                            </span>
                            <Button type="button" size="sm" variant="primary" onClick={() => setProductFormKey(item.key)} className="ml-auto">
                              <PlusCircle className="size-4" /> Sukurti produktą
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <Badge tone="success">Sistemoje</Badge>
                            <Combobox
                              options={productOptions}
                              value={item.productId}
                              onChange={(v) => {
                                const p = localProducts.find((pr) => pr.id === v);
                                updateItem(item.key, { productId: v, unit: p?.unit ?? item.unit });
                              }}
                              placeholder="Pasirinkite"
                              className="flex-1"
                            />
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => updateItem(item.key, item.isNewProduct ? { isNewProduct: false } : { isNewProduct: true, productId: null })}
                          className="mt-1 text-[11px] text-accent-hover hover:underline"
                        >
                          {item.isNewProduct ? "pasirinkti esamą" : "sukurti naują"}
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <div>
                          <Label className="text-[10px]">Pak. dydis</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.001"
                            value={item.packageSize}
                            onChange={(e) => updateItem(item.key, { packageSize: e.target.value })}
                            placeholder="—"
                            className="h-7 text-[12px]"
                          />
                        </div>
                        <div>
                          <Label className="text-[10px]">Kiek pak.</Label>
                          <Input
                            type="number"
                            min="0"
                            step="1"
                            value={item.packageCount}
                            onChange={(e) => updateItem(item.key, { packageCount: e.target.value })}
                            placeholder="—"
                            className="h-7 text-[12px]"
                          />
                        </div>
                        <div>
                          <Label className="text-[10px]">Viso kiekis</Label>
                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              min="0"
                              step="0.001"
                              value={item.qty}
                              onChange={(e) => updateItem(item.key, { qty: toNumber(e.target.value) })}
                              readOnly={packaged}
                              className={cn("h-7 text-[12px]", packaged && "bg-success-soft/40 font-semibold")}
                            />
                            <span className="text-[11px] text-text-muted">{item.unit}</span>
                          </div>
                        </div>
                        <div>
                          <Label className="text-[10px]">Kaina (eilutė)</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={item.lineTotal}
                            onChange={(e) => updateItem(item.key, { lineTotal: toNumber(e.target.value) })}
                            className="h-7 text-[12px]"
                          />
                        </div>
                        <div>
                          <Label className="text-[10px]">Kaina / vnt.</Label>
                          <p className="flex h-7 items-center text-[12px] font-medium text-text-primary">{formatEur(itemUnitCost(item))}</p>
                        </div>
                        <div>
                          <Label className="text-[10px]">Serija{lotRequired ? " *" : ""}</Label>
                          <Input
                            value={item.lotNumber}
                            onChange={(e) => updateItem(item.key, { lotNumber: e.target.value })}
                            className={cn("h-7 text-[12px]", item.include && lotRequired && !item.lotNumber.trim() && "border-danger")}
                          />
                        </div>
                        <div className="col-span-2 sm:col-span-2">
                          <Label className="text-[10px]">Galioja iki{lotRequired ? " *" : ""}</Label>
                          <Input
                            type="date"
                            value={item.expiryDate}
                            onChange={(e) => updateItem(item.key, { expiryDate: e.target.value })}
                            className={cn("h-7 text-[12px]", item.include && lotRequired && !item.expiryDate && "border-danger")}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <p className="text-[13px] text-text-secondary">
                  Iš viso pasirinkta: <span className="font-semibold text-text-primary">{formatEur(computedTotal)}</span>
                  {header.totalNet != null && Math.abs(computedTotal - header.totalNet) > 0.05 && (
                    <span className="ml-2 text-warning">sąskaitoje be PVM: {formatEur(header.totalNet)}</span>
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" onClick={reset} disabled={stage === "saving"}>
                    Atšaukti
                  </Button>
                  <Button onClick={handleConfirm} disabled={stage === "saving"}>
                    {stage === "saving" ? (
                      <>
                        <Loader2 className="size-4 animate-spin" /> Priimama...
                      </>
                    ) : (
                      <>
                        <PackageCheck className="size-4" /> Pajamuoti
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {stage === "done" && (
          <div className="flex flex-col items-center gap-2 rounded-panel border border-success-soft bg-success-soft/40 px-6 py-8 text-center">
            <CheckCircle2 className="size-7 text-success" />
            <p className="text-[14px] font-medium text-text-primary">Sąskaita pajamuota sėkmingai.</p>
            <Button variant="outline" size="sm" onClick={reset} className="mt-1">
              Įkelti dar vieną
            </Button>
          </div>
        )}

        {error && <p className="mt-3 whitespace-pre-line text-[13px] text-danger">{error}</p>}
      </CardContent>

      <ProductFormDialog
        open={!!productFormKey}
        onOpenChange={(o) => {
          if (!o) setProductFormKey(null);
        }}
        onCreated={handleProductCreated}
        defaultName={dialogItem?.newProductName}
        defaults={
          dialogItem
            ? {
                unit: dialogItem.unit,
                packSize: toNumber(dialogItem.packageSize) || null,
                invoice: {
                  packageSize: toNumber(dialogItem.packageSize) || null,
                  packageCount: toNumber(dialogItem.packageCount) || null,
                  qty: dialogItem.qty,
                },
              }
            : undefined
        }
      />
    </Card>
  );
}

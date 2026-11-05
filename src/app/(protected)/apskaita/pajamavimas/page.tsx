import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { ReceiveStockView } from "@/components/pajamavimas/receive-stock-view";
import { InvoiceUpload } from "@/components/pajamavimas/invoice-upload";
import { InvoicesList, type InvoiceListRow } from "@/components/pajamavimas/invoices-list";
import { PajamavimasTabs } from "@/components/pajamavimas/pajamavimas-tabs";
import { ReceiptEditSection, type EditBatchRow, type EditInvoiceRow } from "@/components/pajamavimas/receipt-edit-section";

// PostgREST caps a response at max_rows (1000) regardless of .limit() — page through.
const CHUNK = 1000;
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null }>, max: number): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += CHUNK) {
    const { data } = await build(from, from + CHUNK - 1);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < CHUNK) break;
  }
  return out;
}

type InvoiceQueryRow = {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier_name: string | null;
  total_net: number | null;
  pdf_filename: string | null;
  created_at: string;
  invoice_items: { products: { name: string } | null }[] | null;
};

type BatchQueryRow = {
  id: string;
  lot: string | null;
  expiry_date: string | null;
  received_qty: number;
  qty_left: number;
  purchase_price: number | null;
  received_at: string;
  products: { name: string; unit: string } | null;
  suppliers: { name: string } | null;
};

export default async function PajamavimasPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: allProducts }, { data: suppliers }, { data: recentBatches }, invoiceRows, standalone] = await Promise.all([
    supabase.from("products").select("*").order("name"),
    supabase.from("suppliers").select("*").order("name"),
    supabase
      .from("batches")
      .select("*, products(name, unit), suppliers(name)")
      .order("received_at", { ascending: false })
      .limit(20),
    fetchAll<InvoiceQueryRow>(
      (from, to) =>
        supabase
          .from("invoices")
          .select("id, invoice_number, invoice_date, supplier_name, total_net, pdf_filename, created_at, invoice_items(products(name))")
          .order("created_at", { ascending: false })
          .order("id")
          .range(from, to),
      20000,
    ),
    fetchAll<BatchQueryRow>(
      (from, to) =>
        supabase
          .from("batches")
          .select("id, lot, expiry_date, received_qty, qty_left, purchase_price, received_at, products(name, unit), suppliers(name)")
          .is("invoice_id", null)
          .order("received_at", { ascending: false })
          .order("id")
          .range(from, to),
      20000,
    ),
  ]);

  const products = allProducts ?? [];
  const activeProducts = products.filter((p) => p.is_active);

  const invoices: InvoiceListRow[] = invoiceRows.slice(0, 20).map((i) => ({
    id: i.id,
    invoice_number: i.invoice_number,
    invoice_date: i.invoice_date,
    supplier_name: i.supplier_name,
    total_net: i.total_net,
    pdf_filename: i.pdf_filename,
    lines: i.invoice_items?.length ?? 0,
  }));

  const editInvoices: EditInvoiceRow[] = invoiceRows.map((i) => ({
    id: i.id,
    invoice_number: i.invoice_number,
    invoice_date: i.invoice_date,
    supplier_name: i.supplier_name,
    total_net: i.total_net,
    pdf_filename: i.pdf_filename,
    lines: i.invoice_items?.length ?? 0,
    products: (i.invoice_items ?? []).map((ii) => ii.products?.name ?? "").join(" "),
  }));

  const editBatches: EditBatchRow[] = standalone.map((b) => ({
    id: b.id,
    product_name: b.products?.name ?? "—",
    unit: b.products?.unit ?? "",
    supplier_name: b.suppliers?.name ?? null,
    lot: b.lot,
    expiry_date: b.expiry_date,
    received_qty: b.received_qty,
    qty_left: b.qty_left,
    purchase_price: b.purchase_price,
    received_at: b.received_at,
  }));

  return (
    <div className="flex flex-col">
      <PageHeader title="Pajamavimas" />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <PajamavimasTabs
          initialTab={sp.tab === "redagavimas" ? "redagavimas" : "priemimas"}
          priemimas={
            <>
              <InvoiceUpload products={activeProducts} />
              <ReceiveStockView products={activeProducts} suppliers={suppliers ?? []} recentBatches={(recentBatches ?? []) as never} />
              <InvoicesList invoices={invoices} />
            </>
          }
          redagavimas={<ReceiptEditSection invoices={editInvoices} batches={editBatches} products={products} suppliers={suppliers ?? []} />}
        />
      </div>
    </div>
  );
}

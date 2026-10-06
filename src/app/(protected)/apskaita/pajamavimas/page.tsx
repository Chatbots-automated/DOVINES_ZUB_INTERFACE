import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { ReceiveStockView } from "@/components/pajamavimas/receive-stock-view";
import { InvoiceUpload } from "@/components/pajamavimas/invoice-upload";
import { InvoicesList, type InvoiceListRow } from "@/components/pajamavimas/invoices-list";

export default async function PajamavimasPage() {
  const supabase = await createClient();

  const [{ data: products }, { data: suppliers }, { data: recentBatches }, { data: invoiceRows }] = await Promise.all([
    supabase.from("products").select("*").eq("is_active", true).order("name"),
    supabase.from("suppliers").select("*").order("name"),
    supabase
      .from("batches")
      .select("*, products(name, unit), suppliers(name)")
      .order("received_at", { ascending: false })
      .limit(20),
    supabase
      .from("invoices")
      .select("id, invoice_number, invoice_date, supplier_name, total_net, pdf_filename, created_at, invoice_items(count)")
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const invoices: InvoiceListRow[] = (invoiceRows ?? []).map((i) => ({
    id: i.id,
    invoice_number: i.invoice_number,
    invoice_date: i.invoice_date,
    supplier_name: i.supplier_name,
    total_net: i.total_net,
    pdf_filename: i.pdf_filename,
    lines: (i.invoice_items as unknown as { count: number }[] | null)?.[0]?.count ?? 0,
  }));

  return (
    <div className="flex flex-col">
      <PageHeader title="Pajamavimas" />
      <div className="space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <InvoiceUpload products={products ?? []} />
        <ReceiveStockView products={products ?? []} suppliers={suppliers ?? []} recentBatches={(recentBatches ?? []) as never} />
        <InvoicesList invoices={invoices} />
      </div>
    </div>
  );
}

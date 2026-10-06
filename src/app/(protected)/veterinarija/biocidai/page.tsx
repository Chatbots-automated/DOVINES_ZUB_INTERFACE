import { Droplet } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatQty } from "@/lib/utils";
import { NewBiocideDialog, type BiocideProduct } from "@/components/biocidai/new-biocide-dialog";
import { BiocideLog, type BiocideReceiptRow, type BiocideUsageRow } from "@/components/biocidai/biocide-log";

// "Biocidai" (Priedas §2.8 biocidinių produktų žurnalas): usage log with
// batch (serija) info, receiving + remaining per batch, and the current
// stock per product. The print/PDF journal forms are under Apskaita ->
// Žurnalai ir ataskaitos.
export default async function BiocidaiPage() {
  const supabase = await createClient();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vilnius" }).format(new Date());

  const [usageRes, receiptsRes, productsRes] = await Promise.all([
    supabase
      .from("vw_biocide_journal")
      .select("id, name, registration_code, unit, use_date, purpose, work_scope, qty, used_by_name, batch_number, expiry_date")
      .order("use_date", { ascending: false })
      .limit(2000),
    supabase
      .from("vw_biocide_receiving_journal")
      .select("id, name, unit, receipt_date, supplier_name, invoice_number, received_qty, batch_number, expiry_date, quantity_remaining")
      .order("receipt_date", { ascending: false })
      .limit(2000),
    supabase.from("products").select("id, name, unit").eq("category", "biocide").eq("is_active", true).order("name"),
  ]);

  const productRows = productsRes.data ?? [];
  const { data: batchRows } = productRows.length
    ? await supabase
        .from("stock_by_batch")
        .select("product_id, lot, qty_left, expiry_date")
        .in("product_id", productRows.map((p) => p.id))
        .gt("qty_left", 0)
    : { data: [] };

  // FEFO never touches expired batches, so only those count as usable stock.
  const products: BiocideProduct[] = productRows.map((p) => {
    const lots = (batchRows ?? []).filter((b) => b.product_id === p.id);
    const usable = lots.filter((b) => !b.expiry_date || b.expiry_date >= today);
    return {
      ...p,
      on_hand: usable.reduce((sum, b) => sum + Number(b.qty_left), 0),
      expired: lots.filter((b) => b.expiry_date && b.expiry_date < today).reduce((sum, b) => sum + Number(b.qty_left), 0),
      next_lot: usable[0] ? { lot: usable[0].lot, expiry_date: usable[0].expiry_date } : null,
    };
  });

  return (
    <>
      <PageHeader title="Biocidai" description="Biocidinių produktų panaudojimas, gavimas ir likučiai" actions={<NewBiocideDialog products={products} today={today} />} />

      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        {products.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {products.map((p) => (
              <Card key={p.id}>
                <CardContent className="space-y-1 p-4">
                  <p className="text-[13px] font-semibold text-text-primary">{p.name}</p>
                  <p className="text-[20px] font-bold tabular-nums text-text-primary">{formatQty(p.on_hand, p.unit)}</p>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
                    {p.next_lot ? (
                      <span>
                        Seniausia partija: {p.next_lot.lot ?? "—"}
                        {p.next_lot.expiry_date ? ` · iki ${formatDate(p.next_lot.expiry_date)}` : ""}
                      </span>
                    ) : (
                      <Badge tone="danger">Nėra naudojamo likučio</Badge>
                    )}
                    {p.expired > 0 && <Badge tone="warning">Pasibaigęs galiojimas: {formatQty(p.expired, p.unit)}</Badge>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {(usageRes.data ?? []).length === 0 && (receiptsRes.data ?? []).length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-[13px] text-text-muted">
              <Droplet className="size-8" />
              Biocidų įrašų dar nėra.
              <NewBiocideDialog products={products} today={today} />
            </CardContent>
          </Card>
        ) : (
          <BiocideLog
            usage={(usageRes.data ?? []) as unknown as BiocideUsageRow[]}
            receipts={(receiptsRes.data ?? []) as unknown as BiocideReceiptRow[]}
            today={today}
          />
        )}
      </div>
    </>
  );
}

import { ClipboardList } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { GeneralUsageForm, type UsageProduct } from "@/components/sunaudojimas/general-usage-form";
import { DeleteUsageButton } from "@/components/sunaudojimas/delete-usage-button";
import { productWriteOffKind } from "@/lib/write-off-kinds";
import { formatDate, formatQty } from "@/lib/utils";

// Sunaudojimas be gyvulio (Priedas §2.5 atsargų kontrolė, §2.9 nurašymo
// aktai): medžiagos, priedai, nagų vonelė... used without a treatment
// record. Saved through create_general_usage (0012) so it hits stock and
// lands on the right nurašymo aktas like every other consumption.
export default async function SunaudojimasPage() {
  const supabase = await createClient();
  const todayIso = new Date().toISOString().slice(0, 10);

  const [productsRes, batchesRes, groupsRes, historyRes] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, unit, category, write_off_kind, default_write_off_group_id")
      .eq("is_active", true)
      .order("name"),
    // Same stock basis as create_general_usage: active, non-expired batches
    // (stock_by_product also counts expired ones, which FEFO won't touch).
    supabase.from("batches").select("product_id, qty_left, expiry_date").eq("status", "active").gt("qty_left", 0),
    supabase.from("write_off_groups").select("id, name, act_kinds").eq("active", true).order("sort_order"),
    supabase
      .from("general_usage")
      .select("id, use_date, qty, unit, stock_before, counted_remaining, notes, products(name), write_off_groups(name)")
      .order("use_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const stock = new Map<string, number>();
  for (const b of batchesRes.data ?? []) {
    if (b.expiry_date && b.expiry_date < todayIso) continue;
    stock.set(b.product_id, (stock.get(b.product_id) ?? 0) + Number(b.qty_left));
  }

  const products: UsageProduct[] = (productsRes.data ?? [])
    .filter((p) => (stock.get(p.id) ?? 0) > 0)
    .map((p) => ({
      id: p.id,
      name: p.name,
      unit: p.unit,
      kind: productWriteOffKind(p.category, p.write_off_kind),
      stock: Number((stock.get(p.id) ?? 0).toFixed(4)),
      default_group_id: p.default_write_off_group_id,
    }));

  const history = (historyRes.data ?? []) as unknown as Array<{
    id: string;
    use_date: string;
    qty: number;
    unit: string | null;
    stock_before: number | null;
    counted_remaining: number | null;
    notes: string | null;
    products: { name: string } | null;
    write_off_groups: { name: string } | null;
  }>;

  return (
    <div className="flex flex-col">
      <PageHeader title="Sunaudojimas be gyvulio" />
      <div className="space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <GeneralUsageForm products={products} groups={groupsRes.data ?? []} />

        <Card>
          <CardHeader>
            <CardTitle>Paskutiniai įrašai</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {history.length === 0 ? (
              <EmptyState icon={ClipboardList} title="Sunaudojimo įrašų dar nėra" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-border text-left text-text-muted">
                      <th className="px-5 py-2 font-medium">Data</th>
                      <th className="px-5 py-2 font-medium">Produktas</th>
                      <th className="px-5 py-2 font-medium">Sunaudota</th>
                      <th className="px-5 py-2 font-medium">Grupė</th>
                      <th className="px-5 py-2 font-medium">Inventorizacija</th>
                      <th className="px-5 py-2 font-medium">Pastabos</th>
                      <th className="px-5 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-secondary">
                        <td className="px-5 py-2">{formatDate(r.use_date)}</td>
                        <td className="px-5 py-2 font-semibold text-text-primary">{r.products?.name ?? "—"}</td>
                        <td className="px-5 py-2 tabular-nums">{formatQty(Number(r.qty), r.unit)}</td>
                        <td className="px-5 py-2 text-text-secondary">{r.write_off_groups?.name ?? "Nepriskirta"}</td>
                        <td className="px-5 py-2 tabular-nums text-text-secondary">
                          {r.counted_remaining !== null && r.stock_before !== null
                            ? `${formatQty(Number(r.stock_before))} − ${formatQty(Number(r.counted_remaining))}`
                            : "—"}
                        </td>
                        <td className="px-5 py-2 text-text-secondary">{r.notes ?? "—"}</td>
                        <td className="px-5 py-2 text-right">
                          <DeleteUsageButton id={r.id} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

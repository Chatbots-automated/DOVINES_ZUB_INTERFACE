import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Boxes } from "lucide-react";
import { formatDate, formatQty } from "@/lib/utils";

export default async function AtsargosPage() {
  const supabase = await createClient();
  const { data: batches } = await supabase.from("stock_by_batch").select("*");

  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date();
  soon.setDate(soon.getDate() + 30);
  const soonStr = soon.toISOString().slice(0, 10);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Atsargos"
        actions={
          <Link
            href="/apskaita/sunaudojimas"
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3 text-[13px] font-semibold hover:bg-surface-secondary"
          >
            <ClipboardList className="size-4" /> Sunaudojimas be gyvulio
          </Link>
        }
      />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        {(batches ?? []).length === 0 ? (
          <EmptyState icon={Boxes} title="Atsargų nėra" description="Priimkite pirmą partiją Pajamavimo skiltyje." />
        ) : (
          <div className="overflow-x-auto rounded-panel border border-border bg-surface">
            <table className="w-full min-w-[720px] text-left text-[14px]">
              <thead className="border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-4 py-3 font-medium">Produktas</th>
                  <th className="px-4 py-3 font-medium">Partija</th>
                  <th className="px-4 py-3 font-medium">Likutis</th>
                  <th className="px-4 py-3 font-medium">Galiojimo terminas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(batches ?? []).map((b) => {
                  const expired = b.expiry_date && b.expiry_date < today;
                  const expiringSoon = b.expiry_date && !expired && b.expiry_date <= soonStr;
                  return (
                    <tr key={b.id}>
                      <td className="px-4 py-3 font-medium text-text-primary">{b.product_name}</td>
                      <td className="px-4 py-3 text-text-secondary">{b.lot ?? "—"}</td>
                      <td className="px-4 py-3 text-text-secondary">{formatQty(b.qty_left, b.unit)}</td>
                      <td className="px-4 py-3">
                        {b.expiry_date ? (
                          <Badge tone={expired ? "danger" : expiringSoon ? "warning" : "neutral"}>{formatDate(b.expiry_date)}</Badge>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

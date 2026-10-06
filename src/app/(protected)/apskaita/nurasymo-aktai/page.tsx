import Link from "next/link";
import { FileMinus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { NewWriteOffActDialog } from "@/components/nurasymai/new-act-dialog";
import { WRITE_OFF_KINDS } from "@/lib/write-off-kinds";
import { formatDate, formatEur } from "@/lib/utils";
import { WRITE_OFF_STATUS as STATUS_LABEL } from "@/lib/write-off-status";

// Veterinarinių produktų nurašymo aktai (Priedas §2.9).
export default async function NurasymoAktaiPage() {
  const supabase = await createClient();
  const { data: acts } = await supabase.from("write_off_acts").select("*").order("act_date", { ascending: false }).order("act_number", { ascending: false }).limit(500);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Nurašymo aktai"
        description="Vaistų, biocidų · veterinarinių priedų · medžiagų panaudojimo aktai su paskirstymu pagal grupes"
        actions={<NewWriteOffActDialog />}
      />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        {(acts ?? []).length === 0 ? (
          <EmptyState icon={FileMinus} title="Nurašymo aktų dar nėra" description="Suformuokite aktą už pasirinktą mėnesį." />
        ) : (
          <div className="overflow-x-auto rounded-panel border border-border bg-surface">
            <table className="w-full min-w-[760px] text-left text-[14px]">
              <thead className="border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-4 py-3 font-medium">Nr.</th>
                  <th className="px-4 py-3 font-medium">Data</th>
                  <th className="px-4 py-3 font-medium">Laikotarpis</th>
                  <th className="px-4 py-3 font-medium">Aktas</th>
                  <th className="px-4 py-3 font-medium">Suma</th>
                  <th className="px-4 py-3 font-medium">Būsena</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(acts ?? []).map((a) => (
                  <tr key={a.id} className="hover:bg-surface-secondary/50">
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/apskaita/nurasymo-aktai/${a.id}`} className="text-accent-hover hover:underline">
                        {a.act_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{formatDate(a.act_date)}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {formatDate(a.period_start)} – {formatDate(a.period_end)}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{WRITE_OFF_KINDS[a.act_kind]?.label ?? a.act_kind}</td>
                    <td className="px-4 py-3 tabular-nums text-text-secondary">{formatEur(a.total_amount)}</td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_LABEL[a.status]?.tone ?? "neutral"}>{STATUS_LABEL[a.status]?.label ?? a.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

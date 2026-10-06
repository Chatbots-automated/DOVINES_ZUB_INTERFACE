import { Dna } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils";
import { INSEMINATION_SELECT, PREGNANCY_LABELS, expectedCalvingDate, pregnancyStatus, type InseminationRow } from "@/lib/seklinimas";

// Per-animal insemination history for the animal card (self-fetching, so the
// page only has to render <AnimalInseminationCard animalId={id} />).
export async function AnimalInseminationCard({ animalId }: { animalId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("insemination_records")
    .select(INSEMINATION_SELECT)
    .eq("animal_id", animalId)
    .order("insemination_date", { ascending: false });
  const rows = (data ?? []) as unknown as InseminationRow[];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sėklinimų istorija</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <EmptyState icon={Dna} title="Sėklinimų nėra" className="py-10" />
        ) : (
          <div className="divide-y divide-border">
            {rows.map((i) => {
              const status = pregnancyStatus(i.pregnancy_confirmed);
              return (
                <div key={i.id} className="px-5 py-3">
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-[14px] font-medium text-text-primary">{formatDate(i.insemination_date)}</p>
                    <Badge tone={status === "confirmed" ? "success" : status === "not_confirmed" ? "danger" : "neutral"}>{PREGNANCY_LABELS[status]}</Badge>
                  </div>
                  <p className="text-[13px] text-text-secondary">
                    {i.sperm?.name ?? i.bull_name ?? "—"}
                    {i.reproduktoriaus_id ? ` · KK Nr. ${i.reproduktoriaus_id}` : ""}
                    {i.inseminator_name ? ` · ${i.inseminator_name}` : ""}
                  </p>
                  <p className="mt-1 text-[12px] text-text-muted">
                    {i.pregnancy_check_date
                      ? `Patikra: ${formatDate(i.pregnancy_check_date)}`
                      : i.next_pregnancy_check_date
                        ? `Planuojama patikra: ${formatDate(i.next_pregnancy_check_date)}`
                        : "Patikra nenurodyta"}
                    {i.pregnancy_confirmed !== false ? ` · Numatomas apsiveršiavimas: ${formatDate(expectedCalvingDate(i.insemination_date))}` : ""}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

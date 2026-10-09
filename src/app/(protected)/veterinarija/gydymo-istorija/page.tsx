import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { TreatmentHistory } from "@/components/gydymo-istorija/treatment-history";
import { groupTreatments, type TreatedRow } from "@/lib/treatment-history";
import { vilniusDay } from "@/lib/visits";

// PostgREST caps a response at max_rows (1000) regardless of .limit(), so the
// journal view is read in pages.
const CHUNK = 1000;
const MAX_ROWS = 20000;

// "Gydymų istorija" — searchable/filterable treatment log (Priedas §2.10
// "paieška, filtrai ir istorija": pagal gyvūną, produktą, laikotarpį, diagnozę).
// Same underlying view as the Ataskaitos "Gydomų gyvūnų žurnalas" tab, shown as
// one card per treatment instead of a table.
export default async function GydymoIstorijaPage() {
  const supabase = await createClient();

  const rows: TreatedRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += CHUNK) {
    const { data } = await supabase
      .from("vw_treated_animals")
      .select("*")
      .order("reg_date", { ascending: false })
      .order("treatment_id")
      .order("used_on")
      .order("product_name")
      .range(from, from + CHUNK - 1);
    const chunk = (data ?? []) as unknown as TreatedRow[];
    rows.push(...chunk);
    if (chunk.length < CHUNK) break;
  }

  return (
    <>
      <PageHeader title="Gydymų istorija" description="Visi gydymai, profilaktika ir apžiūros — kortelė kiekvienam įrašui" />
      <div className="p-4 sm:p-6 lg:p-8">
        <TreatmentHistory cards={groupTreatments(rows)} today={vilniusDay(new Date())} />
      </div>
    </>
  );
}

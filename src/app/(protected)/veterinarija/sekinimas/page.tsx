import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { NewInseminationDialog } from "@/components/seklinimas/new-insemination-dialog";
import { InseminationTable } from "@/components/seklinimas/insemination-table";
import { INSEMINATION_SELECT, type InseminationRow } from "@/lib/seklinimas";

// "Sėklinimas" — insemination journal: records, semen/glove stock use,
// pregnancy checks and the VIC journal CSV (0017_insemination.sql).
export default async function SekinimasPage() {
  const supabase = await createClient();
  const session = await getCurrentProfile();

  const [{ data: records }, { data: animals }, { data: sperm }, { data: gloves }] = await Promise.all([
    supabase.from("insemination_records").select(INSEMINATION_SELECT).order("insemination_date", { ascending: false }).limit(5000),
    supabase.from("animals").select("id, tag_no, animal_no, group_name, sex").eq("active", true).order("animal_no"),
    supabase.from("products").select("id, name, unit").eq("is_active", true).eq("category", "reproduction").order("name"),
    supabase.from("products").select("id, name, unit").eq("is_active", true).eq("category", "treatment_materials").order("name"),
  ]);

  // DelPro "lytis" is a lifecycle category — leave out bulls and calves.
  const females = (animals ?? []).filter((a) => !/bulius|buliuk|veršel/i.test(a.sex ?? ""));

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Sėklinimas"
        description="Sėklinimo žurnalas, spermos ir pirštinių sunaudojimas, nėštumo patikros"
        actions={<NewInseminationDialog animals={females} sperm={sperm ?? []} gloves={gloves ?? []} currentVetName={session?.profile.full_name} />}
      />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <InseminationTable rows={(records ?? []) as unknown as InseminationRow[]} />
      </div>
    </div>
  );
}

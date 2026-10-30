import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { TreatmentHistory } from "@/components/gydymo-istorija/treatment-history";
import { groupTreatments, type TreatedRow } from "@/lib/treatment-history";
import { vilniusDay } from "@/lib/visits";
import type { DelproSyncJobStatus } from "@/lib/supabase/types";

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

  // DelPro transfer state per gydymas (Priedas §4). Shown only while the
  // integration is switched on; approving is limited to admin + vet (re-checked
  // in the database by delpro_approve_treatment, this just hides the button).
  const [{ data: modeRow }, session] = await Promise.all([
    supabase.from("system_settings").select("setting_value").eq("setting_key", "delpro_outbound_mode").maybeSingle(),
    getCurrentProfile(),
  ]);
  let delpro: { statuses: Record<string, DelproSyncJobStatus>; canApprove: boolean } | undefined;
  if ((modeRow?.setting_value ?? "approval") !== "off") {
    const statuses: Record<string, DelproSyncJobStatus> = {};
    for (let from = 0; from < MAX_ROWS; from += CHUNK) {
      const { data } = await supabase.from("delpro_sync_jobs").select("treatment_id, status").order("treatment_id").range(from, from + CHUNK - 1);
      for (const j of data ?? []) statuses[j.treatment_id] = j.status;
      if ((data?.length ?? 0) < CHUNK) break;
    }
    const role = session?.profile.role;
    delpro = { statuses, canApprove: role === "admin" || role === "vet" };
  }

  return (
    <>
      <PageHeader title="Gydymų istorija" description="Visi gydymai, profilaktika ir apžiūros — kortelė kiekvienam įrašui" />
      <div className="p-4 sm:p-6 lg:p-8">
        <TreatmentHistory cards={groupTreatments(rows)} today={vilniusDay(new Date())} delpro={delpro} />
      </div>
    </>
  );
}

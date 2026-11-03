import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { NewInseminationDialog } from "@/components/seklinimas/new-insemination-dialog";
import { InseminationTable } from "@/components/seklinimas/insemination-table";
import { DelproSyncPanel, type DelproScanProblem, type DelproSemenItem } from "@/components/seklinimas/delpro-sync-panel";
import { INSEMINATION_SELECT, type InseminationRow } from "@/lib/seklinimas";
import type { DelproInseminationStatus, DelproInseminationScanRow, DelproSemenRow } from "@/lib/supabase/types";

// "Sėklinimas" — insemination journal: records, semen/glove stock use,
// pregnancy checks and the VIC journal CSV (0017_insemination.sql); DelPro-imported events (0053) in the same journal.
export default async function SekinimasPage() {
  const supabase = await createClient();
  const session = await getCurrentProfile();

  const [{ data: records }, { data: animals }, { data: sperm }, { data: gloves }, { data: status }, { data: scans }, { data: semenRows }] = await Promise.all([
    supabase.from("insemination_records").select(INSEMINATION_SELECT).order("insemination_date", { ascending: false }).limit(5000),
    supabase.from("animals").select("id, tag_no, animal_no, group_name, sex").eq("active", true).order("animal_no"),
    supabase.from("products").select("id, name, unit").eq("is_active", true).eq("category", "reproduction").order("name"),
    supabase.from("products").select("id, name, unit").eq("is_active", true).eq("category", "treatment_materials").order("name"),
    supabase.rpc("delpro_insemination_status"),
    // animals whose last DelPro read failed or was incomplete
    supabase
      .from("delpro_insemination_scans")
      .select("animal_id, checked_at, ok, complete, error, invalid, animals(tag_no, animal_no)")
      .not("checked_at", "is", null)
      .or("ok.eq.false,complete.eq.false")
      .order("checked_at", { ascending: false })
      .limit(100),
    supabase.from("delpro_semen").select("semen_key, delpro_name, delpro_comment, name_override, synced_at, updated_at, updated_by").limit(2000),
  ]);
  const rows = (records ?? []) as unknown as InseminationRow[];
  const useCount = new Map<string, number>();
  for (const r of rows) if (r.delpro_semen_key) useCount.set(r.delpro_semen_key, (useCount.get(r.delpro_semen_key) ?? 0) + 1);
  const semen: DelproSemenItem[] = ((semenRows ?? []) as DelproSemenRow[]).map((x) => ({
    semen_key: x.semen_key, delpro_name: x.delpro_name, delpro_comment: x.delpro_comment, name_override: x.name_override, count: useCount.get(x.semen_key) ?? 0,
  }));
  const problems: DelproScanProblem[] = ((scans ?? []) as unknown as (Pick<DelproInseminationScanRow, "animal_id" | "checked_at" | "ok" | "error" | "invalid"> & {
    animals: { tag_no: string; animal_no: string | null } | null;
  })[]).map((s) => ({ animal_id: s.animal_id, tag_no: s.animals?.tag_no ?? "—", animal_no: s.animals?.animal_no ?? null, checked_at: s.checked_at, ok: s.ok, error: s.error, invalid: s.invalid ?? [] }));
  const canWrite = !!session && session.profile.role !== "viewer";

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
        <DelproSyncPanel status={(status ?? null) as DelproInseminationStatus | null} problems={problems} semen={semen} canWrite={canWrite} />
        <InseminationTable rows={rows} />
      </div>
    </div>
  );
}

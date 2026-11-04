import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { MassTreatmentClient } from "@/components/masinis-gydymas/mass-treatment-client";
import { PRODUCT_WITHDRAWAL_COLUMNS } from "@/lib/administration-routes";
import { vilniusDay } from "@/lib/visits";
import type { Product } from "@/components/gyvunai/new-treatment-dialog";
import type { MassAnimal, MassHistoryRow, MassDelproInfo } from "@/lib/mass-treatments";

// PostgREST caps a response at max_rows (1000) regardless of .limit() — page through.
const CHUNK = 1000;
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null }>, max: number): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += CHUNK) {
    const { data } = await build(from, from + CHUNK - 1);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < CHUNK) break;
  }
  return out;
}

// Masinis gydymas (0056, farm's request — billed separately): the same treatment
// for many animals; one ordinary treatment + DelPro job per animal.
export default async function MasinisGydymasPage() {
  const supabase = await createClient();
  const session = await getCurrentProfile();
  const today = vilniusDay(new Date());

  const [animals, activeWithdrawals, history, { data: groups }, { data: diseases }, { data: products }, links, { data: settings }] =
    await Promise.all([
      fetchAll<Omit<MassAnimal, "milk_active" | "meat_active">>(
        (from, to) =>
          supabase
            .from("animals")
            .select("id, tag_no, animal_no, group_name, sex, birth_date, lactation_no, delpro_object_guid")
            .eq("active", true)
            .order("animal_no")
            .order("id")
            .range(from, to),
        20000,
      ),
      fetchAll<{ animal_id: string; milk_active: boolean; meat_active: boolean }>(
        (from, to) =>
          supabase
            .from("vw_withdrawal_status")
            .select("animal_id, milk_active, meat_active")
            .or("milk_active.eq.true,meat_active.eq.true")
            .order("animal_id")
            .range(from, to),
        20000,
      ),
      fetchAll<MassHistoryRow>(
        (from, to) => supabase.from("vw_mass_treatments").select("*").order("created_at", { ascending: false }).range(from, to),
        2000,
      ),
      supabase.from("delpro_groups").select("name").eq("active", true).order("name"),
      supabase.from("diseases").select("id, name").order("name"),
      supabase.from("products").select(PRODUCT_WITHDRAWAL_COLUMNS).order("name"),
      fetchAll<{ object_type: string; disease_id: string | null; product_id: string | null }>(
        (from, to) =>
          supabase
            .from("delpro_catalog_links")
            .select("object_type, disease_id, product_id")
            .is("retired_at", null)
            .order("id")
            .range(from, to),
        20000,
      ),
      supabase.from("system_settings").select("setting_key, setting_value").in("setting_key", ["delpro_outbound_mode", "delpro_write_channel"]),
    ]);

  const karencija = new Map(activeWithdrawals.map((w) => [w.animal_id, w]));
  const pickerAnimals: MassAnimal[] = animals.map((a) => ({
    ...a,
    milk_active: karencija.get(a.id)?.milk_active ?? false,
    meat_active: karencija.get(a.id)?.meat_active ?? false,
  }));

  const setting = (k: string) => (settings ?? []).find((s) => s.setting_key === k)?.setting_value ?? null;
  const delpro: MassDelproInfo = {
    enabled: (setting("delpro_outbound_mode") ?? "approval") !== "off",
    gateway: setting("delpro_write_channel") === "gateway",
    linkedDiseaseIds: links.filter((l) => l.object_type === "Diagnosis" && l.disease_id).map((l) => l.disease_id as string),
    linkedProductIds: links.filter((l) => l.object_type === "Drug" && l.product_id).map((l) => l.product_id as string),
    canApprove: session?.profile.role === "admin",
  };

  return (
    <div className="flex flex-col">
      <PageHeader title="Masinis gydymas" description="Tas pats gydymas daugeliui gyvūnų vienu metu — kiekvienam gyvūnui atskiras įrašas ir DelPro perdavimas" />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <MassTreatmentClient
          animals={pickerAnimals}
          groups={(groups ?? []).map((g) => g.name)}
          diseases={diseases ?? []}
          products={(products ?? []) as unknown as Product[]}
          history={history}
          delpro={delpro}
          currentVetName={session?.profile.full_name}
          canWrite={session?.profile.role !== "viewer"}
          today={today}
        />
      </div>
    </div>
  );
}

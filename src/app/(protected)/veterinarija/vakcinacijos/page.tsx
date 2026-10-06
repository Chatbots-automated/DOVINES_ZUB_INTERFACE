import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { VaccinationsClient } from "@/components/vakcinacijos/vaccinations-client";
import { PRODUCT_WITHDRAWAL_COLUMNS } from "@/lib/administration-routes";
import { addDaysIso, type PickerAnimal, type VaccProduct, type VaccRow } from "@/lib/vaccinations";

// PostgREST caps a response at max_rows (1000 by default) regardless of
// .limit() — page through with .range() so a herd of thousands is complete.
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

export default async function VakcinacijosPage() {
  const supabase = await createClient();
  const session = await getCurrentProfile();
  const today = new Date().toISOString().slice(0, 10);
  const since = addDaysIso(today, -730); // history window: last 24 months

  const [vaccinations, animals, activeWithdrawals, { data: groups }, { data: products }] = await Promise.all([
    fetchAll<VaccRow>(
      (from, to) =>
        supabase
          .from("vaccinations")
          .select(
            "id, session_id, target_group_name, animal_group_snapshot, animal_id, product_id, vaccination_date, dose_amount, unit, administration_route, is_revaccination, next_booster_date, withdrawal_until_milk, withdrawal_until_meat, vet_name, notes, animals(tag_no, animal_no)",
          )
          .gte("vaccination_date", since)
          .order("vaccination_date", { ascending: false })
          .order("id")
          .range(from, to),
      20000,
    ),
    fetchAll<Omit<PickerAnimal, "milk_active" | "meat_active">>(
      (from, to) =>
        supabase
          .from("animals")
          .select("id, tag_no, animal_no, group_name, sex, birth_date, lactation_no")
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
    supabase.from("delpro_groups").select("name").eq("active", true).order("name"),
    supabase
      .from("products")
      .select(`${PRODUCT_WITHDRAWAL_COLUMNS}, is_active`)
      .eq("category", "vakcina")
      .order("name"),
  ]);

  const karencija = new Map(activeWithdrawals.map((w) => [w.animal_id, w]));
  const pickerAnimals: PickerAnimal[] = animals.map((a) => ({
    ...a,
    milk_active: karencija.get(a.id)?.milk_active ?? false,
    meat_active: karencija.get(a.id)?.meat_active ?? false,
  }));

  return (
    <div className="flex flex-col">
      <PageHeader title="Vakcinacijos" description="Masinė gyvūnų vakcinacija, pakartotinių vakcinacijų planas ir istorija" />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <VaccinationsClient
          animals={pickerAnimals}
          groups={(groups ?? []).map((g) => g.name)}
          products={(products ?? []) as unknown as VaccProduct[]}
          vaccinations={vaccinations}
          currentVetName={session?.profile.full_name}
          today={today}
        />
      </div>
    </div>
  );
}

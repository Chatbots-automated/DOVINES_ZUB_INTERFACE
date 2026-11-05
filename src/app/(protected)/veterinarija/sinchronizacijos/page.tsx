import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { SyncClient } from "@/components/sinchronizacijos/sync-client";
import { vilniusDay } from "@/lib/visits";
import type { SyncAnimal } from "@/lib/sync-mass";
import type { SyncProductOption, SyncProtocolData } from "@/lib/sync-protocols";
import type { SyncApplicationViewRow, SyncOpenStepRow, SyncStepKind, SyncStepMedication, Database } from "@/lib/supabase/types";

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

// Same list as TREATMENT_PRODUCT_CATEGORIES / fn_sync_clean_medications (0025).
const PROTOCOL_PRODUCT_CATEGORIES = ["medicines", "vakcina", "profilaktika", "boliusai", "treatment_materials"] as const;

type FlagRow = Database["public"]["Views"]["vw_sync_animal_flags"]["Row"];
type MassRow = Database["public"]["Views"]["vw_sync_mass_applications"]["Row"];
type ProtocolRow = {
  id: string;
  name: string;
  description: string | null;
  sync_protocol_steps: { day_offset: number; title: string; notes: string | null; sort_order: number; kind: SyncStepKind; medications: SyncStepMedication[] }[];
};

// Sinchronizacijos (0059, farm's request — billed with Sinchronizacijos protokolai 0025):
// one protocol for many animals, every animal's due steps, running/finished protocols,
// and the protocol templates.
export default async function SinchronizacijosPage() {
  const supabase = await createClient();
  const session = await getCurrentProfile();
  const today = vilniusDay(new Date());

  const [animals, flags, steps, applications, { data: massApplications }, { data: groups }, { data: protocols, error: protocolsError }, { data: products }] = await Promise.all([
    fetchAll<Omit<SyncAnimal, "open_protocol_name" | "last_insemination_date" | "last_pregnancy_confirmed">>(
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
    fetchAll<FlagRow>((from, to) => supabase.from("vw_sync_animal_flags").select("*").order("animal_id").range(from, to), 20000),
    fetchAll<SyncOpenStepRow>(
      (from, to) => supabase.from("vw_sync_open_steps").select("*").order("visit_datetime").order("visit_id").range(from, to),
      20000,
    ),
    fetchAll<SyncApplicationViewRow>(
      (from, to) => supabase.from("vw_sync_applications").select("*").order("created_at", { ascending: false }).order("id").range(from, to),
      10000,
    ),
    supabase.from("vw_sync_mass_applications").select("*").order("created_at", { ascending: false }).limit(200),
    supabase.from("delpro_groups").select("name").eq("active", true).order("name"),
    supabase.from("sync_protocols").select("id, name, description, sync_protocol_steps(day_offset, title, notes, sort_order, kind, medications)").order("name"),
    supabase.from("products").select("id, name, unit, category, is_active").order("name"),
  ]);

  const flagById = new Map(flags.map((f) => [f.animal_id, f]));
  const syncAnimals: SyncAnimal[] = animals.map((a) => {
    const f = flagById.get(a.id);
    return {
      ...a,
      open_protocol_name: f?.open_protocol_name ?? null,
      last_insemination_date: f?.last_insemination_date ?? null,
      last_pregnancy_confirmed: f?.last_pregnancy_confirmed ?? null,
    };
  });

  const protocolData: SyncProtocolData[] = ((protocols ?? []) as unknown as ProtocolRow[]).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    steps: [...p.sync_protocol_steps]
      .sort((a, b) => a.day_offset - b.day_offset || a.sort_order - b.sort_order)
      .map((s) => ({ day_offset: s.day_offset, title: s.title, notes: s.notes, kind: s.kind, medications: s.medications ?? [] })),
  }));
  const allProducts = (products ?? []).map((p) => ({ id: p.id, name: p.name, unit: p.unit as string }));
  const protocolProducts: SyncProductOption[] = (products ?? [])
    .filter((p) => p.is_active && (PROTOCOL_PRODUCT_CATEGORIES as readonly string[]).includes(p.category))
    .map((p) => ({ id: p.id, name: p.name, unit: p.unit }));

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Sinchronizacijos"
        description="Sinchronizacijos protokolas daugeliui gyvūnų vienu metu, visų gyvūnų protokolo žingsniai ir protokolų šablonai"
      />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        {protocolsError && (
          <p className="mb-4 rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">
            Nepavyko įkelti protokolų: {protocolsError.message}
          </p>
        )}
        <SyncClient
          animals={syncAnimals}
          groups={(groups ?? []).map((g) => g.name)}
          steps={steps}
          applications={applications}
          massApplications={(massApplications ?? []) as MassRow[]}
          protocols={protocolData}
          protocolProducts={protocolProducts}
          allProducts={allProducts}
          currentVetName={session?.profile.full_name}
          canWrite={session?.profile.role !== "viewer"}
          today={today}
        />
      </div>
    </div>
  );
}

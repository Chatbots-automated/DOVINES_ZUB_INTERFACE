import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { NewVisitDialog } from "@/components/vizitai/new-visit-dialog";
import { VisitsBoard } from "@/components/vizitai/visits-board";
import type { VisitCardData } from "@/components/vizitai/visit-card";
import { PRODUCT_WITHDRAWAL_COLUMNS } from "@/lib/administration-routes";
import { vilniusDay } from "@/lib/visits";
import type { Product } from "@/components/gyvunai/new-treatment-dialog";
import type { ProcedureType, VisitProcedure, VisitStatus } from "@/lib/supabase/types";

const PROCEDURE_LABELS: Record<ProcedureType, string> = { apziura: "Apžiūra", gydymas: "Gydymas", profilaktika: "Profilaktika" };

// PostgREST caps a response at max_rows (1000) regardless of .limit().
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

type VisitRow = {
  id: string;
  animal_id: string;
  visit_datetime: string;
  procedures: VisitProcedure[];
  status: VisitStatus;
  temperature: number | null;
  notes: string | null;
  vet_name: string | null;
  next_visit_date: string | null;
  related_visit_id: string | null;
  animals: { tag_no: string; animal_no: string | null; group_name: string | null } | null;
  treatments: { id: string; procedure_type: ProcedureType; diagnosis: string | null; diseases: { name: string } | null }[];
  vaccinations: { id: string; products: { name: string } | null }[];
};

// "Vizitai" — veterinarijos vizitų planavimas ir istorija (0018_visits.sql).
// A visit is only the scheduling wrapper; the real clinical records
// (treatments / vaccinations, with their FEFO stock use and DelPro queue)
// are linked to it through visit_id.
export default async function VizitaiPage() {
  const supabase = await createClient();
  const session = await getCurrentProfile();
  const today = vilniusDay(new Date());

  const [visitRows, animals, withdrawals, diseasesRes, productsRes] = await Promise.all([
    fetchAll<VisitRow>(
      (from, to) =>
        supabase
          .from("animal_visits")
          .select(
            "id, animal_id, visit_datetime, procedures, status, temperature, notes, vet_name, next_visit_date, related_visit_id, animals(tag_no, animal_no, group_name), treatments(id, procedure_type, diagnosis, diseases(name)), vaccinations(id, products(name))",
          )
          .order("visit_datetime", { ascending: false })
          .order("id")
          .range(from, to),
      5000,
    ),
    fetchAll<{ id: string; tag_no: string; animal_no: string | null; group_name: string | null }>(
      (from, to) => supabase.from("animals").select("id, tag_no, animal_no, group_name").eq("active", true).order("animal_no").order("id").range(from, to),
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
    supabase.from("diseases").select("id, name").order("name"),
    supabase.from("products").select(PRODUCT_WITHDRAWAL_COLUMNS).eq("is_active", true).order("name"),
  ]);

  const karencija = new Map(withdrawals.map((w) => [w.animal_id, w]));
  const products = (productsRes.data ?? []) as unknown as (Product & { category: string })[];

  const visits: VisitCardData[] = visitRows.map((v) => ({
    id: v.id,
    animal_id: v.animal_id,
    animal_no: v.animals?.animal_no ?? null,
    tag_no: v.animals?.tag_no ?? "—",
    group_name: v.animals?.group_name ?? null,
    visit_datetime: v.visit_datetime,
    procedures: v.procedures,
    status: v.status,
    temperature: v.temperature,
    notes: v.notes,
    vet_name: v.vet_name,
    next_visit_date: v.next_visit_date,
    isFollowUp: v.related_visit_id !== null,
    records: [
      ...v.treatments.map((t) => ({
        kind: "treatment" as const,
        id: t.id,
        label: PROCEDURE_LABELS[t.procedure_type],
        detail: t.diagnosis ?? t.diseases?.name ?? null,
      })),
      ...v.vaccinations.map((x) => ({ kind: "vaccination" as const, id: x.id, label: "Vakcinacija", detail: x.products?.name ?? null })),
    ],
    treatmentTypes: v.treatments.map((t) => t.procedure_type),
    hasVaccination: v.vaccinations.length > 0,
    withdrawalMilk: karencija.get(v.animal_id)?.milk_active ?? false,
    withdrawalMeat: karencija.get(v.animal_id)?.meat_active ?? false,
  }));

  const currentVetName = session?.profile.full_name ?? null;
  const canWrite = session?.profile.role !== "viewer";

  return (
    <>
      <PageHeader
        title="Vizitai"
        description="Veterinarijos vizitų planas ir istorija — gydymo bei vakcinacijos įrašai susiejami su vizitu"
        actions={canWrite ? <NewVisitDialog animals={animals} currentVetName={currentVetName} today={today} /> : undefined}
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <VisitsBoard
          visits={visits}
          today={today}
          diseases={diseasesRes.data ?? []}
          treatmentProducts={products.filter((p) => p.category !== "biocide")}
          vaccineProducts={products.filter((p) => p.category === "vakcina")}
          currentVetName={currentVetName}
          canWrite={canWrite}
        />
      </div>
    </>
  );
}

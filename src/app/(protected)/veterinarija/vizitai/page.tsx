import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { NewVisitDialog } from "@/components/vizitai/new-visit-dialog";
import { VisitsBoard } from "@/components/vizitai/visits-board";
import type { VisitCardData } from "@/components/vizitai/visit-card";
import { PRODUCT_WITHDRAWAL_COLUMNS, ROUTE_OPTIONS } from "@/lib/administration-routes";
import { formatQty } from "@/lib/utils";
import { TREATMENT_TYPE_LABELS, vilniusDay } from "@/lib/visits";
import type { Product } from "@/components/gyvunai/new-treatment-dialog";
import type { AdministrationRoute, ProcedureType, SyncStepMedication, Unit, VisitProcedure, VisitStatus } from "@/lib/supabase/types";

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
  sync_application_id: string | null;
  sync_step_title: string | null;
  sync_step_no: number | null;
  sync_step_total: number | null;
  planned_medications: SyncStepMedication[];
  sync_protocol_applications: { protocol_name: string } | null;
  animals: { tag_no: string; animal_no: string | null; group_name: string | null } | null;
  treatments: {
    id: string;
    procedure_type: ProcedureType;
    reg_date: string;
    diagnosis: string | null;
    outcome: string | null;
    withdrawal_until_milk: string | null;
    withdrawal_until_meat: string | null;
    diseases: { name: string } | null;
    treatment_courses: { days: number; status: string }[];
    usage_items: { qty: number; unit: Unit | null; administration_route: AdministrationRoute | null; products: { name: string } | null }[];
  }[];
  vaccinations: {
    id: string;
    dose_amount: number | null;
    unit: Unit | null;
    administration_route: AdministrationRoute | null;
    withdrawal_until_milk: string | null;
    withdrawal_until_meat: string | null;
    products: { name: string } | null;
  }[];
  insemination_records: { id: string; bull_name: string | null; pazymejimo_nr: string | null; sperm_quantity: number | null; sperm: { name: string } | null }[];
};

const ROUTE_LABEL = new Map<string, string>(ROUTE_OPTIONS.map((r) => [r.value, r.label]));
const routeSuffix = (route: AdministrationRoute | null) => (route ? ` (${ROUTE_LABEL.get(route) ?? route})` : "");

// "Vizitai" — veterinarijos vizitų planavimas ir istorija (0018_visits.sql).
// A visit is only the scheduling wrapper; the real clinical records
// (treatments / vaccinations, with their FEFO stock use and DelPro queue)
// are linked to it through visit_id.
export default async function VizitaiPage() {
  const supabase = await createClient();
  const session = await getCurrentProfile();
  const today = vilniusDay(new Date());

  const [visitRows, animals, withdrawals, diseasesRes, productsRes, spermRes, glovesRes] = await Promise.all([
    fetchAll<VisitRow>(
      (from, to) =>
        supabase
          .from("animal_visits")
          .select(
            "id, animal_id, visit_datetime, procedures, status, temperature, notes, vet_name, next_visit_date, related_visit_id, sync_application_id, sync_step_title, sync_step_no, sync_step_total, planned_medications, sync_protocol_applications(protocol_name), animals(tag_no, animal_no, group_name), treatments(id, procedure_type, reg_date, diagnosis, outcome, withdrawal_until_milk, withdrawal_until_meat, diseases(name), treatment_courses(days, status), usage_items(qty, unit, administration_route, products(name))), vaccinations(id, dose_amount, unit, administration_route, withdrawal_until_milk, withdrawal_until_meat, products(name)), insemination_records(id, bull_name, pazymejimo_nr, sperm_quantity, sperm:products!insemination_records_sperm_product_id_fkey(name))",
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
    supabase.from("products").select("id, name, unit").eq("is_active", true).eq("category", "reproduction").order("name"),
    supabase.from("products").select("id, name, unit").eq("is_active", true).eq("category", "treatment_materials").order("name"),
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
    // What was actually done on the visit — shown on the card so nobody has to open it.
    records: [
      ...v.treatments.map((t) => {
        const course = t.treatment_courses.find((c) => c.status !== "cancelled");
        return {
          kind: "treatment" as const,
          id: t.id,
          label: TREATMENT_TYPE_LABELS[t.procedure_type],
          detail: [t.diseases?.name, t.diagnosis && t.diagnosis !== t.diseases?.name ? t.diagnosis : null].filter(Boolean).join(" · ") || null,
          lines: [
            ...t.usage_items.map((u) => `${u.products?.name ?? "Produktas"} — ${formatQty(u.qty, u.unit)}${routeSuffix(u.administration_route)}`),
            ...(course ? [`Kursas: ${course.days} d.`] : []),
          ],
          outcome: t.outcome,
          karencijaMilk: t.withdrawal_until_milk,
          karencijaMeat: t.withdrawal_until_meat,
        };
      }),
      ...v.vaccinations.map((x) => ({
        kind: "vaccination" as const,
        id: x.id,
        label: "Vakcinacija",
        detail: null,
        lines: [`${x.products?.name ?? "Vakcina"}${x.dose_amount != null ? ` — ${formatQty(x.dose_amount, x.unit)}` : ""}${routeSuffix(x.administration_route)}`],
        outcome: null,
        karencijaMilk: x.withdrawal_until_milk,
        karencijaMeat: x.withdrawal_until_meat,
      })),
      ...v.insemination_records.map((i) => ({
        kind: "insemination" as const,
        id: i.id,
        label: "Sėklinimas",
        detail: [i.bull_name, i.pazymejimo_nr ? `Nr. ${i.pazymejimo_nr}` : null].filter(Boolean).join(" · ") || null,
        lines: i.sperm ? [`${i.sperm.name}${i.sperm_quantity != null ? ` — ${i.sperm_quantity} dozė(s)` : ""}`] : [],
        outcome: null,
        karencijaMilk: null,
        karencijaMeat: null,
      })),
    ],
    treatmentTypes: v.treatments.map((t) => t.procedure_type),
    hasVaccination: v.vaccinations.length > 0,
    hasInsemination: v.insemination_records.length > 0,
    withdrawalMilk: karencija.get(v.animal_id)?.milk_active ?? false,
    withdrawalMeat: karencija.get(v.animal_id)?.meat_active ?? false,
    sync: v.sync_application_id !== null || v.procedures.includes("sinchronizacija")
      ? {
          applicationId: v.sync_application_id,
          protocolName: v.sync_protocol_applications?.protocol_name ?? null,
          stepTitle: v.sync_step_title,
          stepNo: v.sync_step_no,
          stepTotal: v.sync_step_total,
          plannedMedications: v.planned_medications ?? [],
        }
      : null,
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
          sperm={spermRes.data ?? []}
          gloves={glovesRes.data ?? []}
          currentVetName={currentVetName}
          canWrite={canWrite}
        />
      </div>
    </>
  );
}

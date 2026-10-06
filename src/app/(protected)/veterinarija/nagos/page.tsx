import Link from "next/link";
import { Footprints } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatQty } from "@/lib/utils";
import { HOOF_LEG_LABELS, formatZones, severityTone } from "@/lib/hoof";
import type { HoofLeg, HoofZoneSelection } from "@/lib/supabase/types";
import { NewHoofExamDialog, type HoofProductOption } from "@/components/nagos/new-hoof-exam-dialog";
import { CompleteFollowupButton, DeleteHoofExamButton } from "@/components/nagos/row-actions";

type SearchParams = { animal?: string; from?: string; to?: string; condition?: string; followup?: string };

type FindingRow = {
  id: string;
  leg: HoofLeg | null;
  zones: HoofZoneSelection[];
  condition_code: string | null;
  diagnosis: string | null;
  severity: number;
  was_trimmed: boolean;
  was_treated: boolean;
  bandage_applied: boolean;
  followup_required: boolean;
  followup_date: string | null;
  followup_completed: boolean;
  notes: string | null;
  hoof_condition_codes: { description: string } | null;
  hoof_exams: {
    id: string;
    exam_date: string;
    performed_by: string | null;
    animal_id: string;
    animals: { id: string; tag_no: string; animal_no: string | null } | null;
  };
  usage_items: Array<{ qty: number; unit: string | null; products: { name: string } | null }>;
};

export default async function NagosPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const session = await getCurrentProfile();
  const today = new Date().toISOString().slice(0, 10);

  const animalQuery = sp.animal?.trim() ?? "";
  let animalIds: string[] | null = null;
  if (animalQuery) {
    const safe = animalQuery.replace(/[%,()]/g, " ").trim();
    const { data } = await supabase.from("animals").select("id").or(`tag_no.ilike.%${safe}%,animal_no.ilike.%${safe}%`).limit(200);
    animalIds = (data ?? []).map((a) => a.id);
  }

  let query = supabase
    .from("hoof_findings")
    .select(
      "id, leg, zones, condition_code, diagnosis, severity, was_trimmed, was_treated, bandage_applied, followup_required, followup_date, followup_completed, notes, " +
        "hoof_condition_codes(description), hoof_exams!inner(id, exam_date, performed_by, animal_id, animals(id, tag_no, animal_no)), usage_items(qty, unit, products(name))",
    )
    .order("hoof_exams(exam_date)", { ascending: false })
    .limit(300);
  if (animalIds) query = query.in("hoof_exams.animal_id", animalIds.length ? animalIds : ["00000000-0000-0000-0000-000000000000"]);
  if (sp.from) query = query.gte("hoof_exams.exam_date", sp.from);
  if (sp.to) query = query.lte("hoof_exams.exam_date", sp.to);
  if (sp.condition) query = query.eq("condition_code", sp.condition);
  if (sp.followup === "open") query = query.eq("followup_required", true).eq("followup_completed", false);

  const [{ data }, conditionRes, animalsRes, productsRes, batchesRes, subsRes, openRes] = await Promise.all([
    query,
    supabase.from("hoof_condition_codes").select("code, description, severity_default").order("sort_order"),
    supabase.from("animals").select("id, tag_no, animal_no").eq("active", true).order("animal_no"),
    supabase
      .from("products")
      .select("id, name, unit, category, subcategory_id, standard_amount")
      .eq("is_active", true)
      .not("category", "in", "(vakcina,reproduction)")
      .order("name"),
    // Same stock basis as create_hoof_exam (FEFO): active, non-expired batches.
    supabase.from("batches").select("product_id, qty_left, expiry_date").eq("status", "active").gt("qty_left", 0),
    supabase.from("product_subcategories").select("id, name, sort_order").eq("active", true).order("sort_order"),
    supabase.from("hoof_findings").select("id, followup_date").eq("followup_required", true).eq("followup_completed", false),
  ]);

  const stock = new Map<string, number>();
  for (const b of batchesRes.data ?? []) {
    if (b.expiry_date && b.expiry_date < today) continue;
    stock.set(b.product_id, (stock.get(b.product_id) ?? 0) + Number(b.qty_left));
  }
  const subById = new Map((subsRes.data ?? []).map((s) => [s.id, s]));
  const hoofProducts: HoofProductOption[] = (productsRes.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    unit: p.unit,
    category: p.category,
    subcategory: p.subcategory_id ? (subById.get(p.subcategory_id)?.name ?? null) : null,
    subcategory_order: p.subcategory_id ? (subById.get(p.subcategory_id)?.sort_order ?? 0) : 999,
    standard_amount: p.standard_amount,
    stock: Number((stock.get(p.id) ?? 0).toFixed(4)),
  }));

  const rows = ((data ?? []) as unknown as FindingRow[]).sort((a, b) => b.hoof_exams.exam_date.localeCompare(a.hoof_exams.exam_date));
  const conditionCodes = conditionRes.data ?? [];
  const openFollowups = openRes.data ?? [];
  const overdue = openFollowups.filter((f) => f.followup_date && f.followup_date < today).length;

  return (
    <>
      <PageHeader
        title="Nagų sveikata"
        description="Nagų apžiūros, karpymas ir gydymas pagal nagą ir zoną; produktai nurašomi iš atsargų"
        actions={
          <NewHoofExamDialog
            animals={animalsRes.data ?? []}
            conditionCodes={conditionCodes}
            products={hoofProducts}
            currentUserName={session?.profile.full_name ?? null}
          />
        }
      />

      <div className="space-y-4 p-4 sm:p-6 lg:p-8">
        <Card>
          <CardContent className="py-4">
            <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
              <div>
                <Label htmlFor="f_animal">Gyvūnas</Label>
                <Input id="f_animal" name="animal" defaultValue={sp.animal ?? ""} placeholder="Nr." />
              </div>
              <div>
                <Label htmlFor="f_from">Data nuo</Label>
                <Input id="f_from" name="from" type="date" defaultValue={sp.from ?? ""} />
              </div>
              <div>
                <Label htmlFor="f_to">Data iki</Label>
                <Input id="f_to" name="to" type="date" defaultValue={sp.to ?? ""} />
              </div>
              <div>
                <Label htmlFor="f_condition">Diagnozė / pažeidimas</Label>
                <Select id="f_condition" name="condition" defaultValue={sp.condition ?? ""}>
                  <option value="">Visi</option>
                  {conditionCodes.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.description}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="f_followup">Pakartotinis patikrinimas</Label>
                <Select id="f_followup" name="followup" defaultValue={sp.followup ?? ""}>
                  <option value="">Visi</option>
                  <option value="open">Tik laukiantys</option>
                </Select>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">
                  Filtruoti
                </Button>
                <Link href="/veterinarija/nagos" className="inline-flex h-9 items-center px-3 text-[13px] font-medium text-accent-hover hover:underline">
                  Išvalyti
                </Link>
              </div>
            </form>
            {openFollowups.length > 0 && (
              <p className="mt-3 text-[13px] text-text-secondary">
                Laukia pakartotinio patikrinimo: <span className="font-semibold text-text-primary">{openFollowups.length}</span>
                {overdue > 0 && (
                  <>
                    {" "}
                    · <Badge tone="danger">vėluoja: {overdue}</Badge>
                  </>
                )}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="overflow-x-auto p-0">
            {rows.length === 0 ? (
              <EmptyState icon={Footprints} title="Nagų sveikatos įrašų nėra" description="Užregistravę apžiūrą, ją pamatysite čia." />
            ) : (
              <table className="journal-table w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-text-muted">
                    <th className="px-5 py-2 font-medium">Data</th>
                    <th className="px-5 py-2 font-medium">Gyvūnas</th>
                    <th className="px-5 py-2 font-medium">Naga / zonos</th>
                    <th className="px-5 py-2 font-medium">Būklė</th>
                    <th className="px-5 py-2 font-medium">Veiksmai</th>
                    <th className="px-5 py-2 font-medium">Produktai</th>
                    <th className="px-5 py-2 font-medium">Atliko</th>
                    <th className="px-5 py-2 font-medium">Pakartotinis</th>
                    <th className="px-5 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => {
                    const actions = [f.was_trimmed && "karpyta", f.was_treated && "gydyta", f.bandage_applied && "tvarstis"].filter(Boolean).join(", ");
                    const animal = f.hoof_exams.animals;
                    return (
                      <tr key={f.id} className="border-b border-border last:border-0 align-top hover:bg-surface-secondary">
                        <td className="px-5 py-2">{formatDate(f.hoof_exams.exam_date)}</td>
                        <td className="px-5 py-2 font-semibold text-text-primary">
                          {animal ? (
                            <Link href={`/veterinarija/gyvunai/${animal.id}`} className="hover:underline">
                              {animal.animal_no ?? animal.tag_no}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-5 py-2">
                          {f.leg ? (
                            <>
                              {HOOF_LEG_LABELS[f.leg]}
                              <span className="block text-[12px] text-text-muted">{formatZones(f.zones)}</span>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-5 py-2">
                          {f.condition_code ? (
                            <>
                              <Badge tone={severityTone(f.severity)}>
                                {f.hoof_condition_codes?.description.split(" (")[0] ?? f.condition_code}
                                {f.condition_code !== "OK" ? ` · S${f.severity}` : ""}
                              </Badge>
                              {f.diagnosis && <span className="mt-1 block text-[12px] text-text-secondary">{f.diagnosis}</span>}
                            </>
                          ) : (
                            (f.diagnosis ?? "—")
                          )}
                        </td>
                        <td className="px-5 py-2">{actions || "—"}</td>
                        <td className="px-5 py-2 text-[12px]">
                          {f.usage_items.length === 0
                            ? "—"
                            : f.usage_items.map((u, i) => (
                                <span key={i} className="block">
                                  {u.products?.name ?? "?"} ({formatQty(u.qty, u.unit)})
                                </span>
                              ))}
                        </td>
                        <td className="px-5 py-2">{f.hoof_exams.performed_by ?? "—"}</td>
                        <td className="px-5 py-2">
                          {f.followup_required ? (
                            f.followup_completed ? (
                              <Badge tone="success">atlikta</Badge>
                            ) : (
                              <div className="flex flex-col items-start gap-1">
                                <Badge tone={f.followup_date && f.followup_date < today ? "danger" : "warning"}>{formatDate(f.followup_date)}</Badge>
                                <CompleteFollowupButton id={f.id} />
                              </div>
                            )
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-5 py-2">
                          <DeleteHoofExamButton id={f.hoof_exams.id} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

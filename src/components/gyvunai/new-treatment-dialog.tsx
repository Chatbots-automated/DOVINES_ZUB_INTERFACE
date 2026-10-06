"use client";

import * as React from "react";
import { useActionState } from "react";
import { AlertTriangle, Pill, Plus, Stethoscope, ClipboardCheck, UserRound } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { createTreatment, type ActionResult } from "@/lib/actions/treatments";
import type { CreatedDisease } from "@/lib/actions/diseases";
import { NewDiseaseDialog } from "@/components/gyvunai/new-disease-dialog";
import { MedicineLine } from "@/components/gydymas/medicine-line";
import { CoursePlanner, PlanSummaryPanel, EMPTY_COURSE_PLAN, type CoursePlan } from "@/components/gydymas/course-planner";
import type { ProcedureType } from "@/lib/supabase/types";
import { ROUTE_OPTIONS, type WithdrawalFieldKey } from "@/lib/administration-routes";
import { catalogFromProps, loadTreatmentCatalog } from "@/lib/treatments/catalog";
import {
  addDays,
  assignDayNumbers,
  daysBetween,
  summarizePlan,
  todayIso,
  type CatalogProduct,
  type CourseRow,
  type MedLine,
} from "@/lib/treatments/planner";

export { ROUTE_OPTIONS };

type Disease = { id: string; name: string };
export type Product = { id: string; name: string; unit: string; withdrawal_days_milk: number | null; withdrawal_days_meat: number | null } & Partial<
  Record<WithdrawalFieldKey, number | null>
>;
export type AnimalOption = { id: string; tag_no: string; animal_no: string | null; group_name?: string | null };

export function animalLabel(a: { tag_no: string; animal_no: string | null }) {
  return a.animal_no ? `Nr. ${a.animal_no} · ${a.tag_no}` : a.tag_no;
}

export const PROCEDURE_OPTIONS: { value: ProcedureType; label: string }[] = [
  { value: "apziura", label: "Apžiūra" },
  { value: "gydymas", label: "Gydymas" },
  { value: "profilaktika", label: "Profilaktika" },
];

export function PillToggle<T extends string>({
  options,
  value,
  onChange,
  allowClear,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  allowClear?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(allowClear && value === opt.value ? ("" as T) : opt.value)}
          className={`rounded-control px-3 py-1.5 text-[13px] font-medium transition-colors ${
            value === opt.value ? "bg-accent text-white" : "bg-surface-secondary text-text-secondary hover:bg-border"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function StepHeader({ n, icon: Icon, title, hint }: { n: number; icon: React.ComponentType<{ className?: string }>; title: string; hint?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-bold text-white">{n}</span>
      <Icon className="size-4 text-accent" />
      <h3 className="text-[14px] font-semibold text-text-primary">{title}</h3>
      {hint && <span className="hidden text-[12px] text-text-muted sm:inline">{hint}</span>}
    </div>
  );
}

const NO_ROWS: CourseRow[] = [];
const newLine = (): MedLine => ({ key: crypto.randomUUID(), product_id: "", qty: "", route: "" });

// "Naujas gydymo įrašas" (Priedas §2.3/§2.4) — anchors directly on
// `treatments` (no separate visits table). Saved atomically by
// create_treatment() (0004/0021); a "gydymas" is then queued for DelPro (0006).
export function NewTreatmentDialog({
  animalId,
  animals,
  diseases,
  products,
  currentVetName,
  trigger,
  dialogTitle = "Naujas gydymo įrašas",
  fixedProcedureType,
  submitLabel,
  onCreated,
  visitId,
}: {
  animalId?: string;
  animals?: AnimalOption[];
  diseases: Disease[];
  products: Product[];
  currentVetName?: string | null;
  trigger?: React.ReactNode;
  dialogTitle?: string;
  /** Locks procedure_type to one value and hides the toggle. */
  fixedProcedureType?: ProcedureType;
  submitLabel?: string;
  /** Fires after a treatment is successfully created — e.g. so a parent
   * drawer/list can refetch this animal's history. */
  onCreated?: () => void;
  /** Vizitai (0018): links the saved treatment to this visit (atomically, via create_treatment_for_visit). */
  visitId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createTreatment, null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const [selectedAnimalId, setSelectedAnimalId] = React.useState<string | null>(animalId ?? null);
  const [diseaseId, setDiseaseId] = React.useState<string | null>(null);
  const [diagnosisText, setDiagnosisText] = React.useState("");
  const [localDiseases, setLocalDiseases] = React.useState<Disease[]>(diseases);
  const [procedureType, setProcedureType] = React.useState<ProcedureType>(fixedProcedureType ?? "gydymas");
  const [regDate, setRegDate] = React.useState(todayIso);
  const [medLines, setMedLines] = React.useState<MedLine[]>([]);
  const [plan, setPlan] = React.useState<CoursePlan>(EMPTY_COURSE_PLAN);

  // Products with live usable stock — loaded each time the dialog opens so
  // the stock figures are current. If the query fails we fall back to the
  // `products` prop (no stock info, so no stock validation).
  const [catalog, setCatalog] = React.useState<CatalogProduct[] | null>(null);
  const [catalogError, setCatalogError] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadTreatmentCatalog()
      .then((c) => {
        if (cancelled) return;
        setCatalog(c);
        setCatalogError(false);
      })
      .catch((err) => {
        console.error("[NewTreatmentDialog] catalog load failed:", err);
        if (cancelled) return;
        setCatalog(null);
        setCatalogError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  const catalogLoading = open && catalog === null && !catalogError;
  const effectiveCatalog = React.useMemo(() => catalog ?? (catalogError ? catalogFromProps(products) : []), [catalog, catalogError, products]);
  const productById = React.useMemo(() => new Map(effectiveCatalog.map((p) => [p.id, p])), [effectiveCatalog]);

  const [handledDiseases, setHandledDiseases] = React.useState(diseases);
  if (diseases !== handledDiseases) {
    setHandledDiseases(diseases);
    setLocalDiseases((prev) => {
      const merged = new Map(diseases.map((d) => [d.id, d]));
      for (const d of prev) if (!merged.has(d.id)) merged.set(d.id, d);
      return Array.from(merged.values());
    });
  }

  const animalOptions: ComboboxOption[] = React.useMemo(
    () => (animals ?? []).map((a) => ({ value: a.id, label: animalLabel(a), sublabel: a.group_name ?? undefined })),
    [animals],
  );

  // Picking a disease prefills the diagnosis text, which stays editable
  // for the specifics ("Mastitas, kairė priekinė ketvirtis").
  function selectDisease(id: string | null) {
    setDiseaseId(id);
    const name = localDiseases.find((d) => d.id === id)?.name;
    if (name) setDiagnosisText(name);
  }
  const diseaseOptions: ComboboxOption[] = React.useMemo(() => localDiseases.map((d) => ({ value: d.id, label: d.name })), [localDiseases]);

  function handleDiseaseCreated(disease: CreatedDisease) {
    setLocalDiseases((prev) => (prev.some((d) => d.id === disease.id) ? prev : [...prev, disease]));
    setDiseaseId(disease.id);
    setDiagnosisText(disease.name);
  }

  function resetOwnState() {
    setSelectedAnimalId(animalId ?? null);
    setDiseaseId(null);
    setDiagnosisText("");
    setProcedureType(fixedProcedureType ?? "gydymas");
    setRegDate(todayIso());
    setMedLines([]);
    setPlan(EMPTY_COURSE_PLAN);
  }

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) {
      setOpen(false);
      resetOwnState();
      onCreated?.();
    }
  }

  React.useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  function updateLine(key: string, patch: Partial<MedLine>) {
    setMedLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  // Moving the treatment date shifts the whole planned course with it.
  function changeRegDate(next: string) {
    if (next && plan.rows.length > 0) {
      const delta = daysBetween(regDate, next);
      setPlan((p) => ({ ...p, rows: p.rows.map((r) => (r.date ? { ...r, date: addDays(r.date, delta) } : r)) }));
    }
    setRegDate(next);
  }

  const startDate = regDate || todayIso();
  const courseRows = plan.enabled ? plan.rows : NO_ROWS;
  const summary = React.useMemo(() => summarizePlan(startDate, medLines, courseRows, productById), [startDate, medLines, courseRows, productById]);
  const nowByProduct = React.useMemo(() => new Map(summary.totals.map((t) => [t.product.id, t.now])), [summary]);
  const courseDoses = plan.enabled ? summary.doseDays : 1;

  // ---- Blocking validation (stock shortfall for today is also refused by the DB) ----
  const problems: string[] = [];
  if (!selectedAnimalId) problems.push("Pasirinkite gyvūną.");
  if (medLines.some((l) => l.product_id && !(Number(l.qty) > 0))) problems.push("Nurodykite vaisto dozę (didesnę už 0).");
  if (medLines.some((l) => !l.product_id && Number(l.qty) > 0)) problems.push("Pasirinkite produktą eilutei su doze.");
  if (summary.totals.some((t) => t.nowShort)) problems.push("Šiandienos dozės viršija atsargas.");
  if (plan.enabled) {
    if (plan.rows.length === 0) problems.push("Kursas neturi papildomų dozių — pridėkite dozę arba išjunkite kursą.");
    if (plan.rows.some((r) => !r.product_id || !(Number(r.qty) > 0) || !r.date)) problems.push("Užpildykite visas kurso eilutes (data, produktas, dozė).");
    if (plan.rows.some((r) => r.date && r.date <= startDate)) problems.push("Kurso dozių datos turi būti vėlesnės už gydymo datą.");
  }

  const medicationsJson = JSON.stringify(
    medLines
      .filter((l) => l.product_id && Number(l.qty) > 0)
      .map((l) => ({
        product_id: l.product_id,
        qty: Number(l.qty),
        unit: productById.get(l.product_id)?.unit ?? "vnt",
        administration_route: l.route || null,
      })),
  );

  const courseDaysJson = React.useMemo(() => {
    const dayNumbers = assignDayNumbers(startDate, courseRows);
    return JSON.stringify(
      [...courseRows]
        .sort((a, b) => a.date.localeCompare(b.date))
        .filter((r) => r.date && r.product_id && Number(r.qty) > 0)
        .map((r) => ({
          day_number: dayNumbers.get(r.date),
          scheduled_date: r.date,
          product_id: r.product_id,
          qty: Number(r.qty),
          unit: productById.get(r.product_id)?.unit ?? null,
          administration_route: r.route || null,
        })),
    );
  }, [courseRows, startDate, productById]);

  const hasMedicines = medLines.some((l) => l.product_id && Number(l.qty) > 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          resetOwnState();
          formRef.current?.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <Plus className="size-4" /> {submitLabel ?? "Naujas gydymas"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>
        <form ref={formRef} action={formAction}>
          <DialogBody className="space-y-6">
            {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
            {catalogError && (
              <p className="flex items-center gap-2 rounded-control bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
                <AlertTriangle className="size-4 shrink-0" /> Nepavyko gauti atsargų likučių — likučiai nerodomi ir netikrinami iki išsaugojimo.
              </p>
            )}

            <input type="hidden" name="animal_id" value={selectedAnimalId ?? ""} />
            <input type="hidden" name="disease_id" value={diseaseId ?? ""} />
            <input type="hidden" name="procedure_type" value={procedureType} />
            {visitId && <input type="hidden" name="visit_id" value={visitId} />}
            <input type="hidden" name="medications" value={medicationsJson} />
            {plan.enabled && <input type="hidden" name="course_days" value={courseDaysJson} />}

            <section>
              <StepHeader n={1} icon={UserRound} title="Gyvūnas ir data" />
              <div className="space-y-4">
                {!animalId && (
                  <div>
                    <Label>Gyvūnas *</Label>
                    <Combobox options={animalOptions} value={selectedAnimalId} onChange={setSelectedAnimalId} placeholder="Pasirinkite gyvūną..." />
                  </div>
                )}
                {!fixedProcedureType && (
                  <div>
                    <Label className="mb-1.5">Procedūra</Label>
                    <PillToggle options={PROCEDURE_OPTIONS} value={procedureType} onChange={setProcedureType} />
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="reg_date">Data</Label>
                    <Input id="reg_date" name="reg_date" type="date" value={regDate} onChange={(e) => changeRegDate(e.target.value)} required />
                  </div>
                  <div>
                    <Label htmlFor="vet_name">Veterinarijos gydytojas</Label>
                    <Input id="vet_name" name="vet_name" defaultValue={currentVetName ?? undefined} />
                  </div>
                </div>
              </div>
            </section>

            <section>
              <StepHeader n={2} icon={Stethoscope} title="Diagnozė" />
              <div className="flex gap-2">
                <div className="flex-1">
                  <Combobox options={diseaseOptions} value={diseaseId} onChange={selectDisease} placeholder="Pasirinkite ligą (neprivaloma)..." />
                </div>
                <NewDiseaseDialog onCreated={handleDiseaseCreated} />
              </div>
              <Input
                name="diagnosis"
                value={diagnosisText}
                onChange={(e) => setDiagnosisText(e.target.value)}
                placeholder="Diagnozė / patikslinimas"
                className="mt-2"
              />
            </section>

            <section>
              <StepHeader n={3} icon={Pill} title="Suteikti vaistai" hint="Rodomi tik produktai su galiojančiomis atsargomis" />
              <div className="rounded-panel border border-border bg-surface-secondary p-4">
                {medLines.length === 0 ? (
                  <p className="mb-3 text-[13px] text-text-muted">Vaistų nepridėta — gydymas bus įrašytas be vaisto sunaudojimo.</p>
                ) : (
                  <div className="mb-3 space-y-3">
                    {medLines.map((line) => (
                      <MedicineLine
                        key={line.key}
                        line={line}
                        catalog={effectiveCatalog}
                        productById={productById}
                        loading={catalogLoading}
                        regDate={startDate}
                        nowByProduct={nowByProduct}
                        courseDoses={courseDoses}
                        onChange={(patch) => updateLine(line.key, patch)}
                        onRemove={() => setMedLines((prev) => prev.filter((l) => l.key !== line.key))}
                      />
                    ))}
                  </div>
                )}
                <Button type="button" size="sm" variant="outline" onClick={() => setMedLines((prev) => [...prev, newLine()])}>
                  <Plus className="size-4" /> Pridėti vaistą
                </Button>
                <p className="mt-3 text-[11px] text-text-muted">Vaistai nurašomi automatiškai iš seniausiai galiojančios partijos (FEFO).</p>
              </div>
            </section>

            <section>
              <StepHeader n={4} icon={ClipboardCheck} title="Kurso planavimas" hint="Neprivaloma — kelių dienų gydymas" />
              <CoursePlanner
                plan={plan}
                onChange={setPlan}
                lines={medLines}
                regDate={startDate}
                catalog={effectiveCatalog}
                productById={productById}
                loading={catalogLoading}
              />
            </section>

            {hasMedicines && <PlanSummaryPanel summary={summary} hasCourse={plan.enabled} />}

            <section>
              <StepHeader n={5} icon={ClipboardCheck} title="Baigtis ir pastabos" />
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="outcome">Ligos baigtis</Label>
                    <Input id="outcome" name="outcome" list="outcome-suggestions" placeholder="Pasveiko, Gydymas tęsiamas..." />
                    <datalist id="outcome-suggestions">
                      <option value="Pasveiko" />
                      <option value="Gydymas tęsiamas" />
                      <option value="Nugaišo" />
                      <option value="Paskersta" />
                    </datalist>
                  </div>
                  <div>
                    <Label htmlFor="outcome_date">Baigties data</Label>
                    <Input id="outcome_date" name="outcome_date" type="date" />
                  </div>
                </div>
                <div>
                  <Label htmlFor="notes">Pastabos</Label>
                  <Textarea id="notes" name="notes" rows={2} />
                </div>
              </div>
            </section>
          </DialogBody>
          <DialogFooter>
            <div className="mr-auto min-w-0 self-center">
              {problems.length > 0 && selectedAnimalId !== null && <p className="text-[12px] font-medium text-danger">{problems[0]}</p>}
              {procedureType === "gydymas" && problems.length === 0 && <p className="text-[11px] text-text-muted">Gydymo įrašas bus perduotas į DelPro.</p>}
            </div>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Atšaukti
            </Button>
            <Button type="submit" disabled={pending || problems.length > 0}>
              {pending ? "Saugoma..." : "Sukurti"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

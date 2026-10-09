"use client";

import * as React from "react";
import { useActionState } from "react";
import { CheckCircle2, Check, CalendarClock, Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, Select } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Badge } from "@/components/ui/badge";
import { HoofZonePicker } from "@/components/nagos/hoof-zone-picker";
import { HOOF_LEG_LABELS, formatZones, severityTone, type HoofLeg, type ZoneSelection } from "@/lib/hoof";
import { formatQty } from "@/lib/utils";
import { createHoofExam, type ActionResult } from "@/lib/actions/hoof";
import { RouteSelect, WithdrawalChips } from "@/components/gydymas/medicine-line";
import { CoursePlanner, PlanSummaryPanel, EMPTY_COURSE_PLAN, type CoursePlan } from "@/components/gydymas/course-planner";
import { catalogFromProps, loadTreatmentCatalog } from "@/lib/treatments/catalog";
import { assignDayNumbers, summarizePlan, type CatalogProduct, type CourseRow, type MedLine } from "@/lib/treatments/planner";
import { DRUG_CATEGORIES } from "@/lib/product-categories";
import type { ProductCategory } from "@/lib/supabase/types";

type AnimalOption = { id: string; tag_no: string; animal_no: string | null };
type ConditionCode = { code: string; description: string; severity_default: number };
export type HoofProductOption = {
  id: string;
  name: string;
  unit: string;
  category: string;
  subcategory: string | null;
  subcategory_order: number;
  standard_amount: number | null;
  /** Usable stock: active, non-expired batches (what FEFO can consume). */
  stock: number;
};
type ProductOption = HoofProductOption;
type ProductLine = { key: string; product_id: string; qty: string; route: string };

type Finding = {
  key: string;
  leg: HoofLeg | null;
  zones: ZoneSelection[];
  condition_code: string | null;
  diagnosis: string | null;
  severity: number;
  was_trimmed: boolean;
  was_treated: boolean;
  bandage_applied: boolean;
  followup_required: boolean;
  followup_date: string | null;
  notes: string | null;
  products: Array<{ product_id: string; qty: number; unit: string | null; administration_route: string | null }>;
  /** Planned repeat doses (kurso planavimas, 0030) — same shape as create_treatment's course_days. */
  course_days: Array<{ day_number: number | undefined; scheduled_date: string; product_id: string; qty: number; unit: string | null; administration_route: string | null }>;
};

type Draft = {
  condition_code: string;
  diagnosis: string;
  severity: number;
  was_trimmed: boolean;
  was_treated: boolean;
  bandage_applied: boolean;
  followup_required: boolean;
  followup_date: string;
  notes: string;
  lines: ProductLine[];
};

const emptyDraft = (): Draft => ({
  condition_code: "",
  diagnosis: "",
  severity: 0,
  was_trimmed: false,
  was_treated: false,
  bandage_applied: false,
  followup_required: false,
  followup_date: "",
  notes: "",
  lines: [],
});

const today = () => new Date().toISOString().slice(0, 10);

// "Nagų apžiūra" (Nagos): pick the animal, then add one finding per leg +
// zones (per-claw, from the leg->zone picker) with lesion, severity,
// trimming/treatment, products used and an optional follow-up date, or a
// one-click "Sveikas" check. Everything is submitted together and stock is
// consumed in the same transaction (create_hoof_exam).
//
// After each hoof the vet chooses: "Išsaugoti ir pridėti kitą nagą" (keeps the
// animal / date / vet, resets the editor) or "Baigti apžiūrą" (saves the hoof
// being edited, if any, and submits the exam). A drug (medicines, vaccines,
// profilaktika, boliusai) may also get a course plan (kurso planavimas): doses
// on later dates, consumed only when each dose is given (Gydymo kursai).
export function NewHoofExamDialog({
  animals,
  conditionCodes,
  products,
  currentUserName,
  animalId: presetAnimalId,
  trigger,
  onCreated,
}: {
  animals: AnimalOption[];
  conditionCodes: ConditionCode[];
  products: ProductOption[];
  currentUserName: string | null;
  /** Preselects the animal (e.g. opened from the animal's card). */
  animalId?: string;
  trigger?: React.ReactNode;
  /** Fires after an exam is saved — lets a parent card refetch its history. */
  onCreated?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createHoofExam, null);

  const [animalId, setAnimalId] = React.useState<string | null>(presetAnimalId ?? null);
  const [examDate, setExamDate] = React.useState(today);
  const [performedBy, setPerformedBy] = React.useState(currentUserName ?? "");
  const [notes, setNotes] = React.useState("");
  const [leg, setLeg] = React.useState<HoofLeg | null>(null);
  const [zones, setZones] = React.useState<ZoneSelection[]>([]);
  const [draft, setDraft] = React.useState<Draft>(emptyDraft);
  const [findings, setFindings] = React.useState<Finding[]>([]);
  const [pickerKey, setPickerKey] = React.useState(0);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [justAdded, setJustAdded] = React.useState<string | null>(null);
  const [plan, setPlan] = React.useState<CoursePlan>(EMPTY_COURSE_PLAN);
  const formRef = React.useRef<HTMLFormElement>(null);
  const editorRef = React.useRef<HTMLDivElement>(null);
  // Set by "Baigti apžiūrą" when it first has to add the hoof being edited: the form is
  // submitted once `findings` (and so the hidden input) has re-rendered.
  const submitAfterRender = React.useRef(false);

  // Products with live usable stock + withdrawal data, loaded when the dialog
  // opens (needed by the course planner and the karencija chips).
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
        console.error("[NewHoofExamDialog] catalog load failed:", err);
        if (cancelled) return;
        setCatalog(null);
        setCatalogError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  const catalogLoading = open && catalog === null && !catalogError;
  const effectiveCatalog = React.useMemo(
    () => catalog ?? (catalogError ? catalogFromProps(products.map((p) => ({ ...p, withdrawal_days_milk: null, withdrawal_days_meat: null }))) : []),
    [catalog, catalogError, products],
  );
  const catalogById = React.useMemo(() => new Map(effectiveCatalog.map((p) => [p.id, p])), [effectiveCatalog]);

  const animalOptions: ComboboxOption[] = React.useMemo(
    () => animals.map((a) => ({ value: a.id, label: a.animal_no ? `${a.animal_no} · ${a.tag_no}` : a.tag_no })),
    [animals],
  );
  // Free lines: every non-hoof product with stock ("Kiti produktai"), plus
  // hoof products (also reachable through the chips above).
  const productOptions: ComboboxOption[] = React.useMemo(
    () =>
      [...products]
        .sort((a, b) => Number(b.category === "hoof_care") - Number(a.category === "hoof_care"))
        .map((p) => ({ value: p.id, label: p.name, sublabel: `${p.unit} · likutis ${formatQty(p.stock)}` })),
    [products],
  );
  // "Nagų priežiūra" products grouped by subcategory (Padukos, Tvarsčiai...).
  const hoofGroups = React.useMemo(() => {
    const groups = new Map<string, { name: string; order: number; items: ProductOption[] }>();
    for (const p of products) {
      if (p.category !== "hoof_care") continue;
      const name = p.subcategory ?? "Kita nagų priežiūra";
      const g = groups.get(name) ?? { name, order: p.subcategory_order, items: [] };
      g.items.push(p);
      groups.set(name, g);
    }
    return [...groups.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "lt"));
  }, [products]);
  const productById = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const codeLabel = (code: string | null) => conditionCodes.find((c) => c.code === code)?.description ?? code ?? "";

  function resetAll() {
    setAnimalId(presetAnimalId ?? null);
    setExamDate(today());
    setNotes("");
    setLeg(null);
    setZones([]);
    setDraft(emptyDraft());
    setFindings([]);
    setPickerKey((k) => k + 1);
    setLocalError(null);
    setJustAdded(null);
    setPlan(EMPTY_COURSE_PLAN);
  }

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) {
      setOpen(false);
      resetAll();
      onCreated?.();
    }
  }

  function handleCondition(code: string) {
    const found = conditionCodes.find((c) => c.code === code);
    setDraft((d) => ({ ...d, condition_code: code, severity: found ? found.severity_default : d.severity }));
  }

  function setLine(key: string, patch: Partial<ProductLine>) {
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  }

  // Tap a hoof product: add a line prefilled with its standard amount, or
  // add another standard amount to the existing line.
  function pickHoofProduct(p: ProductOption) {
    setDraft((d) => {
      const std = p.standard_amount ?? 1;
      const existing = d.lines.find((l) => l.product_id === p.id);
      if (existing) {
        return { ...d, lines: d.lines.map((l) => (l.product_id === p.id ? { ...l, qty: String((Number(l.qty) || 0) + std) } : l)) };
      }
      return { ...d, lines: [...d.lines, { key: crypto.randomUUID(), product_id: p.id, qty: String(std), route: "" }] };
    });
  }

  // Drug lines (medicines, vaccines, profilaktika, boliusai) can carry a route
  // (karencija is route-aware) and a course plan; hoof-care materials cannot.
  const isDrug = (productId: string) => DRUG_CATEGORIES.includes((productById.get(productId)?.category ?? "") as ProductCategory);
  const drugLines: MedLine[] = draft.lines
    .filter((l) => l.product_id && isDrug(l.product_id))
    .map((l) => ({ key: l.key, product_id: l.product_id, qty: l.qty, route: l.route }));
  const hasDrug = drugLines.length > 0;
  const courseRows: CourseRow[] = plan.enabled && hasDrug ? plan.rows : [];
  const summary = summarizePlan(examDate, drugLines, courseRows, catalogById);

  // Validates the editor and returns the finding to add, or an error message.
  function buildFinding(): { finding: Finding } | { error: string } {
    if (!leg || zones.length === 0) return { error: "Pasirinkite nagą ir bent vieną zoną." };
    if (draft.followup_required && !draft.followup_date) return { error: "Nurodykite pakartotinio patikrinimo datą." };
    const lines = draft.lines.filter((l) => l.product_id);
    if (lines.some((l) => !(Number(l.qty) > 0))) return { error: "Nurodykite kiekį kiekvienam pasirinktam produktui." };
    if (plan.enabled && hasDrug) {
      if (plan.rows.length === 0) return { error: "Kursas neturi papildomų dozių — pridėkite dozę arba išjunkite kursą." };
      if (plan.rows.some((r) => !r.product_id || !(Number(r.qty) > 0) || !r.date)) return { error: "Užpildykite visas kurso eilutes (data, produktas, dozė)." };
      if (plan.rows.some((r) => r.date <= examDate)) return { error: "Kurso dozių datos turi būti vėlesnės už apžiūros datą." };
    }
    const dayNumbers = assignDayNumbers(examDate, courseRows);
    return {
      finding: {
        key: crypto.randomUUID(),
        leg,
        zones,
        condition_code: draft.condition_code || null,
        diagnosis: draft.diagnosis.trim() || null,
        severity: draft.severity,
        was_trimmed: draft.was_trimmed,
        was_treated: draft.was_treated,
        bandage_applied: draft.bandage_applied,
        followup_required: draft.followup_required,
        followup_date: draft.followup_required ? draft.followup_date : null,
        notes: draft.notes.trim() || null,
        products: lines.map((l) => ({
          product_id: l.product_id,
          qty: Number(l.qty),
          unit: productById.get(l.product_id)?.unit ?? null,
          administration_route: isDrug(l.product_id) ? l.route || null : null,
        })),
        course_days: [...courseRows]
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((r) => ({
            day_number: dayNumbers.get(r.date),
            scheduled_date: r.date,
            product_id: r.product_id,
            qty: Number(r.qty),
            unit: productById.get(r.product_id)?.unit ?? null,
            administration_route: r.route || null,
          })),
      },
    };
  }

  function resetEditor() {
    setLeg(null);
    setZones([]);
    setDraft(emptyDraft());
    setPlan(EMPTY_COURSE_PLAN);
    setPickerKey((k) => k + 1);
  }

  const editorInProgress = leg !== null || zones.length > 0;

  // "Išsaugoti ir pridėti kitą nagą": keep this hoof, reset the editor for the next one.
  function saveAndAddAnother() {
    setLocalError(null);
    const built = buildFinding();
    if ("error" in built) {
      setLocalError(built.error);
      return;
    }
    setFindings((prev) => [...prev, built.finding]);
    setJustAdded(`${HOOF_LEG_LABELS[built.finding.leg as HoofLeg]} · ${formatZones(built.finding.zones)} išsaugota — pasirinkite kitą nagą.`);
    resetEditor();
    editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // "Baigti apžiūrą": add the hoof being edited (if one is selected), then submit the exam.
  function finishExam() {
    setLocalError(null);
    setJustAdded(null);
    if (editorInProgress) {
      const built = buildFinding();
      if ("error" in built) {
        setLocalError(built.error);
        return;
      }
      submitAfterRender.current = true;
      setFindings((prev) => [...prev, built.finding]);
      resetEditor();
    } else if (findings.length === 0) {
      setLocalError("Pridėkite bent vieną radinį.");
    } else {
      formRef.current?.requestSubmit();
    }
  }

  React.useEffect(() => {
    if (!submitAfterRender.current) return;
    submitAfterRender.current = false;
    formRef.current?.requestSubmit();
  }, [findings]);

  function addHealthy() {
    setLocalError(null);
    setFindings((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        leg: null,
        zones: [],
        condition_code: "OK",
        diagnosis: null,
        severity: 0,
        was_trimmed: false,
        was_treated: false,
        bandage_applied: false,
        followup_required: false,
        followup_date: null,
        notes: null,
        products: [],
        course_days: [],
      },
    ]);
    setJustAdded("Pažymėta: sveikas.");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetAll();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <Plus className="size-4" /> Nauja apžiūra
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Nauja nagų apžiūra</DialogTitle>
        </DialogHeader>
        <form ref={formRef} action={formAction}>
          <DialogBody className="space-y-5">
            {((state && !state.ok && state.error) || localError) && (
              <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{localError ?? (state && !state.ok ? state.error : "")}</p>
            )}

            <input type="hidden" name="animal_id" value={animalId ?? ""} />
            <input type="hidden" name="exam_date" value={examDate} />
            <input type="hidden" name="performed_by" value={performedBy} />
            <input type="hidden" name="notes" value={notes} />
            <input type="hidden" name="findings" value={JSON.stringify(findings.map((f) => ({ ...f, key: undefined })))} />

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label>Gyvūnas *</Label>
                <Combobox options={animalOptions} value={animalId} onChange={setAnimalId} placeholder="Ieškoti pagal Nr..." />
              </div>
              <div>
                <Label htmlFor="hoof_exam_date">Data *</Label>
                <Input id="hoof_exam_date" type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="hoof_performed_by">Atliko</Label>
                <Input id="hoof_performed_by" value={performedBy} onChange={(e) => setPerformedBy(e.target.value)} placeholder="Nagų karpytojas / veterinaras" />
              </div>
            </div>

            {findings.length > 0 && (
              <div className="space-y-2">
                <p className="text-[13px] font-semibold text-text-primary">Jau išsaugota šiai karvei ({findings.length})</p>
                {findings.map((f) => (
                  <div key={f.key} className="flex items-center justify-between gap-3 rounded-control border border-border bg-surface px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      {f.leg ? <Badge tone="neutral">{HOOF_LEG_LABELS[f.leg]}</Badge> : <Badge tone="success">Sveikas</Badge>}
                      {f.zones.length > 0 && <span className="text-text-secondary">{formatZones(f.zones)}</span>}
                      {f.condition_code && f.condition_code !== "OK" && (
                        <Badge tone={severityTone(f.severity)}>
                          {codeLabel(f.condition_code).split(" (")[0]} · S{f.severity}
                        </Badge>
                      )}
                      {f.products.length > 0 && (
                        <span className="text-[12px] text-text-muted">
                          {f.products.map((p) => `${productById.get(p.product_id)?.name ?? "?"} ${p.qty} ${p.unit ?? ""}`).join(", ")}
                        </span>
                      )}
                      {f.course_days.length > 0 && (
                        <Badge tone="info">
                          <CalendarClock className="size-3" /> Kursas: +{f.course_days.length} dozės iki {f.course_days[f.course_days.length - 1].scheduled_date}
                        </Badge>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label="Pašalinti radinį"
                      onClick={() => setFindings((prev) => prev.filter((x) => x.key !== f.key))}
                      className="rounded-control p-1 text-text-muted hover:bg-surface-secondary hover:text-danger"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div ref={editorRef} className="scroll-mt-4" />
            {justAdded && (
              <p className="flex items-center gap-2 rounded-control bg-success-soft px-3 py-2 text-[13px] font-medium text-success">
                <CheckCircle2 className="size-4 shrink-0" /> {justAdded}
              </p>
            )}

            <div className="rounded-panel border border-border bg-surface-secondary p-4">
              <HoofZonePicker key={pickerKey} leg={leg} onLegChange={setLeg} zones={zones} onZonesChange={setZones} />
            </div>

            {hoofGroups.length > 0 && (
              <div className="space-y-3 rounded-panel border border-border bg-surface-secondary p-4">
                <p className="text-[13px] font-semibold text-text-primary">Nagų priežiūros priemonės</p>
                {hoofGroups.map((g) => (
                  <div key={g.name}>
                    <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-text-secondary">{g.name}</p>
                    <div className="flex flex-wrap gap-2">
                      {g.items.map((p) => {
                        const selected = draft.lines.some((l) => l.product_id === p.id);
                        const empty = p.stock <= 0;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            disabled={empty}
                            onClick={() => pickHoofProduct(p)}
                            aria-pressed={selected}
                            className={`flex min-w-[8.5rem] flex-col items-start rounded-control border px-3 py-2 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                              selected ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-border-strong"
                            }`}
                          >
                            <span className="flex items-center gap-1 font-medium text-text-primary">
                              {selected && <Check className="size-3.5" />}
                              {p.name}
                            </span>
                            <span className={`text-[11px] ${empty ? "text-danger" : "text-text-muted"}`}>
                              {empty ? "nėra atsargų" : `likutis ${formatQty(p.stock)} ${p.unit}`}
                              {p.standard_amount ? ` · std. ${formatQty(p.standard_amount)}` : ""}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <Label>Pažeidimas / būklė</Label>
                <Select value={draft.condition_code} onChange={(e) => handleCondition(e.target.value)}>
                  <option value="">Nenurodyta</option>
                  {conditionCodes.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.description}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Sunkumas (0-4)</Label>
                <Input
                  type="number"
                  min={0}
                  max={4}
                  value={draft.severity}
                  onChange={(e) => setDraft((d) => ({ ...d, severity: Math.min(4, Math.max(0, Number(e.target.value) || 0)) }))}
                />
              </div>
            </div>

            <div>
              <Label>Diagnozė (laisvas tekstas)</Label>
              <Input value={draft.diagnosis} onChange={(e) => setDraft((d) => ({ ...d, diagnosis: e.target.value }))} />
            </div>

            <div className="flex flex-wrap gap-4">
              {(
                [
                  ["was_trimmed", "Karpyta"],
                  ["was_treated", "Gydyta"],
                  ["bandage_applied", "Uždėtas tvarstis"],
                ] as const
              ).map(([name, label]) => (
                <label key={name} className="flex items-center gap-2 text-[13px] font-medium">
                  <input
                    type="checkbox"
                    checked={draft[name]}
                    onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.checked }))}
                    className="size-4 rounded border-border-strong"
                  />
                  {label}
                </label>
              ))}
            </div>

            <div>
              <Label>Panaudoti produktai (nurašomi iš atsargų) · kiti produktai</Label>
              <div className="space-y-2">
                {draft.lines.map((l) => (
                  <div key={l.key} className="space-y-1.5">
                  <div className="grid grid-cols-[minmax(0,1fr)_100px_32px] items-center gap-2">
                    <Combobox options={productOptions} value={l.product_id || null} onChange={(v) => setLine(l.key, { product_id: v })} placeholder="Produktas..." />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder={l.product_id ? productById.get(l.product_id)?.unit : "Kiekis"}
                      value={l.qty}
                      onChange={(e) => setLine(l.key, { qty: e.target.value })}
                    />
                    <button
                      type="button"
                      aria-label="Pašalinti produktą"
                      onClick={() => setDraft((d) => ({ ...d, lines: d.lines.filter((x) => x.key !== l.key) }))}
                      className="rounded-control p-1 text-text-muted hover:bg-surface-secondary hover:text-danger"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                  {l.product_id && isDrug(l.product_id) && (
                    <div className="flex flex-wrap items-center gap-2 pl-0.5">
                      <RouteSelect value={l.route} onChange={(v) => setLine(l.key, { route: v })} className="w-52" />
                      {catalogById.get(l.product_id) && <WithdrawalChips product={catalogById.get(l.product_id)!} route={l.route} fromDate={examDate} />}
                    </div>
                  )}
                  </div>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setDraft((d) => ({ ...d, lines: [...d.lines, { key: crypto.randomUUID(), product_id: "", qty: "", route: "" }] }))}
                >
                  <Plus className="size-4" /> Pridėti produktą
                </Button>
              </div>
            </div>

            {hasDrug && (
              <div className="space-y-3">
                {catalogError && (
                  <p className="rounded-control bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
                    Nepavyko gauti atsargų likučių — kurso planavimas rodomas be likučių patikros.
                  </p>
                )}
                <CoursePlanner
                  plan={plan}
                  onChange={setPlan}
                  lines={drugLines}
                  regDate={examDate}
                  catalog={effectiveCatalog}
                  productById={catalogById}
                  loading={catalogLoading}
                />
                <PlanSummaryPanel summary={summary} hasCourse={plan.enabled} />
              </div>
            )}

            <div className="rounded-panel border border-border bg-surface-secondary p-3">
              <label className="flex items-center gap-2 text-[13px] font-medium">
                <input
                  type="checkbox"
                  checked={draft.followup_required}
                  onChange={(e) => setDraft((d) => ({ ...d, followup_required: e.target.checked }))}
                  className="size-4 rounded border-border-strong"
                />
                Reikalingas pakartotinis patikrinimas
              </label>
              {draft.followup_required && (
                <div className="mt-3 max-w-xs">
                  <Label>Patikrinimo data</Label>
                  <Input type="date" value={draft.followup_date} onChange={(e) => setDraft((d) => ({ ...d, followup_date: e.target.value }))} />
                </div>
              )}
            </div>

            <div>
              <Label>Radinio pastabos</Label>
              <Textarea rows={2} value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={addHealthy} disabled={!animalId}>
                <CheckCircle2 className="size-4" /> Viskas gerai (sveikas)
              </Button>
            </div>

            <div>
              <Label>Bendros apžiūros pastabos</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </DialogBody>
          <DialogFooter>
            <p className="mr-auto self-center text-[12px] text-text-muted">
              {editorInProgress ? "Redaguojama naga dar neišsaugota — pasirinkite veiksmą." : findings.length > 0 ? `Išsaugota radinių: ${findings.length}` : ""}
            </p>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Atšaukti
            </Button>
            <Button type="button" variant="outline" disabled={pending || !animalId || !editorInProgress} onClick={saveAndAddAnother}>
              <Plus className="size-4" /> Išsaugoti ir pridėti kitą nagą
            </Button>
            <Button type="button" disabled={pending || !animalId || (!editorInProgress && findings.length === 0)} onClick={finishExam}>
              <Check className="size-4" />
              {pending ? "Saugoma..." : `Baigti apžiūrą (${findings.length + (editorInProgress ? 1 : 0)})`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

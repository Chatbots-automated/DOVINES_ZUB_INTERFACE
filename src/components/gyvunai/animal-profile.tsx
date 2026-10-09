"use client";

import * as React from "react";
import { useActionState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Baby,
  CalendarClock,
  CalendarPlus,
  Database,
  Dna,
  Droplets,
  ExternalLink,
  Footprints,
  Gauge,
  HeartPulse,
  Hourglass,
  Info,
  Layers,
  Milk,
  PawPrint,
  ShieldAlert,
  ShieldCheck,
  Repeat,
  StickyNote,
  Stethoscope,
  Syringe,
  Thermometer,
  Users,
  X,
} from "lucide-react";
import { DrawerBody, DrawerClose, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";
import { cn, formatDate, formatDateTime, formatQty } from "@/lib/utils";
import { updateAnimalNotes, type ActionResult } from "@/lib/actions/animals";
import { NewTreatmentDialog } from "@/components/gyvunai/new-treatment-dialog";
import { NewVaccinationDialog } from "@/components/vakcinacijos/new-vaccination-dialog";
import { NewVisitDialog } from "@/components/vizitai/new-visit-dialog";
import { ApplySyncProtocolDialog } from "@/components/sinchronizacijos/apply-protocol-dialog";
import { NewInseminationDialog } from "@/components/seklinimas/new-insemination-dialog";
import { NewHoofExamDialog } from "@/components/nagos/new-hoof-exam-dialog";
import {
  Chip,
  InfoRow,
  ProgressBar,
  SectionCard,
  StatTile,
  TeatGrid,
  Timeline,
  WithdrawalChip,
  WithdrawalMini,
} from "@/components/gyvunai/animal-profile-parts";
import type { AnimalLookups } from "@/lib/animal-lookups";
import {
  EMPTY_HISTORY,
  HOOF_EXAM_SELECT,
  TONE_CLASSES,
  TREATMENT_SELECT,
  VACCINATION_SELECT,
  VISIT_SELECT,
  ageFromBirth,
  buildTreatmentCards,
  daysAgoLabel,
  daysUntil,
  groupTone,
  hasDelproFields,
  sortTimeline,
  speciesEmoji,
  syncRelativeLabel,
  type AnimalHistory,
  type AnimalRow,
  type TimelineEvent,
  type Tone,
  type VaccinationCardData,
  type WithdrawalRow,
} from "@/lib/animal-profile";
import { GESTATION_DAYS, INSEMINATION_SELECT, PREGNANCY_LABELS, expectedCalvingDate, pregnancyStatus, type InseminationRow } from "@/lib/seklinimas";
import { HOOF_LEG_LABELS, formatZones, severityTone } from "@/lib/hoof";
import { TREATMENT_TYPE_LABELS, VISIT_PROCEDURE_LABELS, VISIT_STATUS_LABELS, VISIT_STATUS_TONE } from "@/lib/visits";
import type { ProcedureType, VisitProcedure, VisitStatus } from "@/lib/supabase/types";

type Variant = "drawer" | "page";

function animalTitle(a: AnimalRow) {
  return a.animal_no ? `Nr. ${a.animal_no}` : a.tag_no;
}

/** Fetches everything the card shows besides the animal row itself. */
function useAnimalHistory(animalId: string | null, active: boolean) {
  const [history, setHistory] = React.useState<AnimalHistory>(EMPTY_HISTORY);
  const [inseminations, setInseminations] = React.useState<InseminationRow[]>([]);
  const [loadedForId, setLoadedForId] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    if (!active || !animalId) return;
    let cancelled = false;
    const supabase = createClient();
    Promise.all([
      supabase.from("treatments").select(TREATMENT_SELECT).eq("animal_id", animalId),
      supabase.from("vw_treated_animals").select("treatment_id, product_name, qty, unit").eq("animal_id", animalId),
      supabase.from("vaccinations").select(VACCINATION_SELECT).eq("animal_id", animalId).order("vaccination_date", { ascending: false }),
      supabase.from("insemination_records").select(INSEMINATION_SELECT).eq("animal_id", animalId).order("insemination_date", { ascending: false }),
      supabase.from("animal_visits").select(VISIT_SELECT).eq("animal_id", animalId).order("visit_datetime", { ascending: false }),
      supabase.from("hoof_exams").select(HOOF_EXAM_SELECT).eq("animal_id", animalId).order("exam_date", { ascending: false }),
    ]).then(([tRes, lRes, vRes, iRes, visRes, hRes]) => {
      if (cancelled) return;
      setHistory({
        treatments: buildTreatmentCards(
          (tRes.data ?? []) as unknown as Parameters<typeof buildTreatmentCards>[0],
          (lRes.data ?? []) as unknown as Parameters<typeof buildTreatmentCards>[1],
        ),
        vaccinations: (vRes.data ?? []) as unknown as VaccinationCardData[],
        visits: (visRes.data ?? []) as unknown as AnimalHistory["visits"],
        hoofExams: (hRes.data ?? []) as unknown as AnimalHistory["hoofExams"],
      });
      setInseminations((iRes.data ?? []) as unknown as InseminationRow[]);
      setLoadedForId(animalId);
    });
    return () => {
      cancelled = true;
    };
  }, [active, animalId, tick]);

  return {
    history,
    inseminations,
    loading: active && animalId !== null && loadedForId !== animalId,
    refetch: () => setTick((t) => t + 1),
  };
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero({ animal, variant }: { animal: AnimalRow; variant: Variant }) {
  const age = ageFromBirth(animal.birth_date);
  const gTone = TONE_CLASSES[groupTone(animal.group_name)];
  const pregDays = animal.pregnancy_days;
  const heroChip = "inline-flex items-center gap-1 rounded-badge bg-white/15 px-2.5 py-0.5 text-[11.5px] font-semibold text-white backdrop-blur-sm";
  const Title = variant === "drawer" ? DrawerTitle : "h2";

  return (
    <div className="relative overflow-hidden bg-gradient-to-br from-ink via-ink-soft to-accent px-6 pb-5 pt-5 text-text-on-ink">
      <div className="pointer-events-none absolute -right-8 -top-8 size-40 rounded-full bg-accent/30 blur-2xl" aria-hidden />
      <div className="pointer-events-none absolute -bottom-10 left-1/3 size-32 rounded-full bg-accent-alt/30 blur-2xl" aria-hidden />
      {variant === "drawer" && (
        <DrawerClose className="absolute right-3 top-3 rounded-control p-1.5 text-white/70 hover:bg-white/10 hover:text-white" aria-label="Uždaryti">
          <X className="size-4" />
        </DrawerClose>
      )}
      <div className="relative flex items-start gap-4">
        <div className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-[34px] shadow-soft backdrop-blur-sm" aria-hidden>
          {speciesEmoji(animal.species)}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Title className="text-[30px] font-extrabold leading-none tracking-tight text-white">{animalTitle(animal)}</Title>
            <span
              className={cn("inline-flex items-center gap-1 rounded-badge px-2 py-0.5 text-[11px] font-bold", animal.active ? "bg-success text-white" : "bg-white/20 text-white/80")}
            >
              <span className="size-1.5 rounded-full bg-white" />
              {animal.active ? "Aktyvus" : "Neaktyvus"}
            </span>
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[13px] text-white/80">
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[12px]">{animal.tag_no}</span>
            {animal.name && <span className="font-semibold text-white">{animal.name}</span>}
            {animal.breed && <span>{animal.breed}</span>}
          </p>
        </div>
      </div>

      <div className="relative mt-4 flex flex-wrap gap-1.5">
        {animal.group_name && (
          <span className={cn("inline-flex items-center gap-1 rounded-badge px-2.5 py-0.5 text-[11.5px] font-bold", gTone.soft, gTone.text)}>
            <Users className="size-3" /> {animal.group_name}
          </span>
        )}
        {animal.sex && <span className={heroChip}>{animal.sex}</span>}
        {age && <span className={heroChip}>{age}</span>}
        {animal.lactation_no !== null && (
          <span className={heroChip}>
            <Milk className="size-3" /> {animal.lactation_no} laktacija
          </span>
        )}
        {animal.days_in_milk !== null && <span className={heroChip}>{animal.days_in_milk} d. pieno</span>}
        {animal.is_pregnant && (
          <span className="inline-flex items-center gap-1 rounded-badge bg-accent-alt-soft px-2.5 py-0.5 text-[11.5px] font-bold text-accent-alt">
            <Baby className="size-3" /> Veršinga{pregDays !== null ? ` · ${pregDays} d.` : ""}
          </span>
        )}
        {animal.health_alert && (
          <span className="inline-flex items-center gap-1 rounded-badge bg-danger px-2.5 py-0.5 text-[11.5px] font-bold text-white">
            <AlertTriangle className="size-3" /> {animal.health_alert}
          </span>
        )}
        <span className={heroChip}>
          <Database className="size-3" /> {animal.source === "delpro" ? "DelPro" : animal.source === "vic" ? "VIC" : "Rankinis"}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function DelproCard({ animal }: { animal: AnimalRow }) {
  const has = hasDelproFields(animal);
  const toCalving = daysUntil(animal.expected_calving_date);
  const pregDays =
    animal.pregnancy_days ?? (animal.is_pregnant && toCalving !== null ? Math.max(GESTATION_DAYS - toCalving, 0) : null);
  const toDry = daysUntil(animal.dry_off_date);

  return (
    <SectionCard
      title="DelPro kortelė"
      icon={Database}
      tone="info"
      aside={animal.updated_from_delpro_at ? `atnaujinta ${syncRelativeLabel(animal.updated_from_delpro_at)}` : undefined}
    >
      {!has ? (
        <EmptyState
          icon={Database}
          title="Duomenų iš DelPro dar nėra"
          description="Veršiavimosi, laktacijos, sėklinimo ir pieno laukai atsiras po kitos DelPro sinchronizacijos."
          className="py-6"
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {animal.reproduction_status && (
              <Chip tone="alt" icon={Dna}>
                {animal.reproduction_status}
              </Chip>
            )}
            {animal.produces_milk !== null && (
              <Chip tone={animal.produces_milk ? "success" : "neutral"} icon={Milk}>
                {animal.produces_milk ? "Gamina pieną" : "Nemelžiama"}
              </Chip>
            )}
            {animal.is_pregnant !== null && (
              <Chip tone={animal.is_pregnant ? "alt" : "neutral"} icon={Baby}>
                {animal.is_pregnant ? "Veršinga" : "Neveršinga"}
              </Chip>
            )}
            {animal.health_alert && (
              <Chip tone="danger" icon={ShieldAlert}>
                {animal.health_alert}
              </Chip>
            )}
          </div>

          {animal.is_pregnant && (
            <div className="rounded-control border border-accent-alt-border bg-accent-alt-soft p-3">
              <div className="mb-1.5 flex items-baseline justify-between">
                <p className="text-[12px] font-semibold text-accent-alt">Veršingumas</p>
                <p className="text-[12px] text-accent-alt">
                  {pregDays !== null ? `${pregDays} / ${GESTATION_DAYS} d.` : ""}
                  {toCalving !== null && toCalving >= 0 ? ` · liko ${toCalving} d.` : ""}
                </p>
              </div>
              <ProgressBar value={pregDays ?? 0} max={GESTATION_DAYS} tone="alt" label="Veršingumo eiga" />
              <p className="mt-1.5 text-[12px] text-text-secondary">Numatomas apsiveršiavimas: {formatDate(animal.expected_calving_date)}</p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-accent-alt">
                <Dna className="size-3.5" /> Reprodukcija
              </p>
              <dl>
                <InfoRow label="Paskutinis apsiveršiavimas">
                  {animal.last_calving_date ? `${formatDate(animal.last_calving_date)} (${daysAgoLabel(animal.last_calving_date)})` : null}
                </InfoRow>
                <InfoRow label="Paskutinis sėklinimas">
                  {animal.last_insemination_date ? `${formatDate(animal.last_insemination_date)} (${daysAgoLabel(animal.last_insemination_date)})` : null}
                </InfoRow>
                <InfoRow label="Sėklinimų skaičius">{animal.insemination_count}</InfoRow>
                <InfoRow label="Buliai">{animal.last_bulls}</InfoRow>
                <InfoRow label="Numatomas veršiavimasis">{animal.expected_calving_date ? formatDate(animal.expected_calving_date) : null}</InfoRow>
                <InfoRow label="Užtrūkimas">
                  {animal.dry_off_date ? `${formatDate(animal.dry_off_date)}${toDry !== null && toDry >= 0 ? ` (po ${toDry} d.)` : ""}` : null}
                </InfoRow>
              </dl>
            </div>
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-success">
                <Milk className="size-3.5" /> Pienas ir kilmė
              </p>
              <dl>
                <InfoRow label="Laktacijos dienos">{animal.days_in_milk !== null ? `${animal.days_in_milk} d.` : null}</InfoRow>
                <InfoRow label="Pieno vidurkis">{animal.milk_yield_kg !== null ? `${animal.milk_yield_kg} kg/d.` : null}</InfoRow>
                <InfoRow label="Paskutinis melžimas">
                  {animal.last_milking_at ? `${formatDateTime(animal.last_milking_at)}${animal.last_milking_kg !== null ? ` · ${animal.last_milking_kg} kg` : ""}` : null}
                </InfoRow>
                <InfoRow label="Veislinė vertė">{animal.genetic_worth}</InfoRow>
                <InfoRow label="Kraujo linija">{animal.blood_line}</InfoRow>
                <InfoRow label="Grupėje nuo">{animal.group_since ? formatDate(animal.group_since) : null}</InfoRow>
              </dl>
            </div>
          </div>

          {animal.missing_teats !== null && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-info">
                <Droplets className="size-3.5" /> Speniai
              </p>
              <TeatGrid missing={animal.missing_teats} />
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function NotesForm({ animal, canWrite }: { animal: AnimalRow; canWrite: boolean }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(updateAnimalNotes, null);
  return (
    <SectionCard title="Pastabos" icon={StickyNote} tone="warning">
      <form action={formAction} key={`${animal.id}:${animal.notes ?? ""}`} className="space-y-2">
        <input type="hidden" name="id" value={animal.id} />
        <Textarea name="notes" rows={3} defaultValue={animal.notes ?? ""} placeholder="Pastabos apie gyvūną..." disabled={!canWrite} />
        {state && !state.ok && <p className="text-[12px] text-danger">{state.error}</p>}
        {canWrite && (
          <div className="flex items-center justify-end gap-2">
            {state?.ok && <span className="text-[12px] text-success">Išsaugota</span>}
            <Button type="submit" size="sm" variant="outline" disabled={pending}>
              {pending ? "Saugoma..." : "Išsaugoti pastabas"}
            </Button>
          </div>
        )}
      </form>
    </SectionCard>
  );
}

function OverviewTab({ animal, canWrite }: { animal: AnimalRow; canWrite: boolean }) {
  const age = ageFromBirth(animal.birth_date);
  const toCalving = daysUntil(animal.expected_calving_date);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <StatTile label="Amžius" value={age ?? "—"} sub={animal.birth_date ? `gim. ${formatDate(animal.birth_date)}` : undefined} icon={Hourglass} tone="info" />
        <StatTile label="Laktacija" value={animal.lactation_no ?? "—"} sub={animal.group_name ?? undefined} icon={Milk} tone="accent" />
        <StatTile label="Dienos pienu" value={animal.days_in_milk ?? "—"} sub={animal.milk_yield_kg !== null ? `${animal.milk_yield_kg} kg/d.` : "DelPro"} icon={Gauge} tone="success" />
        <StatTile
          label="Apsiveršiavo"
          value={animal.last_calving_date ? formatDate(animal.last_calving_date) : "—"}
          sub={animal.last_calving_date ? daysAgoLabel(animal.last_calving_date) : undefined}
          icon={Baby}
          tone="alt"
        />
        <StatTile
          label="Veršiuosis"
          value={animal.expected_calving_date ? formatDate(animal.expected_calving_date) : "—"}
          sub={toCalving !== null && toCalving >= 0 ? `liko ${toCalving} d.` : undefined}
          icon={CalendarClock}
          tone="warning"
        />
        <StatTile
          label="Reprodukcija"
          value={animal.reproduction_status ?? "—"}
          sub={animal.last_insemination_date ? `sėkl. ${formatDate(animal.last_insemination_date)}` : undefined}
          icon={Dna}
          tone="alt"
        />
      </div>

      <DelproCard animal={animal} />

      <SectionCard title="Pagrindinė informacija" icon={Info} tone="accent">
        <dl className="grid gap-x-6 sm:grid-cols-2">
          <InfoRow label="Ausies įsaga">{animal.tag_no}</InfoRow>
          <InfoRow label="Ūkio Nr.">{animal.animal_no}</InfoRow>
          <InfoRow label="Vardas">{animal.name}</InfoRow>
          <InfoRow label="Rūšis">{animal.species}</InfoRow>
          <InfoRow label="Lytis / kategorija">{animal.sex}</InfoRow>
          <InfoRow label="Veislė">{animal.breed}</InfoRow>
          <InfoRow label="Gimimo data">{animal.birth_date ? `${formatDate(animal.birth_date)}${age ? ` · ${age}` : ""}` : null}</InfoRow>
          <InfoRow label="Grupė">{animal.group_name}</InfoRow>
          <InfoRow label="Laktacijos Nr.">{animal.lactation_no}</InfoRow>
          <InfoRow label="Šaltinis">
            <Badge tone={animal.source === "delpro" ? "info" : "neutral"}>{animal.source === "delpro" ? "DelPro" : animal.source === "vic" ? "VIC" : "Rankinis"}</Badge>
          </InfoRow>
          <InfoRow label="DelPro ID">{animal.delpro_animal_id}</InfoRow>
          <InfoRow label="Būsena">
            <Badge tone={animal.active ? "success" : "neutral"}>{animal.active ? "Aktyvus" : "Neaktyvus"}</Badge>
          </InfoRow>
        </dl>
      </SectionCard>

      <NotesForm animal={animal} canWrite={canWrite} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// History tabs
// ---------------------------------------------------------------------------

function HistoryCard({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <div className={cn("relative overflow-hidden rounded-control border bg-surface p-3 pl-4 shadow-soft", TONE_CLASSES[tone].border)}>
      <span className={cn("absolute inset-y-0 left-0 w-1.5", TONE_CLASSES[tone].solid)} aria-hidden />
      {children}
    </div>
  );
}

function TreatmentsTab({ history, loading }: { history: AnimalHistory; loading: boolean }) {
  if (loading) return <Loading />;
  if (history.treatments.length === 0) return <EmptyState icon={Stethoscope} title="Gydymų nėra" className="py-8" />;
  return (
    <div className="space-y-2.5">
      {history.treatments.map((t) => (
        <HistoryCard key={t.id} tone="danger">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[14px] font-semibold text-text-primary">
              {formatDate(t.reg_date)} · {t.title}
            </p>
            <div className="flex gap-1">
              <Badge tone="neutral">{TREATMENT_TYPE_LABELS[t.procedure_type as ProcedureType] ?? "Apžiūra"}</Badge>
              {t.outcome && <Badge tone="info">{t.outcome}</Badge>}
            </div>
          </div>
          {t.lines.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {t.lines.map((l, i) => (
                <Chip key={i} tone="accent">
                  {l.product_name} · {formatQty(l.qty, l.unit)}
                </Chip>
              ))}
            </div>
          )}
          {t.course && (
            <div className="mb-2 rounded-control bg-surface-secondary/70 p-2">
              <div className="mb-1 flex items-center justify-between text-[12px]">
                <span className="font-semibold text-text-primary">
                  Kursas: {t.course.doneDays} / {t.course.days} d.
                </span>
                <span className="text-text-secondary">
                  {t.course.status === "completed" ? "baigtas" : t.course.status === "cancelled" ? "atšauktas" : t.course.nextDose ? `kita dozė ${formatDate(t.course.nextDose)}` : "vykdomas"}
                </span>
              </div>
              <ProgressBar
                value={t.course.doneDays}
                max={t.course.days}
                tone={t.course.status === "cancelled" ? "neutral" : t.course.status === "completed" ? "success" : "info"}
                label="Gydymo kurso eiga"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <WithdrawalMini kind="milk" until={t.withdrawal_until_milk} />
            <WithdrawalMini kind="meat" until={t.withdrawal_until_meat} />
            {t.vet_name && <span className="text-[12px] text-text-muted">{t.vet_name}</span>}
          </div>
          {t.notes && <p className="mt-1.5 text-[12px] text-text-secondary">{t.notes}</p>}
        </HistoryCard>
      ))}
    </div>
  );
}

function VaccinationsTab({ history, loading }: { history: AnimalHistory; loading: boolean }) {
  if (loading) return <Loading />;
  if (history.vaccinations.length === 0) return <EmptyState icon={Syringe} title="Vakcinacijų nėra" className="py-8" />;
  return (
    <div className="space-y-2.5">
      {history.vaccinations.map((v) => {
        const boosterIn = daysUntil(v.next_booster_date);
        return (
          <HistoryCard key={v.id} tone="success">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[14px] font-semibold text-text-primary">
                {formatDate(v.vaccination_date)} · {v.products?.name ?? "—"}
              </p>
              <div className="flex gap-1">
                <Chip tone="success">{formatQty(v.dose_amount, v.unit)}</Chip>
                {v.is_revaccination && <Badge tone="info">Pakartotinė</Badge>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {v.next_booster_date && (
                <Chip tone={boosterIn !== null && boosterIn < 0 ? "danger" : boosterIn !== null && boosterIn <= 14 ? "warning" : "info"} icon={CalendarClock}>
                  Kitas skiepas {formatDate(v.next_booster_date)}
                  {boosterIn !== null ? (boosterIn < 0 ? " · pavėluota" : ` · po ${boosterIn} d.`) : ""}
                </Chip>
              )}
              <WithdrawalMini kind="milk" until={v.withdrawal_until_milk} />
              <WithdrawalMini kind="meat" until={v.withdrawal_until_meat} />
            </div>
          </HistoryCard>
        );
      })}
    </div>
  );
}

function InseminationsTab({ rows, loading }: { rows: InseminationRow[]; loading: boolean }) {
  if (loading) return <Loading />;
  if (rows.length === 0) return <EmptyState icon={Dna} title="Sėklinimų nėra" className="py-8" />;
  return (
    <div className="space-y-2.5">
      {rows.map((i) => {
        const status = pregnancyStatus(i.pregnancy_confirmed);
        return (
          <HistoryCard key={i.id} tone="alt">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[14px] font-semibold text-text-primary">{formatDate(i.insemination_date)}</p>
              <Chip tone={status === "confirmed" ? "success" : status === "not_confirmed" ? "danger" : "warning"}>{PREGNANCY_LABELS[status]}</Chip>
            </div>
            <p className="text-[13px] text-text-secondary">
              {i.sperm?.name ?? i.bull_name ?? "—"}
              {i.reproduktoriaus_id ? ` · KK Nr. ${i.reproduktoriaus_id}` : ""}
              {i.inseminator_name ? ` · ${i.inseminator_name}` : ""}
            </p>
            <p className="mt-1 text-[12px] text-text-muted">
              {i.pregnancy_check_date
                ? `Patikra: ${formatDate(i.pregnancy_check_date)}`
                : i.next_pregnancy_check_date
                  ? `Planuojama patikra: ${formatDate(i.next_pregnancy_check_date)}`
                  : "Patikra nenurodyta"}
              {i.pregnancy_confirmed !== false ? ` · Numatomas apsiveršiavimas: ${formatDate(expectedCalvingDate(i.insemination_date))}` : ""}
            </p>
          </HistoryCard>
        );
      })}
    </div>
  );
}

function VisitsTab({ history, loading }: { history: AnimalHistory; loading: boolean }) {
  if (loading) return <Loading />;
  if (history.visits.length === 0) return <EmptyState icon={CalendarClock} title="Vizitų nėra" className="py-8" />;
  return (
    <div className="space-y-2.5">
      {history.visits.map((v) => {
        const status = v.status as VisitStatus;
        return (
          <HistoryCard key={v.id} tone="info">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[14px] font-semibold text-text-primary">{formatDateTime(v.visit_datetime)}</p>
              <Badge tone={VISIT_STATUS_TONE[status] ?? "neutral"}>{VISIT_STATUS_LABELS[status] ?? v.status}</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {v.procedures.map((p) => (
                <Chip key={p} tone="info">
                  {VISIT_PROCEDURE_LABELS[p as VisitProcedure] ?? p}
                </Chip>
              ))}
              {v.temperature !== null && (
                <Chip tone={v.temperature >= 39.5 ? "danger" : "neutral"} icon={Thermometer}>
                  {v.temperature} °C
                </Chip>
              )}
              {v.vet_name && <span className="text-[12px] text-text-muted">{v.vet_name}</span>}
            </div>
            {v.sync_step_title && (
              <p className="mt-1.5 text-[12px] font-medium text-text-primary">
                {v.sync_protocol_applications?.protocol_name ?? "Protokolas"}
                {v.sync_step_no && v.sync_step_total ? ` · ${v.sync_step_no}/${v.sync_step_total}` : ""} — {v.sync_step_title}
              </p>
            )}
            {v.notes && <p className="mt-1.5 text-[12px] text-text-secondary">{v.notes}</p>}
            {v.next_visit_date && <p className="mt-1 text-[12px] text-text-muted">Kitas vizitas: {formatDate(v.next_visit_date)}</p>}
          </HistoryCard>
        );
      })}
    </div>
  );
}

function HoofTab({ history, loading }: { history: AnimalHistory; loading: boolean }) {
  if (loading) return <Loading />;
  if (history.hoofExams.length === 0) return <EmptyState icon={Footprints} title="Nagų apžiūrų nėra" className="py-8" />;
  return (
    <div className="space-y-2.5">
      {history.hoofExams.map((exam) => (
        <HistoryCard key={exam.id} tone="warning">
          <p className="mb-1.5 text-[14px] font-semibold text-text-primary">
            {formatDate(exam.exam_date)}
            {exam.performed_by && <span className="ml-2 text-[12px] font-normal text-text-muted">{exam.performed_by}</span>}
          </p>
          <div className="space-y-1">
            {exam.hoof_findings.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center gap-2 text-[13px] text-text-secondary">
                {f.leg ? (
                  <span>
                    {HOOF_LEG_LABELS[f.leg]} ({formatZones(f.zones)})
                  </span>
                ) : (
                  <span>Visos kojos</span>
                )}
                {f.condition_code && (
                  <Badge tone={severityTone(f.severity)}>
                    {f.hoof_condition_codes?.description.split(" (")[0] ?? f.condition_code}
                    {f.condition_code !== "OK" ? ` · S${f.severity}` : ""}
                  </Badge>
                )}
                {f.followup_required && !f.followup_completed && <Badge tone="warning">pakartoti {formatDate(f.followup_date)}</Badge>}
              </div>
            ))}
          </div>
          {exam.notes && <p className="mt-1.5 text-[12px] text-text-secondary">{exam.notes}</p>}
        </HistoryCard>
      ))}
    </div>
  );
}

function WithdrawalTab({ history, loading }: { history: AnimalHistory; loading: boolean }) {
  if (loading) return <Loading />;
  const rows = [
    ...history.treatments.map((t) => ({
      key: `t-${t.id}`,
      date: t.reg_date,
      title: `Gydymas · ${t.title}`,
      milk: t.withdrawal_until_milk,
      meat: t.withdrawal_until_meat,
    })),
    ...history.vaccinations.map((v) => ({
      key: `v-${v.id}`,
      date: v.vaccination_date,
      title: `Vakcinacija · ${v.products?.name ?? "—"}`,
      milk: v.withdrawal_until_milk,
      meat: v.withdrawal_until_meat,
    })),
  ]
    .filter((r) => r.milk || r.meat)
    .sort((a, b) => [b.milk, b.meat].filter(Boolean).sort().reverse()[0]!.localeCompare([a.milk, a.meat].filter(Boolean).sort().reverse()[0]!));
  if (rows.length === 0) return <EmptyState icon={ShieldAlert} title="Karencijų nėra" description="Šiam gyvūnui nebuvo vaistų su karencija." className="py-8" />;
  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const live = [r.milk, r.meat].some((d) => d && (daysUntil(d) ?? -1) >= 0);
        return (
          <HistoryCard key={r.key} tone={live ? "danger" : "neutral"}>
            <p className="mb-1.5 text-[13.5px] font-semibold text-text-primary">
              {formatDate(r.date)} · {r.title}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <WithdrawalMini kind="milk" until={r.milk} />
              <WithdrawalMini kind="meat" until={r.meat} />
            </div>
          </HistoryCard>
        );
      })}
    </div>
  );
}

function TimelineTab({ animal, history, inseminations, loading }: { animal: AnimalRow; history: AnimalHistory; inseminations: InseminationRow[]; loading: boolean }) {
  const icons = { treatment: Stethoscope, vaccination: Syringe, insemination: Dna, visit: CalendarClock, hoof: Footprints, delpro: Database };
  const events = React.useMemo(() => {
    const e: TimelineEvent[] = [];
    for (const t of history.treatments) {
      e.push({
        key: `t-${t.id}`,
        date: t.reg_date,
        kind: "treatment",
        title: `Gydymas: ${t.title}`,
        detail: t.lines.map((l) => `${l.product_name} (${formatQty(l.qty, l.unit)})`).join(", ") || null,
      });
    }
    for (const v of history.vaccinations) {
      e.push({ key: `v-${v.id}`, date: v.vaccination_date, kind: "vaccination", title: `Vakcinacija: ${v.products?.name ?? "—"}`, detail: formatQty(v.dose_amount, v.unit) });
    }
    for (const i of inseminations) {
      e.push({ key: `i-${i.id}`, date: i.insemination_date, kind: "insemination", title: "Sėklinimas", detail: i.sperm?.name ?? i.bull_name });
    }
    for (const v of history.visits) {
      e.push({
        key: `vis-${v.id}`,
        date: v.visit_datetime,
        kind: "visit",
        title: `Vizitas (${VISIT_STATUS_LABELS[v.status as VisitStatus] ?? v.status})`,
        detail: v.procedures.map((p) => VISIT_PROCEDURE_LABELS[p as VisitProcedure] ?? p).join(", ") || null,
      });
    }
    for (const h of history.hoofExams) {
      e.push({ key: `h-${h.id}`, date: h.exam_date, kind: "hoof", title: "Nagų apžiūra", detail: `${h.hoof_findings.length} radin.` });
    }
    // DelPro-reported milestones (only when GVET has no journal entry for the day)
    const insemDays = new Set(inseminations.map((i) => i.insemination_date));
    if (animal.last_calving_date) e.push({ key: "dp-calving", date: animal.last_calving_date, kind: "delpro", title: "Apsiveršiavo", detail: "DelPro" });
    if (animal.last_insemination_date && !insemDays.has(animal.last_insemination_date)) {
      e.push({ key: "dp-insem", date: animal.last_insemination_date, kind: "delpro", title: "Apsėklinta", detail: animal.last_bulls ? `DelPro · ${animal.last_bulls}` : "DelPro" });
    }
    if (animal.dry_off_date) e.push({ key: "dp-dry", date: animal.dry_off_date, kind: "delpro", title: "Užtrūkimas", detail: "DelPro" });
    if (animal.expected_calving_date && animal.is_pregnant !== false) {
      e.push({ key: "dp-expected", date: animal.expected_calving_date, kind: "delpro", title: "Numatomas apsiveršiavimas", detail: "DelPro" });
    }
    if (animal.group_since && animal.group_name) {
      e.push({ key: "dp-group", date: animal.group_since, kind: "delpro", title: `Grupė: ${animal.group_name}`, detail: "DelPro" });
    }
    if (animal.birth_date) e.push({ key: "birth", date: animal.birth_date, kind: "delpro", title: "Gimė", detail: null });
    return sortTimeline(e);
  }, [animal, history, inseminations]);

  if (loading) return <Loading />;
  if (events.length === 0) return <EmptyState icon={Activity} title="Įvykių dar nėra" className="py-8" />;
  return <Timeline items={events} icons={icons} />;
}

function Loading() {
  return <p className="py-6 text-center text-[13px] text-text-muted">Kraunama...</p>;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function TabLabel({ icon: Icon, label, count, tone }: { icon: React.ComponentType<{ className?: string }>; label: string; count?: number; tone: Tone }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <Icon className={cn("size-3.5", TONE_CLASSES[tone].text)} />
      {label}
      {count !== undefined && count > 0 && <span className="rounded-full bg-black/10 px-1.5 text-[10px] font-bold text-current">{count}</span>}
    </span>
  );
}

/**
 * The one animal view: hero, karencija countdowns, quick actions and tabs
 * (overview + DelPro card, karencija, gydymai, vakcinacijos, sėklinimai,
 * vizitai, nagai, įvykių juosta). Used both in the side panel opened from
 * the list and on /veterinarija/gyvunai/[id].
 */
export function AnimalProfile({
  animal,
  withdrawal,
  lookups,
  variant,
  active = true,
}: {
  animal: AnimalRow;
  withdrawal?: WithdrawalRow;
  lookups: AnimalLookups;
  variant: Variant;
  /** Drawer: only fetch while open. */
  active?: boolean;
}) {
  const { history, inseminations, loading, refetch } = useAnimalHistory(animal.id, active);
  const { canWrite, currentVetName } = lookups;
  const animalOption = { id: animal.id, tag_no: animal.tag_no, animal_no: animal.animal_no, group_name: animal.group_name };
  const lastTreatment = history.treatments[0]?.reg_date ?? null;
  const count = (n: number) => (loading ? undefined : n);

  const body = (
    <div className="space-y-4">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <WithdrawalChip kind="milk" active={!!withdrawal?.milk_active} until={withdrawal?.milk_until ?? null} />
        <WithdrawalChip kind="meat" active={!!withdrawal?.meat_active} until={withdrawal?.meat_until ?? null} />
      </div>

      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <NewTreatmentDialog
            animalId={animal.id}
            diseases={lookups.diseases}
            products={lookups.products}
            currentVetName={currentVetName}
            dialogTitle={`Naujas gydymas — ${animalTitle(animal)}`}
            trigger={
              <Button size="sm">
                <Stethoscope className="size-4" /> Gydymas
              </Button>
            }
            onCreated={refetch}
          />
          <NewVaccinationDialog
            animalId={animal.id}
            animals={[animalOption]}
            groups={lookups.groups}
            products={lookups.products}
            currentVetName={currentVetName}
            trigger={
              <Button size="sm" variant="success">
                <Syringe className="size-4" /> Vakcinacija
              </Button>
            }
            onCreated={refetch}
          />
          <NewTreatmentDialog
            animalId={animal.id}
            diseases={lookups.diseases}
            products={lookups.products}
            currentVetName={currentVetName}
            fixedProcedureType="profilaktika"
            dialogTitle={`Nauja profilaktika — ${animalTitle(animal)}`}
            trigger={
              <Button size="sm" variant="outline">
                <ShieldCheck className="size-4 text-success" /> Profilaktika
              </Button>
            }
            onCreated={refetch}
          />
          <ApplySyncProtocolDialog
            animalId={animal.id}
            currentVetName={currentVetName}
            today={lookups.today}
            title={`Sinchronizacija — ${animalTitle(animal)}`}
            trigger={
              <Button size="sm" variant="outline">
                <Repeat className="size-4 text-accent" /> Sinchronizacija
              </Button>
            }
            onCreated={refetch}
          />
          <NewVisitDialog
            animalId={animal.id}
            animals={[animalOption]}
            currentVetName={currentVetName}
            today={lookups.today}
            trigger={
              <Button size="sm" variant="outline">
                <CalendarPlus className="size-4 text-info" /> Vizitas
              </Button>
            }
            onCreated={refetch}
          />
          <NewInseminationDialog
            animalId={animal.id}
            animals={[animalOption]}
            sperm={lookups.sperm}
            gloves={lookups.gloves}
            currentVetName={currentVetName}
            trigger={
              <Button size="sm" variant="outline">
                <Dna className="size-4 text-accent-alt" /> Sėklinimas
              </Button>
            }
            onCreated={refetch}
          />
          <NewHoofExamDialog
            animalId={animal.id}
            animals={[animalOption]}
            conditionCodes={lookups.conditionCodes}
            products={lookups.hoofProducts}
            currentUserName={currentVetName}
            trigger={
              <Button size="sm" variant="outline">
                <Footprints className="size-4 text-warning" /> Nagų apžiūra
              </Button>
            }
            onCreated={refetch}
          />
        </div>
      )}

      {!loading && lastTreatment && (
        <p className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          <HeartPulse className="size-3.5 text-danger" /> Paskutinis gydymas: {formatDate(lastTreatment)} ({daysAgoLabel(lastTreatment)})
        </p>
      )}

      <Tabs defaultValue="overview">
        <TabsList className="flex w-full justify-start overflow-x-auto scrollbar-thin">
          <TabsTrigger value="overview">
            <TabLabel icon={PawPrint} label="Apžvalga" tone="accent" />
          </TabsTrigger>
          <TabsTrigger value="withdrawal">
            <TabLabel icon={ShieldAlert} label="Karencija" tone="danger" />
          </TabsTrigger>
          <TabsTrigger value="treatments">
            <TabLabel icon={Stethoscope} label="Gydymai" tone="danger" count={count(history.treatments.length)} />
          </TabsTrigger>
          <TabsTrigger value="vaccinations">
            <TabLabel icon={Syringe} label="Vakcinacijos" tone="success" count={count(history.vaccinations.length)} />
          </TabsTrigger>
          <TabsTrigger value="inseminations">
            <TabLabel icon={Dna} label="Sėklinimai" tone="alt" count={count(inseminations.length)} />
          </TabsTrigger>
          <TabsTrigger value="visits">
            <TabLabel icon={CalendarClock} label="Vizitai" tone="info" count={count(history.visits.length)} />
          </TabsTrigger>
          <TabsTrigger value="hoof">
            <TabLabel icon={Footprints} label="Nagai" tone="warning" count={count(history.hoofExams.length)} />
          </TabsTrigger>
          <TabsTrigger value="timeline">
            <TabLabel icon={Layers} label="Įvykiai" tone="accent" />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab animal={animal} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="withdrawal">
          <WithdrawalTab history={history} loading={loading} />
        </TabsContent>
        <TabsContent value="treatments">
          <TreatmentsTab history={history} loading={loading} />
        </TabsContent>
        <TabsContent value="vaccinations">
          <VaccinationsTab history={history} loading={loading} />
        </TabsContent>
        <TabsContent value="inseminations">
          <InseminationsTab rows={inseminations} loading={loading} />
        </TabsContent>
        <TabsContent value="visits">
          <VisitsTab history={history} loading={loading} />
        </TabsContent>
        <TabsContent value="hoof">
          <HoofTab history={history} loading={loading} />
        </TabsContent>
        <TabsContent value="timeline">
          <TimelineTab animal={animal} history={history} inseminations={inseminations} loading={loading} />
        </TabsContent>
      </Tabs>
    </div>
  );

  if (variant === "drawer") {
    return (
      <>
        <Hero animal={animal} variant="drawer" />
        <DrawerBody>
          <Link
            href={`/veterinarija/gyvunai/${animal.id}`}
            className="mb-3 inline-flex items-center gap-1 text-[12px] font-semibold text-accent-hover hover:underline"
          >
            <ExternalLink className="size-3.5" /> Atidaryti per visą puslapį
          </Link>
          {body}
        </DrawerBody>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-panel shadow-soft">
        <Hero animal={animal} variant="page" />
      </div>
      {body}
    </div>
  );
}

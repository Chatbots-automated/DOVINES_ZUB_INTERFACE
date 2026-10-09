// Shared types + pure helpers for the animal card (side panel and
// /veterinarija/gyvunai/[id]). Nothing here is stored — it is all derived
// from dates already on hand, so the card reads as current.
import type { Database } from "@/lib/supabase/types";

export type AnimalRow = Database["public"]["Tables"]["animals"]["Row"];

export type WithdrawalRow = {
  animal_id: string;
  milk_active: boolean;
  meat_active: boolean;
  milk_until: string | null;
  meat_until: string | null;
};

export type Tone = "accent" | "success" | "warning" | "danger" | "info" | "alt" | "neutral";

// Full literal class strings so Tailwind can see them.
export const TONE_CLASSES: Record<Tone, { soft: string; text: string; solid: string; border: string; ring: string }> = {
  accent: { soft: "bg-accent-soft", text: "text-accent-hover", solid: "bg-accent", border: "border-accent-border", ring: "ring-accent/30" },
  success: { soft: "bg-success-soft", text: "text-success", solid: "bg-success", border: "border-success/30", ring: "ring-success/30" },
  warning: { soft: "bg-warning-soft", text: "text-warning", solid: "bg-warning", border: "border-warning/30", ring: "ring-warning/30" },
  danger: { soft: "bg-danger-soft", text: "text-danger", solid: "bg-danger", border: "border-danger/30", ring: "ring-danger/30" },
  info: { soft: "bg-info-soft", text: "text-info", solid: "bg-info", border: "border-info/30", ring: "ring-info/30" },
  alt: { soft: "bg-accent-alt-soft", text: "text-accent-alt", solid: "bg-accent-alt", border: "border-accent-alt-border", ring: "ring-accent-alt/30" },
  neutral: { soft: "bg-surface-secondary", text: "text-text-secondary", solid: "bg-text-muted", border: "border-border", ring: "ring-border" },
};

const DAY_MS = 86_400_000;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole days from today until the date (negative = in the past); null for no date. */
export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = new Date(dateStr.slice(0, 10) + "T00:00:00").getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - startOfToday()) / DAY_MS);
}

export function ageFromBirth(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const birth = new Date(dateStr.slice(0, 10) + "T00:00:00");
  const now = new Date();
  let years = now.getFullYear() - birth.getFullYear();
  let months = now.getMonth() - birth.getMonth();
  if (now.getDate() < birth.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years <= 0) return `${Math.max(months, 0)} mėn.`;
  return months > 0 ? `${years} m. ${months} mėn.` : `${years} m.`;
}

/** "šiandien" / "vakar" / "prieš N d." for a past date. */
export function daysAgoLabel(dateStr: string | null | undefined): string | null {
  const d = daysUntil(dateStr);
  if (d === null) return null;
  if (d >= 0) return d === 0 ? "šiandien" : `po ${d} d.`;
  if (d === -1) return "vakar";
  return `prieš ${-d} d.`;
}

export function syncRelativeLabel(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const diffHours = Math.round((Date.now() - new Date(dateStr).getTime()) / 3_600_000);
  if (diffHours < 1) return "ką tik";
  if (diffHours < 24) return `prieš ${diffHours} val.`;
  return `prieš ${Math.round(diffHours / 24)} d.`;
}

/**
 * Karencija chip colour: clear = green, a few days left = amber ("netrukus
 * baigsis"), longer = red (still cannot be sold / slaughtered).
 */
export const WITHDRAWAL_SOON_DAYS = 3;
export function withdrawalTone(active: boolean, daysLeft: number | null): Tone {
  if (!active) return "success";
  if (daysLeft !== null && daysLeft <= WITHDRAWAL_SOON_DAYS) return "warning";
  return "danger";
}

const GROUP_TONES: Tone[] = ["accent", "alt", "info", "success", "warning"];
/** Stable colour per DelPro group name, so the same group always looks the same. */
export function groupTone(name: string | null): Tone {
  if (!name) return "neutral";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GROUP_TONES[h % GROUP_TONES.length];
}

export function speciesEmoji(species: string | null | undefined): string {
  switch ((species ?? "").toLowerCase()) {
    case "galvijas":
    case "karve":
      return "🐄";
    case "avis":
      return "🐑";
    case "ožka":
      return "🐐";
    case "arklys":
      return "🐴";
    case "kiaulė":
      return "🐖";
    default:
      return "🐾";
  }
}

export const TEAT_LABELS: Record<string, string> = {
  FL: "Priekinis kairysis",
  FR: "Priekinis dešinysis",
  HL: "Galinis kairysis",
  HR: "Galinis dešinysis",
};

/** True when DelPro has supplied at least one DairyPlan-style field for the animal. */
export function hasDelproFields(a: AnimalRow): boolean {
  return [
    a.reproduction_status,
    a.last_calving_date,
    a.days_in_milk,
    a.milk_yield_kg,
    a.last_milking_at,
    a.last_milking_kg,
    a.produces_milk,
    a.last_insemination_date,
    a.insemination_count,
    a.last_bulls,
    a.is_pregnant,
    a.pregnancy_days,
    a.expected_calving_date,
    a.dry_off_date,
    a.genetic_worth,
    a.blood_line,
    a.missing_teats,
    a.health_alert,
    a.group_since,
  ].some((v) => v !== null && v !== undefined);
}

// ---------------------------------------------------------------------------
// History rows (fetched client-side from the same tables/views the journals use)
// ---------------------------------------------------------------------------

export type TreatmentLine = { product_name: string; qty: number | null; unit: string | null };

export type CourseProgress = {
  days: number;
  doneDays: number;
  status: "active" | "completed" | "cancelled";
  startDate: string;
  nextDose: string | null;
};

export type TreatmentCardData = {
  id: string;
  reg_date: string;
  procedure_type: string;
  title: string;
  outcome: string | null;
  vet_name: string | null;
  notes: string | null;
  withdrawal_until_milk: string | null;
  withdrawal_until_meat: string | null;
  lines: TreatmentLine[];
  course: CourseProgress | null;
};

export type VaccinationCardData = {
  id: string;
  vaccination_date: string;
  dose_amount: number | null;
  unit: string | null;
  is_revaccination: boolean;
  next_booster_date: string | null;
  withdrawal_until_milk: string | null;
  withdrawal_until_meat: string | null;
  products: { name: string } | null;
};

export type VisitCardRow = {
  id: string;
  visit_datetime: string;
  procedures: string[];
  status: string;
  temperature: number | null;
  notes: string | null;
  vet_name: string | null;
  next_visit_date: string | null;
  sync_step_title: string | null;
  sync_step_no: number | null;
  sync_step_total: number | null;
  sync_protocol_applications: { protocol_name: string } | null;
};

export type HoofExamCardRow = {
  id: string;
  exam_date: string;
  performed_by: string | null;
  notes: string | null;
  hoof_findings: Array<{
    id: string;
    leg: "FL" | "FR" | "HL" | "HR" | null;
    zones: Array<{ zone: number; claw: "inner" | "outer" }>;
    condition_code: string | null;
    severity: number;
    followup_required: boolean;
    followup_date: string | null;
    followup_completed: boolean;
    hoof_condition_codes: { description: string } | null;
  }>;
};

export type AnimalHistory = {
  treatments: TreatmentCardData[];
  vaccinations: VaccinationCardData[];
  visits: VisitCardRow[];
  hoofExams: HoofExamCardRow[];
};

export const EMPTY_HISTORY: AnimalHistory = { treatments: [], vaccinations: [], visits: [], hoofExams: [] };

export const TREATMENT_SELECT =
  "id, reg_date, procedure_type, diagnosis, outcome, vet_name, notes, withdrawal_until_milk, withdrawal_until_meat, diseases(name), treatment_courses(days, status, start_date, course_doses(day_number, scheduled_date, administered))";

export const VACCINATION_SELECT =
  "id, vaccination_date, dose_amount, unit, is_revaccination, next_booster_date, withdrawal_until_milk, withdrawal_until_meat, products(name)";

export const VISIT_SELECT = "id, visit_datetime, procedures, status, temperature, notes, vet_name, next_visit_date, sync_step_title, sync_step_no, sync_step_total, sync_protocol_applications(protocol_name)";

export const HOOF_EXAM_SELECT =
  "id, exam_date, performed_by, notes, hoof_findings(id, leg, zones, condition_code, severity, followup_required, followup_date, followup_completed, hoof_condition_codes(description))";

type RawTreatment = {
  id: string;
  reg_date: string;
  procedure_type: string;
  diagnosis: string | null;
  outcome: string | null;
  vet_name: string | null;
  notes: string | null;
  withdrawal_until_milk: string | null;
  withdrawal_until_meat: string | null;
  diseases: { name: string } | null;
  treatment_courses: Array<{
    days: number;
    status: "active" | "completed" | "cancelled";
    start_date: string;
    course_doses: Array<{ day_number: number; scheduled_date: string; administered: boolean }>;
  }>;
};

type RawLine = { treatment_id: string; product_name: string | null; qty: number | null; unit: string | null };

/** Treatments + their medication lines (vw_treated_animals) + course progress. */
export function buildTreatmentCards(raw: RawTreatment[], lines: RawLine[]): TreatmentCardData[] {
  const byTreatment = new Map<string, TreatmentLine[]>();
  for (const l of lines) {
    if (!l.product_name) continue;
    const list = byTreatment.get(l.treatment_id) ?? [];
    list.push({ product_name: l.product_name, qty: l.qty, unit: l.unit });
    byTreatment.set(l.treatment_id, list);
  }
  return raw
    .map((t): TreatmentCardData => {
      const c = t.treatment_courses?.[0];
      let course: CourseProgress | null = null;
      if (c) {
        // Day 1 is the treatment's own usage; a later day is done once every
        // dose scheduled for it has been administered.
        const perDay = new Map<number, boolean>();
        for (const d of c.course_doses ?? []) perDay.set(d.day_number, (perDay.get(d.day_number) ?? true) && d.administered);
        const doneLater = [...perDay.values()].filter(Boolean).length;
        const pending = (c.course_doses ?? []).filter((d) => !d.administered).map((d) => d.scheduled_date).sort();
        course = {
          days: c.days,
          doneDays: Math.min(c.days, 1 + doneLater),
          status: c.status,
          startDate: c.start_date,
          nextDose: pending[0] ?? null,
        };
      }
      return {
        id: t.id,
        reg_date: t.reg_date,
        procedure_type: t.procedure_type,
        title: t.diseases?.name ?? t.diagnosis ?? "Be diagnozės",
        outcome: t.outcome,
        vet_name: t.vet_name,
        notes: t.notes,
        withdrawal_until_milk: t.withdrawal_until_milk,
        withdrawal_until_meat: t.withdrawal_until_meat,
        lines: byTreatment.get(t.id) ?? [],
        course,
      };
    })
    .sort((a, b) => b.reg_date.localeCompare(a.reg_date));
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type TimelineKind = "treatment" | "vaccination" | "insemination" | "visit" | "hoof" | "delpro";

export type TimelineEvent = {
  key: string;
  date: string; // ISO date or datetime, sortable
  kind: TimelineKind;
  title: string;
  detail: string | null;
};

export function sortTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => b.date.localeCompare(a.date));
}

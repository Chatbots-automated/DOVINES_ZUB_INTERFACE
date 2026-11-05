// Pure helpers for the "Naujas gydymas" dialog: course schedule generation,
// stock sufficiency and karencija preview. Everything here mirrors what the
// database does on save (create_treatment() + calculate_withdrawal_dates()
// in 0004/0021) so the vet sees the real outcome before submitting. The DB
// stays the source of truth — nothing here is trusted server-side.
import type { AdministrationRoute } from "@/lib/supabase/types";
import { getRouteWithdrawalDays, type WithdrawalFieldKey } from "@/lib/administration-routes";

// ---------------------------------------------------------------------------
// Dates — local-time arithmetic on ISO yyyy-mm-dd strings (never `new Date(iso)`
// + setDate(), which parses as UTC and can shift a day).
// ---------------------------------------------------------------------------

export function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayIso(): string {
  return toIso(new Date());
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return toIso(new Date(y, (m ?? 1) - 1, (d ?? 1) + days));
}

// ---------------------------------------------------------------------------
// Catalog (products + usable stock)
// ---------------------------------------------------------------------------

export type CatalogLot = { id: string; lot: string | null; qty_left: number; expiry_date: string | null };

export type CatalogProduct = {
  id: string;
  name: string;
  unit: string;
  category: string | null;
  is_antimicrobial: boolean;
  active_substance: string | null;
  dosage_notes: string | null;
  withdrawal_days_milk: number | null;
  withdrawal_days_meat: number | null;
} & Partial<Record<WithdrawalFieldKey, number | null>> & {
    /** null = stock unknown (catalog could not be loaded) — no validation. */
    usable_qty: number | null;
    expired_qty: number;
    /** Usable lots in FEFO order (earliest expiry first). */
    lots: CatalogLot[];
  };

/** Which lots FEFO would take for `qty` (mirror of fn_consume_fefo). */
export function previewFefo(product: CatalogProduct, qty: number): { lot: CatalogLot; take: number }[] {
  const out: { lot: CatalogLot; take: number }[] = [];
  let remaining = qty;
  for (const lot of product.lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.qty_left, remaining);
    if (take > 0) out.push({ lot, take });
    remaining -= take;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Course schedule
// ---------------------------------------------------------------------------

/** frequency / days: the vet's times per day and duration in days (gydymas, 0046) — sent to DelPro, never defaulted. */
export type MedLine = { key: string; product_id: string; qty: string; route: string; frequency?: string; days?: string };
/**
 * One medicine on one course day. `times` doses that day, `every` hours apart, the first at
 * `start` (HH:MM, Europe/Vilnius) — each time is its own course dose and planned visit (0064).
 * A row dated on the treatment day itself (day 1) holds the EXTRA doses of that day.
 */
export type CourseRow = { key: string; date: string; product_id: string; qty: string; route: string; times: string; every: string; start: string };
export type ScheduleMode = "daily" | "every2" | "interval";

export const SCHEDULE_MODE_OPTIONS: { value: ScheduleMode; label: string }[] = [
  { value: "daily", label: "Kas dieną" },
  { value: "every2", label: "Kas antrą dieną" },
  { value: "interval", label: "Kas N dienų" },
];

export function modeStep(mode: ScheduleMode, interval: number): number {
  if (mode === "daily") return 1;
  if (mode === "every2") return 2;
  return Math.max(1, Math.floor(interval) || 1);
}

/** Dose dates (excluding day 1) for a course spanning `days` calendar days. */
export function courseDates(startDate: string, days: number, step: number): string[] {
  const out: string[] = [];
  for (let offset = step; offset < days; offset += step) out.push(addDays(startDate, offset));
  return out;
}

const posInt = (v: string | undefined) => (/^[1-9]\d*$/.test((v ?? "").trim()) ? Number(v) : null);

/** HH:MM → minutes since midnight (null when not a valid time). */
export function timeToMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export function minutesToTime(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Default spacing for n doses a day starting in the morning: the last one by ~12 h later (2× → 12 h, 3× → 6 h). */
export function defaultEveryHours(times: number): number {
  return times > 1 ? Math.max(1, Math.floor(12 / (times - 1))) : 24;
}

/**
 * The dose times of a row (HH:MM), or an error when the times don't fit in the day
 * (a dose after midnight belongs to the next day's row).
 */
export function rowSlots(row: Pick<CourseRow, "times" | "every" | "start">): { slots: string[]; error: string | null } {
  const times = posInt(row.times);
  const start = timeToMinutes(row.start);
  if (times === null || times > 24) return { slots: [], error: "Kartai per dieną: 1–24." };
  if (start === null) return { slots: [], error: "Nurodykite pirmo karto laiką." };
  const every = times > 1 ? Number(row.every) : 0;
  if (times > 1 && !(every > 0)) return { slots: [], error: "Nurodykite, kas kiek valandų." };
  const slots: string[] = [];
  for (let i = 0; i < times; i++) {
    const at = start + Math.round(i * every * 60);
    if (at >= 24 * 60) return { slots, error: "Dozės netelpa į dieną — paankstinkite pirmą kartą arba sumažinkite intervalą." };
    slots.push(minutesToTime(at));
  }
  return { slots, error: null };
}

/**
 * Copies the medicine lines onto each course date. Per medicine, its own "kartai per dieną" /
 * "trukmė" (gydymas) win over the planner defaults. Times > 1 also plans the extra doses of day 1
 * (the first dose of day 1 is the treatment itself).
 */
export function generateCourseRows(
  lines: MedLine[],
  startDate: string,
  days: number,
  mode: ScheduleMode,
  interval: number,
  defaults: { times: number; every: number; start: string } = { times: 1, every: 24, start: "08:00" },
): CourseRow[] {
  const usable = lines.filter((l) => l.product_id);
  const step = modeStep(mode, interval);
  const startMin = timeToMinutes(defaults.start) ?? 8 * 60;
  const rows: CourseRow[] = [];
  for (const l of usable) {
    const times = posInt(l.frequency) ?? defaults.times;
    // the planner's interval applies when it was set for this many doses; otherwise spread them over the day
    const every = times === defaults.times ? defaults.every : defaultEveryHours(times);
    const lineDays = posInt(l.days) ?? days;
    const base = { product_id: l.product_id, qty: l.qty, route: l.route, every: String(every) };
    if (times > 1) {
      const first = startMin + Math.round(every * 60);
      if (first < 24 * 60) rows.push({ key: crypto.randomUUID(), date: startDate, ...base, times: String(times - 1), start: minutesToTime(first) });
    }
    for (const date of courseDates(startDate, lineDays, step)) {
      rows.push({ key: crypto.randomUUID(), date, ...base, times: String(times), start: defaults.start });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

/** Day 1 = startDate (extra doses that day); each further distinct date gets the next number. */
export function assignDayNumbers(startDate: string, rows: CourseRow[]): Map<string, number> {
  const dates = Array.from(new Set(rows.map((r) => r.date).filter((d) => d && d > startDate))).sort();
  return new Map<string, number>([[startDate, 1], ...dates.map((d, i) => [d, i + 2] as [string, number])]);
}

/** Problems that block saving the course rows (empty = ok). */
export function courseRowProblems(startDate: string, rows: CourseRow[]): string[] {
  const out: string[] = [];
  if (rows.some((r) => !r.product_id || !(Number(r.qty) > 0) || !r.date)) out.push("Užpildykite visas kurso eilutes (data, produktas, dozė).");
  if (rows.some((r) => r.date && r.date < startDate)) out.push("Kurso dozių datos negali būti ankstesnės už gydymo datą.");
  const slotError = rows.map((r) => rowSlots(r).error).find(Boolean);
  if (slotError) out.push(slotError);
  return out;
}

/** The course as create_treatment() takes it: one entry per dose time (0064 scheduled_time). */
export function courseDaysPayload(startDate: string, rows: CourseRow[], unitOf: (productId: string) => string | null | undefined) {
  const dayNumbers = assignDayNumbers(startDate, rows);
  return [...rows]
    .filter((r) => r.date && r.product_id && Number(r.qty) > 0)
    .flatMap((r) =>
      rowSlots(r).slots.map((t) => ({
        day_number: dayNumbers.get(r.date),
        scheduled_date: r.date,
        scheduled_time: t,
        product_id: r.product_id,
        qty: Number(r.qty),
        unit: unitOf(r.product_id) ?? null,
        administration_route: r.route || null,
      })),
    )
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || a.scheduled_time.localeCompare(b.scheduled_time));
}

// ---------------------------------------------------------------------------
// Plan summary: consumption per product, stock sufficiency, karencija
// ---------------------------------------------------------------------------

export type ProductTotals = {
  product: CatalogProduct;
  now: number;
  later: number;
  total: number;
  /** Doses of this product in the plan, incl. day 1. */
  doses: number;
  /** Day-1 quantity exceeds usable stock — saving would be refused. */
  nowShort: boolean;
  /** Whole course exceeds usable stock (later doses may fail unless restocked). */
  courseShort: boolean;
};

export type PlanSummary = {
  totals: ProductTotals[];
  milkUntil: string | null;
  meatUntil: string | null;
  lastDate: string;
  doseDays: number;
  /** All dose times in the plan, incl. day 1's treatment (= planned visits + 1). */
  doseCount: number;
};

type WithdrawalProduct = Pick<CatalogProduct, "withdrawal_days_milk" | "withdrawal_days_meat"> & Partial<Record<WithdrawalFieldKey, number | null>>;

/**
 * Last karencija day for a dose given on `date`: date + days + 1 (contract formula,
 * mirrors fn_withdrawal_until()). 0 days = no karencija at all, so null.
 */
export function withdrawalUntil(date: string, days: number): string | null {
  return days > 0 ? addDays(date, days + 1) : null;
}

function until(date: string, product: WithdrawalProduct, route: string, kind: "milk" | "meat") {
  return withdrawalUntil(date, getRouteWithdrawalDays(product, (route || null) as AdministrationRoute | null, kind));
}

export function summarizePlan(
  startDate: string,
  lines: MedLine[],
  rows: CourseRow[],
  productById: Map<string, CatalogProduct>,
): PlanSummary {
  const acc = new Map<string, { now: number; later: number; doses: number }>();
  let milk: string | null = null;
  let meat: string | null = null;
  let lastDate = startDate;
  const lastByKey = new Map<string, { date: string; product: CatalogProduct; route: string }>();

  const num = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const bump = (m: string | null, c: string | null) => (c === null ? m : m === null || c > m ? c : m);

  for (const l of lines) {
    const product = productById.get(l.product_id);
    if (!product || num(l.qty) <= 0) continue;
    const e = acc.get(product.id) ?? { now: 0, later: 0, doses: 0 };
    e.now += num(l.qty);
    e.doses += 1;
    acc.set(product.id, e);
    milk = bump(milk, until(startDate, product, l.route, "milk"));
    meat = bump(meat, until(startDate, product, l.route, "meat"));
  }
  for (const r of rows) {
    const product = productById.get(r.product_id);
    const slots = rowSlots(r).slots.length;
    if (!product || num(r.qty) <= 0 || !r.date || slots === 0) continue;
    const e = acc.get(product.id) ?? { now: 0, later: 0, doses: 0 };
    e.later += num(r.qty) * slots;
    e.doses += slots;
    acc.set(product.id, e);
    if (r.date > lastDate) lastDate = r.date;
    const k = `${product.id}|${r.route}`;
    const prev = lastByKey.get(k);
    if (!prev || r.date > prev.date) lastByKey.set(k, { date: r.date, product, route: r.route });
  }
  for (const { date, product, route } of lastByKey.values()) {
    const d = date > startDate ? date : startDate;
    milk = bump(milk, until(d, product, route, "milk"));
    meat = bump(meat, until(d, product, route, "meat"));
  }

  const totals: ProductTotals[] = Array.from(acc.entries()).map(([id, e]) => {
    const product = productById.get(id)!;
    const total = e.now + e.later;
    const stock = product.usable_qty;
    return {
      product,
      now: e.now,
      later: e.later,
      total,
      doses: e.doses,
      nowShort: stock !== null && e.now > stock + 1e-9,
      courseShort: stock !== null && total > stock + 1e-9,
    };
  });

  return {
    totals,
    milkUntil: milk,
    meatUntil: meat,
    lastDate,
    doseDays: new Set(rows.filter((r) => r.date && r.date > startDate).map((r) => r.date)).size + 1,
    doseCount: 1 + new Set(rows.flatMap((r) => (r.date ? rowSlots(r).slots.map((t) => `${r.date} ${t}`) : []))).size,
  };
}

/** Whole days from `from` to `to` (ISO dates), DST-safe. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

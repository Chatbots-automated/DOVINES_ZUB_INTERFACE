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

export type MedLine = { key: string; product_id: string; qty: string; route: string };
export type CourseRow = { key: string; date: string; product_id: string; qty: string; route: string };
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

/** Copies the day-1 medicine lines onto each course date (days 2..N). */
export function generateCourseRows(lines: MedLine[], startDate: string, days: number, mode: ScheduleMode, interval: number): CourseRow[] {
  const usable = lines.filter((l) => l.product_id);
  const dates = courseDates(startDate, days, modeStep(mode, interval));
  const rows: CourseRow[] = [];
  for (const date of dates) {
    for (const l of usable) rows.push({ key: crypto.randomUUID(), date, product_id: l.product_id, qty: l.qty, route: l.route });
  }
  return rows;
}

/** Day 1 = startDate; each further distinct date gets the next number. */
export function assignDayNumbers(startDate: string, rows: CourseRow[]): Map<string, number> {
  const dates = Array.from(new Set(rows.map((r) => r.date).filter((d) => d && d > startDate))).sort();
  return new Map(dates.map((d, i) => [d, i + 2]));
}

// ---------------------------------------------------------------------------
// Plan summary: consumption per product, stock sufficiency, karencija
// ---------------------------------------------------------------------------

export type ProductTotals = {
  product: CatalogProduct;
  now: number;
  later: number;
  total: number;
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
};

type WithdrawalProduct = Pick<CatalogProduct, "withdrawal_days_milk" | "withdrawal_days_meat"> & Partial<Record<WithdrawalFieldKey, number | null>>;

function until(date: string, product: WithdrawalProduct, route: string, kind: "milk" | "meat") {
  return addDays(date, getRouteWithdrawalDays(product, (route || null) as AdministrationRoute | null, kind) + 1);
}

export function summarizePlan(
  startDate: string,
  lines: MedLine[],
  rows: CourseRow[],
  productById: Map<string, CatalogProduct>,
): PlanSummary {
  const acc = new Map<string, { now: number; later: number }>();
  let milk: string | null = null;
  let meat: string | null = null;
  let lastDate = startDate;
  const lastByKey = new Map<string, { date: string; product: CatalogProduct; route: string }>();

  const num = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const bump = (m: string | null, c: string) => (m === null || c > m ? c : m);

  for (const l of lines) {
    const product = productById.get(l.product_id);
    if (!product || num(l.qty) <= 0) continue;
    const e = acc.get(product.id) ?? { now: 0, later: 0 };
    e.now += num(l.qty);
    acc.set(product.id, e);
    milk = bump(milk, until(startDate, product, l.route, "milk"));
    meat = bump(meat, until(startDate, product, l.route, "meat"));
  }
  for (const r of rows) {
    const product = productById.get(r.product_id);
    if (!product || num(r.qty) <= 0 || !r.date) continue;
    const e = acc.get(product.id) ?? { now: 0, later: 0 };
    e.later += num(r.qty);
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
      nowShort: stock !== null && e.now > stock + 1e-9,
      courseShort: stock !== null && total > stock + 1e-9,
    };
  });

  return {
    totals,
    milkUntil: milk,
    meatUntil: meat,
    lastDate,
    doseDays: new Set(rows.filter((r) => r.date).map((r) => r.date)).size + 1,
  };
}

/** Whole days from `from` to `to` (ISO dates), DST-safe. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

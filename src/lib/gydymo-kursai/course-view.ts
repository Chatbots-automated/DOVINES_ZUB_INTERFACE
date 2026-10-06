import type { AdministrationRoute } from "@/lib/supabase/types";

// Plain, serializable view-model of a treatment course for the
// "Gydymo kursai" board (built on the server, filtered in the browser).

export type CourseStatusKey = "overdue" | "today" | "active" | "completed" | "cancelled";

export const COURSE_STATUS_META: Record<CourseStatusKey, { label: string; tone: "danger" | "warning" | "info" | "success" | "neutral" }> = {
  overdue: { label: "Vėluoja", tone: "danger" },
  today: { label: "Šiandien", tone: "warning" },
  active: { label: "Eigoje", tone: "info" },
  completed: { label: "Baigtas", tone: "success" },
  cancelled: { label: "Atšauktas", tone: "neutral" },
};

export type RawDose = {
  id: string;
  day_number: number;
  scheduled_date: string;
  dose_amount: number | null;
  unit: string | null;
  administration_route: AdministrationRoute | null;
  administered: boolean;
  administered_date: string | null;
  product_id: string | null;
  products: { name: string } | null;
};

export type RawCourse = {
  id: string;
  days: number;
  start_date: string;
  status: "active" | "completed" | "cancelled";
  treatments: {
    diagnosis: string | null;
    withdrawal_until_milk: string | null;
    withdrawal_until_meat: string | null;
    animals: { id: string; tag_no: string; animal_no: string | null } | null;
  } | null;
  course_doses: RawDose[];
};

export type DoseView = {
  id: string;
  product: string;
  productId: string | null;
  amount: number | null;
  unit: string | null;
  route: AdministrationRoute | null;
  administered: boolean;
  administeredDate: string | null;
};

export type DayView = {
  day: number;
  date: string;
  doses: DoseView[];
  done: boolean;
  overdue: boolean;
  today: boolean;
};

export type StockWarning = { product: string; need: number; have: number; unit: string | null };

export type CourseView = {
  id: string;
  animalId: string | null;
  animalLabel: string;
  animalSearch: string;
  diagnosis: string | null;
  days: number;
  startDate: string;
  statusKey: CourseStatusKey;
  /** Days fully given, counting day 1 (given when the treatment was saved). */
  doneDays: number;
  nextDate: string | null;
  nextDay: number | null;
  /** Earliest / latest scheduled date among not-yet-given doses (filter range). */
  pendingDates: string[];
  lastDate: string;
  milkUntil: string | null;
  meatUntil: string | null;
  daysView: DayView[];
  stockWarnings: StockWarning[];
};

export function buildCourseViews(
  courses: RawCourse[],
  today: string,
  /** product_id -> usable (non-expired) stock. */
  stock: Map<string, number>,
): CourseView[] {
  return courses.map((c) => {
    const byDay = new Map<number, DayView>();
    for (const d of c.course_doses) {
      const view: DayView = byDay.get(d.day_number) ?? { day: d.day_number, date: d.scheduled_date, doses: [], done: true, overdue: false, today: false };
      view.doses.push({
        id: d.id,
        product: d.products?.name ?? "—",
        productId: d.product_id,
        amount: d.dose_amount,
        unit: d.unit,
        route: d.administration_route,
        administered: d.administered,
        administeredDate: d.administered_date,
      });
      if (d.scheduled_date < view.date) view.date = d.scheduled_date;
      byDay.set(d.day_number, view);
    }
    const daysView = [...byDay.values()].sort((a, b) => a.day - b.day);
    for (const day of daysView) {
      day.done = day.doses.every((x) => x.administered);
      day.overdue = !day.done && day.date < today;
      day.today = !day.done && day.date === today;
    }

    const open = daysView.filter((d) => !d.done);
    let statusKey: CourseStatusKey = "active";
    if (c.status === "cancelled") statusKey = "cancelled";
    else if (c.status === "completed" || open.length === 0) statusKey = "completed";
    else if (open.some((d) => d.overdue)) statusKey = "overdue";
    else if (open.some((d) => d.today)) statusKey = "today";

    // Remaining planned consumption per product vs usable stock.
    const need = new Map<string, { name: string; qty: number; unit: string | null }>();
    if (statusKey !== "completed" && statusKey !== "cancelled") {
      for (const day of open) {
        for (const d of day.doses) {
          if (d.administered || !d.productId || !d.amount) continue;
          const e = need.get(d.productId) ?? { name: d.product, qty: 0, unit: d.unit };
          e.qty += Number(d.amount);
          need.set(d.productId, e);
        }
      }
    }
    const stockWarnings: StockWarning[] = [];
    for (const [pid, e] of need) {
      const have = stock.get(pid) ?? 0;
      if (e.qty > have + 1e-9) stockWarnings.push({ product: e.name, need: e.qty, have, unit: e.unit });
    }

    const animal = c.treatments?.animals ?? null;
    return {
      id: c.id,
      animalId: animal?.id ?? null,
      animalLabel: animal ? (animal.animal_no ? `Nr. ${animal.animal_no}` : animal.tag_no) : "—",
      animalSearch: animal ? `${animal.animal_no ?? ""} ${animal.tag_no}`.toLowerCase() : "",
      diagnosis: c.treatments?.diagnosis ?? null,
      days: c.days,
      startDate: c.start_date,
      statusKey,
      doneDays: (statusKey === "completed" && c.status !== "cancelled" ? c.days : 1 + daysView.filter((d) => d.done).length),
      nextDate: open[0]?.date ?? null,
      nextDay: open[0]?.day ?? null,
      pendingDates: open.map((d) => d.date),
      lastDate: daysView[daysView.length - 1]?.date ?? c.start_date,
      milkUntil: c.treatments?.withdrawal_until_milk ?? null,
      meatUntil: c.treatments?.withdrawal_until_meat ?? null,
      daysView,
      stockWarnings,
    };
  });
}

/** yyyy-mm-dd in the farm's timezone (the server may run in UTC). */
export function farmToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vilnius" }).format(new Date());
}

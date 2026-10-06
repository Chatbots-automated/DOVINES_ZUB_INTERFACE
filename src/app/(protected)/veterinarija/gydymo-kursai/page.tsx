import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { CalendarClock } from "lucide-react";
import { CoursesBoard } from "@/components/gydymo-kursai/courses-board";
import { buildCourseViews, farmToday, type RawCourse } from "@/lib/gydymo-kursai/course-view";

// "Gydymo kursai" (Priedas §2.4): per-animal course progress, today's and
// overdue doses highlighted, "Skirti dozę" per dose / per day.
export default async function GydymoKursaiPage() {
  const supabase = await createClient();
  const today = farmToday();

  const [{ data: courses }, { data: batches }] = await Promise.all([
    supabase
      .from("treatment_courses")
      .select(
        "id, days, start_date, status, treatments(diagnosis, withdrawal_until_milk, withdrawal_until_meat, animals(id, tag_no, animal_no)), course_doses(id, day_number, scheduled_date, product_id, dose_amount, unit, administration_route, administered, administered_date, products(name))",
      )
      .order("start_date", { ascending: false })
      .limit(300),
    supabase.from("batches").select("product_id, qty_left, expiry_date").eq("status", "active").gt("qty_left", 0),
  ]);

  const stock = new Map<string, number>();
  for (const b of batches ?? []) {
    if (b.expiry_date && b.expiry_date < today) continue;
    stock.set(b.product_id, (stock.get(b.product_id) ?? 0) + Number(b.qty_left));
  }

  const views = buildCourseViews((courses ?? []) as unknown as RawCourse[], today, stock);
  // Needs-attention first (overdue, today, running), then finished; newest first inside a group.
  const rank = { overdue: 0, today: 1, active: 2, completed: 3, cancelled: 4 } as const;
  views.sort((a, b) => rank[a.statusKey] - rank[b.statusKey] || (b.startDate > a.startDate ? 1 : -1));

  return (
    <div className="flex flex-col">
      <PageHeader title="Gydymo kursai" description="Kelių dienų gydymų eiga, šiandienos ir pavėluotos dozės." />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        {views.length === 0 ? (
          <EmptyState icon={CalendarClock} title="Gydymo kursų nėra" description="Kursai planuojami kuriant naują gydymo įrašą (skiltis „Kurso planavimas“)." />
        ) : (
          <CoursesBoard courses={views} today={today} />
        )}
      </div>
    </div>
  );
}

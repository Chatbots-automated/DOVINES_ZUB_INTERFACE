"use client";

import * as React from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, Clock, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { AdministerDoseButton } from "@/components/gydymo-kursai/administer-dose-button";
import { COURSE_STATUS_META, type CourseStatusKey, type CourseView, type DayView } from "@/lib/gydymo-kursai/course-view";
import { ADMINISTRATION_ROUTES } from "@/lib/administration-routes";
import { cn, formatDate, formatQty } from "@/lib/utils";

const ROUTE_LABELS: Record<string, string> = Object.fromEntries([...ADMINISTRATION_ROUTES.map((r) => [r.code, r.label]), ["kita", "kita"]]);

type StatusFilter = "all" | "attention" | CourseStatusKey;

const TILES: { key: CourseStatusKey; icon: React.ComponentType<{ className?: string }>; cls: string }[] = [
  { key: "overdue", icon: AlertTriangle, cls: "border-danger/30 bg-danger-soft text-danger" },
  { key: "today", icon: Clock, cls: "border-warning/30 bg-warning-soft text-warning" },
  { key: "active", icon: CalendarClock, cls: "border-info/30 bg-info-soft text-info" },
  { key: "completed", icon: CheckCircle2, cls: "border-success/30 bg-success-soft text-success" },
];

export function CoursesBoard({ courses, today }: { courses: CourseView[]; today: string }) {
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [dueFrom, setDueFrom] = React.useState("");
  const [dueTo, setDueTo] = React.useState("");

  const counts = React.useMemo(() => {
    const c: Record<CourseStatusKey, number> = { overdue: 0, today: 0, active: 0, completed: 0, cancelled: 0 };
    for (const course of courses) c[course.statusKey]++;
    return c;
  }, [courses]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return courses.filter((c) => {
      if (q && !c.animalSearch.includes(q) && !(c.diagnosis ?? "").toLowerCase().includes(q)) return false;
      if (status === "attention" ? c.statusKey !== "overdue" && c.statusKey !== "today" : status !== "all" && c.statusKey !== status) return false;
      if (dueFrom || dueTo) {
        // Has a not-yet-given dose scheduled inside the chosen window.
        if (!c.pendingDates.some((d) => (!dueFrom || d >= dueFrom) && (!dueTo || d <= dueTo))) return false;
      }
      return true;
    });
  }, [courses, search, status, dueFrom, dueTo]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TILES.map(({ key, icon: Icon, cls }) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatus(status === key ? "all" : key)}
            className={cn(
              "flex items-center justify-between rounded-panel border px-4 py-3 text-left transition-shadow",
              cls,
              status === key && "ring-2 ring-current",
            )}
          >
            <span>
              <span className="block text-[12px] font-semibold uppercase tracking-wide">{COURSE_STATUS_META[key].label}</span>
              <span className="block text-[26px] font-bold leading-none tabular-nums">{counts[key]}</span>
            </span>
            <Icon className="size-6 opacity-70" />
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ieškoti pagal gyvūną ar diagnozę..." className="pl-8" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="w-auto">
          <option value="all">Visos būsenos</option>
          <option value="attention">Reikia dėmesio (vėluoja + šiandien)</option>
          {(Object.keys(COURSE_STATUS_META) as CourseStatusKey[]).map((k) => (
            <option key={k} value={k}>
              {COURSE_STATUS_META[k].label}
            </option>
          ))}
        </Select>
        <span className="text-[12px] text-text-muted">Dozė nuo</span>
        <Input type="date" value={dueFrom} onChange={(e) => setDueFrom(e.target.value)} className="w-auto" />
        <span className="text-[12px] text-text-muted">iki</span>
        <Input type="date" value={dueTo} onChange={(e) => setDueTo(e.target.value)} className="w-auto" />
        <span className="text-[12px] text-text-muted">
          {filtered.length} / {courses.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Kursų nerasta" description="Pakeiskite filtrus arba sukurkite naują gydymą su kursu." />
      ) : (
        <div className="space-y-4">
          {filtered.map((course) => (
            <CourseCard key={course.id} course={course} today={today} />
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_BAR: Record<CourseStatusKey, string> = {
  overdue: "bg-danger",
  today: "bg-warning",
  active: "bg-info",
  completed: "bg-success",
  cancelled: "bg-border-strong",
};
const STATUS_EDGE: Record<CourseStatusKey, string> = {
  overdue: "border-l-danger",
  today: "border-l-warning",
  active: "border-l-info",
  completed: "border-l-success",
  cancelled: "border-l-border-strong",
};

function CourseCard({ course, today }: { course: CourseView; today: string }) {
  const meta = COURSE_STATUS_META[course.statusKey];
  const finished = course.statusKey === "completed" || course.statusKey === "cancelled";
  const [expanded, setExpanded] = React.useState(!finished);
  const pct = Math.min(100, Math.round((course.doneDays / Math.max(1, course.days)) * 100));
  const milkActive = !!course.milkUntil && course.milkUntil >= today;
  const meatActive = !!course.meatUntil && course.meatUntil >= today;

  return (
    <Card className={cn("overflow-hidden border-l-4", STATUS_EDGE[course.statusKey])}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[16px] font-semibold text-text-primary">{course.animalLabel}</h3>
            <Badge tone={meta.tone}>{meta.label}</Badge>
            {course.diagnosis && <span className="text-[13px] text-text-muted">{course.diagnosis}</span>}
          </div>
          <p className="mt-1 text-[12.5px] text-text-secondary">
            {course.days} d. kursas nuo {formatDate(course.startDate)} iki {formatDate(course.lastDate)}
            {course.nextDate && course.nextDay && !finished && (
              <>
                {" "}
                · eilinė: <span className="font-semibold text-text-primary">{course.nextDay} diena, {formatDate(course.nextDate)}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {course.milkUntil && <Badge tone={milkActive ? "warning" : "neutral"}>🥛 iki {formatDate(course.milkUntil)}</Badge>}
          {course.meatUntil && <Badge tone={meatActive ? "danger" : "neutral"}>🥩 iki {formatDate(course.meatUntil)}</Badge>}
        </div>
      </div>

      <div className="px-5 pb-4">
        <div className="mb-1 flex items-center justify-between text-[12px] text-text-secondary">
          <span>
            Pažanga: <span className="font-semibold text-text-primary">{course.doneDays}/{course.days} d.</span>
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-secondary">
          <div className={cn("h-full rounded-full transition-all", STATUS_BAR[course.statusKey])} style={{ width: `${pct}%` }} />
        </div>
        {course.stockWarnings.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {course.stockWarnings.map((w) => (
              <Badge key={w.product} tone="danger">
                <AlertTriangle className="size-3" /> Trūksta atsargų: {w.product} (reikia {formatQty(w.need, w.unit)}, yra {formatQty(w.have, w.unit)})
              </Badge>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between border-t border-border bg-surface-secondary/60 px-5 py-2 text-[12px] font-semibold text-text-secondary hover:bg-surface-secondary"
      >
        <span>{expanded ? "Slėpti dienas" : `Rodyti dienas (${course.daysView.length})`}</span>
        <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
      </button>

      {expanded && (
        <div className="divide-y divide-border">
          <div className="flex items-center gap-3 px-5 py-2.5">
            <Badge tone="success">Diena 1</Badge>
            <span className="text-[13px] text-text-secondary">{formatDate(course.startDate)} · suteikta išsaugant gydymą</span>
          </div>
          {course.daysView.map((day) => (
            <DayRow key={day.day} day={day} cancelled={course.statusKey === "cancelled"} />
          ))}
        </div>
      )}
    </Card>
  );
}

function DayRow({ day, cancelled }: { day: DayView; cancelled: boolean }) {
  const open = day.doses.filter((d) => !d.administered);
  const urgent = day.overdue || day.today;
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 px-5 py-3", day.overdue && "bg-danger-soft/60", day.today && "bg-warning-soft/70")}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={day.done ? "success" : day.overdue ? "danger" : day.today ? "warning" : "neutral"}>Diena {day.day}</Badge>
          <span className="text-[13px] font-medium text-text-primary">{formatDate(day.date)}</span>
          {day.overdue && <Badge tone="danger">Vėluoja</Badge>}
          {day.today && <Badge tone="warning">Šiandien</Badge>}
        </div>
        <ul className="space-y-0.5">
          {day.doses.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-text-secondary">
              <span className={cn("font-medium", d.administered ? "text-text-muted line-through decoration-1" : "text-text-primary")}>{d.product}</span>
              <span>{formatQty(d.amount, d.unit)}</span>
              {d.route && <span className="text-text-muted">· {ROUTE_LABELS[d.route] ?? d.route}</span>}
              {d.administered && <Badge tone="success">Suteikta {formatDate(d.administeredDate)}</Badge>}
            </li>
          ))}
        </ul>
      </div>
      {!cancelled &&
        open.length > 0 &&
        (open.length === 1 ? (
          <AdministerDoseButton doseId={open[0].id} variant={urgent ? "primary" : "outline"} />
        ) : (
          <AdministerDoseButton doseIds={open.map((d) => d.id)} label={`Skirti visas (${open.length})`} variant={urgent ? "primary" : "outline"} />
        ))}
    </div>
  );
}

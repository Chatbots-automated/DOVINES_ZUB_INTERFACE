"use client";

import * as React from "react";
import { CalendarClock, Download, Search } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { downloadCsv } from "@/lib/export";
import { formatDate, formatDateTime } from "@/lib/utils";
import { VisitCard, type VisitCardData } from "@/components/vizitai/visit-card";
import type { Product } from "@/components/gyvunai/new-treatment-dialog";
import {
  OPEN_VISIT_STATUSES,
  VISIT_PROCEDURE_LABELS,
  VISIT_PROCEDURE_OPTIONS,
  VISIT_STATUS_LABELS,
  addDays,
  vilniusDay,
} from "@/lib/visits";
import type { VisitProcedure, VisitStatus } from "@/lib/supabase/types";

type Props = {
  visits: VisitCardData[];
  today: string;
  diseases: { id: string; name: string }[];
  treatmentProducts: Product[];
  vaccineProducts: Product[];
  currentVetName: string | null;
  canWrite: boolean;
};

type Section = { key: string; title: string; visits: VisitCardData[]; collapsed?: boolean };

// Vizitai calendar-style board: open visits bucketed by when they fall
// (praleisti / šiandien / rytoj / ši savaitė / vėliau), finished and past
// ones below. Filtering is client-side over the fetched window.
export function VisitsBoard({ visits, today, ...cardProps }: Props) {
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<VisitStatus | "all">("all");
  const [procedure, setProcedure] = React.useState<VisitProcedure | "all">("all");
  const [vet, setVet] = React.useState("all");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [showPast, setShowPast] = React.useState(false);

  const vets = React.useMemo(() => Array.from(new Set(visits.map((v) => v.vet_name).filter((v): v is string => !!v))).sort(), [visits]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return visits.filter((v) => {
      const day = vilniusDay(v.visit_datetime);
      if (status !== "all" && v.status !== status) return false;
      if (procedure !== "all" && !v.procedures.includes(procedure)) return false;
      if (vet !== "all" && v.vet_name !== vet) return false;
      if (dateFrom && day < dateFrom) return false;
      if (dateTo && day > dateTo) return false;
      if (term) {
        const hay = [v.animal_no, v.tag_no, v.group_name, v.notes, v.vet_name].join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [visits, search, status, procedure, vet, dateFrom, dateTo]);

  const sections = React.useMemo<Section[]>(() => {
    const tomorrow = addDays(today, 1);
    const weekEnd = addDays(today, 7);
    const asc = (a: VisitCardData, b: VisitCardData) => (a.visit_datetime < b.visit_datetime ? -1 : 1);
    const desc = (a: VisitCardData, b: VisitCardData) => -asc(a, b);
    const open = filtered.filter((v) => OPEN_VISIT_STATUSES.includes(v.status));
    const rest = filtered.filter((v) => !OPEN_VISIT_STATUSES.includes(v.status));
    const day = (v: VisitCardData) => vilniusDay(v.visit_datetime);
    return [
      { key: "overdue", title: "Praleisti", visits: open.filter((v) => day(v) < today).sort(asc) },
      { key: "today", title: "Šiandien", visits: open.filter((v) => day(v) === today).sort(asc) },
      { key: "tomorrow", title: "Rytoj", visits: open.filter((v) => day(v) === tomorrow).sort(asc) },
      { key: "week", title: "Per artimiausias 7 dienas", visits: open.filter((v) => day(v) > tomorrow && day(v) <= weekEnd).sort(asc) },
      { key: "later", title: "Vėliau", visits: open.filter((v) => day(v) > weekEnd).sort(asc) },
      { key: "history", title: "Atlikti, atšaukti ir ankstesni", visits: rest.sort(desc), collapsed: true },
    ].filter((s) => s.visits.length > 0);
  }, [filtered, today]);

  function exportCsv() {
    downloadCsv(
      `vizitai_${today}`,
      ["Data", "Nr.", "Ausies įsaga", "Grupė", "Būsena", "Procedūros", "Gydytojas", "Temperatūra", "Įrašai", "Kitas vizitas", "Pastabos"],
      filtered.map((v) => [
        formatDateTime(v.visit_datetime),
        v.animal_no ?? "",
        v.tag_no,
        v.group_name ?? "",
        VISIT_STATUS_LABELS[v.status],
        v.procedures.map((p) => VISIT_PROCEDURE_LABELS[p]).join(", "),
        v.vet_name ?? "",
        v.temperature != null ? String(v.temperature) : "",
        v.records.map((r) => `${r.label}${r.detail ? ` (${r.detail})` : ""}`).join("; "),
        v.next_visit_date ? formatDate(v.next_visit_date) : "",
        v.notes ?? "",
      ]),
    );
  }

  const openCount = visits.filter((v) => OPEN_VISIT_STATUSES.includes(v.status)).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ieškoti pagal gyvūną, grupę, gydytoją, pastabas..." className="pl-8" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value as VisitStatus | "all")} className="w-auto" aria-label="Būsena">
          <option value="all">Visos būsenos</option>
          {Object.entries(VISIT_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select value={procedure} onChange={(e) => setProcedure(e.target.value as VisitProcedure | "all")} className="w-auto" aria-label="Procedūra">
          <option value="all">Visos procedūros</option>
          {VISIT_PROCEDURE_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
        {vets.length > 0 && (
          <Select value={vet} onChange={(e) => setVet(e.target.value)} className="w-auto" aria-label="Gydytojas">
            <option value="all">Visi gydytojai</option>
            {vets.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        )}
        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" aria-label="Nuo" />
        <span className="text-[13px] text-text-muted">—</span>
        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" aria-label="Iki" />
        <span className="text-[12px] text-text-muted">
          {filtered.length} / {visits.length} · neužbaigta: {openCount}
        </span>
        {filtered.length > 0 && (
          <Button type="button" size="sm" variant="success" className="ml-auto" onClick={exportCsv}>
            <Download className="size-4" /> CSV
          </Button>
        )}
      </div>

      {sections.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Vizitų nerasta" description="Pakeiskite filtrus arba sukurkite naują vizitą." />
      ) : (
        sections.map((s) => (
          <div key={s.key}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className={`text-[14px] font-bold ${s.key === "overdue" ? "text-danger" : "text-text-primary"}`}>
                {s.title} <span className="font-medium text-text-muted">({s.visits.length})</span>
              </h2>
              {s.collapsed && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setShowPast((p) => !p)}>
                  {showPast ? "Slėpti" : "Rodyti"}
                </Button>
              )}
            </div>
            {(!s.collapsed || showPast) && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {s.visits.map((v) => (
                  <VisitCard key={v.id} visit={v} today={today} {...cardProps} />
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

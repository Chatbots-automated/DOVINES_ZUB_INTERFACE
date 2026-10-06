"use client";

import * as React from "react";
import { Download, Printer, Search } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { downloadCsv, printDocument } from "@/lib/export";
import { EmptyState } from "@/components/ui/empty-state";
import { BarChart3 } from "lucide-react";
import { FARM_NAME } from "@/lib/brand";
import { formatDate, formatEur, formatQty } from "@/lib/utils";

// Declarative formatting instead of a `render` callback: JournalTable is a
// Client Component, and every caller here is a Server Component page — a
// function prop can't cross that boundary (React errors on it), so the
// server side only ever hands over plain, serializable column config and
// this component does the actual formatting itself.
export interface JournalColumn {
  key: string;
  label: string;
  format?: "date" | "eur" | "boolean";
  /** format: "qty" pairs `key` (the amount) with the column holding its unit. */
  qtyUnitKey?: string;
}

function formatCell(row: Record<string, unknown>, column: JournalColumn): string {
  const value = row[column.key];
  if (column.qtyUnitKey) return formatQty(value as number | null, row[column.qtyUnitKey] as string | null);
  switch (column.format) {
    case "date":
      return formatDate(value as string | null);
    case "eur":
      return formatEur(value as number | null);
    case "boolean":
      return value ? "Taip" : "Ne";
    default:
      return String(value ?? "—");
  }
}

/** Optional per-column filter: a dropdown of the distinct values, or a type-ahead text box. */
export interface JournalColumnFilter {
  key: string;
  label: string;
  kind?: "select" | "combo";
}

/**
 * Journal table with client-side search + optional date-range filter
 * (Priedas §2.10), plus print/PDF and CSV export of exactly the filtered
 * rows (Priedas §2.8 — the journal "formed" for a chosen period).
 * Filtering in the browser keeps this a plain server-fetched page; only
 * this leaf component is a client component.
 */
export function JournalTable({
  columns,
  rows,
  dateField,
  searchPlaceholder = "Paieška...",
  title,
  columnFilters,
}: {
  columns: JournalColumn[];
  rows: Record<string, unknown>[];
  dateField?: string;
  searchPlaceholder?: string;
  /** Document title for print/CSV; export buttons are hidden without it. */
  title?: string;
  columnFilters?: JournalColumnFilter[];
}) {
  const [search, setSearch] = React.useState("");
  const [colFilters, setColFilters] = React.useState<Record<string, string>>({});
  const distinct = React.useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const f of columnFilters ?? []) {
      out[f.key] = Array.from(new Set(rows.map((r) => String(r[f.key] ?? "")).filter(Boolean))).sort((a, b) => a.localeCompare(b, "lt", { numeric: true }));
    }
    return out;
  }, [rows, columnFilters]);
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");

  const filtered = React.useMemo(() => {
    return rows.filter((row) => {
      if (dateField) {
        const raw = row[dateField];
        const value = typeof raw === "string" ? raw.slice(0, 10) : null;
        if (dateFrom && (!value || value < dateFrom)) return false;
        if (dateTo && (!value || value > dateTo)) return false;
      }
      for (const f of columnFilters ?? []) {
        const want = colFilters[f.key]?.trim().toLowerCase();
        if (!want) continue;
        const have = String(row[f.key] ?? "").toLowerCase();
        if (f.kind === "combo" ? !have.includes(want) : have !== want) return false;
      }
      if (!search.trim()) return true;
      const term = search.trim().toLowerCase();
      return columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(term));
    });
  }, [rows, search, dateFrom, dateTo, dateField, columns, columnFilters, colFilters]);

  function exportRows(kind: "csv" | "print") {
    if (!title) return;
    const headers = columns.map((c) => c.label);
    const data = filtered.map((row) => columns.map((c) => formatCell(row, c)));
    const period = dateFrom || dateTo ? `Laikotarpis: ${dateFrom ? formatDate(dateFrom) : "…"} – ${dateTo ? formatDate(dateTo) : "…"}` : undefined;
    if (kind === "csv") {
      const stamp = new Date().toISOString().slice(0, 10);
      downloadCsv(`${title.replace(/\s+/g, "_")}_${stamp}`, headers, data);
    } else {
      printDocument({ title, subtitle: period, headers, rows: data });
    }
  }

  const isNumeric = (c: JournalColumn) => !!c.qtyUnitKey || c.format === "eur";
  const period =
    dateFrom || dateTo ? `Laikotarpis: ${dateFrom ? formatDate(dateFrom) : "…"} – ${dateTo ? formatDate(dateTo) : "…"}` : "Visi įrašai";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="pl-8"
          />
        </div>
        {(columnFilters ?? []).map((f) =>
          f.kind === "combo" ? (
            <React.Fragment key={f.key}>
              <Input
                list={`jt-${f.key}`}
                value={colFilters[f.key] ?? ""}
                onChange={(e) => setColFilters((p) => ({ ...p, [f.key]: e.target.value }))}
                placeholder={f.label}
                className="w-40"
              />
              <datalist id={`jt-${f.key}`}>
                {distinct[f.key]?.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </React.Fragment>
          ) : (
            <Select key={f.key} value={colFilters[f.key] ?? ""} onChange={(e) => setColFilters((p) => ({ ...p, [f.key]: e.target.value }))} className="w-auto max-w-[200px]">
              <option value="">{f.label}: visi</option>
              {distinct[f.key]?.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          ),
        )}
        {dateField && (
          <>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" />
            <span className="text-[13px] text-text-muted">—</span>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" />
          </>
        )}
        <span className="text-[12px] text-text-muted">{filtered.length} / {rows.length} įrašų</span>
        {title && filtered.length > 0 && (
          <div className="ml-auto flex gap-2">
            <Button type="button" size="sm" variant="success" onClick={() => exportRows("csv")}>
              <Download className="size-4" /> CSV
            </Button>
            <Button type="button" size="sm" variant="danger" onClick={() => exportRows("print")}>
              <Printer className="size-4" /> Spausdinti / PDF
            </Button>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={BarChart3} title="Įrašų nėra" className="py-10" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-border-strong bg-white shadow-sm">
          <div className="min-w-[760px] p-5 text-black">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-gray-700">{FARM_NAME}</p>
            {title && <h3 className="mt-2 text-center text-[15px] font-bold uppercase leading-snug">{title}</h3>}
            <p className="mb-4 mt-1 text-center text-[12px] text-gray-600">{period}</p>
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="bg-gray-100">
                  <th className="w-12 border border-gray-500 px-2 py-2 text-center font-bold">Eil. Nr.</th>
                  {columns.map((c) => (
                    <th key={c.key} className="border border-gray-500 px-2 py-2 text-center font-bold">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, i) => (
                  <tr key={i} className={i % 2 === 1 ? "bg-gray-50" : ""}>
                    <td className="border border-gray-400 px-2 py-1.5 text-center tabular-nums text-gray-600">{i + 1}</td>
                    {columns.map((c) => (
                      <td key={c.key} className={`border border-gray-400 px-2 py-1.5 align-top ${isNumeric(c) ? "text-right tabular-nums" : ""}`}>
                        {formatCell(row, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-8 grid grid-cols-3 gap-10 text-center text-[11px] text-gray-600">
              <div className="border-t border-gray-500 pt-1">Atsakingas asmuo</div>
              <div className="border-t border-gray-500 pt-1">Parašas</div>
              <div className="border-t border-gray-500 pt-1">Data</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

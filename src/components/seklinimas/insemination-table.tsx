"use client";

import * as React from "react";
import { Download, Search } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Dna } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { expectedCalvingDate, pregnancyStatus, type InseminationRow } from "@/lib/seklinimas";
import { DeleteInseminationButton, PregnancyActions } from "./row-actions";

type StatusFilter = "" | "pending" | "confirmed" | "not_confirmed";

function animalName(r: InseminationRow) {
  return r.animals ? (r.animals.animal_no ? `Nr. ${r.animals.animal_no}` : r.animals.tag_no) : (r.karves_id ?? "—");
}

// VIC (ise.vic.lt) compares the first line byte-for-byte with its template:
// exactly this header, no "sep=;" line and no BOM (same as Monika's export).
const VIC_HEADER = "pazymejimo_nr;seklintojo_kodas;seklinimo_data;karves_ID;imones_kodas;reproduktoriaus_ID;reproduktoriaus_kk_kodas;sp_savininkas";

function csvCell(v: string | null | undefined) {
  const s = v ?? "";
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function InseminationTable({ rows }: { rows: InseminationRow[] }) {
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      const d = r.insemination_date.slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (status && pregnancyStatus(r.pregnancy_confirmed) !== status) return false;
      if (!term) return true;
      return [
        r.animals?.tag_no, r.animals?.animal_no, r.karves_id, r.pazymejimo_nr, r.seklintojo_kodas, r.inseminator_name,
        r.bull_name, r.reproduktoriaus_id, r.sperm?.name, r.sp_savininkas, r.imones_kodas, r.notes,
      ].some((v) => (v ?? "").toLowerCase().includes(term));
    });
  }, [rows, search, status, from, to]);

  function exportCsv() {
    const lines = filtered
      .slice()
      .sort((a, b) => a.insemination_date.localeCompare(b.insemination_date))
      .map((r) =>
        [
          r.pazymejimo_nr, r.seklintojo_kodas, r.insemination_date.slice(0, 10),
          // official ear tag of the cow (what VIC expects), snapshot as fallback
          r.animals?.tag_no ?? r.karves_id, r.imones_kodas, r.reproduktoriaus_id, r.reproduktoriaus_kk_kodas, r.sp_savininkas,
        ]
          .map(csvCell)
          .join(";"),
      );
    const blob = new Blob([[VIC_HEADER, ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `seklinimo_zurnalas_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ieškoti pagal gyvūną, įsagą, pažymėjimo Nr., bulių, sėklintoją..." className="pl-8" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="w-auto">
          <option value="">Visi nėštumo statusai</option>
          <option value="pending">Laukiama</option>
          <option value="confirmed">Patvirtinta</option>
          <option value="not_confirmed">Nepatvirtinta</option>
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" />
        <span className="text-[13px] text-text-muted">—</span>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" />
        <span className="text-[12px] text-text-muted">{filtered.length} / {rows.length} įrašų</span>
        {filtered.length > 0 && (
          <Button type="button" size="sm" variant="success" className="ml-auto" onClick={exportCsv} title="Atsisiųsti VIC žurnalo CSV (pagal filtrus)">
            <Download className="size-4" /> CSV (VIC)
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Dna} title="Sėklinimo įrašų nėra" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-border bg-surface">
          <table className="w-full min-w-[1100px] text-left text-[14px]">
            <thead className="border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-4 py-3 font-medium">Data</th>
                <th className="px-4 py-3 font-medium">Pažymėjimo Nr.</th>
                <th className="px-4 py-3 font-medium">Gyvūnas</th>
                <th className="px-4 py-3 font-medium">Sėklintojas</th>
                <th className="px-4 py-3 font-medium">Bulius / sperma</th>
                <th className="px-4 py-3 font-medium">Nėštumo patikra</th>
                <th className="px-4 py-3 font-medium">Nėštumas</th>
                <th className="px-4 py-3 font-medium">Apsiveršiavimas</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3 text-text-secondary">{formatDate(r.insemination_date)}</td>
                  <td className="px-4 py-3 font-mono text-[13px] text-text-secondary">{r.pazymejimo_nr ?? "—"}</td>
                  <td className="px-4 py-3 font-medium text-text-primary">
                    {animalName(r)}
                    {r.animals?.animal_no && <span className="block text-[12px] font-normal text-text-muted">{r.animals.tag_no}</span>}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {r.inseminator_name ?? "—"}
                    {r.seklintojo_kodas && <span className="block text-[12px] text-text-muted">{r.seklintojo_kodas}</span>}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {r.sperm?.name ?? r.bull_name ?? "—"}
                    {r.sperm && r.sperm_quantity ? <span className="text-text-muted"> · {r.sperm_quantity} d.</span> : null}
                    {r.reproduktoriaus_id && <span className="block text-[12px] text-text-muted">KK Nr. {r.reproduktoriaus_id}</span>}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {formatDate(r.pregnancy_check_date ?? r.next_pregnancy_check_date)}
                    {r.pregnancy_check_date ? null : r.next_pregnancy_check_date && <span className="block text-[12px] text-text-muted">planuojama</span>}
                  </td>
                  <td className="px-4 py-3">
                    <PregnancyActions id={r.id} confirmed={r.pregnancy_confirmed} />
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {r.pregnancy_confirmed === false ? "—" : formatDate(expectedCalvingDate(r.insemination_date))}
                    {r.pregnancy_confirmed === null && <span className="block text-[12px] text-text-muted">preliminari</span>}
                  </td>
                  <td className="px-4 py-3">
                    <DeleteInseminationButton id={r.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

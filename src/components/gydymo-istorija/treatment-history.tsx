"use client";

import * as React from "react";
import { Download, History, Search } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { TreatmentCard } from "@/components/gydymo-istorija/treatment-card";
import { downloadCsv } from "@/lib/export";
import { TREATMENT_TYPE_LABELS } from "@/lib/visits";
import { formatDate, formatQty } from "@/lib/utils";
import type { TreatmentHistoryCard } from "@/lib/treatment-history";
import type { ProcedureType } from "@/lib/supabase/types";

const PAGE = 30;
const MONTH = new Intl.DateTimeFormat("lt-LT", { year: "numeric", month: "long" });

const distinct = (values: (string | null)[]) => Array.from(new Set(values.filter((v): v is string => !!v))).sort((a, b) => a.localeCompare(b, "lt"));
const monthKey = (d: string) => d.slice(0, 7);

// Gydymų istorija (Priedas §2.10 "paieška, filtrai ir istorija"): one card per
// treatment, filtered in the browser over the fetched window, month by month,
// "Rodyti daugiau" instead of rendering thousands of cards at once.
export function TreatmentHistory({ cards, today }: { cards: TreatmentHistoryCard[]; today: string }) {
  const [search, setSearch] = React.useState("");
  const [type, setType] = React.useState<ProcedureType | "all">("all");
  const [product, setProduct] = React.useState("all");
  const [disease, setDisease] = React.useState("all");
  const [group, setGroup] = React.useState("all");
  const [vet, setVet] = React.useState("all");
  const [activeOnly, setActiveOnly] = React.useState(false);
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [limit, setLimit] = React.useState(PAGE);

  const products = React.useMemo(() => distinct(cards.flatMap((c) => c.lines.map((l) => l.product))), [cards]);
  const diseases = React.useMemo(() => distinct(cards.map((c) => c.disease)), [cards]);
  const groups = React.useMemo(() => distinct(cards.map((c) => c.group)), [cards]);
  const vets = React.useMemo(() => distinct(cards.map((c) => c.vet)), [cards]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return cards.filter((c) => {
      if (type !== "all" && c.procedureType !== type) return false;
      if (product !== "all" && !c.lines.some((l) => l.product === product)) return false;
      if (disease !== "all" && c.disease !== disease) return false;
      if (group !== "all" && c.group !== group) return false;
      if (vet !== "all" && c.vet !== vet) return false;
      if (activeOnly && !((c.milkUntil && c.milkUntil >= today) || (c.meatUntil && c.meatUntil >= today))) return false;
      if (dateFrom && c.regDate < dateFrom) return false;
      if (dateTo && c.regDate > dateTo) return false;
      if (term) {
        const hay = [c.animalNo, c.tagNo, c.group, c.disease, c.diagnosis, c.vet, c.outcome, ...c.lines.map((l) => l.product)].join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [cards, search, type, product, disease, group, vet, activeOnly, dateFrom, dateTo, today]);

  // Back to the first page whenever the filters change.
  const signature = [search, type, product, disease, group, vet, activeOnly, dateFrom, dateTo].join("|");
  const [seenSignature, setSeenSignature] = React.useState(signature);
  if (signature !== seenSignature) {
    setSeenSignature(signature);
    setLimit(PAGE);
  }

  const shown = filtered.slice(0, limit);
  const months = React.useMemo(() => {
    const out: { key: string; title: string; cards: TreatmentHistoryCard[] }[] = [];
    for (const c of shown) {
      const key = monthKey(c.regDate);
      const last = out[out.length - 1];
      if (last?.key === key) last.cards.push(c);
      else out.push({ key, title: MONTH.format(new Date(`${key}-15T12:00:00Z`)), cards: [c] });
    }
    return out;
  }, [shown]);

  function exportCsv() {
    const rows: string[][] = [];
    for (const c of filtered) {
      const base = [formatDate(c.regDate), c.animalNo ?? "", c.tagNo, c.group ?? "", TREATMENT_TYPE_LABELS[c.procedureType], c.disease ?? "", c.diagnosis ?? ""];
      const tail = [formatDate(c.milkUntil), formatDate(c.meatUntil), c.outcome ?? "", c.vet ?? ""].map((v) => (v === "—" ? "" : v));
      if (c.lines.length === 0) rows.push([...base, "", "", "", ...tail]);
      for (const l of c.lines) rows.push([...base, l.product, l.qty != null ? formatQty(l.qty, l.unit) : "", l.route ?? "", ...tail]);
    }
    downloadCsv(
      `gydymu_istorija_${today}`,
      ["Data", "Nr.", "Ausies įsaga", "Grupė", "Tipas", "Liga", "Diagnozė", "Produktas", "Kiekis", "Būdas", "Pieno karencija iki", "Mėsos karencija iki", "Baigtis", "Gydytojas"],
      rows,
    );
  }

  const filtersActive = signature !== "|all|all|all|all|all|false||";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ieškoti pagal gyvūno Nr., įsagą, diagnozę, produktą, gydytoją..." className="pl-8" />
        </div>
        <Select value={type} onChange={(e) => setType(e.target.value as ProcedureType | "all")} className="w-auto" aria-label="Tipas">
          <option value="all">Visi tipai</option>
          {(Object.keys(TREATMENT_TYPE_LABELS) as ProcedureType[]).map((t) => (
            <option key={t} value={t}>
              {TREATMENT_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
        <FilterSelect label="Visi produktai" value={product} onChange={setProduct} options={products} />
        <FilterSelect label="Visos ligos" value={disease} onChange={setDisease} options={diseases} />
        <FilterSelect label="Visos grupės" value={group} onChange={setGroup} options={groups} />
        <FilterSelect label="Visi gydytojai" value={vet} onChange={setVet} options={vets} />
        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" aria-label="Nuo" />
        <span className="text-[13px] text-text-muted">—</span>
        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" aria-label="Iki" />
        <label className="flex items-center gap-1.5 text-[13px] font-medium">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="size-4 rounded border-border-strong" />
          Karencija aktyvi
        </label>
        <span className="text-[12px] text-text-muted">
          {filtered.length} / {cards.length}
        </span>
        {filtersActive && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearch("");
              setType("all");
              setProduct("all");
              setDisease("all");
              setGroup("all");
              setVet("all");
              setActiveOnly(false);
              setDateFrom("");
              setDateTo("");
            }}
          >
            Išvalyti
          </Button>
        )}
        {filtered.length > 0 && (
          <Button type="button" size="sm" variant="success" className="ml-auto" onClick={exportCsv}>
            <Download className="size-4" /> CSV
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={History} title="Gydymų nerasta" description="Pakeiskite filtrus arba paiešką." />
      ) : (
        <>
          {months.map((m) => (
            <section key={m.key}>
              <h2 className="mb-3 text-[14px] font-bold capitalize text-text-primary">
                {m.title} <span className="font-medium text-text-muted">({m.cards.length})</span>
              </h2>
              <div className="grid gap-3 xl:grid-cols-2">
                {m.cards.map((c) => (
                  <TreatmentCard key={c.id} card={c} today={today} />
                ))}
              </div>
            </section>
          ))}
          {limit < filtered.length && (
            <div className="flex justify-center">
              <Button type="button" variant="outline" onClick={() => setLimit((l) => l + PAGE)}>
                Rodyti daugiau ({filtered.length - limit})
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  if (options.length === 0) return null;
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-auto max-w-[200px]" aria-label={label}>
      <option value="all">{label}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </Select>
  );
}

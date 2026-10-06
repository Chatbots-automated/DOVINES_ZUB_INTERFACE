"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, Download, Search, Syringe, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { downloadCsv } from "@/lib/export";
import { rowAnimalLabel, rowGroupLabel, type VaccRow } from "@/lib/vaccinations";
import { ADMINISTRATION_ROUTES } from "@/lib/administration-routes";
import { formatDate, formatQty } from "@/lib/utils";

type Entry = { key: string; first: VaccRow; rows: VaccRow[] };

const PAGE = 100;
const routeLabel = (c: string | null) => (c ? (ADMINISTRATION_ROUTES.find((r) => r.code === c)?.label ?? c) : "");

// A group/bulk vaccination is N rows sharing a session_id — one line here,
// expandable to the individual animals (each keeps its own karencija).
export function VaccinationHistory({
  vaccinations,
  productNames,
  groups,
}: {
  vaccinations: VaccRow[];
  productNames: Record<string, string>;
  groups: string[];
}) {
  const [q, setQ] = React.useState("");
  const [product, setProduct] = React.useState("");
  const [group, setGroup] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [limit, setLimit] = React.useState(PAGE);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const dq = React.useDeferredValue(q);

  const productOptions = React.useMemo(() => {
    const ids = new Set(vaccinations.map((v) => v.product_id));
    return [...ids].map((id) => ({ id, name: productNames[id] ?? "—" })).sort((a, b) => a.name.localeCompare(b.name));
  }, [vaccinations, productNames]);

  const filteredRows = React.useMemo(() => {
    const tokens = dq
      .toLowerCase()
      .split(/[\s,;]+/)
      .filter(Boolean);
    return vaccinations.filter((v) => {
      if (product && v.product_id !== product) return false;
      if (group && rowGroupLabel(v) !== group && v.animal_group_snapshot !== group) return false;
      if (from && v.vaccination_date < from) return false;
      if (to && v.vaccination_date > to) return false;
      if (tokens.length) {
        const no = v.animals?.animal_no?.toLowerCase() ?? "";
        const tag = v.animals?.tag_no.toLowerCase() ?? "";
        if (!tokens.some((t) => no.includes(t) || tag.includes(t))) return false;
      }
      return true;
    });
  }, [vaccinations, dq, product, group, from, to]);

  const entries = React.useMemo(() => {
    const m = new Map<string, Entry>();
    for (const r of filteredRows) {
      const key = r.session_id ?? r.id;
      const e = m.get(key);
      if (e) e.rows.push(r);
      else m.set(key, { key, first: r, rows: [r] });
    }
    return [...m.values()];
  }, [filteredRows]);

  const filtersActive = !!(q || product || group || from || to);
  function reset() {
    setQ("");
    setProduct("");
    setGroup("");
    setFrom("");
    setTo("");
    setLimit(PAGE);
  }
  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function exportCsv() {
    downloadCsv(
      `vakcinacijos-${new Date().toISOString().slice(0, 10)}`,
      ["Data", "Gyvūnas", "Ausies Nr.", "Grupė", "Vakcina", "Dozė", "Skyrimo būdas", "Pakartotinė", "Kita vakcinacija", "Karencija pienui iki", "Karencija mėsai iki", "Gydytojas", "Pastabos"],
      filteredRows.map((v) => [
        formatDate(v.vaccination_date),
        v.animals?.animal_no ?? "",
        v.animals?.tag_no ?? "",
        rowGroupLabel(v) ?? "",
        productNames[v.product_id] ?? "",
        v.dose_amount != null ? formatQty(v.dose_amount, v.unit) : "",
        routeLabel(v.administration_route),
        v.is_revaccination ? "Taip" : "",
        formatDate(v.next_booster_date),
        formatDate(v.withdrawal_until_milk),
        formatDate(v.withdrawal_until_meat),
        v.vet_name ?? "",
        v.notes ?? "",
      ]),
    );
  }

  const visible = entries.slice(0, limit);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-panel border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <Label htmlFor="vh_q">Gyvūnas</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-text-muted" />
            <Input id="vh_q" className="pl-8" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Nr. / ausies Nr." />
          </div>
        </div>
        <div>
          <Label htmlFor="vh_p">Vakcina</Label>
          <Select id="vh_p" value={product} onChange={(e) => { setProduct(e.target.value); setLimit(PAGE); }}>
            <option value="">Visos</option>
            {productOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="vh_g">Grupė</Label>
          <Select id="vh_g" value={group} onChange={(e) => { setGroup(e.target.value); setLimit(PAGE); }}>
            <option value="">Visos</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="vh_from">Data nuo</Label>
          <Input id="vh_from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setLimit(PAGE); }} />
        </div>
        <div>
          <Label htmlFor="vh_to">Data iki</Label>
          <Input id="vh_to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setLimit(PAGE); }} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-secondary sm:col-span-2 lg:col-span-5">
          <span>
            Rasta: <strong className="text-text-primary">{entries.length}</strong> vakcinacijų ({filteredRows.length} gyv. įrašų) iš {vaccinations.length} įrašų
          </span>
          <div className="ml-auto flex gap-2">
            {filtersActive && (
              <Button type="button" size="sm" variant="ghost" onClick={reset}>
                <X className="size-3.5" /> Išvalyti
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" onClick={exportCsv} disabled={filteredRows.length === 0}>
              <Download className="size-4" /> CSV
            </Button>
          </div>
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyState icon={Syringe} title="Vakcinacijų nėra" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-border bg-surface">
          <table className="w-full min-w-[900px] text-left text-[14px]">
            <thead className="border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="w-8 px-2 py-3" />
                <th className="px-3 py-3 font-medium">Data</th>
                <th className="px-3 py-3 font-medium">Gyvūnas / grupė</th>
                <th className="px-3 py-3 font-medium">Vakcina</th>
                <th className="px-3 py-3 font-medium">Dozė</th>
                <th className="px-3 py-3 font-medium">Pakartotinė</th>
                <th className="px-3 py-3 font-medium">Karencija</th>
                <th className="px-3 py-3 font-medium">Gydytojas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map(({ key, first: v, rows }) => {
                const multi = rows.length > 1;
                const isOpen = open.has(key);
                return (
                  <React.Fragment key={key}>
                    <tr className={multi ? "cursor-pointer hover:bg-surface-secondary" : undefined} onClick={multi ? () => toggle(key) : undefined}>
                      <td className="px-2 py-3 text-text-muted">{multi ? isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" /> : null}</td>
                      <td className="px-3 py-3 text-text-secondary">
                        {formatDate(v.vaccination_date)} {v.is_revaccination && <Badge tone="info">Pakart.</Badge>}
                      </td>
                      <td className="px-3 py-3 font-medium text-text-primary">
                        {multi ? (
                          <>
                            {v.target_group_name ?? "Keli gyvūnai"} <span className="font-normal text-text-muted">· {rows.length} gyv.</span>
                          </>
                        ) : (
                          <>
                            {rowAnimalLabel(v)}
                            {rowGroupLabel(v) && <span className="font-normal text-text-muted"> · {rowGroupLabel(v)}</span>}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-3 text-text-secondary">{productNames[v.product_id] ?? "—"}</td>
                      <td className="px-3 py-3 text-text-secondary">
                        {formatQty(v.dose_amount, v.unit)}
                        {v.administration_route && <span className="text-text-muted"> {routeLabel(v.administration_route)}</span>}
                        {multi && <span className="text-text-muted"> / gyv.</span>}
                      </td>
                      <td className="px-3 py-3 text-text-secondary">{formatDate(v.next_booster_date)}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          <Badge tone="warning">🥛 {formatDate(v.withdrawal_until_milk)}</Badge>
                          <Badge tone="danger">🥩 {formatDate(v.withdrawal_until_meat)}</Badge>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-text-secondary">{v.vet_name ?? "—"}</td>
                    </tr>
                    {multi && isOpen && (
                      <tr className="bg-surface-secondary/60">
                        <td />
                        <td colSpan={7} className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1.5">
                            {rows.map((r) => (
                              <Badge key={r.id} tone="neutral" title={`Karencija: 🥛 ${formatDate(r.withdrawal_until_milk)} · 🥩 ${formatDate(r.withdrawal_until_meat)}`}>
                                {rowAnimalLabel(r)}
                              </Badge>
                            ))}
                          </div>
                          {v.notes && <p className="mt-2 text-[12px] text-text-secondary">Pastabos: {v.notes}</p>}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {entries.length > visible.length && (
            <div className="border-t border-border p-2 text-center">
              <Button type="button" size="sm" variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                Rodyti daugiau ({entries.length - visible.length})
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

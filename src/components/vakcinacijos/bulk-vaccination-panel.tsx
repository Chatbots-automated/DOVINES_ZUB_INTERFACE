"use client";

import * as React from "react";
import { useActionState } from "react";
import { Search, Syringe, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { createVaccination, type ActionResult } from "@/lib/actions/vaccinations";
import { PillToggle, ROUTE_OPTIONS } from "@/components/gyvunai/new-treatment-dialog";
import { getRouteWithdrawalDays } from "@/lib/administration-routes";
import type { AdministrationRoute } from "@/lib/supabase/types";
import { addDaysIso, ageInMonths, daysBetween, type BoosterPrefill, type PickerAnimal, type VaccProduct, type VaccRow } from "@/lib/vaccinations";
import { formatDate } from "@/lib/utils";

type Filters = {
  q: string;
  group: string;
  sex: string;
  lactFrom: string;
  lactTo: string;
  ageFrom: string;
  ageTo: string;
  birthFrom: string;
  birthTo: string;
  notWithinDays: string;
  hideKarencija: boolean;
};

const EMPTY_FILTERS: Filters = {
  q: "",
  group: "",
  sex: "",
  lactFrom: "",
  lactTo: "",
  ageFrom: "",
  ageTo: "",
  birthFrom: "",
  birthTo: "",
  notWithinDays: "",
  hideKarencija: false,
};

const PAGE = 300;
const BOOSTER_SHORTCUTS = [
  { label: "+14 d.", days: 14 },
  { label: "+21 d.", days: 21 },
  { label: "+28 d.", days: 28 },
  { label: "+6 mėn.", days: 182 },
  { label: "+1 m.", days: 365 },
];

function num(v: string) {
  return v === "" ? null : Number(v);
}

const AnimalRow = React.memo(function AnimalRow({
  a,
  checked,
  onToggle,
  last,
  today,
  showLast,
}: {
  a: PickerAnimal;
  checked: boolean;
  onToggle: (id: string) => void;
  last: string | undefined;
  today: string;
  showLast: boolean;
}) {
  const age = a.birth_date ? ageInMonths(a.birth_date, today) : null;
  return (
    <tr className={checked ? "bg-accent-soft/50" : undefined}>
      <td className="w-9 px-3 py-1.5">
        <input type="checkbox" className="size-4" checked={checked} onChange={() => onToggle(a.id)} aria-label={`Pažymėti ${a.tag_no}`} />
      </td>
      <td className="px-2 py-1.5 font-medium text-text-primary">{a.animal_no ?? "—"}</td>
      <td className="px-2 py-1.5 text-text-secondary">{a.tag_no}</td>
      <td className="px-2 py-1.5 text-text-secondary">{a.group_name ?? "—"}</td>
      <td className="px-2 py-1.5 text-text-secondary">{a.sex ?? "—"}</td>
      <td className="px-2 py-1.5 text-text-secondary">{a.lactation_no ?? "—"}</td>
      <td className="px-2 py-1.5 text-text-secondary">{age == null ? "—" : `${age} mėn.`}</td>
      <td className="px-2 py-1.5">
        {a.milk_active && <Badge tone="warning">🥛</Badge>} {a.meat_active && <Badge tone="danger">🥩</Badge>}
      </td>
      {showLast && <td className="px-2 py-1.5 text-text-secondary">{last ? formatDate(last) : "—"}</td>}
    </tr>
  );
});

// Bulk vaccination (Priedas §2.6): tick animals (or "select all" of the
// filtered list), pick the vaccine, save everything through create_vaccinations
// in one transaction — a stock shortfall rolls back the whole batch.
export function BulkVaccinationPanel({
  animals,
  groups,
  products,
  vaccinations,
  currentVetName,
  today,
  prefill,
}: {
  animals: PickerAnimal[];
  groups: string[];
  products: VaccProduct[];
  vaccinations: VaccRow[];
  currentVetName?: string | null;
  today: string;
  prefill?: BoosterPrefill | null;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createVaccination, null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const deferred = React.useDeferredValue(filters);
  const [limit, setLimit] = React.useState(PAGE);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(prefill?.animalIds ?? []));
  const [productId, setProductId] = React.useState<string | null>(prefill?.productId ?? null);
  const [route, setRoute] = React.useState("");
  const [date, setDate] = React.useState(today);
  const [booster, setBooster] = React.useState("");
  const [notice, setNotice] = React.useState<string | null>(null);

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) {
      setNotice(`Vakcinuota gyvūnų: ${state.count ?? selected.size}`);
      setSelected(new Set());
      setProductId(null);
      setRoute("");
      setBooster("");
      setDate(today);
    } else {
      setNotice(null);
    }
  }
  React.useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const patch = React.useCallback((p: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setLimit(PAGE);
  }, []);

  const productOptions: ComboboxOption[] = React.useMemo(
    () => products.filter((p) => p.is_active || p.id === productId).map((p) => ({ value: p.id, label: p.name, sublabel: p.unit })),
    [products, productId],
  );
  const product = products.find((p) => p.id === productId);
  const r = (route || null) as AdministrationRoute | null;

  // animal_id -> latest vaccination date with the chosen product.
  const lastByAnimal = React.useMemo(() => {
    const m = new Map<string, string>();
    if (!productId) return m;
    for (const v of vaccinations) {
      if (v.product_id !== productId) continue;
      const cur = m.get(v.animal_id);
      if (!cur || v.vaccination_date > cur) m.set(v.animal_id, v.vaccination_date);
    }
    return m;
  }, [vaccinations, productId]);

  const sexes = React.useMemo(() => [...new Set(animals.map((a) => a.sex).filter((s): s is string => !!s))].sort(), [animals]);
  const groupNames = React.useMemo(() => [...new Set([...groups, ...animals.map((a) => a.group_name).filter((g): g is string => !!g)])].sort(), [groups, animals]);

  const filtered = React.useMemo(() => {
    const f = deferred;
    const tokens = f.q
      .toLowerCase()
      .split(/[\s,;]+/)
      .filter(Boolean);
    const lf = num(f.lactFrom), lt = num(f.lactTo), af = num(f.ageFrom), at = num(f.ageTo);
    const within = num(f.notWithinDays);
    return animals.filter((a) => {
      if (tokens.length) {
        const no = a.animal_no?.toLowerCase() ?? "";
        const tag = a.tag_no.toLowerCase();
        if (!tokens.some((t) => no.includes(t) || tag.includes(t))) return false;
      }
      if (f.group && a.group_name !== f.group) return false;
      if (f.sex && a.sex !== f.sex) return false;
      if (lf != null && (a.lactation_no ?? 0) < lf) return false;
      if (lt != null && (a.lactation_no ?? 0) > lt) return false;
      if (af != null || at != null) {
        if (!a.birth_date) return false;
        const m = ageInMonths(a.birth_date, today);
        if (af != null && m < af) return false;
        if (at != null && m > at) return false;
      }
      if (f.birthFrom && (!a.birth_date || a.birth_date < f.birthFrom)) return false;
      if (f.birthTo && (!a.birth_date || a.birth_date > f.birthTo)) return false;
      if (f.hideKarencija && (a.milk_active || a.meat_active)) return false;
      if (within != null && productId) {
        const last = lastByAnimal.get(a.id);
        if (last && daysBetween(last, today) < within) return false;
      }
      return true;
    });
  }, [animals, deferred, lastByAnimal, productId, today]);

  const toggle = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedInFiltered = React.useMemo(() => filtered.reduce((n, a) => n + (selected.has(a.id) ? 1 : 0), 0), [filtered, selected]);
  const allFilteredSelected = filtered.length > 0 && selectedInFiltered === filtered.length;

  function selectAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const a of filtered) next.add(a.id);
      return next;
    });
  }
  function deselectFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const a of filtered) next.delete(a.id);
      return next;
    });
  }

  // Group vaccination (target_group_name) when a group filter is active and
  // every ticked animal belongs to that group.
  const targetGroup = React.useMemo(() => {
    if (!filters.group || selected.size === 0) return "";
    const byId = new Map(animals.map((a) => [a.id, a]));
    for (const id of selected) if (byId.get(id)?.group_name !== filters.group) return "";
    return filters.group;
  }, [filters.group, selected, animals]);

  const visible = filtered.slice(0, limit);
  const showLast = !!productId;
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div className="space-y-5">
      <div className="rounded-panel border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[14px] font-bold text-text-primary">1. Pasirinkite gyvūnus</h2>
          <span className="text-[12px] text-text-muted">(rodomi tik aktyvūs DelPro gyvūnai)</span>
          {filtersActive && (
            <Button type="button" size="sm" variant="ghost" onClick={() => patch(EMPTY_FILTERS)}>
              <X className="size-3.5" /> Išvalyti filtrus
            </Button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <Label htmlFor="vf_q">Paieška (Nr. / ausies Nr.; keli per kablelį)</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-text-muted" />
              <Input id="vf_q" className="pl-8" value={filters.q} onChange={(e) => patch({ q: e.target.value })} placeholder="pvz. 1234, 5678" />
            </div>
          </div>
          <div>
            <Label htmlFor="vf_group">Grupė (DelPro)</Label>
            <Select id="vf_group" value={filters.group} onChange={(e) => patch({ group: e.target.value })}>
              <option value="">Visos</option>
              {groupNames.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="vf_sex">Lytis</Label>
            <Select id="vf_sex" value={filters.sex} onChange={(e) => patch({ sex: e.target.value })}>
              <option value="">Visos</option>
              {sexes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Laktacija (nuo – iki)</Label>
            <div className="flex gap-1.5">
              <Input type="number" min="0" value={filters.lactFrom} onChange={(e) => patch({ lactFrom: e.target.value })} placeholder="nuo" />
              <Input type="number" min="0" value={filters.lactTo} onChange={(e) => patch({ lactTo: e.target.value })} placeholder="iki" />
            </div>
          </div>
          <div>
            <Label>Amžius mėn. (nuo – iki)</Label>
            <div className="flex gap-1.5">
              <Input type="number" min="0" value={filters.ageFrom} onChange={(e) => patch({ ageFrom: e.target.value })} placeholder="nuo" />
              <Input type="number" min="0" value={filters.ageTo} onChange={(e) => patch({ ageTo: e.target.value })} placeholder="iki" />
            </div>
          </div>
          <div>
            <Label>Gimimo data (nuo – iki)</Label>
            <div className="flex gap-1.5">
              <Input type="date" value={filters.birthFrom} onChange={(e) => patch({ birthFrom: e.target.value })} />
              <Input type="date" value={filters.birthTo} onChange={(e) => patch({ birthTo: e.target.value })} />
            </div>
          </div>
          <div>
            <Label htmlFor="vf_within">Nevakcinuoti šia vakcina per (d.)</Label>
            <Input
              id="vf_within"
              type="number"
              min="1"
              value={filters.notWithinDays}
              disabled={!productId}
              title={productId ? undefined : "Pirmiausia pasirinkite vakciną (2 žingsnis)"}
              onChange={(e) => patch({ notWithinDays: e.target.value })}
              placeholder={productId ? "pvz. 180" : "pasirinkite vakciną"}
            />
          </div>
          <label className="flex items-center gap-2 pt-6 text-[13px] text-text-secondary">
            <input type="checkbox" className="size-4" checked={filters.hideKarencija} onChange={(e) => patch({ hideKarencija: e.target.checked })} />
            Slėpti gyvūnus su aktyvia karencija
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-text-secondary">
            Rasta: <strong className="text-text-primary">{filtered.length}</strong> iš {animals.length}
          </span>
          <span className="text-text-secondary">
            · Pažymėta: <strong className="text-accent">{selected.size}</strong>
            {selected.size !== selectedInFiltered && <span className="text-text-muted"> (iš jų {selectedInFiltered} rodomų)</span>}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={allFilteredSelected ? deselectFiltered : selectAllFiltered} disabled={filtered.length === 0}>
              {allFilteredSelected ? `Atžymėti rodomus (${filtered.length})` : `Pažymėti visus (${filtered.length})`}
            </Button>
            {selected.size > 0 && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Išvalyti pasirinkimą
              </Button>
            )}
          </div>
        </div>

        <div className="mt-3 max-h-[440px] overflow-auto rounded-control border border-border">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="sticky top-0 z-10 border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="w-9 px-3 py-2">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={allFilteredSelected}
                    onChange={allFilteredSelected ? deselectFiltered : selectAllFiltered}
                    aria-label="Pažymėti visus rodomus"
                  />
                </th>
                <th className="px-2 py-2">Nr.</th>
                <th className="px-2 py-2">Ausies Nr.</th>
                <th className="px-2 py-2">Grupė</th>
                <th className="px-2 py-2">Lytis</th>
                <th className="px-2 py-2">Lakt.</th>
                <th className="px-2 py-2">Amžius</th>
                <th className="px-2 py-2">Karencija</th>
                {showLast && <th className="px-2 py-2">Paskutinė šia vakcina</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((a) => (
                <AnimalRow key={a.id} a={a} checked={selected.has(a.id)} onToggle={toggle} last={lastByAnimal.get(a.id)} today={today} showLast={showLast} />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-text-muted">
                    Pagal filtrus gyvūnų nerasta.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {filtered.length > visible.length && (
            <div className="border-t border-border p-2 text-center">
              <Button type="button" size="sm" variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                Rodyti daugiau ({filtered.length - visible.length})
              </Button>
              <span className="ml-2 text-[12px] text-text-muted">&bdquo;Pažymėti visus&ldquo; apima ir nerodomus.</span>
            </div>
          )}
        </div>
      </div>

      <form ref={formRef} action={formAction} className="space-y-4 rounded-panel border border-border bg-surface p-4">
        <h2 className="text-[14px] font-bold text-text-primary">2. Vakcinos duomenys</h2>
        {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
        {notice && state?.ok && <p className="rounded-control bg-success-soft px-3 py-2 text-[13px] text-success">{notice}</p>}

        <input type="hidden" name="animal_ids" value={JSON.stringify([...selected])} />
        <input type="hidden" name="target_group_name" value={targetGroup} />
        <input type="hidden" name="product_id" value={productId ?? ""} />
        <input type="hidden" name="unit" value={product?.unit ?? ""} />
        <input type="hidden" name="administration_route" value={route} />

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <Label>Vakcina *</Label>
            <Combobox options={productOptions} value={productId} onChange={setProductId} placeholder="Pasirinkite vakciną..." />
          </div>
          {product && (
            <div>
              <Label className="mb-1">Skyrimo būdas</Label>
              <PillToggle options={ROUTE_OPTIONS} value={route} onChange={setRoute} allowClear />
              <p className="mt-1.5 text-[12px] text-text-secondary">
                Karencija: <span className="font-semibold text-warning">🥛 {getRouteWithdrawalDays(product, r, "milk")} d.</span>{" "}
                <span className="font-semibold text-danger">🥩 {getRouteWithdrawalDays(product, r, "meat")} d.</span>
              </p>
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="vaccination_date">Data</Label>
            <Input id="vaccination_date" name="vaccination_date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="dose_amount">Dozė vienam gyvūnui{product ? ` (${product.unit})` : ""}</Label>
            <Input id="dose_amount" name="dose_amount" type="number" step="0.01" min="0" />
          </div>
          <div>
            <Label htmlFor="vacc_vet_name">Vet. gydytojas</Label>
            <Input id="vacc_vet_name" name="vet_name" defaultValue={currentVetName ?? undefined} />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex items-center gap-2 pt-6">
            <input id="is_revaccination" name="is_revaccination" type="checkbox" className="size-4 rounded border-border-strong" defaultChecked={!!prefill} />
            <Label htmlFor="is_revaccination" className="mb-0">
              Pakartotinė vakcinacija
            </Label>
          </div>
          <div>
            <Label htmlFor="next_booster_date">Kita (pakartotinė) vakcinacija</Label>
            <Input id="next_booster_date" name="next_booster_date" type="date" value={booster} onChange={(e) => setBooster(e.target.value)} />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {BOOSTER_SHORTCUTS.map((s) => (
                <button
                  key={s.days}
                  type="button"
                  onClick={() => setBooster(addDaysIso(date || today, s.days))}
                  className="rounded-control bg-surface-secondary px-2 py-0.5 text-[12px] text-text-secondary hover:bg-border"
                >
                  {s.label}
                </button>
              ))}
              {booster && (
                <button type="button" onClick={() => setBooster("")} className="px-1 text-[12px] text-text-muted hover:text-text-primary">
                  išvalyti
                </button>
              )}
            </div>
          </div>
        </div>

        <div>
          <Label htmlFor="notes">Pastabos</Label>
          <Textarea id="notes" name="notes" rows={2} />
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button type="submit" disabled={pending || selected.size === 0 || !productId}>
            <Syringe className="size-4" />
            {pending ? "Saugoma..." : selected.size > 0 ? `Vakcinuoti ${selected.size} gyv.` : "Vakcinuoti"}
          </Button>
          <span className="text-[12px] text-text-secondary">
            {targetGroup ? `Grupės vakcinacija: ${targetGroup}. ` : ""}Viskas išsaugoma viena operacija — nepakankant likučio neįrašoma nė vienam gyvūnui.
          </span>
        </div>
      </form>
    </div>
  );
}

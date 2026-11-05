"use client";

import * as React from "react";
import { useActionState } from "react";
import { Repeat, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SyncProtocolPicker } from "@/components/sinchronizacijos/protocol-picker";
import { applySyncProtocolMass, type SyncMassResult } from "@/lib/actions/sync-mass";
import { SYNC_MASS_MAX_ANIMALS, type SyncAnimal } from "@/lib/sync-mass";
import { formatDate } from "@/lib/utils";

type Filters = { q: string; group: string; sex: string; lactFrom: string; lactTo: string; hideBusy: boolean; hidePregnant: boolean; daysSinceIns: string };
const EMPTY_FILTERS: Filters = { q: "", group: "", sex: "", lactFrom: "", lactTo: "", hideBusy: true, hidePregnant: false, daysSinceIns: "" };
const PAGE = 300;
const num = (v: string) => (v === "" ? null : Number(v));

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

const AnimalRow = React.memo(function AnimalRow({
  a,
  checked,
  onToggle,
  today,
}: {
  a: SyncAnimal;
  checked: boolean;
  onToggle: (id: string) => void;
  today: string;
}) {
  const busy = !!a.open_protocol_name;
  const since = a.last_insemination_date ? daysBetween(a.last_insemination_date, today) : null;
  return (
    <tr className={checked ? "bg-accent-soft/50" : busy ? "opacity-60" : undefined}>
      <td className="w-9 px-3 py-1.5">
        <input
          type="checkbox"
          className="size-4"
          checked={checked}
          disabled={busy && !checked}
          onChange={() => onToggle(a.id)}
          aria-label={`Pažymėti ${a.tag_no}`}
        />
      </td>
      <td className="px-2 py-1.5 font-medium text-text-primary">{a.animal_no ?? "—"}</td>
      <td className="px-2 py-1.5 text-text-secondary">{a.tag_no}</td>
      <td className="px-2 py-1.5 text-text-secondary">{a.group_name ?? "—"}</td>
      <td className="px-2 py-1.5 text-text-secondary">{a.sex ?? "—"}</td>
      <td className="px-2 py-1.5 text-text-secondary">{a.lactation_no ?? "—"}</td>
      <td className="px-2 py-1.5 text-text-secondary">
        {a.last_insemination_date ? (
          <>
            {formatDate(a.last_insemination_date)} <span className="text-text-muted">({since} d.)</span>
            {a.last_pregnancy_confirmed === true && (
              <Badge tone="success" className="ml-1">
                Veršinga
              </Badge>
            )}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-2 py-1.5">{busy ? <Badge tone="warning">{a.open_protocol_name}</Badge> : <span className="text-text-muted">—</span>}</td>
    </tr>
  );
});

// Sinchronizacija for many animals (0059, farm's request — billed with Sinchronizacijos
// protokolai). Tick animals, pick a protocol + start date: apply_sync_protocol_mass()
// plans one visit per step per animal in ONE transaction. No stock is used here.
export function SyncMassPanel({
  animals,
  groups,
  currentVetName,
  today,
}: {
  animals: SyncAnimal[];
  groups: string[];
  currentVetName?: string | null;
  today: string;
}) {
  const [state, formAction, pending] = useActionState<SyncMassResult | null, FormData>(applySyncProtocolMass, null);
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const deferred = React.useDeferredValue(filters);
  const [limit, setLimit] = React.useState(PAGE);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [protocolId, setProtocolId] = React.useState("");
  const [startDate, setStartDate] = React.useState(today);

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) setSelected(new Set());
  }

  const patch = React.useCallback((p: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setLimit(PAGE);
  }, []);

  const sexes = React.useMemo(() => [...new Set(animals.map((a) => a.sex).filter((s): s is string => !!s))].sort(), [animals]);
  const groupNames = React.useMemo(
    () => [...new Set([...groups, ...animals.map((a) => a.group_name).filter((g): g is string => !!g)])].sort(),
    [groups, animals],
  );

  const filtered = React.useMemo(() => {
    const f = deferred;
    const tokens = f.q.toLowerCase().split(/[\s,;]+/).filter(Boolean);
    const lf = num(f.lactFrom), lt = num(f.lactTo), ds = num(f.daysSinceIns);
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
      if (f.hideBusy && a.open_protocol_name) return false;
      if (f.hidePregnant && a.last_pregnancy_confirmed === true) return false;
      if (ds != null && a.last_insemination_date && daysBetween(a.last_insemination_date, today) < ds) return false;
      return true;
    });
  }, [animals, deferred, today]);

  const toggle = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectable = React.useMemo(() => filtered.filter((a) => !a.open_protocol_name), [filtered]);
  const selectedInFiltered = React.useMemo(() => selectable.reduce((n, a) => n + (selected.has(a.id) ? 1 : 0), 0), [selectable, selected]);
  const allSelected = selectable.length > 0 && selectedInFiltered === selectable.length;
  const selectAll = () => setSelected((prev) => new Set([...prev, ...selectable.map((a) => a.id)]));
  const deselectAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const a of filtered) next.delete(a.id);
      return next;
    });

  const n = selected.size;
  const busySelected = animals.filter((a) => selected.has(a.id) && a.open_protocol_name).length;
  const pregnantSelected = animals.filter((a) => selected.has(a.id) && a.last_pregnancy_confirmed === true).length;
  const problems: string[] = [];
  if (n === 0) problems.push("Pasirinkite gyvūnus.");
  if (n > SYNC_MASS_MAX_ANIMALS) problems.push(`Vienu kartu galima ne daugiau kaip ${SYNC_MASS_MAX_ANIMALS} gyvūnų.`);
  if (busySelected > 0) problems.push(`${busySelected} pažymėtiems gyvūnams jau taikomas protokolas — nuimkite juos.`);
  if (!protocolId) problems.push("Pasirinkite protokolą.");
  if (!startDate) problems.push("Įveskite pradžios datą.");

  const visible = filtered.slice(0, limit);
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div className="space-y-5">
      <div className="rounded-panel border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[14px] font-bold text-text-primary">1. Pasirinkite gyvūnus</h2>
          <span className="text-[12px] text-text-muted">(rodomi tik aktyvūs gyvūnai)</span>
          {filtersActive && (
            <Button type="button" size="sm" variant="ghost" onClick={() => patch(EMPTY_FILTERS)}>
              <X className="size-3.5" /> Atstatyti filtrus
            </Button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <Label htmlFor="sf_q">Paieška (Nr. / ausies Nr.; keli per kablelį)</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-text-muted" />
              <Input id="sf_q" className="pl-8" value={filters.q} onChange={(e) => patch({ q: e.target.value })} placeholder="pvz. 1234, 5678" />
            </div>
          </div>
          <div>
            <Label htmlFor="sf_group">Grupė (DelPro)</Label>
            <Select id="sf_group" value={filters.group} onChange={(e) => patch({ group: e.target.value })}>
              <option value="">Visos</option>
              {groupNames.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="sf_sex">Lytis</Label>
            <Select id="sf_sex" value={filters.sex} onChange={(e) => patch({ sex: e.target.value })}>
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
            <Label htmlFor="sf_ins">Nuo paskutinio sėklinimo ≥ d.</Label>
            <Input id="sf_ins" type="number" min="0" value={filters.daysSinceIns} onChange={(e) => patch({ daysSinceIns: e.target.value })} />
          </div>
          <div className="flex flex-col justify-end gap-1.5 text-[13px] text-text-secondary sm:col-span-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="size-4" checked={filters.hideBusy} onChange={(e) => patch({ hideBusy: e.target.checked })} />
              Slėpti gyvūnus, kuriems jau taikomas protokolas
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="size-4" checked={filters.hidePregnant} onChange={(e) => patch({ hidePregnant: e.target.checked })} />
              Slėpti patvirtintas veršingas
            </label>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-text-secondary">
            Rasta: <strong className="text-text-primary">{filtered.length}</strong> iš {animals.length}
          </span>
          <span className="text-text-secondary">
            · Pažymėta: <strong className="text-accent">{n}</strong>
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={allSelected ? deselectAll : selectAll} disabled={selectable.length === 0}>
              {allSelected ? `Atžymėti rodomus (${selectable.length})` : `Pažymėti visus (${selectable.length})`}
            </Button>
            {n > 0 && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Išvalyti pasirinkimą
              </Button>
            )}
          </div>
        </div>

        <div className="mt-3 max-h-[440px] overflow-auto rounded-control border border-border">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="sticky top-0 z-10 border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="w-9 px-3 py-2">
                  <input type="checkbox" className="size-4" checked={allSelected} onChange={allSelected ? deselectAll : selectAll} aria-label="Pažymėti visus rodomus" />
                </th>
                <th className="px-2 py-2">Nr.</th>
                <th className="px-2 py-2">Ausies Nr.</th>
                <th className="px-2 py-2">Grupė</th>
                <th className="px-2 py-2">Lytis</th>
                <th className="px-2 py-2">Lakt.</th>
                <th className="px-2 py-2">Paskutinis sėklinimas</th>
                <th className="px-2 py-2">Taikomas protokolas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((a) => (
                <AnimalRow key={a.id} a={a} checked={selected.has(a.id)} onToggle={toggle} today={today} />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-text-muted">
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
            </div>
          )}
        </div>
      </div>

      <form action={formAction} className="space-y-4 rounded-panel border border-border bg-surface p-4">
        <h2 className="text-[14px] font-bold text-text-primary">2. Protokolas</h2>
        {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
        {state?.ok && <p className="rounded-control bg-success-soft px-3 py-2 text-[13px] text-success">{state.message}</p>}
        <input type="hidden" name="animal_ids" value={JSON.stringify([...selected])} />

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="sm_date">Protokolo pradžios data (0 d.) *</Label>
            <Input id="sm_date" name="start_date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="sm_time">Laikas</Label>
            <Input id="sm_time" name="start_time" type="time" defaultValue="09:00" />
          </div>
          <div>
            <Label htmlFor="sm_vet">Veterinarijos gydytojas</Label>
            <Input id="sm_vet" name="vet_name" defaultValue={currentVetName ?? undefined} />
          </div>
        </div>

        <SyncProtocolPicker open startDate={startDate} protocolId={protocolId} onChange={setProtocolId} />

        <div>
          <Label htmlFor="sm_notes">Pastabos</Label>
          <Textarea id="sm_notes" name="notes" rows={2} />
        </div>

        {pregnantSelected > 0 && (
          <p className="rounded-control bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
            {pregnantSelected} pažymėt{pregnantSelected === 1 ? "as gyvūnas" : "i gyvūnai"} pažymėti kaip veršingi — patikrinkite prieš taikydami protokolą.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button
            type="submit"
            disabled={pending || problems.length > 0}
            onClick={(e) => {
              if (!window.confirm(`Pritaikyti protokolą ${n} gyvūnams?`)) e.preventDefault();
            }}
          >
            <Repeat className="size-4" />
            {pending ? "Saugoma..." : n > 0 ? `Pritaikyti ${n} gyv.` : "Pritaikyti"}
          </Button>
          <span className="text-[12px] text-text-secondary">
            {problems.length > 0 && n > 0 ? (
              <span className="font-medium text-danger">{problems[0]}</span>
            ) : (
              "Viskas išsaugoma viena operacija. Kiekvienam gyvūnui bus suplanuoti protokolo vizitai; vaistai nurašomi tik įrašant žingsnį."
            )}
          </span>
        </div>
      </form>
    </div>
  );
}

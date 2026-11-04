"use client";

import * as React from "react";
import { useActionState } from "react";
import { AlertTriangle, Plus, Search, Syringe, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { PillToggle, type Product } from "@/components/gyvunai/new-treatment-dialog";
import { NewDiseaseDialog } from "@/components/gyvunai/new-disease-dialog";
import { MedicineLine } from "@/components/gydymas/medicine-line";
import type { CreatedDisease } from "@/lib/actions/diseases";
import { createMassTreatment, type MassActionResult } from "@/lib/actions/mass-treatments";
import { catalogFromProps, loadTreatmentCatalog } from "@/lib/treatments/catalog";
import type { CatalogProduct, MedLine } from "@/lib/treatments/planner";
import { PROPHYLAXIS_CATEGORIES } from "@/lib/product-categories";
import type { ProductCategory } from "@/lib/supabase/types";
import { ageInMonths } from "@/lib/vaccinations";
import {
  MASS_PROCEDURE_OPTIONS,
  MASS_TREATMENT_MAX_ANIMALS,
  type MassAnimal,
  type MassDelproInfo,
  type MassProcedureType,
} from "@/lib/mass-treatments";

type Filters = {
  q: string;
  group: string;
  sex: string;
  lactFrom: string;
  lactTo: string;
  ageFrom: string;
  ageTo: string;
  hideKarencija: boolean;
};
const EMPTY_FILTERS: Filters = { q: "", group: "", sex: "", lactFrom: "", lactTo: "", ageFrom: "", ageTo: "", hideKarencija: false };
const PAGE = 300;
const num = (v: string) => (v === "" ? null : Number(v));
const isPositiveInt = (v: string | undefined) => /^[1-9]\d*$/.test((v ?? "").trim());
const newLine = (): MedLine => ({ key: crypto.randomUUID(), product_id: "", qty: "", route: "", frequency: "", days: "" });

const AnimalRow = React.memo(function AnimalRow({
  a,
  checked,
  onToggle,
  today,
  showGuid,
}: {
  a: MassAnimal;
  checked: boolean;
  onToggle: (id: string) => void;
  today: string;
  showGuid: boolean;
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
      {showGuid && (
        <td className="px-2 py-1.5">{a.delpro_object_guid ? <Badge tone="success">Susietas</Badge> : <Badge tone="danger">Nesusietas</Badge>}</td>
      )}
    </tr>
  );
});

// Masinis gydymas (0056, farm's request — billed separately; pattern from Oksana's
// BulkTreatment). Tick animals, enter the treatment once — the dose is PER ANIMAL.
// create_mass_treatment() saves one ordinary treatment per animal in one transaction
// (FEFO, karencija, visit, frequency/duration); each gydymas gets its own DelPro job,
// which the farm-PC worker handles exactly like a single treatment.
export function MassTreatmentPanel({
  animals,
  groups,
  diseases,
  products,
  delpro,
  currentVetName,
  today,
}: {
  animals: MassAnimal[];
  groups: string[];
  diseases: { id: string; name: string }[];
  products: Product[];
  delpro: MassDelproInfo;
  currentVetName?: string | null;
  today: string;
}) {
  const [state, formAction, pending] = useActionState<MassActionResult | null, FormData>(createMassTreatment, null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const deferred = React.useDeferredValue(filters);
  const [limit, setLimit] = React.useState(PAGE);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());

  const [procedureType, setProcedureType] = React.useState<MassProcedureType>("gydymas");
  const [regDate, setRegDate] = React.useState(today);
  const [diseaseId, setDiseaseId] = React.useState<string | null>(null);
  const [diagnosisText, setDiagnosisText] = React.useState("");
  const [localDiseases, setLocalDiseases] = React.useState(diseases);
  const [medLines, setMedLines] = React.useState<MedLine[]>(() => [newLine()]);

  // Live stock — reloaded after every save so the next mass treatment sees it.
  const [catalog, setCatalog] = React.useState<CatalogProduct[] | null>(null);
  const [catalogError, setCatalogError] = React.useState(false);
  const [catalogVersion, setCatalogVersion] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    loadTreatmentCatalog()
      .then((c) => {
        if (cancelled) return;
        setCatalog(c);
        setCatalogError(false);
      })
      .catch((err) => {
        console.error("[MassTreatmentPanel] catalog load failed:", err);
        if (cancelled) return;
        setCatalog(null);
        setCatalogError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [catalogVersion]);
  const catalogLoading = catalog === null && !catalogError;

  const prophylaxisOnly = procedureType === "profilaktika";
  const effectiveCatalog = React.useMemo(() => {
    const all = catalog ?? (catalogError ? catalogFromProps(products) : []);
    return prophylaxisOnly ? all.filter((p) => !p.category || PROPHYLAXIS_CATEGORIES.includes(p.category as ProductCategory)) : all;
  }, [catalog, catalogError, products, prophylaxisOnly]);
  const productById = React.useMemo(() => new Map(effectiveCatalog.map((p) => [p.id, p])), [effectiveCatalog]);

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) {
      setSelected(new Set());
      setDiseaseId(null);
      setDiagnosisText("");
      setMedLines([newLine()]);
      setRegDate(today);
      setCatalogVersion((v) => v + 1);
    }
  }
  React.useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

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
    const tokens = f.q
      .toLowerCase()
      .split(/[\s,;]+/)
      .filter(Boolean);
    const lf = num(f.lactFrom), lt = num(f.lactTo), af = num(f.ageFrom), at = num(f.ageTo);
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
      if (f.hideKarencija && (a.milk_active || a.meat_active)) return false;
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
  const selectedInFiltered = React.useMemo(() => filtered.reduce((n, a) => n + (selected.has(a.id) ? 1 : 0), 0), [filtered, selected]);
  const allFilteredSelected = filtered.length > 0 && selectedInFiltered === filtered.length;
  function selectAllFiltered() {
    setSelected((prev) => new Set([...prev, ...filtered.map((a) => a.id)]));
  }
  function deselectFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const a of filtered) next.delete(a.id);
      return next;
    });
  }

  // ---- Disease ----
  const diseaseOptions: ComboboxOption[] = React.useMemo(() => localDiseases.map((d) => ({ value: d.id, label: d.name })), [localDiseases]);
  function selectDisease(id: string | null) {
    setDiseaseId(id);
    const name = localDiseases.find((d) => d.id === id)?.name;
    if (name) setDiagnosisText(name);
  }
  function handleDiseaseCreated(d: CreatedDisease) {
    setLocalDiseases((prev) => (prev.some((x) => x.id === d.id) ? prev : [...prev, d]));
    setDiseaseId(d.id);
    setDiagnosisText(d.name);
  }

  // ---- Medicines: the dose is per animal, stock is checked for all of them ----
  const n = selected.size;
  const nowByProduct = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const l of medLines) {
      const q = Number(l.qty);
      if (!l.product_id || !(q > 0)) continue;
      m.set(l.product_id, Math.round(((m.get(l.product_id) ?? 0) + q * Math.max(n, 1)) * 1e6) / 1e6);
    }
    return m;
  }, [medLines, n]);
  const validLines = medLines.filter((l) => l.product_id && Number(l.qty) > 0);
  const updateLine = (key: string, p: Partial<MedLine>) => setMedLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const problems: string[] = [];
  if (n === 0) problems.push("Pasirinkite gyvūnus.");
  if (n > MASS_TREATMENT_MAX_ANIMALS) problems.push(`Vienu kartu galima ne daugiau kaip ${MASS_TREATMENT_MAX_ANIMALS} gyvūnų.`);
  if (procedureType === "gydymas" && !diseaseId) problems.push("Pasirinkite ligą — ji perduodama į DelPro kaip diagnozė.");
  if (validLines.length === 0) problems.push("Pridėkite bent vieną vaistą su doze.");
  if (medLines.some((l) => l.product_id && !(Number(l.qty) > 0))) problems.push("Nurodykite vaisto dozę (didesnę už 0).");
  if (medLines.some((l) => !l.product_id && Number(l.qty) > 0)) problems.push("Pasirinkite produktą eilutei su doze.");
  if (prophylaxisOnly && !catalogLoading && medLines.some((l) => l.product_id && !productById.has(l.product_id))) {
    problems.push("Profilaktikai tinka tik Profilaktikos ir Boliusų kategorijos produktai.");
  }
  if (procedureType === "gydymas" && validLines.some((l) => !(isPositiveInt(l.frequency) && isPositiveInt(l.days)))) {
    problems.push("Kiekvienam vaistui nurodykite, kiek kartų per dieną ir kiek dienų.");
  }
  const short = [...nowByProduct].some(([id, need]) => {
    const p = productById.get(id);
    return !!p && p.usable_qty !== null && need > p.usable_qty + 1e-9;
  });
  if (short) problems.push("Visiems pasirinktiems gyvūnams neužtenka atsargų.");

  // ---- DelPro readiness (warnings only — each job is checked again in the database) ----
  const warnings: string[] = [];
  if (procedureType === "gydymas" && delpro.enabled) {
    if (delpro.gateway) {
      const diseaseLinks = new Set(delpro.linkedDiseaseIds);
      const productLinks = new Set(delpro.linkedProductIds);
      if (diseaseId && !diseaseLinks.has(diseaseId)) warnings.push("Liga nesusieta su DelPro diagnoze — DelPro perdavimas nepavyks.");
      for (const l of validLines) {
        if (!productLinks.has(l.product_id)) warnings.push(`Vaistas „${productById.get(l.product_id)?.name ?? "?"}“ nesusietas su DelPro vaistu.`);
      }
      const noGuid = animals.filter((a) => selected.has(a.id) && !a.delpro_object_guid).length;
      if (noGuid > 0) warnings.push(`${noGuid} pasirinkt${noGuid === 1 ? "as gyvūnas nesusietas" : "i gyvūnai nesusieti"} su DelPro — jų perdavimas nepavyks.`);
    } else if (validLines.length > 1) {
      warnings.push("DelPro scenarijus perduoda tik vieną vaistą — gydymai su keliais vaistais liks DelPro eilėje.");
    }
  }

  const medicationsJson = JSON.stringify(
    validLines.map((l) => ({
      product_id: l.product_id,
      qty: Number(l.qty),
      unit: productById.get(l.product_id)?.unit ?? "vnt",
      administration_route: l.route || null,
      ...(procedureType === "gydymas" ? { frequency_per_day: Number(l.frequency), course_days: Number(l.days) } : {}),
    })),
  );

  const visible = filtered.slice(0, limit);
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);
  const showGuid = delpro.enabled && delpro.gateway && procedureType === "gydymas";

  return (
    <div className="space-y-5">
      <div className="rounded-panel border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[14px] font-bold text-text-primary">1. Pasirinkite gyvūnus</h2>
          <span className="text-[12px] text-text-muted">(rodomi tik aktyvūs gyvūnai)</span>
          {filtersActive && (
            <Button type="button" size="sm" variant="ghost" onClick={() => patch(EMPTY_FILTERS)}>
              <X className="size-3.5" /> Išvalyti filtrus
            </Button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <Label htmlFor="mf_q">Paieška (Nr. / ausies Nr.; keli per kablelį)</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-text-muted" />
              <Input id="mf_q" className="pl-8" value={filters.q} onChange={(e) => patch({ q: e.target.value })} placeholder="pvz. 1234, 5678" />
            </div>
          </div>
          <div>
            <Label htmlFor="mf_group">Grupė (DelPro)</Label>
            <Select id="mf_group" value={filters.group} onChange={(e) => patch({ group: e.target.value })}>
              <option value="">Visos</option>
              {groupNames.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="mf_sex">Lytis</Label>
            <Select id="mf_sex" value={filters.sex} onChange={(e) => patch({ sex: e.target.value })}>
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
          <label className="flex items-center gap-2 pt-6 text-[13px] text-text-secondary sm:col-span-2">
            <input type="checkbox" className="size-4" checked={filters.hideKarencija} onChange={(e) => patch({ hideKarencija: e.target.checked })} />
            Slėpti gyvūnus su aktyvia karencija
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-text-secondary">
            Rasta: <strong className="text-text-primary">{filtered.length}</strong> iš {animals.length}
          </span>
          <span className="text-text-secondary">
            · Pažymėta: <strong className="text-accent">{n}</strong>
            {n !== selectedInFiltered && <span className="text-text-muted"> (iš jų {selectedInFiltered} rodomų)</span>}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={allFilteredSelected ? deselectFiltered : selectAllFiltered} disabled={filtered.length === 0}>
              {allFilteredSelected ? `Atžymėti rodomus (${filtered.length})` : `Pažymėti visus (${filtered.length})`}
            </Button>
            {n > 0 && (
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
                {showGuid && <th className="px-2 py-2">DelPro</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((a) => (
                <AnimalRow key={a.id} a={a} checked={selected.has(a.id)} onToggle={toggle} today={today} showGuid={showGuid} />
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
        <h2 className="text-[14px] font-bold text-text-primary">2. Gydymo duomenys</h2>
        {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
        {state?.ok && <p className="rounded-control bg-success-soft px-3 py-2 text-[13px] text-success">{state.message}</p>}
        {catalogError && (
          <p className="flex items-center gap-2 rounded-control bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
            <AlertTriangle className="size-4 shrink-0" /> Nepavyko gauti atsargų likučių — likučiai nerodomi ir netikrinami iki išsaugojimo.
          </p>
        )}

        <input type="hidden" name="animal_ids" value={JSON.stringify([...selected])} />
        <input type="hidden" name="procedure_type" value={procedureType} />
        <input type="hidden" name="disease_id" value={diseaseId ?? ""} />
        <input type="hidden" name="medications" value={medicationsJson} />

        <div>
          <Label className="mb-1.5">Procedūra</Label>
          <PillToggle options={[...MASS_PROCEDURE_OPTIONS]} value={procedureType} onChange={setProcedureType} />
          {procedureType === "profilaktika" && (
            <p className="mt-1.5 text-[12px] text-text-muted">Profilaktika į DelPro neperduodama; tinka tik Profilaktikos ir Boliusų produktai.</p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="mass_reg_date">Data</Label>
            <Input id="mass_reg_date" name="reg_date" type="date" value={regDate} onChange={(e) => setRegDate(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="mass_vet_name">Veterinarijos gydytojas</Label>
            <Input id="mass_vet_name" name="vet_name" defaultValue={currentVetName ?? undefined} />
          </div>
        </div>

        <div>
          <Label>Liga{procedureType === "gydymas" ? " *" : ""}</Label>
          <div className="flex gap-2">
            <div className="flex-1">
              <Combobox
                options={diseaseOptions}
                value={diseaseId}
                onChange={selectDisease}
                placeholder={procedureType === "gydymas" ? "Pasirinkite ligą..." : "Pasirinkite ligą (neprivaloma)..."}
              />
            </div>
            <NewDiseaseDialog onCreated={handleDiseaseCreated} />
          </div>
          <Input
            name="diagnosis"
            value={diagnosisText}
            onChange={(e) => setDiagnosisText(e.target.value)}
            placeholder="Diagnozė / patikslinimas"
            className="mt-2"
          />
        </div>

        <div>
          <Label className="mb-1.5">Vaistai (dozė vienam gyvūnui)</Label>
          <div className="space-y-3 rounded-panel border border-border bg-surface-secondary p-4">
            {medLines.map((line) => (
              <MedicineLine
                key={line.key}
                line={line}
                catalog={effectiveCatalog}
                productById={productById}
                loading={catalogLoading}
                regDate={regDate || today}
                nowByProduct={nowByProduct}
                courseDoses={1}
                showSchedule={procedureType === "gydymas"}
                onChange={(p) => updateLine(line.key, p)}
                onRemove={() => setMedLines((prev) => prev.filter((l) => l.key !== line.key))}
              />
            ))}
            <Button type="button" size="sm" variant="outline" onClick={() => setMedLines((prev) => [...prev, newLine()])}>
              <Plus className="size-4" /> Pridėti vaistą
            </Button>
            <p className="text-[11px] text-text-muted">
              Likutis tikrinamas visiems pažymėtiems gyvūnams (dozė × {Math.max(n, 1)}). Nurašoma iš seniausiai galiojančios partijos (FEFO), kiekvienam gyvūnui atskirai.
            </p>
          </div>
        </div>

        <div>
          <Label htmlFor="mass_notes">Pastabos</Label>
          <Textarea id="mass_notes" name="notes" rows={2} />
        </div>

        {warnings.length > 0 && (
          <div className="space-y-1 rounded-control bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
            {warnings.map((w) => (
              <p key={w} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {w}
              </p>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button
            type="submit"
            disabled={pending || problems.length > 0}
            onClick={(e) => {
              if (!window.confirm(`Įrašyti ${procedureType === "gydymas" ? "gydymą" : "profilaktiką"} ${n} gyvūnams?`)) e.preventDefault();
            }}
          >
            <Syringe className="size-4" />
            {pending ? "Saugoma..." : n > 0 ? `Gydyti ${n} gyv.` : "Gydyti"}
          </Button>
          <span className="text-[12px] text-text-secondary">
            {problems.length > 0 && n > 0 ? (
              <span className="font-medium text-danger">{problems[0]}</span>
            ) : (
              <>
                Viskas išsaugoma viena operacija — nepakankant likučio neįrašoma nė vienam gyvūnui.
                {procedureType === "gydymas" && delpro.enabled && " Kiekvieno gyvūno gydymas bus perduotas į DelPro atskirai."}
              </>
            )}
          </span>
        </div>
      </form>
    </div>
  );
}

"use client";

import * as React from "react";
import { Search, PawPrint } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils";
import { AnimalDetailDrawer } from "@/components/gyvunai/animal-detail-drawer";
import type { AnimalLookups } from "@/lib/animal-lookups";
import type { AnimalRow, WithdrawalRow } from "@/lib/animal-profile";

/** Numeric-aware sort so herd number 95 comes before 512. */
function compareAnimalNo(a: AnimalRow, b: AnimalRow) {
  return (a.animal_no ?? a.tag_no).localeCompare(b.animal_no ?? b.tag_no, "lt", { numeric: true });
}

/**
 * Gyvūnai list (Priedas §2.7/§2.10): search by herd number / ear tag /
 * name / breed, filter by DelPro group, active status and active karencija.
 * Clicking a row opens the AnimalDetailDrawer sidepanel in place.
 */
export function AnimalsTable({
  animals,
  withdrawal,
  lookups,
}: {
  animals: AnimalRow[];
  withdrawal: WithdrawalRow[];
  lookups: AnimalLookups;
}) {
  const [search, setSearch] = React.useState("");
  const [group, setGroup] = React.useState("");
  const [showInactive, setShowInactive] = React.useState(false);
  const [onlyWithdrawal, setOnlyWithdrawal] = React.useState(false);
  // Keep the id, not the row, so a revalidated list (new notes, DelPro sync) refreshes the open card.
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const withdrawalByAnimal = React.useMemo(() => new Map(withdrawal.map((w) => [w.animal_id, w])), [withdrawal]);

  const groups = React.useMemo(
    () => Array.from(new Set(animals.map((a) => a.group_name).filter((g): g is string => !!g))).sort((a, b) => a.localeCompare(b, "lt")),
    [animals],
  );

  function openAnimal(a: AnimalRow) {
    setSelectedId(a.id);
    setDrawerOpen(true);
  }

  const selectedAnimal = React.useMemo(() => animals.find((a) => a.id === selectedId) ?? null, [animals, selectedId]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return animals
      .filter((a) => showInactive || a.active)
      .filter((a) => !group || a.group_name === group)
      .filter((a) => {
        if (!onlyWithdrawal) return true;
        const w = withdrawalByAnimal.get(a.id);
        return !!(w?.milk_active || w?.meat_active);
      })
      .filter((a) => !term || [a.animal_no, a.tag_no, a.name, a.breed, a.sex].some((v) => v?.toLowerCase().includes(term)))
      .sort(compareAnimalNo);
  }, [animals, search, group, showInactive, onlyWithdrawal, withdrawalByAnimal]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ieškoti pagal Nr., ausies įsagą, vardą, veislę..."
            className="pl-8"
          />
        </div>
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          className="h-9 rounded-control border border-border bg-surface px-2 text-[13px]"
          aria-label="Grupė"
        >
          <option value="">Visos grupės</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-[13px] text-text-secondary">
          <input type="checkbox" checked={onlyWithdrawal} onChange={(e) => setOnlyWithdrawal(e.target.checked)} />
          Tik su karencija
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-text-secondary">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Rodyti išbrokuotus / neaktyvius
        </label>
        <span className="ml-auto text-[12px] text-text-muted">
          {filtered.length} / {animals.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={PawPrint}
          title={animals.length === 0 ? "Gyvūnų dar nėra" : "Nerasta"}
          description={
            animals.length === 0 ? "Gyvūnai atsiras automatiškai po pirmos DelPro sinchronizacijos, arba pridėkite rankiniu būdu." : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-border bg-surface">
          <table className="w-full min-w-[900px] text-left text-[14px]">
            <thead className="border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-4 py-3 font-medium">Nr.</th>
                <th className="px-4 py-3 font-medium">Ausies įsaga</th>
                <th className="px-4 py-3 font-medium">Grupė</th>
                <th className="px-4 py-3 font-medium">Lytis / kategorija</th>
                <th className="px-4 py-3 font-medium">Gimimo data</th>
                <th className="px-4 py-3 font-medium">Lakt.</th>
                <th className="px-4 py-3 font-medium">Šaltinis</th>
                <th className="px-4 py-3 font-medium">Karencija</th>
                <th className="px-4 py-3 font-medium">Būsena</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((a) => {
                const w = withdrawalByAnimal.get(a.id);
                return (
                  <tr
                    key={a.id}
                    tabIndex={0}
                    role="button"
                    onClick={() => openAnimal(a)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openAnimal(a);
                      }
                    }}
                    className="cursor-pointer hover:bg-surface-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  >
                    <td className="px-4 py-3 font-semibold text-accent-hover">{a.animal_no ?? "—"}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {a.tag_no}
                      {a.name && <span className="ml-1.5 text-text-muted">· {a.name}</span>}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{a.group_name ?? "—"}</td>
                    <td className="px-4 py-3 text-text-secondary">{a.sex ?? "—"}</td>
                    <td className="px-4 py-3 text-text-secondary">{formatDate(a.birth_date)}</td>
                    <td className="px-4 py-3 text-text-secondary">{a.lactation_no ?? "—"}</td>
                    <td className="px-4 py-3">
                      <Badge tone={a.source === "manual" ? "neutral" : "info"}>{a.source === "delpro" ? "DelPro" : a.source === "vic" ? "VIC" : "Rankinis"}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {w?.milk_active && <Badge tone="warning">🥛 iki {formatDate(w.milk_until)}</Badge>}
                        {w?.meat_active && <Badge tone="danger">🥩 iki {formatDate(w.meat_until)}</Badge>}
                        {!w?.milk_active && !w?.meat_active && <span className="text-text-muted">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={a.active ? "success" : "neutral"}>{a.active ? "Aktyvus" : "Neaktyvus"}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AnimalDetailDrawer
        animal={selectedAnimal}
        withdrawal={selectedAnimal ? withdrawalByAnimal.get(selectedAnimal.id) : undefined}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        lookups={lookups}
      />
    </div>
  );
}

"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { createVaccination, type ActionResult } from "@/lib/actions/vaccinations";
import { PillToggle, ROUTE_OPTIONS, animalLabel, type AnimalOption, type Product } from "@/components/gyvunai/new-treatment-dialog";
import { getRouteWithdrawalDays } from "@/lib/administration-routes";
import type { AdministrationRoute } from "@/lib/supabase/types";

type Mode = "animal" | "group";

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: "animal", label: "Vienas gyvūnas" },
  { value: "group", label: "Gyvulių grupė" },
];

// "Nauja vakcinacija" (Priedas §2.6 — "gyvulį ar gyvulių grupę"). Group
// mode lists the group's active animals, all ticked; untick the ones that
// weren't vaccinated. Dose is per animal; stock is deducted per animal.
export function NewVaccinationDialog({
  animalId,
  animals,
  groups,
  products,
  currentVetName,
  trigger,
  onCreated,
  visitId,
}: {
  animalId?: string;
  animals?: AnimalOption[];
  groups?: string[];
  products: Product[];
  currentVetName?: string | null;
  trigger?: React.ReactNode;
  onCreated?: () => void;
  /** Vizitai (0018): links the vaccination to this visit (atomically, via create_vaccination_for_visit). */
  visitId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createVaccination, null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const [mode, setMode] = React.useState<Mode>("animal");
  const [selectedAnimalId, setSelectedAnimalId] = React.useState<string | null>(animalId ?? null);
  const [groupName, setGroupName] = React.useState("");
  const [excluded, setExcluded] = React.useState<Set<string>>(new Set());
  const [productId, setProductId] = React.useState<string | null>(null);
  const [route, setRoute] = React.useState("");

  function resetOwnState() {
    setMode("animal");
    setSelectedAnimalId(animalId ?? null);
    setGroupName("");
    setExcluded(new Set());
    setProductId(null);
    setRoute("");
  }

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) {
      setOpen(false);
      resetOwnState();
      onCreated?.();
    }
  }

  React.useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const groupAnimals = React.useMemo(
    () => (animals ?? []).filter((a) => groupName && a.group_name === groupName),
    [animals, groupName],
  );
  const chosenIds = mode === "group" ? groupAnimals.filter((a) => !excluded.has(a.id)).map((a) => a.id) : selectedAnimalId ? [selectedAnimalId] : [];

  const animalOptions: ComboboxOption[] = React.useMemo(
    () => (animals ?? []).map((a) => ({ value: a.id, label: animalLabel(a), sublabel: a.group_name ?? undefined })),
    [animals],
  );
  const productOptions: ComboboxOption[] = React.useMemo(() => products.map((p) => ({ value: p.id, label: p.name, sublabel: p.unit })), [products]);
  const product = products.find((p) => p.id === productId);
  const r = (route || null) as AdministrationRoute | null;

  function toggleExcluded(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          resetOwnState();
          formRef.current?.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <Plus className="size-4" /> Nauja vakcinacija
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Nauja vakcinacija</DialogTitle>
        </DialogHeader>
        <form ref={formRef} action={formAction}>
          <DialogBody className="space-y-4">
            {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}

            <input type="hidden" name="animal_ids" value={JSON.stringify(chosenIds)} />
            <input type="hidden" name="target_group_name" value={mode === "group" ? groupName : ""} />
            <input type="hidden" name="product_id" value={productId ?? ""} />
            <input type="hidden" name="unit" value={product?.unit ?? ""} />
            <input type="hidden" name="administration_route" value={route} />
            {visitId && <input type="hidden" name="visit_id" value={visitId} />}

            {!animalId && (
              <>
                <PillToggle
                  options={MODE_OPTIONS}
                  value={mode}
                  onChange={(m) => {
                    setMode(m);
                    setExcluded(new Set());
                  }}
                />
                {mode === "animal" ? (
                  <div>
                    <Label>Gyvūnas *</Label>
                    <Combobox options={animalOptions} value={selectedAnimalId} onChange={setSelectedAnimalId} placeholder="Pasirinkite gyvūną..." />
                  </div>
                ) : (
                  <div>
                    <Label htmlFor="vacc_group">Grupė *</Label>
                    <select
                      id="vacc_group"
                      value={groupName}
                      onChange={(e) => {
                        setGroupName(e.target.value);
                        setExcluded(new Set());
                      }}
                      className="h-9 w-full rounded-control border border-border bg-surface px-2 text-[14px]"
                    >
                      <option value="">Pasirinkite grupę...</option>
                      {(groups ?? []).map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                    {groupName && (
                      <div className="mt-2 max-h-48 overflow-y-auto rounded-control border border-border bg-surface-secondary p-2">
                        <p className="mb-1.5 text-[12px] text-text-secondary">
                          Pažymėta {chosenIds.length} iš {groupAnimals.length} — nuimkite varnelę nevakcinuotiems.
                        </p>
                        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                          {groupAnimals.map((a) => (
                            <label key={a.id} className="flex items-center gap-1.5 text-[12px] text-text-primary">
                              <input type="checkbox" checked={!excluded.has(a.id)} onChange={() => toggleExcluded(a.id)} />
                              {a.animal_no ? `Nr. ${a.animal_no}` : a.tag_no}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

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

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="vaccination_date">Data</Label>
                <Input id="vaccination_date" name="vaccination_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
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
                <input id="is_revaccination" name="is_revaccination" type="checkbox" className="size-4 rounded border-border-strong" />
                <Label htmlFor="is_revaccination" className="mb-0">
                  Pakartotinė vakcinacija
                </Label>
              </div>
              <div>
                <Label htmlFor="next_booster_date">Kita (pakartotinė) vakcinacija</Label>
                <Input id="next_booster_date" name="next_booster_date" type="date" />
              </div>
            </div>

            <div>
              <Label htmlFor="notes">Pastabos</Label>
              <Textarea id="notes" name="notes" rows={2} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Atšaukti
            </Button>
            <Button type="submit" disabled={pending || chosenIds.length === 0 || !productId}>
              {pending ? "Saugoma..." : chosenIds.length > 1 ? `Vakcinuoti ${chosenIds.length} gyv.` : "Sukurti"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

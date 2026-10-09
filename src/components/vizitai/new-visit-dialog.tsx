"use client";

import * as React from "react";
import { useActionState } from "react";
import { CalendarPlus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, Select } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { createVisit, type ActionResult } from "@/lib/actions/visits";
import { animalLabel, type AnimalOption } from "@/components/gyvunai/new-treatment-dialog";
import { SyncProtocolPicker } from "@/components/sinchronizacijos/protocol-picker";
import { VISIT_PROCEDURE_OPTIONS } from "@/lib/visits";
import type { VisitProcedure } from "@/lib/supabase/types";

const STATUS_OPTIONS = [
  { value: "planuojamas", label: "Planuojamas" },
  { value: "vykdomas", label: "Vykdomas" },
  { value: "baigtas", label: "Baigtas" },
];

// "Naujas vizitas" — schedule a check on an animal ("reikia patikrinti")
// without it implying medicine was (or will be) given. Procedures are tags;
// the actual treatment / vaccination is added later from the visit card.
//
// "Sinchronizacija" is the exception: it is not one visit but a protocol, so
// choosing it swaps the form to "pick a protocol + start date" and saving
// creates one planned visit per protocol step (apply_sync_protocol, 0025).
export function NewVisitDialog({
  animals,
  currentVetName,
  today,
  animalId,
  trigger,
  onCreated,
}: {
  animals?: AnimalOption[];
  currentVetName: string | null;
  today: string;
  /** Fixes the animal (e.g. opened from an animal's page) and hides the picker. */
  animalId?: string;
  trigger?: React.ReactNode;
  /** Fires after a visit is saved — lets a parent card refetch its history. */
  onCreated?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createVisit, null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const [selectedAnimalId, setSelectedAnimalId] = React.useState<string | null>(animalId ?? null);
  const [procedures, setProcedures] = React.useState<Set<VisitProcedure>>(new Set());
  const [nextVisitRequired, setNextVisitRequired] = React.useState(false);
  const [visitDate, setVisitDate] = React.useState(today);
  const [protocolId, setProtocolId] = React.useState("");

  const syncSelected = procedures.has("sinchronizacija");

  const animalOptions: ComboboxOption[] = React.useMemo(
    () => (animals ?? []).map((a) => ({ value: a.id, label: animalLabel(a), sublabel: a.group_name ?? undefined })),
    [animals],
  );

  function resetOwnState() {
    setSelectedAnimalId(animalId ?? null);
    setProcedures(new Set());
    setNextVisitRequired(false);
    setVisitDate(today);
    setProtocolId("");
  }

  // Sinchronizacija is exclusive: it creates the visits itself (one per step).
  function toggleProcedure(value: VisitProcedure) {
    setProcedures((prev) => {
      if (prev.has(value)) {
        const next = new Set(prev);
        next.delete(value);
        return next;
      }
      if (value === "sinchronizacija") return new Set<VisitProcedure>(["sinchronizacija"]);
      const next = new Set(prev);
      next.delete("sinchronizacija");
      next.add(value);
      return next;
    });
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
          <Button size="sm">
            <CalendarPlus className="size-4" /> Naujas vizitas
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Naujas vizitas</DialogTitle>
        </DialogHeader>
        <form ref={formRef} action={formAction}>
          <DialogBody className="space-y-4">
            {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}

            <input type="hidden" name="animal_id" value={selectedAnimalId ?? ""} />
            <input type="hidden" name="procedures" value={JSON.stringify(Array.from(procedures))} />

            {!animalId && (
              <div>
                <Label>Gyvūnas *</Label>
                <Combobox options={animalOptions} value={selectedAnimalId} onChange={setSelectedAnimalId} placeholder="Pasirinkite gyvūną..." />
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="nv_date">{syncSelected ? "Protokolo pradžios data *" : "Data *"}</Label>
                <Input id="nv_date" name="visit_date" type="date" value={visitDate} onChange={(e) => setVisitDate(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="nv_time">Laikas</Label>
                <Input id="nv_time" name="visit_time" type="time" defaultValue="09:00" />
              </div>
              {!syncSelected && (
                <div>
                  <Label htmlFor="nv_status">Būsena</Label>
                  <Select id="nv_status" name="status" defaultValue="planuojamas">
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>

            <div>
              <Label className="mb-2">Procedūros *</Label>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {VISIT_PROCEDURE_OPTIONS.map((p) => (
                  <label key={p.value} className="flex items-center gap-1.5 text-[13px]">
                    <input type="checkbox" checked={procedures.has(p.value)} onChange={() => toggleProcedure(p.value)} className="size-4 rounded border-border-strong" />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>

            {syncSelected && <SyncProtocolPicker open={open} startDate={visitDate} protocolId={protocolId} onChange={setProtocolId} />}

            <div className="grid gap-4 sm:grid-cols-2">
              {!syncSelected && (
                <div>
                  <Label htmlFor="nv_temperature">Temperatūra (°C)</Label>
                  <Input id="nv_temperature" name="temperature" type="number" step="0.1" min="30" max="45" />
                </div>
              )}
              <div>
                <Label htmlFor="nv_vet_name">Veterinarijos gydytojas</Label>
                <Input id="nv_vet_name" name="vet_name" defaultValue={currentVetName ?? undefined} />
              </div>
            </div>

            {!syncSelected && (
              <div>
                <Label htmlFor="nv_notes">Pastabos</Label>
                <Textarea id="nv_notes" name="notes" rows={2} />
              </div>
            )}

            {!syncSelected && (
              <div className="rounded-panel border border-border bg-surface-secondary p-3">
                <label className="flex items-center gap-2 text-[13px] font-medium">
                  <input
                    type="checkbox"
                    name="next_visit_required"
                    checked={nextVisitRequired}
                    onChange={(e) => setNextVisitRequired(e.target.checked)}
                    className="size-4 rounded border-border-strong"
                  />
                  Suplanuoti kitą vizitą
                </label>
                {nextVisitRequired && (
                  <div className="mt-3">
                    <Label htmlFor="nv_next_date">Kito vizito data *</Label>
                    <Input id="nv_next_date" name="next_visit_date" type="date" min={today} required />
                  </div>
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Atšaukti
            </Button>
            <Button type="submit" disabled={pending || !selectedAnimalId || procedures.size === 0 || (syncSelected && !protocolId)}>
              {pending ? "Saugoma..." : syncSelected ? "Pritaikyti protokolą" : "Sukurti vizitą"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

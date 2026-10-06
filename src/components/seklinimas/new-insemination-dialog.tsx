"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { createInsemination, type ActionResult } from "@/lib/actions/insemination";
import { animalLabel, type AnimalOption } from "@/components/gyvunai/new-treatment-dialog";
import { DEFAULT_PREGNANCY_CHECK_DAYS, addDays } from "@/lib/seklinimas";

export type SemenProduct = { id: string; name: string; unit: string };

const today = () => new Date().toISOString().slice(0, 10);

// "Naujas sėklinimas" — journal fields (Lithuania's insemination journal /
// VIC CSV) + semen and gloves taken from stock FEFO by create_insemination().
export function NewInseminationDialog({
  animalId,
  animals,
  sperm,
  gloves,
  currentVetName,
  trigger,
  onCreated,
}: {
  animalId?: string;
  animals?: AnimalOption[];
  sperm: SemenProduct[];
  gloves: SemenProduct[];
  currentVetName?: string | null;
  trigger?: React.ReactNode;
  /** Fires after an insemination is saved — lets a parent card refetch its history. */
  onCreated?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createInsemination, null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const [selectedAnimalId, setSelectedAnimalId] = React.useState<string | null>(animalId ?? null);
  const [spermId, setSpermId] = React.useState<string | null>(null);
  const [gloveId, setGloveId] = React.useState<string | null>(null);
  const [date, setDate] = React.useState(today());
  const [checkDate, setCheckDate] = React.useState<string | null>(null); // null = follow the suggestion
  const [manualNr, setManualNr] = React.useState(false);

  function resetOwnState() {
    setSelectedAnimalId(animalId ?? null);
    setSpermId(null);
    setGloveId(null);
    setDate(today());
    setCheckDate(null);
    setManualNr(false);
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

  const animalOptions: ComboboxOption[] = React.useMemo(
    () => (animals ?? []).map((a) => ({ value: a.id, label: animalLabel(a), sublabel: a.group_name ?? undefined })),
    [animals],
  );
  const spermOptions: ComboboxOption[] = React.useMemo(() => sperm.map((p) => ({ value: p.id, label: p.name, sublabel: p.unit })), [sperm]);
  const gloveOptions: ComboboxOption[] = React.useMemo(() => gloves.map((p) => ({ value: p.id, label: p.name, sublabel: p.unit })), [gloves]);
  const glove = gloves.find((g) => g.id === gloveId);

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
            <Plus className="size-4" /> Naujas sėklinimas
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Naujas sėklinimas</DialogTitle>
        </DialogHeader>
        <form ref={formRef} action={formAction}>
          <DialogBody className="space-y-4">
            {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}

            <input type="hidden" name="animal_id" value={selectedAnimalId ?? ""} />
            <input type="hidden" name="sperm_product_id" value={spermId ?? ""} />
            <input type="hidden" name="glove_product_id" value={gloveId ?? ""} />

            {!animalId && (
              <div>
                <Label>Gyvūnas *</Label>
                <Combobox options={animalOptions} value={selectedAnimalId} onChange={setSelectedAnimalId} placeholder="Pasirinkite gyvūną..." />
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="insemination_date">Sėklinimo data *</Label>
                <Input id="insemination_date" name="insemination_date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="seklintojo_kodas">Sėklintojo kodas</Label>
                <Input id="seklintojo_kodas" name="seklintojo_kodas" maxLength={10} className="uppercase" />
              </div>
              <div>
                <Label htmlFor="inseminator_name">Sėklintojas</Label>
                <Input id="inseminator_name" name="inseminator_name" defaultValue={currentVetName ?? undefined} />
              </div>
            </div>

            <div>
              <label className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-text-secondary">
                <input type="checkbox" checked={manualNr} onChange={(e) => setManualNr(e.target.checked)} className="size-4 rounded border-border-strong" />
                Pažymėjimo numerį įvesti rankiniu būdu
              </label>
              {manualNr ? (
                <Input name="pazymejimo_nr" placeholder="Pažymėjimo Nr." />
              ) : (
                <Input readOnly value="Bus sugeneruotas automatiškai (metai + sėklintojo kodas + Nr.)" className="bg-surface-secondary text-text-muted" />
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
              <div>
                <Label>Sperma (iš atsargų)</Label>
                <Combobox options={spermOptions} value={spermId} onChange={setSpermId} placeholder="Pasirinkite spermą (neprivaloma)..." />
              </div>
              <div>
                <Label htmlFor="sperm_quantity">Dozių</Label>
                <Input id="sperm_quantity" name="sperm_quantity" type="number" step="1" min="1" defaultValue={1} disabled={!spermId} />
              </div>
            </div>
            {sperm.length === 0 && (
              <p className="text-[12px] text-text-secondary">
                Spermos atsargų nėra — sukurkite produktą (tipas „Reprodukcija (sperma)“) ir pajamuokite. Bulių duomenis galima įvesti ir rankiniu būdu.
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="bull_name">Buliaus pavadinimas</Label>
                <Input id="bull_name" name="bull_name" />
              </div>
              <div>
                <Label htmlFor="reproduktoriaus_id">Reproduktoriaus ID (KK Nr.)</Label>
                <Input id="reproduktoriaus_id" name="reproduktoriaus_id" />
              </div>
              <div>
                <Label htmlFor="reproduktoriaus_kk_kodas">KK kodas</Label>
                <Input id="reproduktoriaus_kk_kodas" name="reproduktoriaus_kk_kodas" defaultValue="0" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="imones_kodas">Įmonės kodas</Label>
                <Input id="imones_kodas" name="imones_kodas" />
              </div>
              <div>
                <Label htmlFor="sp_savininkas">Dozių savininkas</Label>
                <Input id="sp_savininkas" name="sp_savininkas" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
              <div>
                <Label>Pirštinės (iš atsargų)</Label>
                <Combobox options={gloveOptions} value={gloveId} onChange={setGloveId} placeholder="Pasirinkite (neprivaloma)..." />
              </div>
              <div>
                <Label htmlFor="glove_quantity">Kiekis{glove ? ` (${glove.unit})` : ""}</Label>
                <Input id="glove_quantity" name="glove_quantity" type="number" step="1" min="1" defaultValue={1} disabled={!gloveId} />
              </div>
            </div>

            <div>
              <Label htmlFor="next_pregnancy_check_date">Nėštumo patikra</Label>
              <Input
                id="next_pregnancy_check_date"
                name="next_pregnancy_check_date"
                type="date"
                value={checkDate ?? addDays(date || today(), DEFAULT_PREGNANCY_CHECK_DAYS)}
                onChange={(e) => setCheckDate(e.target.value)}
              />
              <p className="mt-1 text-[12px] text-text-secondary">Siūloma po {DEFAULT_PREGNANCY_CHECK_DAYS} d. Numatomas apsiveršiavimas: sėklinimo data + 283 d.</p>
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
            <Button type="submit" disabled={pending || !selectedAnimalId}>
              {pending ? "Saugoma..." : "Sukurti"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

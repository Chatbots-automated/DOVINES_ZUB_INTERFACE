"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, Select } from "@/components/ui/input";
import { createAnimal, type ActionResult } from "@/lib/actions/animals";
import { OTHER_OPTION, SEX_OPTIONS, SPECIES_OPTIONS } from "@/lib/animal-options";

export function NewAnimalDialog() {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createAnimal, null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const [species, setSpecies] = React.useState("galvijas");
  const [sex, setSex] = React.useState("");

  function resetOwnState() {
    setSpecies("galvijas");
    setSex("");
  }

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) {
      setOpen(false);
      resetOwnState();
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
          formRef.current?.reset();
          resetOwnState();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Naujas gyvūnas
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Naujas gyvūnas</DialogTitle>
        </DialogHeader>
        <form ref={formRef} action={formAction}>
          <DialogBody className="space-y-4">
            {state && !state.ok && state.error && (
              <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="tag_no">Numeris *</Label>
                <Input id="tag_no" name="tag_no" required autoFocus placeholder="LT123456789" />
              </div>
              <div>
                <Label htmlFor="animal_no">Ūkio Nr.</Label>
                <Input id="animal_no" name="animal_no" placeholder="512" />
              </div>
              <div>
                <Label htmlFor="species">Rūšis</Label>
                <Select id="species" name="species" value={species} onChange={(e) => setSpecies(e.target.value)}>
                  {SPECIES_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                  <option value={OTHER_OPTION}>Kita...</option>
                </Select>
                {species === OTHER_OPTION && (
                  <Input name="species_other" required className="mt-2" placeholder="Nurodykite rūšį" aria-label="Kita rūšis" />
                )}
              </div>
              <div>
                <Label htmlFor="sex">Lytis / kategorija</Label>
                <Select id="sex" name="sex" value={sex} onChange={(e) => setSex(e.target.value)}>
                  <option value="">— nenurodyta —</option>
                  {SEX_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                  <option value={OTHER_OPTION}>Kita...</option>
                </Select>
                {sex === OTHER_OPTION && <Input name="sex_other" required className="mt-2" placeholder="Nurodykite kategoriją" aria-label="Kita kategorija" />}
              </div>
              <div>
                <Label htmlFor="breed">Veislė</Label>
                <Input id="breed" name="breed" placeholder="Holšteinas" />
              </div>
              <div>
                <Label htmlFor="birth_date">Gimimo data</Label>
                <Input id="birth_date" name="birth_date" type="date" />
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
            <Button type="submit" disabled={pending}>
              {pending ? "Saugoma..." : "Sukurti"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

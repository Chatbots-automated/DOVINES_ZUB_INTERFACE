"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { createMedicalWaste, type ActionResult } from "@/lib/actions/medical-waste";

export function NewMedicalWasteDialog() {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createMedicalWaste, null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) setOpen(false);
  }
  React.useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const today = new Date().toISOString().slice(0, 10);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="size-4" /> Registruoti atliekas / perdavimą
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Veterinarinės medicininės atliekos</DialogTitle>
        </DialogHeader>
        <form ref={formRef} action={formAction}>
          <DialogBody className="space-y-4">
            {state && !state.ok && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="mw_name">Atliekos *</Label>
                <Input id="mw_name" name="name" required placeholder="Pvz. panaudoti švirkštai, tuščios vaistų pakuotės" />
              </div>
              <div>
                <Label htmlFor="mw_code">Atliekų kodas</Label>
                <Input id="mw_code" name="waste_code" placeholder="18 02 02*" />
              </div>
              <div>
                <Label htmlFor="mw_date">Susidarymo data</Label>
                <Input id="mw_date" name="waste_date" type="date" defaultValue={today} />
              </div>
              <div>
                <Label htmlFor="mw_gen">Susidarė (kg / g)</Label>
                <Input id="mw_gen" name="qty_generated" type="number" step="any" min="0" />
              </div>
              <div>
                <Label htmlFor="mw_tr">Perduota</Label>
                <Input id="mw_tr" name="qty_transferred" type="number" step="any" min="0" />
              </div>
              <div>
                <Label htmlFor="mw_trd">Perdavimo data</Label>
                <Input id="mw_trd" name="transfer_date" type="date" />
              </div>
              <div>
                <Label htmlFor="mw_doc">Dokumento Nr.</Label>
                <Input id="mw_doc" name="doc_no" />
              </div>
              <div>
                <Label htmlFor="mw_car">Vežėjas</Label>
                <Input id="mw_car" name="carrier" />
              </div>
              <div>
                <Label htmlFor="mw_proc">Tvarkytojas</Label>
                <Input id="mw_proc" name="processor" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="mw_resp">Atsakingas asmuo</Label>
                <Input id="mw_resp" name="responsible" />
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Atšaukti
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saugoma..." : "Išsaugoti"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

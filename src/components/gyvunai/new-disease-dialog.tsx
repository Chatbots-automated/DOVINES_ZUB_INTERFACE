"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { createDisease, type CreatedDisease, type DiseaseActionResult } from "@/lib/actions/diseases";

export function NewDiseaseDialog({ defaultName, onCreated }: { defaultName?: string; onCreated?: (disease: CreatedDisease) => void }) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<DiseaseActionResult | null, FormData>(createDisease, null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) setOpen(false);
  }

  const onCreatedRef = React.useRef(onCreated);
  React.useEffect(() => {
    onCreatedRef.current = onCreated;
  }, [onCreated]);

  React.useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      onCreatedRef.current?.(state.disease);
    }
  }, [state]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) formRef.current?.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Plus className="size-4" /> Nauja liga
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nauja liga</DialogTitle>
        </DialogHeader>
        <form ref={formRef} action={formAction}>
          <DialogBody className="space-y-4">
            {state && !state.ok && state.error && (
              <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>
            )}
            <div>
              <Label htmlFor="disease-name">Pavadinimas *</Label>
              <Input id="disease-name" name="name" required autoFocus defaultValue={defaultName} key={defaultName} />
            </div>
            <div>
              <Label htmlFor="disease-code">Kodas</Label>
              <Input id="disease-code" name="code" placeholder="Neprivaloma" />
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

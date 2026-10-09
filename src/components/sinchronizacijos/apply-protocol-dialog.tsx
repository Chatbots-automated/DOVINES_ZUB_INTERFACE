"use client";

import * as React from "react";
import { useActionState } from "react";
import { Repeat } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { SyncProtocolPicker } from "@/components/sinchronizacijos/protocol-picker";
import { applySyncProtocol, type ActionResult } from "@/lib/actions/sync-protocols";

// "Sinchronizacija" on an animal — pick one of the farm's protocols and its
// start date; one planned visit per step is created (apply_sync_protocol,
// 0025). Same action and picker as Naujas vizitas → Sinchronizacija.
export function ApplySyncProtocolDialog({
  animalId,
  currentVetName,
  today,
  title = "Sinchronizacija",
  trigger,
  onCreated,
}: {
  animalId: string;
  currentVetName: string | null;
  today: string;
  title?: string;
  trigger?: React.ReactNode;
  /** Fires after the protocol is applied — lets a parent refetch the animal's history. */
  onCreated?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(applySyncProtocol, null);
  const [startDate, setStartDate] = React.useState(today);
  const [protocolId, setProtocolId] = React.useState("");

  function reset() {
    setStartDate(today);
    setProtocolId("");
  }

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) {
      setOpen(false);
      reset();
      onCreated?.();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <Repeat className="size-4" /> Sinchronizacija
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form action={formAction}>
          <DialogBody className="space-y-4">
            {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
            <input type="hidden" name="animal_id" value={animalId} />

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="asp_date">Protokolo pradžios data *</Label>
                <Input id="asp_date" name="visit_date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="asp_time">Laikas</Label>
                <Input id="asp_time" name="visit_time" type="time" defaultValue="09:00" />
              </div>
              <div>
                <Label htmlFor="asp_vet">Veterinarijos gydytojas</Label>
                <Input id="asp_vet" name="vet_name" defaultValue={currentVetName ?? undefined} />
              </div>
            </div>

            <SyncProtocolPicker open={open} startDate={startDate} protocolId={protocolId} onChange={setProtocolId} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Atšaukti
            </Button>
            <Button type="submit" disabled={pending || !protocolId || !startDate}>
              {pending ? "Saugoma..." : "Pritaikyti protokolą"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

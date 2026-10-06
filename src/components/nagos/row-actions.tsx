"use client";

import { useActionState } from "react";
import { CheckCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { completeHoofFollowup, deleteHoofExam, type ActionResult } from "@/lib/actions/hoof";

export function CompleteFollowupButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(completeHoofFollowup, null);
  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        <CheckCheck className="size-4" /> Atlikta
      </Button>
      {state && !state.ok && <span className="text-[11px] text-danger">{state.error}</span>}
    </form>
  );
}

export function DeleteHoofExamButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(deleteHoofExam, null);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm("Ištrinti visą šią apžiūrą? Sunaudoti produktai bus grąžinti į atsargas.")) e.preventDefault();
      }}
      className="flex flex-col items-end gap-1"
    >
      <input type="hidden" name="id" value={id} />
      <Button type="submit" size="icon" variant="ghost" className="h-8 w-8" disabled={pending} aria-label="Ištrinti apžiūrą">
        <Trash2 className="size-4" />
      </Button>
      {state && !state.ok && <span className="max-w-[260px] text-right text-[11px] text-danger">{state.error}</span>}
    </form>
  );
}

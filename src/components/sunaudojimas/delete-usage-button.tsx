"use client";

import { useActionState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteGeneralUsage, type GeneralUsageActionResult } from "@/lib/actions/general-usage";

export function DeleteUsageButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState<GeneralUsageActionResult | null, FormData>(deleteGeneralUsage, null);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm("Ištrinti šį sunaudojimo įrašą? Kiekis bus grąžintas į atsargas.")) e.preventDefault();
      }}
      className="flex flex-col items-end gap-1"
    >
      <input type="hidden" name="id" value={id} />
      <Button type="submit" size="icon" variant="ghost" className="h-8 w-8" disabled={pending} aria-label="Ištrinti">
        <Trash2 className="size-4" />
      </Button>
      {state && !state.ok && <span className="max-w-[260px] text-right text-[11px] text-danger">{state.error}</span>}
    </form>
  );
}

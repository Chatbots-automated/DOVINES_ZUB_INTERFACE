"use client";

import * as React from "react";
import { useActionState } from "react";
import { Check, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { deleteInsemination, setPregnancyResult, type ActionResult } from "@/lib/actions/insemination";
import { PREGNANCY_LABELS, pregnancyStatus } from "@/lib/seklinimas";

// Tri-state pregnancy badge + result buttons (Laukiama / Patvirtinta /
// Nepatvirtinta). Each button submits the same form with its own `result`.
export function PregnancyActions({ id, confirmed }: { id: string; confirmed: boolean | null }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(setPregnancyResult, null);
  const status = pregnancyStatus(confirmed);
  const tone = status === "confirmed" ? "success" : status === "not_confirmed" ? "danger" : "neutral";

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="id" value={id} />
      <Badge tone={tone}>{PREGNANCY_LABELS[status]}</Badge>
      {status !== "confirmed" && (
        <Button type="submit" name="result" value="confirmed" size="sm" variant="outline" disabled={pending} title="Patvirtinti nėštumą">
          <Check className="size-3.5" /> Nėščia
        </Button>
      )}
      {status !== "not_confirmed" && (
        <Button type="submit" name="result" value="not_confirmed" size="sm" variant="outline" disabled={pending} title="Nėštumas nepatvirtintas">
          <X className="size-3.5" /> Ne
        </Button>
      )}
      {status !== "pending" && (
        <Button type="submit" name="result" value="pending" size="sm" variant="ghost" disabled={pending} title="Grąžinti į „Laukiama“">
          <Undo2 className="size-3.5" />
        </Button>
      )}
      {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
    </form>
  );
}

export function DeleteInseminationButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(deleteInsemination, null);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm("Ištrinti sėklinimo įrašą? Sunaudotos dozės grįš į atsargas.")) e.preventDefault();
      }}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="id" value={id} />
      <Button type="submit" size="sm" variant="ghost" disabled={pending} title="Ištrinti">
        <Trash2 className="size-4" />
      </Button>
      {state && !state.ok && <span className="max-w-[220px] text-[12px] text-danger">{state.error}</span>}
    </form>
  );
}

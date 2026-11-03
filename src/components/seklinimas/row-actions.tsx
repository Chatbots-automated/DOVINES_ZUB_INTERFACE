"use client";

import * as React from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, RefreshCw, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { deleteInsemination, setPregnancyResult, type ActionResult } from "@/lib/actions/insemination";
import { PREGNANCY_LABELS, pregnancyStatus } from "@/lib/seklinimas";
import { delproInseminationPost } from "@/lib/seklinimas-delpro-client";

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

/** DelPro-imported row (0053): re-read this animal from DelPro; "Palikti abu" for a flagged possible duplicate. Never deletes. */
export function DelproRowActions({ id, animalId, duplicate }: { id: string; animalId: string; duplicate: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  async function run(key: string, op: "request" | "dismiss_duplicate", payload: Record<string, unknown>) {
    setBusy(key);
    const res = await delproInseminationPost(op, payload);
    setBusy(null);
    setMessage(res.ok ? { ok: true, text: res.data?.message ?? "Atlikta." } : { ok: false, text: res.error });
    if (res.ok) router.refresh();
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        {duplicate && (
          <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={() => run("dup", "dismiss_duplicate", { id })} title="Tai du skirtingi sėklinimai">
            Palikti abu
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={() => run("req", "request", { animal_ids: [animalId] })} title="Atnaujinti šį gyvulį iš DelPro">
          {busy === "req" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
      </div>
      {message && <span className={`max-w-[220px] text-right text-[12px] ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</span>}
    </div>
  );
}

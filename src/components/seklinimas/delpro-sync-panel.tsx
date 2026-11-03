"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { vilniusDateTime } from "@/lib/seklinimas";
import { delproInseminationPost } from "@/lib/seklinimas-delpro-client";
import type { DelproInseminationStatus } from "@/lib/supabase/types";

export type DelproScanProblem = {
  animal_id: string;
  tag_no: string;
  animal_no: string | null;
  checked_at: string | null;
  ok: boolean | null;
  error: string | null;
  invalid: { guid: string | null; error: string }[];
};

const MIN = 60_000;

/** DelPro -> GVET inseminations (0053): state of the import, "Atnaujinti iš DelPro" by ORN, and animals whose read had problems. */
export function DelproSyncPanel({ status, problems, canWrite }: { status: DelproInseminationStatus | null; problems: DelproScanProblem[]; canWrite: boolean }) {
  const router = useRouter();
  const [now] = React.useState(() => Date.now());
  const [open, setOpen] = React.useState(false);
  const [tag, setTag] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);

  const on = status?.source === "gateway";
  const seenMin = status?.worker_seen_at ? (now - Date.parse(status.worker_seen_at.replace(" ", "T"))) / MIN : Infinity;
  const workerOk = seenMin < 5;
  const last = status?.last_round;

  async function request(key: string, payload: Record<string, unknown>) {
    setBusy(key);
    setMessage(null);
    const res = await delproInseminationPost("request", payload);
    setBusy(null);
    setMessage(res.ok ? { ok: true, text: res.data?.message ?? "Paprašyta." } : { ok: false, text: res.error });
    if (res.ok) router.refresh();
  }

  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-[13px]">
        <span className="font-medium text-text-primary">DelPro → GVET sėklinimai</span>
        <Badge tone={on && workerOk ? "success" : on ? "warning" : "neutral"}>
          {on ? (workerOk ? "Automatinis importas veikia" : "Ūkio kompiuteris neatsako") : "Automatinis importas išjungtas"}
        </Badge>
        <span className="text-text-muted">
          importuota {status?.imported ?? 0} · nuskaityta {status?.read_animals ?? 0} iš {status?.linked_animals ?? 0} susietų gyv.
          {last?.finished_at ? ` · paskutinis nuskaitymas ${vilniusDateTime(last.finished_at)}` : ""}
        </span>
        {(status?.problem_animals ?? 0) > 0 && <Badge tone="danger">Problemų: {status?.problem_animals}</Badge>}
        {(status?.possible_duplicates ?? 0) > 0 && <Badge tone="warning">Galimi dublikatai: {status?.possible_duplicates}</Badge>}
        {(status?.pending_requests ?? 0) > 0 && <Badge tone="accent">Laukia nuskaitymo: {status?.pending_requests}</Badge>}
        <button type="button" className="ml-auto flex items-center gap-1 text-text-secondary hover:text-text-primary" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />} {open ? "Suskleisti" : "Daugiau"}
        </button>
      </div>
      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3 text-[13px]">
          <p className="text-text-secondary">
            Ūkio kompiuteris DelPro sėklinimus tik skaito (InseminationEvent + AnimalEvent) ir įrašo į šį žurnalą. Data rodoma Lietuvos laiku. DelPro įrašų čia
            ištrinti ar keisti DelPro laukų negalima — taisykite DelPro, kitas nuskaitymas atnaujins. Nėštumo patikrą galima žymėti kaip įprastai.
            {!on && " Įjungiama ūkio kompiuteryje: INSEMINATION_SOURCE=gateway."}
          </p>
          {canWrite && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (tag.trim()) void request("tag", { tags: [tag.trim()] });
              }}
            >
              <Input className="h-8 w-64" placeholder="ORN, pvz. LT000009526299" value={tag} onChange={(e) => setTag(e.target.value)} />
              <Button type="submit" size="sm" variant="outline" disabled={!tag.trim() || !!busy}>
                {busy === "tag" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Atnaujinti iš DelPro
              </Button>
            </form>
          )}
          {message && <p className={message.ok ? "text-success" : "text-danger"}>{message.text}</p>}
          {problems.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1.5 font-medium text-text-primary">
                <AlertTriangle className="size-4 text-warning" /> Gyvuliai, kurių sėklinimai nuskaityti ne iki galo
              </p>
              <ul className="divide-y divide-border rounded-control border border-border">
                {problems.map((p) => (
                  <li key={p.animal_id} className="flex flex-wrap items-start gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-text-primary">{p.animal_no ? `Nr. ${p.animal_no}` : p.tag_no}</span>{" "}
                      <span className="text-text-muted">{p.tag_no} · {vilniusDateTime(p.checked_at)}</span>
                      <span className={cn("block text-[12px]", p.ok === false ? "text-danger" : "text-warning")}>
                        {p.ok === false ? `Nenuskaityta: ${p.error ?? "klaida"}` : (p.error ?? "Nepilnas nuskaitymas")}
                      </span>
                      {p.invalid.slice(0, 5).map((i, n) => (
                        <span key={n} className="block font-mono text-[11px] text-text-muted">
                          {i.guid ?? "?"}: {i.error}
                        </span>
                      ))}
                    </span>
                    {canWrite && (
                      <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={() => request(p.animal_id, { animal_ids: [p.animal_id] })}>
                        {busy === p.animal_id ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Kartoti
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

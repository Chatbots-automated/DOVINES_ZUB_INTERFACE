"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { parsePgTimestamp, vilniusDateTime } from "@/lib/seklinimas";
import { delproInseminationPost } from "@/lib/seklinimas-delpro-client";
import type { DelproInseminationStatus } from "@/lib/supabase/types";

/** One shared semen name (0055): DelPro Semen.Key, what DelPro calls it, a staff name, and how many inseminations use it. */
export type DelproSemenItem = {
  semen_key: string;
  delpro_name: string | null;
  delpro_comment: string | null;
  name_override: string | null;
  count: number;
};

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
export function DelproSyncPanel({
  status,
  problems,
  semen,
  canWrite,
}: {
  status: DelproInseminationStatus | null;
  problems: DelproScanProblem[];
  semen: DelproSemenItem[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [now] = React.useState(() => Date.now());
  const [open, setOpen] = React.useState(false);
  const [tag, setTag] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);

  const on = status?.source === "gateway";
  // worker_seen_at is Postgres text ("2026-11-03 21:20:12.123+00") — parsed properly, else it always looked "not answering"
  const seen = parsePgTimestamp(status?.worker_seen_at);
  const seenMin = Number.isFinite(seen) ? (now - seen) / MIN : Infinity;
  const workerOk = seenMin < 5;
  const unnamed = semen.filter((x) => !(x.name_override ?? x.delpro_name)).length;
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
        {unnamed > 0 && <Badge tone="warning">Sperma be pavadinimo: {unnamed}</Badge>}
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
          <SemenNames semen={semen} canWrite={canWrite} />
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

/** Shared semen names (0055): one name per DelPro Semen.Key, used by every insemination with that key. */
function SemenNames({ semen, canWrite }: { semen: DelproSemenItem[]; canWrite: boolean }) {
  const router = useRouter();
  const [edit, setEdit] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  if (semen.length === 0) return null;
  // keys without any name first, then the most used
  const sorted = [...semen].sort((a, b) => Number(!!(a.name_override ?? a.delpro_name)) - Number(!!(b.name_override ?? b.delpro_name)) || b.count - a.count);
  const shown = showAll ? sorted : sorted.slice(0, 12);

  async function save(key: string, name: string) {
    setBusy(key);
    const res = await delproInseminationPost("set_semen_name", { semen_key: key, name });
    setBusy(null);
    setMessage(res.ok ? { ok: true, text: res.data?.message ?? "Išsaugota." } : { ok: false, text: res.error });
    if (res.ok) {
      setEdit((e) => {
        const n = { ...e };
        delete n[key];
        return n;
      });
      router.refresh();
    }
  }

  return (
    <div>
      <p className="mb-1 font-medium text-text-primary">Spermos pavadinimai</p>
      <p className="mb-2 text-[12px] text-text-muted">
        Vienas pavadinimas kiekvienai DelPro spermai (Semen raktui) — rodomas visuose jos sėklinimuose. Pavadinimą ūkio kompiuteris paima iš DelPro
        (SemenName); jei DelPro jo negrąžina ar norite kito, įrašykite čia. Tai ne buliaus KK numeris.
      </p>
      <div className="overflow-x-auto rounded-control border border-border">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-surface-secondary text-[11px] uppercase tracking-wide text-text-secondary">
            <tr>
              <th className="px-3 py-2 font-medium">Raktas</th>
              <th className="px-3 py-2 font-medium">DelPro pavadinimas</th>
              <th className="px-3 py-2 font-medium">Rodomas pavadinimas</th>
              <th className="px-3 py-2 text-right font-medium">Sėklinimų</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((x) => {
              const display = x.name_override ?? x.delpro_name;
              const value = edit[x.semen_key];
              return (
                <tr key={x.semen_key}>
                  <td className="px-3 py-1.5 font-mono text-text-secondary">#{x.semen_key}</td>
                  <td className="px-3 py-1.5 text-text-secondary">
                    {x.delpro_name ?? <span className="text-warning">nenuskaityta</span>}
                    {x.delpro_comment && <span className="block text-[11px] text-text-muted">{x.delpro_comment}</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    {canWrite && value !== undefined ? (
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void save(x.semen_key, value);
                        }}
                      >
                        <Input className="h-7 w-48" value={value} maxLength={120} placeholder={x.delpro_name ?? "pavadinimas"} onChange={(e) => setEdit((s) => ({ ...s, [x.semen_key]: e.target.value }))} />
                        <Button type="submit" size="sm" disabled={busy === x.semen_key}>
                          {busy === x.semen_key ? <Loader2 className="size-4 animate-spin" /> : "Išsaugoti"}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setEdit((s) => { const n = { ...s }; delete n[x.semen_key]; return n; })}>
                          Atšaukti
                        </Button>
                      </form>
                    ) : (
                      <span className="flex items-center gap-2">
                        <span className={display ? "text-text-primary" : "text-text-muted"}>{display ?? `Sperma #${x.semen_key}`}</span>
                        {x.name_override && <Badge tone="accent">GVET</Badge>}
                        {canWrite && (
                          <button type="button" className="text-[12px] text-text-secondary underline" onClick={() => setEdit((s) => ({ ...s, [x.semen_key]: x.name_override ?? "" }))}>
                            {display ? "keisti" : "įrašyti"}
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right text-text-secondary">{x.count}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > shown.length && (
        <button type="button" className="mt-1 text-[12px] text-text-secondary underline" onClick={() => setShowAll(true)}>
          Rodyti visas ({sorted.length})
        </button>
      )}
      {message && <p className={cn("mt-1 text-[12px]", message.ok ? "text-success" : "text-danger")}>{message.text}</p>}
      <p className="mt-1 text-[11px] text-text-muted">Palikus tuščią ir išsaugojus, grąžinamas DelPro pavadinimas.</p>
    </div>
  );
}

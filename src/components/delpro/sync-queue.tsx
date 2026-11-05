"use client";

import * as React from "react";
import { Ban, CheckCheck, RefreshCw, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ActionButton } from "@/components/delpro/action-button";
import { HowTo } from "@/components/delpro/how-to";
import { QuickFixButton } from "@/components/delpro/quick-fix-dialog";
import { DELPRO_STATUS_LABEL as STATUS_LABEL, DELPRO_STATUS_TONE as STATUS_TONE, problemLabel } from "@/lib/delpro-status";
import { findHelp } from "@/lib/delpro-help";
import { formatDate, formatDateTime, formatQty } from "@/lib/utils";
import type { Database, DelproPayload, DelproSyncJobStatus } from "@/lib/supabase/types";
import { useDelproAction } from "@/lib/use-delpro-action";

export type QueueJob = Database["public"]["Views"]["vw_delpro_sync_jobs"]["Row"];

function animalLabel(j: QueueJob) {
  return j.animal_no ? `Nr. ${j.animal_no} · ${j.tag_no}` : j.tag_no;
}

function PayloadSummary({ payload }: { payload: DelproPayload | null }) {
  if (!payload) return <span className="text-text-muted">—</span>;
  const d = payload.delpro;
  const ui = d.ui_entry;
  const diagnosis = ui?.diagnosis_name ?? d.diagnosis ?? "—";
  const medicine =
    d.products.length > 1
      ? `${d.products.length} vaistai`
      : ui?.medicine_name
        ? `${ui.medicine_name}${ui.dose != null ? ` · ${formatQty(ui.dose, ui.dose_unit)}` : ""}`
        : d.products.map((p) => `${p.name} ${p.qty} ${p.unit ?? ""}`).join(", ") || "—";
  return (
    <p className="truncate text-[12px] text-text-secondary" title={`${diagnosis} · ${medicine}`}>
      {diagnosis} · {medicine}
      {ui ? ` · ${ui.course_days} d.` : ""}
    </p>
  );
}

/** A short "what to do" line from the help guide, under a problem or an error. */
function Fix({ text }: { text: string | null | undefined }) {
  const help = findHelp(text);
  if (!help) return null;
  return (
    <p className="mt-0.5 text-[12px] text-text-secondary">
      <span className="font-semibold text-text-primary">Ką daryti: </span>
      {help.short} <span className="text-text-muted">(plačiau — „Jei kas nors neveikia“)</span>
    </p>
  );
}

function Problems({ problems }: { problems: QueueJob["preview_problems"] }) {
  if (!problems || problems.length === 0) return null;
  const seen = new Set<string>();
  return (
    <div className="mt-1 space-y-1">
      {problems.map((p, i) => (
        <p key={p.code + (p.fix?.local_id ?? "") + i} className="flex flex-wrap items-center gap-1.5 text-[12px] text-danger">
          <Badge tone="danger">{problemLabel(p)}</Badge>
          {p.message && p.message !== problemLabel(p) && <span>{p.message}</span>}
        </p>
      ))}
      {problems.map((p) => {
        const help = findHelp(p.code) ?? findHelp(p.message);
        if (!help || seen.has(help.id)) return null;
        seen.add(help.id);
        return <Fix key={help.id} text={findHelp(p.code) ? p.code : p.message} />;
      })}
    </div>
  );
}

function ResultDiff({ job }: { job: QueueJob }) {
  if (!job.actual_result || !job.approved_payload) return null;
  const expected: Record<string, unknown> = {
    "Gyvulio Nr.": job.approved_payload.animal.animal_no,
    Data: job.approved_payload.delpro.event_date,
    "Karencija pienui (d.)": job.approved_payload.delpro.milk_withdrawal_days,
    "Karencija mėsai (d.)": job.approved_payload.delpro.meat_withdrawal_days,
  };
  const keys = ["animal_no", "event_date", "milk_withdrawal_days", "meat_withdrawal_days"];
  return (
    <table className="mt-2 text-[11.5px]">
      <thead>
        <tr className="text-text-muted">
          <th className="pr-3 text-left font-medium">Laukas</th>
          <th className="pr-3 text-left font-medium">Siųsta</th>
          <th className="text-left font-medium">DelPro įrašyta</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(expected).map(([label, v], i) => {
          const actual = job.actual_result?.[keys[i]];
          const same = String(actual ?? "") === String(v ?? "");
          return (
            <tr key={label} className={same ? "" : "text-danger"}>
              <td className="pr-3">{label}</td>
              <td className="pr-3">{String(v ?? "—")}</td>
              <td>{String(actual ?? "—")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function useSelection() {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return { selected, setSelected, toggle };
}

/** "Atmesti pažymėtus" — one confirmation for the whole selection (0065). */
function RejectSelected({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const [state, formAction, pending] = useDelproAction("rejectDelproJobs");
  const [handled, setHandled] = React.useState(state);
  if (state !== handled) {
    setHandled(state);
    if (state?.ok) onDone();
  }
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(`Atmesti ${ids.length} įraš.? Į DelPro jie nebus siunčiami. Gydymai GVET lieka.`)) e.preventDefault();
      }}
      className="inline-flex items-center gap-2"
    >
      <input type="hidden" name="job_ids" value={JSON.stringify(ids)} />
      <Button type="submit" size="sm" variant="outline" disabled={pending || ids.length === 0}>
        <Ban className="size-4" /> {pending ? "Atmetama..." : `Atmesti pažymėtus (${ids.length})`}
      </Button>
      {state?.ok && state.message && <span className="text-[12px] text-success">{state.message}</span>}
      {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
    </form>
  );
}

function SelectAll({ jobs, selected, setSelected }: { jobs: QueueJob[]; selected: Set<string>; setSelected: (s: Set<string>) => void }) {
  const all = jobs.length > 0 && jobs.every((j) => selected.has(j.id));
  return (
    <label className="flex items-center gap-2 text-[13px] text-text-secondary">
      <input type="checkbox" className="size-4" checked={all} onChange={() => setSelected(all ? new Set() : new Set(jobs.map((j) => j.id)))} />
      Pažymėti visus ({jobs.length})
    </label>
  );
}

function PendingList({ jobs, waiting }: { jobs: QueueJob[]; waiting: Set<string> }) {
  const { selected, setSelected, toggle } = useSelection();
  const [state, formAction, pending] = useDelproAction("approveDelproJobs");

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) setSelected(new Set());
  }

  const ready = (j: QueueJob) => (j.preview_problems ?? []).length === 0;
  const readyCount = jobs.filter(ready).length;
  const sendIds = jobs.filter((j) => selected.has(j.id) && ready(j)).map((j) => j.id);
  const blockedSelected = jobs.filter((j) => selected.has(j.id) && !ready(j)).length;

  if (jobs.length === 0) return <EmptyState icon={CheckCheck} title="Nieko nelaukia" description="Visi gydymai išsiųsti arba dar neįvesti." className="py-8" />;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <SelectAll jobs={jobs} selected={selected} setSelected={setSelected} />
        <button type="button" className="text-[12.5px] font-medium text-accent hover:underline" onClick={() => setSelected(new Set(jobs.filter(ready).map((j) => j.id)))}>
          Pažymėti tik paruoštus ({readyCount})
        </button>
        <form action={formAction} className="inline-flex items-center gap-2">
          <input type="hidden" name="job_ids" value={JSON.stringify(sendIds)} />
          <Button type="submit" size="sm" disabled={pending || sendIds.length === 0}>
            <Send className="size-4" /> {pending ? "Siunčiama..." : `Siųsti pažymėtus į DelPro (${sendIds.length})`}
          </Button>
        </form>
        <RejectSelected ids={[...selected]} onDone={() => setSelected(new Set())} />
        {state?.ok && state.message && <span className="text-[12px] text-success">{state.message}</span>}
        {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
        {blockedSelected > 0 && (
          <span className="text-[12px] text-text-muted">{blockedSelected} pažymėt. su klaida nebus siunčiami — juos galima tik atmesti arba pataisyti.</span>
        )}
      </div>
      <div className="divide-y divide-border">
        {jobs.map((j) => (
          <label key={j.id} className={`flex cursor-pointer items-start gap-3 px-5 py-2.5 ${selected.has(j.id) ? "bg-accent-soft/40" : ""}`}>
            <input type="checkbox" className="mt-1 size-4" checked={selected.has(j.id)} onChange={() => toggle(j.id)} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-text-primary">
                {animalLabel(j)} <span className="font-normal text-text-muted">· gydyta {formatDate(j.reg_date)}</span>
                {ready(j) ? <Badge tone="success">Paruošta</Badge> : <Badge tone="danger">Reikia pataisyti</Badge>}
              </p>
              <PayloadSummary payload={j.preview_payload} />
              <Problems problems={j.preview_problems} />
              {j.error && (
                <>
                  <p className="mt-0.5 text-[12px] text-text-muted">{j.error}</p>
                  <Fix text={j.error} />
                </>
              )}
            </div>
            {!ready(j) && <QuickFixButton jobId={j.id} waiting={waiting.has(j.id)} />}
          </label>
        ))}
      </div>
    </div>
  );
}

function JobRow({ j, children, select }: { j: QueueJob; children?: React.ReactNode; select?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-5 py-2.5">
      {select}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13px] font-medium text-text-primary">
            {animalLabel(j)} <span className="font-normal text-text-muted">· gydyta {formatDate(j.reg_date)}</span>
          </p>
          <Badge tone={STATUS_TONE[j.status]}>{STATUS_LABEL[j.status]}</Badge>
          {j.payload_stale && <Badge tone="warning">Duomenys pasikeitė</Badge>}
          {j.attempts > 1 && <span className="text-[11px] text-text-muted">bandyta {j.attempts} k.</span>}
        </div>
        <PayloadSummary payload={j.approved_payload ?? j.preview_payload} />
        {j.error && <p className="mt-0.5 text-[12px] text-danger">{j.error}</p>}
        {j.status === "verification_failed" ? <Fix text="verification" /> : j.error ? <Fix text={j.error} /> : null}
        {j.rejection_reason && <p className="mt-0.5 text-[12px] text-text-muted">Priežastis: {j.rejection_reason}</p>}
        {j.status === "verification_failed" && <ResultDiff job={j} />}
        <p className="mt-0.5 text-[11px] text-text-muted">
          {[
            j.approved_at && `Išleista ${formatDateTime(j.approved_at)}${j.approved_by_name ? `, ${j.approved_by_name}` : ""}`,
            j.started_at && `kompiuteris pradėjo ${formatDateTime(j.started_at)}`,
            j.completed_at && `baigta ${formatDateTime(j.completed_at)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      {children}
    </div>
  );
}

function SendingList({ jobs }: { jobs: QueueJob[] }) {
  if (jobs.length === 0) return <EmptyState icon={Send} title="Šiuo metu niekas nesiunčiama" className="py-8" />;
  return (
    <div className="divide-y divide-border">
      {jobs.map((j) => (
        <JobRow key={j.id} j={j}>
          {j.status === "approved" && j.payload_stale && (
            <ActionButton action="confirmDelproTransfer" fields={{ treatment_id: j.treatment_id, reapprove: "1" }} label="Patvirtinti iš naujo" />
          )}
        </JobRow>
      ))}
    </div>
  );
}

function FailedList({ jobs, waiting }: { jobs: QueueJob[]; waiting: Set<string> }) {
  const { selected, setSelected, toggle } = useSelection();
  if (jobs.length === 0) return <EmptyState icon={CheckCheck} title="Klaidų nėra" className="py-8" />;
  const rejectable = jobs.filter((j) => j.status === "error");
  return (
    <div>
      {rejectable.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <SelectAll jobs={rejectable} selected={selected} setSelected={setSelected} />
          <RejectSelected ids={[...selected]} onDone={() => setSelected(new Set())} />
        </div>
      )}
      <div className="divide-y divide-border">
        {jobs.map((j) => (
          <JobRow
            key={j.id}
            j={j}
            select={
              j.status === "error" ? (
                <input type="checkbox" className="mt-1 size-4" checked={selected.has(j.id)} onChange={() => toggle(j.id)} aria-label="Pažymėti" />
              ) : (
                <span className="w-4" />
              )
            }
          >
            <div className="flex flex-col items-end gap-1">
              <QuickFixButton jobId={j.id} waiting={waiting.has(j.id)} />
              <ActionButton action="retryDelproJob" fields={{ job_id: j.id, refresh: "1" }} label={<><RefreshCw className="size-3.5" /> Kartoti (nauji duomenys)</>} variant="ghost" />
              <ActionButton action="retryDelproJob" fields={{ job_id: j.id }} label="Kartoti tą patį" variant="ghost" />
            </div>
          </JobRow>
        ))}
      </div>
    </div>
  );
}

function HistoryList({ jobs }: { jobs: QueueJob[] }) {
  if (jobs.length === 0) return <EmptyState icon={RefreshCw} title="Istorijos dar nėra" className="py-8" />;
  return (
    <div className="divide-y divide-border">
      {jobs.map((j) => (
        <JobRow key={j.id} j={j} />
      ))}
    </div>
  );
}

export function DelproSyncQueue({ jobs, workerOnline, waitingIds = [] }: { jobs: QueueJob[]; workerOnline: boolean; waitingIds?: string[] }) {
  const waiting = new Set(waitingIds);
  const by = (statuses: DelproSyncJobStatus[]) => jobs.filter((j) => statuses.includes(j.status));
  const pending = by(["pending_approval"]);
  const queued = by(["approved", "processing"]);
  const failed = by(["error", "verification_failed"]);
  const done = by(["success", "rejected"]);

  return (
    <Tabs defaultValue={failed.length > 0 ? "failed" : "pending"}>
      <div className="space-y-3 px-5 pt-4">
        <HowTo
          intro="Kiekvienas GVET įvestas gydymas (procedūra „Gydymas“) atsiranda čia ir turi būti nusiųstas į DelPro. Siunčia ūkio kompiuteris; jūs tik išleidžiate įrašus."
          steps={[
            <>Atsidarykite <b>„Paruošta siųsti“</b>. Žali „Paruošta“ įrašai gali būti siunčiami iškart.</>,
            <>Spauskite <b>„Pažymėti tik paruoštus“</b>, tada <b>„Siųsti pažymėtus į DelPro“</b>.</>,
            <>Prie raudono „Reikia pataisyti“ įrašo spauskite <b>„Greitas taisymas“</b>. GVET parodys, kas negerai ir ką padarys, o paspaudus pats pataisys ir išsiųs iš naujo.</>,
            <>Bandomuosius ar nereikalingus įrašus pažymėkite ir spauskite <b>„Atmesti pažymėtus“</b>. Gydymas GVET lieka.</>,
            <>Kartą per dieną pažiūrėkite <b>„Nepavyko“</b> — ten irgi prie kiekvieno įrašo yra <b>„Greitas taisymas“</b>.</>,
          ]}
          note="Išsiųstas įrašas laikomas perduotu tik tada, kai ūkio kompiuteris jį įrašė į DelPro ir perskaitęs atgal patikrino. Tada jis atsiduria „Istorijoje“ kaip „Perduota į DelPro“."
        />
        {!workerOnline && queued.length > 0 && (
          <p className="rounded-control bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
            Ūkio kompiuteris neatsako — {queued.length} įraš. laukia eilėje. Jie bus išsiųsti, kai kompiuteris vėl veiks.
          </p>
        )}
        <TabsList className="flex-wrap">
          <TabsTrigger value="pending">Paruošta siųsti ({pending.length})</TabsTrigger>
          <TabsTrigger value="queued">Siunčiama ({queued.length})</TabsTrigger>
          <TabsTrigger value="failed">Nepavyko ({failed.length})</TabsTrigger>
          <TabsTrigger value="done">Istorija ({done.length})</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="pending">
        <PendingList jobs={pending} waiting={waiting} />
      </TabsContent>
      <TabsContent value="queued">
        <p className="px-5 pb-2 text-[12.5px] text-text-secondary">
          Šie įrašai išleisti ir laukia ūkio kompiuterio. Paprastai tai trunka mažiau nei minutę. Nieko daryti nereikia.
        </p>
        <SendingList jobs={queued} />
      </TabsContent>
      <TabsContent value="failed">
        <p className="px-5 pb-2 text-[12.5px] text-text-secondary">
          Įrašai, kurių nepavyko įrašyti į DelPro. Spauskite <b>„Greitas taisymas“</b>: GVET paaiškins priežastį, pasiūlys sprendimą ir, jį patvirtinus, pats
          pataisys ir išsiųs įrašą iš naujo. Tas pats taisymas (pvz. susietas vaistas) pataiso ir kitus įrašus su ta pačia klaida.
        </p>
        <FailedList jobs={failed} waiting={waiting} />
      </TabsContent>
      <TabsContent value="done">
        <HistoryList jobs={done} />
      </TabsContent>
    </Tabs>
  );
}

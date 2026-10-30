"use client";

import * as React from "react";
import { CheckCheck, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ActionButton } from "@/components/delpro/action-button";
import { DELPRO_STATUS_LABEL as STATUS_LABEL, DELPRO_STATUS_TONE as STATUS_TONE, problemLabel } from "@/lib/delpro-status";
import { formatDate, formatDateTime, formatQty } from "@/lib/utils";
import type { Database, DelproPayload, DelproSyncJobStatus } from "@/lib/supabase/types";
import { useDelproAction } from "@/lib/use-delpro-action";

export type QueueJob = Database["public"]["Views"]["vw_delpro_sync_jobs"]["Row"];

function animalLabel(j: QueueJob) {
  return j.animal_no ? `Nr. ${j.animal_no}` : j.tag_no;
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

function Problems({ problems }: { problems: QueueJob["preview_problems"] }) {
  if (!problems || problems.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-wrap gap-1">
      {problems.map((p) => (
        <Badge key={p.code + (p.fix?.local_id ?? "")} tone="danger" title={p.message}>
          {problemLabel(p)}
        </Badge>
      ))}
    </div>
  );
}

function ResultDiff({ job }: { job: QueueJob }) {
  if (!job.actual_result || !job.approved_payload) return null;
  const expected: Record<string, unknown> = {
    animal_no: job.approved_payload.animal.animal_no,
    event_date: job.approved_payload.delpro.event_date,
    milk_withdrawal_days: job.approved_payload.delpro.milk_withdrawal_days,
    meat_withdrawal_days: job.approved_payload.delpro.meat_withdrawal_days,
  };
  return (
    <table className="mt-2 text-[11px]">
      <thead>
        <tr className="text-text-muted">
          <th className="pr-3 text-left font-medium">Laukas</th>
          <th className="pr-3 text-left font-medium">Siųsta</th>
          <th className="text-left font-medium">DelPro įrašyta</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(expected).map(([k, v]) => {
          const actual = job.actual_result?.[k];
          const same = String(actual ?? "") === String(v ?? "");
          return (
            <tr key={k} className={same ? "" : "text-danger"}>
              <td className="pr-3">{k}</td>
              <td className="pr-3">{String(v ?? "—")}</td>
              <td>{String(actual ?? "—")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PendingList({ jobs }: { jobs: QueueJob[] }) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [state, formAction, pending] = useDelproAction("approveDelproJobs");

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) setSelected(new Set());
  }

  const approvable = jobs.filter((j) => (j.preview_problems ?? []).length === 0);
  const allSelected = approvable.length > 0 && selected.size === approvable.length;
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (jobs.length === 0) return <EmptyState icon={CheckCheck} title="Nėra laukiančių" className="py-8" />;

  return (
    <div>
      <form action={formAction} className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <input type="hidden" name="job_ids" value={JSON.stringify([...selected])} />
        <label className="flex items-center gap-2 text-[13px] text-text-secondary">
          <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(approvable.map((j) => j.id)))} />
          Visi paruošti ({approvable.length})
        </label>
        <Button type="submit" size="sm" disabled={pending || selected.size === 0}>
          <CheckCheck className="size-4" /> {pending ? "Tvirtinama..." : `Patvirtinti (${selected.size})`}
        </Button>
        {state?.ok && state.message && <span className="text-[12px] text-success">{state.message}</span>}
        {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
      </form>
      <div className="divide-y divide-border">
        {jobs.map((j) => (
          <div key={j.id} className="flex items-start gap-3 px-5 py-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.has(j.id)}
              disabled={(j.preview_problems ?? []).length > 0}
              onChange={() => toggle(j.id)}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-text-primary">
                {animalLabel(j)} <span className="font-normal text-text-muted">· {formatDate(j.reg_date)}</span>
              </p>
              <PayloadSummary payload={j.preview_payload} />
              <Problems problems={j.preview_problems} />
              {j.error && <p className="mt-0.5 text-[11px] text-text-muted">{j.error}</p>}
            </div>
            <ActionButton
              action="rejectDelproJob"
              fields={{ job_id: j.id }}
              label="Atmesti"
              variant="ghost"
              confirm="Atmesti? Į DelPro nebus perduota."
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function JobList({ jobs, emptyTitle, retry }: { jobs: QueueJob[]; emptyTitle: string; retry?: boolean }) {
  if (jobs.length === 0) return <EmptyState icon={RefreshCw} title={emptyTitle} className="py-8" />;
  return (
    <div className="divide-y divide-border">
      {jobs.map((j) => (
        <div key={j.id} className="flex items-start gap-3 px-5 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[13px] font-medium text-text-primary">
                {animalLabel(j)} <span className="font-normal text-text-muted">· {formatDate(j.reg_date)}</span>
              </p>
              <Badge tone={STATUS_TONE[j.status]}>{STATUS_LABEL[j.status]}</Badge>
              {j.auto_approved && <Badge tone="neutral">auto</Badge>}
              {j.payload_stale && <Badge tone="warning">Duomenys pasikeitė</Badge>}
              {j.attempts > 1 && <span className="text-[11px] text-text-muted">bandymų: {j.attempts}</span>}
            </div>
            <PayloadSummary payload={j.approved_payload ?? j.preview_payload} />
            {j.error && <p className="mt-0.5 text-[12px] text-danger">{j.error}</p>}
            {j.rejection_reason && <p className="mt-0.5 text-[12px] text-text-muted">Priežastis: {j.rejection_reason}</p>}
            {j.status === "verification_failed" && <ResultDiff job={j} />}
            <p className="mt-0.5 text-[11px] text-text-muted">
              {[
                j.approved_at && `Patvirtinta ${formatDateTime(j.approved_at)}${j.approved_by_name ? `, ${j.approved_by_name}` : ""}`,
                j.started_at && `bandyta ${formatDateTime(j.started_at)}`,
                j.completed_at && `baigta ${formatDateTime(j.completed_at)}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          {j.status === "approved" && j.payload_stale && (
            <ActionButton action="confirmDelproTransfer" fields={{ treatment_id: j.treatment_id, reapprove: "1" }} label="Patvirtinti iš naujo" />
          )}
          {retry && (
            <div className="flex flex-col items-end gap-1">
              <ActionButton action="retryDelproJob" fields={{ job_id: j.id }} label="Kartoti" />
              <ActionButton
                action="retryDelproJob"
                fields={{ job_id: j.id, refresh: "1" }}
                label="Kartoti (nauji duomenys)"
                variant="ghost"
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function DelproSyncQueue({ jobs, workerOnline }: { jobs: QueueJob[]; workerOnline: boolean }) {
  const by = (statuses: DelproSyncJobStatus[]) => jobs.filter((j) => statuses.includes(j.status));
  const pending = by(["pending_approval"]);
  const queued = by(["approved", "processing"]);
  const failed = by(["error", "verification_failed"]);
  const done = by(["success", "rejected"]);

  return (
    <Tabs defaultValue={failed.length > 0 ? "failed" : "pending"}>
      {!workerOnline && queued.length > 0 && (
        <p className="mx-5 mt-3 text-[12px] text-text-muted">Ūkio kompiuteris neatsako, {queued.length} įrašų laukia eilėje.</p>
      )}
      <div className="px-5 pt-3">
        <TabsList className="flex-wrap">
          <TabsTrigger value="pending">Laukia patvirtinimo ({pending.length})</TabsTrigger>
          <TabsTrigger value="queued">Laukia perdavimo ({queued.length})</TabsTrigger>
          <TabsTrigger value="failed">Klaidos ({failed.length})</TabsTrigger>
          <TabsTrigger value="done">Istorija ({done.length})</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="pending">
        <PendingList jobs={pending} />
      </TabsContent>
      <TabsContent value="queued">
        <JobList jobs={queued} emptyTitle="Eilė tuščia" />
      </TabsContent>
      <TabsContent value="failed">
        <JobList jobs={failed} emptyTitle="Klaidų nėra" retry />
      </TabsContent>
      <TabsContent value="done">
        <JobList jobs={done} emptyTitle="Istorijos dar nėra" />
      </TabsContent>
    </Tabs>
  );
}

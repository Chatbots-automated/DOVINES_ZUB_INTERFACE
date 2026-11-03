"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, History, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { cmsPost } from "@/lib/cms/client";
import { CMS_MODE_LABEL, formatVilnius } from "@/lib/cms/separation";
import { CMS_STATUS_LABEL, CMS_STATUS_TONE } from "@/lib/cms/status";
import type { CmsJobStatus, CmsSeparationJobView } from "@/lib/supabase/types";

type Filter = "pending" | "approved" | "problem" | "done" | "all";
const FILTERS: Record<Filter, { label: string; statuses: CmsJobStatus[] | null }> = {
  pending: { label: "Laukia patvirtinimo", statuses: ["pending_approval"] },
  approved: { label: "Laukia perdavimo", statuses: ["approved", "processing"] },
  problem: { label: "Klaidos / peržiūra", statuses: ["error", "needs_review"] },
  done: { label: "Perduota", statuses: ["success"] },
  all: { label: "Visi", statuses: null },
};

export type CmsGate = {
  workerMode: string | null;
  workerSeenAt: string | null;
};

function schedule(j: CmsSeparationJobView) {
  return `${formatVilnius(j.start_at)} → ${j.mode === "ongoing" ? "be pabaigos" : formatVilnius(j.end_at)} · sesijos ${(j.sessions ?? []).join(", ") || "—"}`;
}

export function CmsHistory({ jobs, isAdmin, canWrite, gate, focusBatch }: { jobs: CmsSeparationJobView[]; isAdmin: boolean; canWrite: boolean; gate: CmsGate; focusBatch: string | null }) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>(jobs.some((j) => j.status === "pending_approval") ? "pending" : "all");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [adoptFor, setAdoptFor] = React.useState<string | null>(null);
  const [adoptKey, setAdoptKey] = React.useState("");

  const statuses = FILTERS[filter].statuses;
  const shown = jobs.filter((j) => !statuses || statuses.includes(j.status));
  const approvable = shown.filter((j) => j.status === "pending_approval" && (j.problems ?? []).length === 0);
  const batches = React.useMemo(() => {
    const m = new Map<string, CmsSeparationJobView[]>();
    for (const j of shown) m.set(j.batch_id, [...(m.get(j.batch_id) ?? []), j]);
    return [...m.entries()].sort((a, b) => (a[1][0].batch_created_at < b[1][0].batch_created_at ? 1 : -1));
  }, [shown]);

  async function run(key: string, op: string, payload: Record<string, unknown>, done?: (data: unknown) => string) {
    setBusy(key);
    setMessage(null);
    const res = await cmsPost(op, payload);
    setBusy(null);
    if (!res.ok) {
      setMessage({ ok: false, text: res.error });
      return false;
    }
    setMessage({ ok: true, text: done ? done(res.data) : "Atlikta." });
    setSelected(new Set());
    router.refresh();
    return true;
  }

  // 0052: "Patvirtinti" is the only step — approved jobs go straight to the farm PC's worker.
  const approve = (ids: string[]) =>
    run("approve", "approve", { job_ids: ids, confirm: true }, (d) => {
      const r = d as { approved: number; unchanged: number; refused: { reason: string }[] };
      return `Patvirtinta ${r.approved} — siunčiama į DelPro${r.unchanged ? `, jau patvirtinta ${r.unchanged}` : ""}${r.refused.length ? `, atmesta ${r.refused.length}: ${r.refused.map((x) => x.reason).join(" ")}` : ""}.`;
    });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-4">
      {isAdmin && gate.workerMode !== "gateway" && (
        <p className="rounded-control border border-warning/40 bg-warning-soft px-3 py-2 text-[13px] text-warning">
          Ūkio kompiuteris šiuo metu nesiunčia CMS atskyrimų (CMS_OUTBOUND_MODE={gate.workerMode ?? "nežinoma"}) — patvirtinti atskyrimai lauks.
        </p>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          {(Object.keys(FILTERS) as Filter[]).map((f) => {
            const n = jobs.filter((j) => !FILTERS[f].statuses || FILTERS[f].statuses!.includes(j.status)).length;
            return (
              <button
                key={f}
                type="button"
                onClick={() => {
                  setFilter(f);
                  setSelected(new Set());
                }}
                className={cn(
                  "rounded-control px-2.5 py-1 text-[13px]",
                  filter === f ? "bg-ink text-text-on-ink" : "text-text-secondary hover:bg-surface-secondary",
                )}
              >
                {FILTERS[f].label} <span className="opacity-70">({n})</span>
              </button>
            );
          })}
          {isAdmin && filter === "pending" && (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={selected.size === 0 || busy === "approve"} onClick={() => approve([...selected])}>
                Patvirtinti pažymėtus ({selected.size})
              </Button>
              <Button type="button" size="sm" disabled={approvable.length === 0 || busy === "approve"} onClick={() => approve(approvable.map((j) => j.id))}>
                <CheckCheck className="size-4" /> Patvirtinti visus tinkamus ({approvable.length})
              </Button>
            </div>
          )}
        </div>
        {message && <p className={cn("border-b border-border px-4 py-2 text-[13px]", message.ok ? "text-success" : "text-danger")}>{message.text}</p>}

        {batches.length === 0 ? (
          <EmptyState icon={History} title="Įrašų nėra" className="py-10" />
        ) : (
          <div className="divide-y divide-border">
            {batches.map(([batchId, list]) => (
              <div key={batchId} className={cn(batchId === focusBatch && "bg-accent-soft/30")}>
                <div className="flex flex-wrap items-center gap-2 bg-surface-secondary px-4 py-2 text-[12px] text-text-secondary">
                  <span className="font-medium text-text-primary">Partija {formatVilnius(list[0].batch_created_at)}</span>
                  <span>· {list[0].created_by_name ?? "—"}</span>
                  {list[0].batch_note && <span>· {list[0].batch_note}</span>}
                  <span className="ml-auto">{list.length} gyv.</span>
                </div>
                {list.map((j) => (
                  <div key={j.id} className="flex items-start gap-3 px-4 py-2.5">
                    {isAdmin && filter === "pending" && (
                      <input
                        type="checkbox"
                        className="mt-1"
                        aria-label={`Pažymėti ${j.tag_no}`}
                        disabled={j.status !== "pending_approval" || (j.problems ?? []).length > 0}
                        checked={selected.has(j.id)}
                        onChange={() => toggle(j.id)}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[13px] font-medium text-text-primary">
                          {j.tag_no} <span className="font-normal text-text-muted">· Nr. {j.animal_no ?? "—"}</span>
                        </p>
                        <Badge tone={CMS_STATUS_TONE[j.status]}>{CMS_STATUS_LABEL[j.status]}</Badge>
                        {j.is_override && <Badge tone="accent">Individualūs</Badge>}
                      </div>
                      <p className="text-[12px] text-text-secondary">
                        {CMS_MODE_LABEL[j.mode]} · {schedule(j)}
                      </p>
                      {(j.problems ?? []).length > 0 && <p className="text-[12px] text-danger">{j.problems.map((p) => p.message).join(" ")}</p>}
                      {j.status === "success" && j.action_key && <DelproState j={j} />}
                      {j.last_error && <p className="text-[12px] text-danger">{j.last_error}</p>}
                      {j.readback && j.readback.diffs.length > 0 && (
                        <table className="mt-1 text-[11px]">
                          <thead>
                            <tr className="text-text-muted">
                              <th className="pr-3 text-left font-medium">Laukas</th>
                              <th className="pr-3 text-left font-medium">Siųsta</th>
                              <th className="text-left font-medium">DelPro</th>
                            </tr>
                          </thead>
                          <tbody>
                            {j.readback.diffs.map((d) => (
                              <tr key={d.property} className="text-danger">
                                <td className="pr-3">{d.property}</td>
                                <td className="pr-3">{d.expected ?? "—"}</td>
                                <td>{d.actual ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      <p className="mt-0.5 text-[11px] text-text-muted">
                        {[
                          j.note && `Pastaba: ${j.note}`,
                          j.approved_at && `Patvirtino ${j.approved_by_name ?? "—"} ${formatVilnius(j.approved_at)}`,
                          j.attempts > 0 && `bandymų ${j.attempts}`,
                          j.milk_setting_key && `AnimalMilkSetting ${j.milk_setting_key}`,
                          j.action_key && `DelPro raktas ${j.action_key}`,
                          j.verified_at && `patikrinta ${formatVilnius(j.verified_at)}`,
                          j.next_attempt_at && j.status === "approved" && `kitas bandymas ${formatVilnius(j.next_attempt_at)}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {adoptFor === j.id && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Input className="h-8 w-40" placeholder="AnimalActionSetting Key" value={adoptKey} onChange={(e) => setAdoptKey(e.target.value.trim())} />
                          <Button
                            type="button"
                            size="sm"
                            disabled={!/^\d+$/.test(adoptKey) || !!busy}
                            onClick={async () => {
                              if (await run(`adopt-${j.id}`, "job_action", { job_id: j.id, action: "adopt", key: adoptKey }, () => "Raktas priskirtas — darbininkas nuskaitys ir palygins.")) {
                                setAdoptFor(null);
                                setAdoptKey("");
                              }
                            }}
                          >
                            Priskirti
                          </Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => setAdoptFor(null)}>
                            Atšaukti
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {isAdmin && j.status === "error" && !j.write_started_at && (
                        <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => run(`retry-${j.id}`, "job_action", { job_id: j.id, action: "retry" })}>
                          Kartoti
                        </Button>
                      )}
                      {isAdmin && j.status === "needs_review" && j.approved_snapshot && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!!busy}
                            onClick={() => {
                              if (window.confirm("Patikrinote DelPro ir šio įrašo TIKRAI nėra? Užduotis bus siunčiama iš naujo.")) {
                                void run(`absent-${j.id}`, "job_action", { job_id: j.id, action: "confirm_absent" });
                              }
                            }}
                          >
                            Įrašo DelPro nėra
                          </Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => setAdoptFor(j.id)}>
                            Priskirti DelPro įrašą
                          </Button>
                        </>
                      )}
                      {canWrite && (j.status === "pending_approval" || (isAdmin && ["approved", "error", "needs_review"].includes(j.status))) && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={!!busy}
                          onClick={() => {
                            if (window.confirm(`Atšaukti ${j.tag_no} atskyrimą?`)) void run(`cancel-${j.id}`, "cancel", { job_ids: [j.id] });
                          }}
                        >
                          Atšaukti
                        </Button>
                      )}
                      {busy?.endsWith(j.id) && <Loader2 className="size-4 animate-spin text-text-muted" />}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>

    </div>
  );
}

/** The DelPro record this job created, as the farm PC last read it. GVET never re-creates a record disabled in DelPro. */
function DelproState({ j }: { j: CmsSeparationJobView }) {
  const [now] = React.useState(() => Date.now());
  if (!j.delpro_seen_at) return <p className="text-[12px] text-text-muted">DelPro būsena dar nenuskaityta (Aktyvūs atskyrimai → Atnaujinti).</p>;
  if (j.delpro_removed_at) return <p className="text-[12px] text-text-muted">DelPro įrašo {j.action_key} nebėra (pilnas nuskaitymas {formatVilnius(j.delpro_removed_at)}).</p>;
  const ended = j.delpro_end_at && new Date(j.delpro_end_at).getTime() <= now;
  const label = j.delpro_active === false ? "išjungtas DelPro" : ended ? "pasibaigęs" : j.delpro_active ? "galioja" : "nežinoma";
  return (
    <p className="text-[12px] text-text-secondary">
      DelPro {j.action_key}: <Badge tone={j.delpro_active && !ended ? "warning" : "neutral"}>{label}</Badge>{" "}
      <span className="text-text-muted">· nuskaityta {formatVilnius(j.delpro_seen_at)}</span>
    </p>
  );
}

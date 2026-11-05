"use client";

import * as React from "react";
import { useActionState } from "react";
import { Ban, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { cancelSyncApplications, type SyncMassResult } from "@/lib/actions/sync-mass";
import { SYNC_STATUS_LABELS } from "@/lib/sync-mass";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { Database, SyncApplicationStatus, SyncApplicationViewRow } from "@/lib/supabase/types";

type MassRow = Database["public"]["Views"]["vw_sync_mass_applications"]["Row"];
const PAGE = 200;
const TONE: Record<SyncApplicationStatus, "warning" | "success" | "neutral"> = { aktyvus: "warning", baigtas: "success", nutrauktas: "neutral" };

// Running and finished protocols per animal (vw_sync_applications) + the mass
// applications they came from. Ticked running ones can be stopped at once
// (cancel_sync_applications → their open step visits become "Atšauktas").
export function SyncApplicationsPanel({
  applications,
  massApplications,
  canWrite,
}: {
  applications: SyncApplicationViewRow[];
  massApplications: MassRow[];
  canWrite: boolean;
}) {
  const [state, formAction, pending] = useActionState<SyncMassResult | null, FormData>(cancelSyncApplications, null);
  const [status, setStatus] = React.useState<SyncApplicationStatus | "">("aktyvus");
  const [q, setQ] = React.useState("");
  const [massId, setMassId] = React.useState<string | null>(null);
  const [limit, setLimit] = React.useState(PAGE);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) setSelected(new Set());
  }

  const tokens = q.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const filtered = applications.filter((a) => {
    if (status && a.status !== status) return false;
    if (massId && a.mass_application_id !== massId) return false;
    if (tokens.length) {
      const hay = `${a.animal_no ?? ""} ${a.tag_no} ${a.protocol_name} ${a.group_name ?? ""}`.toLowerCase();
      if (!tokens.some((t) => hay.includes(t))) return false;
    }
    return true;
  });
  const activeFiltered = filtered.filter((a) => a.status === "aktyvus");
  const allOn = activeFiltered.length > 0 && activeFiltered.every((a) => selected.has(a.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const a of activeFiltered) {
        if (allOn) next.delete(a.id);
        else next.add(a.id);
      }
      return next;
    });
  const mass = massId ? massApplications.find((m) => m.id === massId) : null;

  return (
    <div className="space-y-5">
      {massApplications.length > 0 && (
        <div className="rounded-panel border border-border bg-surface">
          <h2 className="border-b border-border px-4 py-2.5 text-[14px] font-bold text-text-primary">Masiniai pritaikymai</h2>
          <div className="max-h-[260px] overflow-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="sticky top-0 border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-4 py-2">Pritaikyta</th>
                  <th className="px-4 py-2">Protokolas</th>
                  <th className="px-4 py-2">Pradžia</th>
                  <th className="px-4 py-2">Gyvūnų</th>
                  <th className="px-4 py-2">Vykdomi / baigti / nutraukti</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {massApplications.map((m) => (
                  <tr key={m.id} className={m.id === massId ? "bg-accent-soft/50" : undefined}>
                    <td className="px-4 py-2 text-text-secondary">{formatDateTime(m.created_at)}</td>
                    <td className="px-4 py-2 font-medium text-text-primary">{m.protocol_name}</td>
                    <td className="px-4 py-2 text-text-secondary">
                      {formatDate(m.start_date)} {m.start_time}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{m.animal_count}</td>
                    <td className="px-4 py-2 tabular-nums text-text-secondary">
                      {m.active_count} / {m.finished_count} / {m.cancelled_count}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setMassId(m.id === massId ? null : m.id);
                          setStatus("");
                          setLimit(PAGE);
                        }}
                      >
                        {m.id === massId ? "Rodyti visus" : "Rodyti gyvūnus"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-panel border border-border bg-surface p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="sa_status">Būsena</Label>
            <Select id="sa_status" value={status} onChange={(e) => setStatus(e.target.value as SyncApplicationStatus | "")}>
              <option value="">Visos</option>
              {(Object.keys(SYNC_STATUS_LABELS) as SyncApplicationStatus[]).map((s) => (
                <option key={s} value={s}>
                  {SYNC_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-[220px] flex-1">
            <Label htmlFor="sa_q">Paieška</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-text-muted" />
              <Input id="sa_q" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Gyvūno Nr., protokolas, grupė" />
            </div>
          </div>
          {mass && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setMassId(null)}>
              <X className="size-3.5" /> {mass.protocol_name} · {formatDate(mass.start_date)}
            </Button>
          )}
        </div>

        {state && !state.ok && state.error && <p className="mt-3 rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
        {state?.ok && <p className="mt-3 rounded-control bg-success-soft px-3 py-2 text-[13px] text-success">{state.message}</p>}

        {filtered.length === 0 ? (
          <EmptyState icon={Search} title="Protokolų nerasta" className="py-10" />
        ) : (
          <div className="mt-3 max-h-[520px] overflow-auto rounded-control border border-border">
            <table className="w-full min-w-[820px] text-left text-[13px]">
              <thead className="sticky top-0 border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="w-9 px-3 py-2">
                    {canWrite && activeFiltered.length > 0 && <input type="checkbox" className="size-4" checked={allOn} onChange={toggleAll} aria-label="Pažymėti vykdomus" />}
                  </th>
                  <th className="px-2 py-2">Gyvūnas</th>
                  <th className="px-2 py-2">Grupė</th>
                  <th className="px-2 py-2">Protokolas</th>
                  <th className="px-2 py-2">Pradžia</th>
                  <th className="px-2 py-2">Eiga</th>
                  <th className="px-2 py-2">Kitas žingsnis</th>
                  <th className="px-2 py-2">Būsena</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.slice(0, limit).map((a) => (
                  <tr key={a.id} className={selected.has(a.id) ? "bg-accent-soft/50" : undefined}>
                    <td className="px-3 py-1.5">
                      {canWrite && a.status === "aktyvus" && (
                        <input type="checkbox" className="size-4" checked={selected.has(a.id)} onChange={() => toggle(a.id)} aria-label={`Pažymėti ${a.tag_no}`} />
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="font-medium text-text-primary">{a.animal_no ?? "—"}</span> <span className="text-text-muted">{a.tag_no}</span>
                    </td>
                    <td className="px-2 py-1.5 text-text-secondary">{a.group_name ?? "—"}</td>
                    <td className="px-2 py-1.5 text-text-primary">{a.protocol_name}</td>
                    <td className="px-2 py-1.5 text-text-secondary">{formatDate(a.start_date)}</td>
                    <td className="px-2 py-1.5 tabular-nums text-text-secondary">
                      {a.steps_done}/{a.steps_total}
                      {a.steps_cancelled > 0 && <span className="text-text-muted"> (atš. {a.steps_cancelled})</span>}
                    </td>
                    <td className="px-2 py-1.5 text-text-secondary">
                      {a.next_step_at ? (
                        <>
                          {formatDateTime(a.next_step_at)} · {a.next_step_title}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge tone={TONE[a.status]}>{SYNC_STATUS_LABELS[a.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > limit && (
              <div className="border-t border-border p-2 text-center">
                <Button type="button" size="sm" variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                  Rodyti daugiau ({filtered.length - limit})
                </Button>
              </div>
            )}
          </div>
        )}

        {canWrite && selected.size > 0 && (
          <form action={formAction} className="mt-3 flex flex-wrap items-center gap-3">
            <input type="hidden" name="application_ids" value={JSON.stringify([...selected])} />
            <Button
              type="submit"
              variant="danger"
              disabled={pending}
              onClick={(e) => {
                if (!window.confirm(`Nutraukti ${selected.size} protokol.? Neatlikti žingsniai bus atšaukti, atlikti liks.`)) e.preventDefault();
              }}
            >
              <Ban className="size-4" /> {pending ? "Saugoma..." : `Nutraukti pažymėtus (${selected.size})`}
            </Button>
            <span className="text-[12px] text-text-muted">Jau įrašyti žingsniai ir nurašyti vaistai lieka.</span>
          </form>
        )}
      </div>
    </div>
  );
}

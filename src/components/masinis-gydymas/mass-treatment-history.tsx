"use client";

import * as React from "react";
import { useActionState } from "react";
import { ChevronDown, ChevronRight, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { createClient } from "@/lib/supabase/client";
import { approveMassTreatment, type MassActionResult } from "@/lib/actions/mass-treatments";
import { DELPRO_STATUS_LABEL, delproStatusLabel, delproStatusTone } from "@/lib/delpro-status";
import { formatDate, formatQty } from "@/lib/utils";
import type { DelproSyncJobStatus } from "@/lib/supabase/types";
import type { Product } from "@/components/gyvunai/new-treatment-dialog";
import type { MassDelproInfo, MassHistoryRow } from "@/lib/mass-treatments";

type AnimalLine = {
  id: string;
  animals: { tag_no: string; animal_no: string | null } | null;
  delpro_sync_jobs: { status: DelproSyncJobStatus }[] | { status: DelproSyncJobStatus } | null;
};

function jobStatus(l: AnimalLine): DelproSyncJobStatus | null {
  const j = Array.isArray(l.delpro_sync_jobs) ? l.delpro_sync_jobs[0] : l.delpro_sync_jobs;
  return j?.status ?? null;
}

// The treatments of one mass treatment, loaded when the row is opened.
function MassAnimals({ massId, showDelpro }: { massId: string; showDelpro: boolean }) {
  const [rows, setRows] = React.useState<AnimalLine[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    createClient()
      .from("treatments")
      .select("id, animals(tag_no, animal_no), delpro_sync_jobs(status)")
      .eq("mass_treatment_id", massId)
      .limit(2000)
      .then(({ data, error: e }) => {
        if (cancelled) return;
        if (e) setError(e.message);
        else setRows((data ?? []) as unknown as AnimalLine[]);
      });
    return () => {
      cancelled = true;
    };
  }, [massId]);

  if (error) return <p className="text-[12px] text-danger">{error}</p>;
  if (!rows) return <p className="text-[12px] text-text-muted">Kraunama...</p>;
  const sorted = [...rows].sort((a, b) => (a.animals?.animal_no ?? "").localeCompare(b.animals?.animal_no ?? "", "lt", { numeric: true }));
  return (
    <div className="flex flex-wrap gap-1.5">
      {sorted.map((r) => {
        const s = jobStatus(r);
        return (
          <span key={r.id} className="inline-flex items-center gap-1 rounded-control border border-border bg-surface px-2 py-0.5 text-[12px]">
            <span className="font-medium text-text-primary">{r.animals?.animal_no ?? r.animals?.tag_no ?? "—"}</span>
            {showDelpro && <Badge tone={delproStatusTone(s)}>{delproStatusLabel(s)}</Badge>}
          </span>
        );
      })}
    </div>
  );
}

function SendButton({ massId, waiting }: { massId: string; waiting: number }) {
  const [state, formAction, pending] = useActionState<MassActionResult | null, FormData>(approveMassTreatment, null);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="mass_treatment_id" value={massId} />
      <Button type="submit" size="sm" disabled={pending || waiting === 0}>
        <Send className="size-3.5" /> {pending ? "Siunčiama..." : `Siųsti į DelPro (${waiting})`}
      </Button>
      {state && <span className={`text-[12px] ${state.ok ? "text-success" : "text-danger"}`}>{state.ok ? state.message : state.error}</span>}
    </form>
  );
}

export function MassTreatmentHistory({ history, products, delpro }: { history: MassHistoryRow[]; products: Product[]; delpro: MassDelproInfo }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const productName = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  if (history.length === 0) return <EmptyState title="Masinių gydymų dar nėra" description="Išsaugotas masinis gydymas atsiras čia." />;

  return (
    <div className="space-y-2">
      {history.map((h) => {
        const isOpen = open === h.id;
        const showDelpro = delpro.enabled && h.procedure_type === "gydymas";
        const counts = Object.entries(h.delpro_status_counts) as [DelproSyncJobStatus, number][];
        const waiting = h.delpro_status_counts.pending_approval ?? 0;
        return (
          <div key={h.id} className="rounded-panel border border-border bg-surface p-3">
            <div className="flex flex-wrap items-start gap-3">
              <button
                type="button"
                className="mt-0.5 text-text-muted hover:text-text-primary"
                onClick={() => setOpen(isOpen ? null : h.id)}
                aria-label={isOpen ? "Suskleisti" : "Rodyti gyvūnus"}
              >
                {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              </button>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-semibold text-text-primary">{formatDate(h.reg_date)}</span>
                  <Badge tone={h.procedure_type === "gydymas" ? "accent" : "neutral"}>{h.procedure_type === "gydymas" ? "Gydymas" : "Profilaktika"}</Badge>
                  <span className="text-text-primary">{h.disease_name ?? h.diagnosis ?? "—"}</span>
                  {h.diagnosis && h.disease_name && h.diagnosis !== h.disease_name && <span className="text-text-secondary">({h.diagnosis})</span>}
                  <span className="text-text-secondary">· {h.animal_count} gyv.</span>
                  {h.vet_name && <span className="text-text-secondary">· {h.vet_name}</span>}
                </div>
                <div className="text-[12px] text-text-secondary">
                  {h.medications.map((m, i) => {
                    const p = productName.get(m.product_id);
                    return (
                      <span key={`${m.product_id}-${i}`}>
                        {i > 0 && "; "}
                        <span className="text-text-primary">{p?.name ?? "?"}</span> {formatQty(m.qty, m.unit)} / gyv.
                        {m.frequency_per_day && m.course_days ? ` · ${m.frequency_per_day}×/d., ${m.course_days} d.` : ""}
                      </span>
                    );
                  })}
                </div>
                {h.notes && <p className="text-[12px] text-text-muted">{h.notes}</p>}
                {showDelpro && counts.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[12px]">
                    <span className="text-text-secondary">DelPro:</span>
                    {counts.map(([s, c]) => (
                      <Badge key={s} tone={delproStatusTone(s)}>
                        {DELPRO_STATUS_LABEL[s] ?? s}: {c}
                      </Badge>
                    ))}
                  </div>
                )}
                {h.treatment_count < h.animal_count && (
                  <p className="text-[12px] text-text-muted">Liko įrašų: {h.treatment_count} (kai kurie gydymai ištrinti Gydymų istorijoje).</p>
                )}
              </div>
              {showDelpro && delpro.canApprove && waiting > 0 && <SendButton massId={h.id} waiting={waiting} />}
            </div>
            {isOpen && (
              <div className="mt-3 border-t border-border pt-3">
                <MassAnimals massId={h.id} showDelpro={showDelpro} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

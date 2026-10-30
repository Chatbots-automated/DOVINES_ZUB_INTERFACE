"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Send, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import { ADMINISTRATION_ROUTES } from "@/lib/administration-routes";
import { DELPRO_CONFIRMABLE, delproStatusLabel, delproStatusTone, problemLabel } from "@/lib/delpro-status";
import { formatDate, formatDateTime, formatQty } from "@/lib/utils";
import type { DelproSyncJobStatus, DelproTransferState, DelproUiEntry } from "@/lib/supabase/types";
import { useDelproAction } from "@/lib/use-delpro-action";

type LoadedState = Extract<DelproTransferState, { found: true }>;

const routeLabel = (code: string | null | undefined) => (code ? (ADMINISTRATION_ROUTES.find((r) => r.code === code)?.label ?? code) : null);

// Fields the farm-PC automation actually types into DelPro, in the order shown.
const UI_FIELDS: Array<{ key: keyof DelproUiEntry; label: string }> = [
  { key: "animal_number", label: "Gyvulys" },
  { key: "diagnosis_name", label: "Diagnozė" },
  { key: "diagnosis_code", label: "Diagnozės kodas" },
  { key: "medicine_name", label: "Vaistas" },
  { key: "dose", label: "Dozė" },
  { key: "course_days", label: "Gydymo kursas (d.)" },
];

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-[13px]">
      <dt className="shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-text-primary">
        {children}
        {hint && <div className="text-[11px] text-text-muted">{hint}</div>}
      </dd>
    </div>
  );
}

function changedFields(frozen: DelproUiEntry | undefined, live: DelproUiEntry | undefined): string[] {
  if (!frozen || !live) return [];
  return UI_FIELDS.filter((f) => String(frozen[f.key] ?? "") !== String(live[f.key] ?? "")).map((f) => f.label);
}

function TransferBody({ s }: { s: LoadedState }) {
  const shown = s.payload;
  const d = shown.delpro;
  const ui = d.ui_entry;
  const product = d.products[0];
  const multi = d.products.length > 1;
  const status = s.job?.status ?? null;
  const diff = s.stale ? changedFields(s.payload.delpro.ui_entry, s.preview.delpro.ui_entry) : [];
  const pendingWork = status === "approved" || status === "processing";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={delproStatusTone(status)}>{delproStatusLabel(status)}</Badge>
        {s.job?.auto_approved && <Badge tone="neutral">auto</Badge>}
        {s.job?.approved_at && (
          <span className="text-[12px] text-text-muted">
            Patvirtinta {formatDateTime(s.job.approved_at)}
            {s.job.approved_by_name ? ` · ${s.job.approved_by_name}` : ""}
          </span>
        )}
      </div>

      {s.stale && (
        <div className="flex gap-2 rounded-control border border-warning/40 bg-warning-soft p-3 text-[13px] text-text-primary">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <p className="font-medium">Duomenys pasikeitė po patvirtinimo{diff.length > 0 ? `: ${diff.join(", ").toLowerCase()}` : ""}.</p>
            <p className="text-text-secondary">
              {status === "approved" ? "Siunčiami patvirtinti duomenys, kol nepatvirtinsite iš naujo." : "Pakeitimai į DelPro nesiunčiami."}
            </p>
          </div>
        </div>
      )}

      {pendingWork && !s.worker.online && (
        <div className="flex gap-2 rounded-control border border-border bg-surface-secondary p-3 text-[13px] text-text-secondary">
          <WifiOff className="mt-0.5 size-4 shrink-0" />
          <p>Ūkio kompiuteris neatsako{s.worker.last_seen_at ? ` (nuo ${formatDateTime(s.worker.last_seen_at)})` : ""}. Įrašas lauks eilėje.</p>
        </div>
      )}

      {s.job?.error && (status === "error" || status === "verification_failed" || status === "pending_approval") && (
        <p className="rounded-control border border-danger/30 bg-danger-soft p-3 text-[13px] text-danger">{s.job.error}</p>
      )}

      {!s.eligible && (
        <p className="rounded-control border border-border bg-surface-secondary p-3 text-[13px] text-text-secondary">
          {s.procedure_type !== "gydymas" ? "Į DelPro perduodami tik gydymai." : "Perdavimas į DelPro išjungtas."}
        </p>
      )}

      {s.problems.length > 0 && s.eligible && status !== "success" && (
        <div className="rounded-control border border-danger/30 bg-danger-soft p-3">
          <p className="mb-1 text-[13px] font-medium text-danger">Negalima patvirtinti</p>
          <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-text-primary">
            {s.problems.map((p) => (
              <li key={p.code} title={p.message}>
                {problemLabel(p)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section>
        <h3 className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-text-muted">
          <Send className="size-3.5" /> {s.frozen ? "Patvirtinta perduoti" : "Bus perduota į DelPro"}
        </h3>
        <dl className="divide-y divide-border rounded-control border border-border px-3">
          <Row label="Gyvulys">{ui?.animal_number ? `Nr. ${ui.animal_number}` : <span className="text-danger">trūksta</span>}</Row>
          <Row label="Diagnozė" hint={d.diagnosis_text && d.diagnosis_text !== ui?.diagnosis_name ? `GVET: ${d.diagnosis_text}` : undefined}>
            {ui?.diagnosis_name ? (
              <>
                {ui.diagnosis_name}
                {ui.diagnosis_code && <span className="text-text-muted"> · kodas {ui.diagnosis_code}</span>}
              </>
            ) : (
              <span className="text-danger">nepasirinkta</span>
            )}
          </Row>
          <Row label="Vaistas" hint={product && product.name !== ui?.medicine_name ? `GVET: ${product.name}` : undefined}>
            {multi ? (
              <span className="text-danger">keli vaistai ({d.products.length}) — nepalaikoma</span>
            ) : ui?.medicine_name ? (
              ui.medicine_name
            ) : (
              <span className="text-danger">nenurodytas</span>
            )}
          </Row>
          <Row label="Dozė">
            {ui?.dose != null ? formatQty(ui.dose, ui.dose_unit) : <span className="text-danger">nenurodyta</span>}
          </Row>
          <Row label="Gydymo kursas" hint={ui?.course_days === 1 ? "be kurso" : undefined}>
            {ui ? `${ui.course_days} d.` : "—"}
          </Row>
        </dl>
      </section>

      <section>
        <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-muted">Tik informacija (neperduodama)</h3>
        <dl className="divide-y divide-border rounded-control border border-border bg-surface-secondary/50 px-3">
          <Row label="Gydymo data (GVET)">{formatDate(d.event_date)}</Row>
          {d.products[0]?.administration_route && <Row label="Vartojimo būdas">{routeLabel(d.products[0].administration_route)}</Row>}
          <Row label="Pieno karencija">
            {d.withdrawal_until_milk ? `iki ${formatDate(d.withdrawal_until_milk)} (${d.milk_withdrawal_days} d.)` : "nėra"}
          </Row>
          <Row label="Mėsos karencija">
            {d.withdrawal_until_meat ? `iki ${formatDate(d.withdrawal_until_meat)} (${d.meat_withdrawal_days} d.)` : "nėra"}
          </Row>
          {d.vet_name && <Row label="Veterinaras">{d.vet_name}</Row>}
        </dl>
      </section>

      {s.stale && s.preview.delpro.ui_entry && (
        <section>
          <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-muted">Dabar</h3>
          <dl className="divide-y divide-border rounded-control border border-warning/40 px-3">
            {UI_FIELDS.map((f) => {
              const before = String(ui?.[f.key] ?? "—");
              const after = String(s.preview.delpro.ui_entry?.[f.key] ?? "—");
              if (before === after) return null;
              return (
                <Row key={f.key} label={f.label}>
                  <span className="text-text-muted line-through">{before}</span> → {after}
                </Row>
              );
            })}
          </dl>
        </section>
      )}
    </div>
  );
}

// "Patvirtinti perdavimą į DelPro" — one dialog for the treatment card. It only
// ever *releases* the treatment to the farm-PC worker through the same database
// approval the /veterinarija/delpro queue uses; the real DelPro write (and its
// verification) happens later on the farm PC.
export function DelproTransferDialog({
  treatmentId,
  status,
  canApprove,
}: {
  treatmentId: string;
  status: DelproSyncJobStatus | null;
  canApprove: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [loaded, setLoaded] = React.useState<{ key: number; state: DelproTransferState | null; error: string | null } | null>(null);
  const [result, formAction, pending] = useDelproAction("confirmDelproTransfer");

  // After a successful approval, re-read the (now frozen) state.
  const [handledResult, setHandledResult] = React.useState(result);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  if (result !== handledResult) {
    setHandledResult(result);
    if (result) setNotice(result.ok ? { ok: true, text: result.message ?? "" } : { ok: false, text: result.error });
    if (result?.ok) setReloadKey((k) => k + 1);
  }

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    createClient()
      .rpc("delpro_treatment_transfer_state", { p_treatment_id: treatmentId })
      .then(({ data, error }) => {
        if (cancelled) return;
        setLoaded({ key: reloadKey, state: data ?? null, error: error?.message ?? null });
      });
    return () => {
      cancelled = true;
    };
  }, [open, treatmentId, reloadKey]);

  const loading = !loaded || loaded.key !== reloadKey;
  const state = loaded?.state && loaded.state.found ? loaded.state : null;

  const confirmable = DELPRO_CONFIRMABLE.includes(state?.job?.status ?? status);
  const canReapprove = !!state && state.job?.status === "approved" && state.stale;
  const showConfirm = !!state && state.can_approve && state.eligible && (confirmable || canReapprove) && state.problems.length === 0;
  const primary = canApprove && DELPRO_CONFIRMABLE.includes(status);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setNotice(null);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant={primary ? "primary" : "ghost"}>
          {primary ? (
            <>
              <Send className="size-3.5" /> Patvirtinti perdavimą į DelPro
            </>
          ) : (
            "DelPro būsena"
          )}
        </Button>
      </DialogTrigger>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{showConfirm || confirmable ? "Patvirtinti gydymo perdavimą į DelPro" : "Gydymo perdavimas į DelPro"}</DialogTitle>
          <DialogDescription>
            Įrašas bus perduotas į DelPro, kai ūkio kompiuteris jį paims.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {loading && <p className="py-6 text-center text-[13px] text-text-muted">Kraunama...</p>}
          {!loading && loaded?.error && <p className="text-[13px] text-danger">{loaded.error}</p>}
          {!loading && !loaded?.error && !state && <p className="text-[13px] text-text-muted">Gydymas nerastas.</p>}
          {!loading && state && <TransferBody s={state} />}
          {notice?.ok && (
            <p className="mt-4 flex items-start gap-2 rounded-control border border-success/30 bg-success-soft p-3 text-[13px] text-success">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> {notice.text}
            </p>
          )}
          {notice && !notice.ok && <p className="mt-4 text-[13px] text-danger">{notice.text}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {showConfirm ? "Atšaukti" : "Uždaryti"}
          </Button>
          {showConfirm && (
            <form action={formAction}>
              <input type="hidden" name="treatment_id" value={treatmentId} />
              {canReapprove && <input type="hidden" name="reapprove" value="1" />}
              <Button type="submit" disabled={pending}>
                {pending ? "Tvirtinama..." : canReapprove ? "Patvirtinti atnaujintus duomenis" : "Patvirtinti perdavimą"}
              </Button>
            </form>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

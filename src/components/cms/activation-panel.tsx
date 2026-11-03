"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleSlash, Loader2, OctagonX, Power, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { cmsPost } from "@/lib/cms/client";
import { PER_JOB_CHECK_NOTE, activationChecks, fullyActive } from "@/lib/cms/activation";
import type { CmsStatus } from "@/lib/supabase/types";

const STOP_NOTE = "Sustabdžius siuntimą (ar patį darbininką), jau DelPro sukurti atskyrimai NEATŠAUKIAMI — juos išjunkite DelPro programoje.";

/** CMS activation checklist + GVET master switch (emergency stop). 0052: approval alone sends — no destination / mode steps. */
export function CmsActivationPanel({ status, isAdmin, canWrite, compact }: { status: CmsStatus | null; isAdmin: boolean; canWrite: boolean; compact?: boolean }) {
  const router = useRouter();
  const [now] = React.useState(() => Date.now());
  const checks = activationChecks(status, now);
  const active = fullyActive(checks);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);

  async function run(key: string, op: string, payload: Record<string, unknown>, okText?: string) {
    setBusy(key);
    const res = await cmsPost<{ message?: string }>(op, payload);
    setBusy(null);
    setMessage(res.ok ? { ok: true, text: res.data?.message ?? okText ?? "Atlikta." } : { ok: false, text: res.error });
    if (res.ok) router.refresh();
  }

  const stopButton = canWrite && status?.outbound_enabled && (
    <Button
      type="button"
      size="sm"
      variant="danger"
      disabled={!!busy}
      onClick={() => {
        if (window.confirm(`Sustabdyti naujų CMS atskyrimų siuntimą į DelPro?\n\nGydymų siuntimas neliečiamas.\n${STOP_NOTE}`)) {
          void run("stop", "set_outbound_enabled", { enabled: false });
        }
      }}
    >
      {busy === "stop" ? <Loader2 className="size-4 animate-spin" /> : <OctagonX className="size-4" />} Avarinis stabdymas
    </Button>
  );

  if (compact) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
        <Badge tone={active ? "success" : status?.outbound_enabled ? "warning" : "neutral"}>
          {active ? "CMS siuntimas veikia" : status?.outbound_enabled ? `CMS: neįvykdyta ${checks.filter((c) => !c.ok).length} sąlyg.` : "CMS siuntimas sustabdytas"}
        </Badge>
        {stopButton}
        {message && <span className={message.ok ? "text-success" : "text-danger"}>{message.text}</span>}
      </div>
    );
  }

  return (
    <Card className="mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="mr-auto text-[15px] font-semibold text-text-primary">Aktyvavimas</h2>
        <Badge tone={active ? "success" : "neutral"}>{active ? "Visiškai aktyvu" : `Neįvykdyta: ${checks.filter((c) => !c.ok).length} iš ${checks.length}`}</Badge>
        {stopButton}
        {isAdmin && !status?.outbound_enabled && (
          <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => run("enable", "set_outbound_enabled", { enabled: true, confirm: true })}>
            <Power className="size-4" /> Įjungti CMS siuntimą
          </Button>
        )}
      </div>
      <ul className="grid gap-x-6 gap-y-1.5 px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
        {checks.map((c) => (
          <li key={c.id} className="flex items-start gap-2 text-[13px]">
            {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />}
            <span>
              <span className={cn("font-medium", c.ok ? "text-text-primary" : "text-text-secondary")}>{c.label}</span>
              <span className="block text-[11px] text-text-muted">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="px-4 pb-3 text-[12px] text-text-muted">{PER_JOB_CHECK_NOTE}</p>
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface-secondary px-4 py-2 text-[12px] text-text-secondary">
        <CircleSlash className="size-4 shrink-0" />
        <span className="mr-auto">{STOP_NOTE} Ūkio kompiuteryje: <code className="font-mono">scripts\gvet-worker.ps1 -Action cms-off</code></span>
      </div>
      {message && <p className={cn("px-4 py-2 text-[13px]", message.ok ? "text-success" : "text-danger")}>{message.text}</p>}
    </Card>
  );
}

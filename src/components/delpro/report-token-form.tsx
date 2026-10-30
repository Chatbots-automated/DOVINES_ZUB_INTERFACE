"use client";

import * as React from "react";
import { Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useDelproAction } from "@/lib/use-delpro-action";

/** New per-farm upload token; the token itself is shown once (only its SHA-256 is stored). */
export function ReportTokenForm() {
  const [state, formAction, pending] = useDelproAction("createReportUploadToken");
  const [copied, setCopied] = React.useState(false);
  const token = state?.ok ? (state.message ?? null) : null;
  return (
    <div className="space-y-2">
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px]">
          <Label htmlFor="report_token_label">Naujas įkėlimo raktas (kompiuterio vardas)</Label>
          <Input id="report_token_label" name="label" defaultValue="DAU-DOV-KDV-002" autoComplete="off" />
        </div>
        <Button type="submit" size="sm" disabled={pending}>
          <KeyRound className="size-4" /> {pending ? "Kuriama…" : "Sukurti raktą"}
        </Button>
        {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
      </form>
      {token && (
        <div className="rounded-control border border-warning/30 bg-warning-soft p-3 text-[12px]">
          <p className="mb-1 font-semibold text-warning">Nukopijuokite raktą dabar — daugiau jis nebus rodomas.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-surface px-2 py-1 font-mono text-[12px]">{token}</code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(token).then(() => setCopied(true));
              }}
            >
              <Copy className="size-3.5" /> {copied ? "Nukopijuota" : "Kopijuoti"}
            </Button>
          </div>
          <p className="mt-1 text-text-secondary">Ūkio kompiuterio įkėlimo programoje: Authorization: Bearer &lt;raktas&gt;.</p>
        </div>
      )}
    </div>
  );
}

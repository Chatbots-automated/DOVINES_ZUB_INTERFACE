"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { useDelproAction } from "@/lib/use-delpro-action";
import type { DelproOp } from "@/lib/delpro-ops";

/** A single-button form bound to a DelPro operation (/api/delpro/action), with inline error. */
export function ActionButton({
  action,
  fields,
  label,
  pendingLabel,
  variant = "outline",
  confirm,
}: {
  /** /api/delpro/action operation (src/lib/delpro-ops.ts) */
  action: DelproOp;
  fields: Record<string, string>;
  label: React.ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "outline" | "ghost" | "danger";
  confirm?: string;
}) {
  const [state, formAction, pending] = useDelproAction(action);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="inline-flex flex-col items-end gap-1"
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Button type="submit" size="sm" variant={variant} disabled={pending}>
        {pending ? (pendingLabel ?? "...") : label}
      </Button>
      {state && !state.ok && <span className="max-w-[240px] text-right text-[11px] text-danger">{state.error}</span>}
    </form>
  );
}

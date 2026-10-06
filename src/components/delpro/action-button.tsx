"use client";

import * as React from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { DelproActionResult } from "@/lib/actions/delpro";

type Action = (prev: DelproActionResult | null, formData: FormData) => Promise<DelproActionResult>;

/** A single-button form bound to a DelPro server action, with inline error. */
export function ActionButton({
  action,
  fields,
  label,
  pendingLabel,
  variant = "outline",
  confirm,
}: {
  action: Action;
  fields: Record<string, string>;
  label: React.ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "outline" | "ghost" | "danger";
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState<DelproActionResult | null, FormData>(action, null);
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

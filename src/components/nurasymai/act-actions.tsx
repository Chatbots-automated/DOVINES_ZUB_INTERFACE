"use client";

import * as React from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  approveAct,
  cancelAct,
  deleteDraftAct,
  updateActHeader,
  type WriteOffActionResult,
} from "@/lib/actions/write-offs";
import type { WriteOffSignatory } from "@/lib/supabase/types";

type Action = (prev: WriteOffActionResult | null, formData: FormData) => Promise<WriteOffActionResult>;

function ActForm({
  action,
  actId,
  label,
  variant = "outline",
  confirm,
}: {
  action: Action;
  actId: string;
  label: string;
  variant?: "primary" | "outline" | "danger" | "ghost";
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState<WriteOffActionResult | null, FormData>(action, null);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="flex flex-col items-end gap-1"
    >
      <input type="hidden" name="act_id" value={actId} />
      <Button type="submit" size="sm" variant={variant} disabled={pending}>
        {pending ? "..." : label}
      </Button>
      {state && !state.ok && <span className="max-w-[320px] text-right text-[11px] text-danger">{state.error}</span>}
    </form>
  );
}

export function ActStatusActions({ actId, status, allBalanced }: { actId: string; status: string; allBalanced: boolean }) {
  if (status === "draft") {
    return (
      <div className="flex flex-wrap items-start gap-2">
        <ActForm action={deleteDraftAct} actId={actId} label="Ištrinti juodraštį" variant="ghost" confirm="Ištrinti šį juodraštį?" />
        <ActForm
          action={approveAct}
          actId={actId}
          label="Patvirtinti aktą"
          variant="primary"
          confirm={allBalanced ? "Patvirtinus aktą, jo keisti nebebus galima. Tęsti?" : undefined}
        />
      </div>
    );
  }
  if (status === "approved") {
    return (
      <ActForm
        action={cancelAct}
        actId={actId}
        label="Anuliuoti"
        variant="danger"
        confirm="Anuliuoti patvirtintą aktą? Sunaudojimas vėl taps prieinamas naujam aktui."
      />
    );
  }
  return null;
}

export function ActHeaderForm({
  actId,
  actNumber,
  actDate,
  isMaterials,
  accountNo,
  expenseObject,
  approverTitle,
  approverName,
  signatories,
  notes,
}: {
  actId: string;
  actNumber: string;
  actDate: string;
  isMaterials: boolean;
  accountNo: string | null;
  expenseObject: string | null;
  approverTitle: string | null;
  approverName: string | null;
  signatories: WriteOffSignatory[];
  notes: string | null;
}) {
  const [state, formAction, pending] = useActionState<WriteOffActionResult | null, FormData>(updateActHeader, null);
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="act_id" value={actId} />
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <Label htmlFor="act_number">Akto Nr.</Label>
          <Input id="act_number" name="act_number" defaultValue={actNumber} required />
        </div>
        <div>
          <Label htmlFor="act_date">Akto data</Label>
          <Input id="act_date" name="act_date" type="date" defaultValue={actDate} required />
        </div>
        <div>
          <Label htmlFor="approver_title">Tvirtinu — pareigos</Label>
          <Input id="approver_title" name="approver_title" defaultValue={approverTitle ?? ""} />
        </div>
        <div>
          <Label htmlFor="approver_name">Tvirtinu — vardas, pavardė</Label>
          <Input id="approver_name" name="approver_name" defaultValue={approverName ?? ""} />
        </div>
        {isMaterials && (
          <>
            <div>
              <Label htmlFor="account_no">Sąskaita</Label>
              <Input id="account_no" name="account_no" defaultValue={accountNo ?? ""} />
            </div>
            <div className="sm:col-span-3">
              <Label htmlFor="expense_object">Išlaidų objektas</Label>
              <Input id="expense_object" name="expense_object" defaultValue={expenseObject ?? ""} />
            </div>
          </>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="signatories">Pasirašo (Pareigos | Vardas Pavardė, po vieną eilutėje)</Label>
          <Textarea
            id="signatories"
            name="signatories"
            rows={3}
            defaultValue={signatories.map((s) => `${s.title} | ${s.name}`).join("\n")}
          />
        </div>
        <div>
          <Label htmlFor="notes">Pastabos</Label>
          <Textarea id="notes" name="notes" rows={3} defaultValue={notes ?? ""} />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {state?.ok && <span className="text-[11px] text-success">✓ Išsaugota</span>}
        {state && !state.ok && <span className="text-[11px] text-danger">{state.error}</span>}
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "..." : "Išsaugoti antraštę"}
        </Button>
      </div>
    </form>
  );
}

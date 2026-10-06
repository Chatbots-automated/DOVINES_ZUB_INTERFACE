"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import {
  addWriteOffGroupRule,
  deleteWriteOffGroupRule,
  saveWriteOffActDefaults,
  saveWriteOffGroup,
  type WriteOffGroupActionResult,
} from "@/lib/actions/write-off-groups";
import { WRITE_OFF_KIND_OPTIONS, WRITE_OFF_RULE_FIELDS } from "@/lib/write-off-kinds";
import type { WriteOffGroupRuleField, WriteOffKind } from "@/lib/supabase/types";

type State = WriteOffGroupActionResult | null;

function Feedback({ state }: { state: State }) {
  if (state?.ok && state.message) return <span className="text-[12px] text-success">{state.message}</span>;
  if (state && !state.ok) return <span className="text-[12px] text-danger">{state.error}</span>;
  return null;
}

function KindCheckboxes({ selected }: { selected: WriteOffKind[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {WRITE_OFF_KIND_OPTIONS.map((k) => (
        <label key={k.value} className="flex items-center gap-1.5 text-[13px] text-text-secondary">
          <input type="checkbox" name="act_kinds" value={k.value} defaultChecked={selected.includes(k.value)} className="size-4 rounded border-border-strong" />
          {k.label}
        </label>
      ))}
    </div>
  );
}

export function GroupEditForm({
  group,
}: {
  group: { id: string; name: string; act_kinds: WriteOffKind[]; sort_order: number; active: boolean };
}) {
  const [state, formAction, pending] = useActionState<State, FormData>(saveWriteOffGroup, null);
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_90px] sm:items-end">
      <input type="hidden" name="id" value={group.id} />
      <div>
        <Label htmlFor={`name-${group.id}`}>Pavadinimas</Label>
        <Input id={`name-${group.id}`} name="name" defaultValue={group.name} required />
      </div>
      <div>
        <Label htmlFor={`sort-${group.id}`}>Eilė</Label>
        <Input id={`sort-${group.id}`} name="sort_order" type="number" defaultValue={group.sort_order} />
      </div>
      <div className="sm:col-span-2">
        <KindCheckboxes selected={group.act_kinds} />
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <label className="flex items-center gap-1.5 text-[13px] text-text-secondary">
          <input type="checkbox" name="active" defaultChecked={group.active} className="size-4 rounded border-border-strong" />
          Aktyvi
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Saugoma..." : "Išsaugoti"}
        </Button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function NewGroupForm() {
  const [state, formAction, pending] = useActionState<State, FormData>(saveWriteOffGroup, null);
  const formRef = React.useRef<HTMLFormElement>(null);
  React.useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);
  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_90px]">
        <div>
          <Label htmlFor="new-group-name">Naujos grupės pavadinimas</Label>
          <Input id="new-group-name" name="name" required placeholder="pvz. Telyčios" />
        </div>
        <div>
          <Label htmlFor="new-group-sort">Eilė</Label>
          <Input id="new-group-sort" name="sort_order" type="number" defaultValue={30} />
        </div>
      </div>
      <KindCheckboxes selected={[]} />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          <Plus className="size-4" /> {pending ? "Kuriama..." : "Sukurti grupę"}
        </Button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function DeleteRuleButton({ id, label }: { id: string; label: string }) {
  const [state, formAction, pending] = useActionState<State, FormData>(deleteWriteOffGroupRule, null);
  return (
    <form action={formAction} className="inline-flex items-center">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        title={`Pašalinti taisyklę „${label}“`}
        className="rounded p-0.5 text-text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-50"
      >
        <X className="size-3.5" />
      </button>
      {state && !state.ok && <span className="ml-1 text-[11px] text-danger">{state.error}</span>}
    </form>
  );
}

export function AddRuleForm({ groupId, delproGroups, sexes }: { groupId: string; delproGroups: string[]; sexes: string[] }) {
  const [state, formAction, pending] = useActionState<State, FormData>(addWriteOffGroupRule, null);
  const [field, setField] = React.useState<WriteOffGroupRuleField>("delpro_group");
  const formRef = React.useRef<HTMLFormElement>(null);
  React.useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);
  const listId = `rule-values-${groupId}-${field}`;
  const options = field === "delpro_group" ? delproGroups : sexes;

  return (
    <form ref={formRef} action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="write_off_group_id" value={groupId} />
      <Select
        name="match_field"
        value={field}
        onChange={(e) => setField(e.target.value as WriteOffGroupRuleField)}
        className="h-8 w-auto text-[13px]"
      >
        {(Object.keys(WRITE_OFF_RULE_FIELDS) as WriteOffGroupRuleField[]).map((f) => (
          <option key={f} value={f}>
            {WRITE_OFF_RULE_FIELDS[f]}
          </option>
        ))}
      </Select>
      <span className="text-[13px] text-text-muted">=</span>
      <Input name="match_value" list={listId} required placeholder="reikšmė" className="h-8 w-48 text-[13px]" />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        <Plus className="size-4" /> Taisyklė
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export type ActDefaults = {
  letterheadAddress: string;
  approverTitle: string;
  approverName: string;
  medziagosAccount: string;
  medziagosExpenseObject: string;
  signatories: Record<WriteOffKind, string>; // "Pareigos | Vardas Pavardė" per line
};

export function ActDefaultsForm({ defaults }: { defaults: ActDefaults }) {
  const [state, formAction, pending] = useActionState<State, FormData>(saveWriteOffActDefaults, null);
  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <Label htmlFor="write_off_letterhead_address">Adresas akto antraštėje</Label>
          <Input id="write_off_letterhead_address" name="write_off_letterhead_address" defaultValue={defaults.letterheadAddress} />
        </div>
        <div>
          <Label htmlFor="write_off_approver_title">„Tvirtinu“ — pareigos</Label>
          <Input id="write_off_approver_title" name="write_off_approver_title" defaultValue={defaults.approverTitle} />
        </div>
        <div>
          <Label htmlFor="write_off_approver_name">„Tvirtinu“ — vardas, pavardė</Label>
          <Input id="write_off_approver_name" name="write_off_approver_name" defaultValue={defaults.approverName} />
        </div>
        <div />
        <div>
          <Label htmlFor="write_off_medziagos_account">Medžiagų aktas — sąskaita</Label>
          <Input id="write_off_medziagos_account" name="write_off_medziagos_account" defaultValue={defaults.medziagosAccount} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="write_off_medziagos_expense_object">Medžiagų aktas — išlaidų objektas</Label>
          <Input
            id="write_off_medziagos_expense_object"
            name="write_off_medziagos_expense_object"
            defaultValue={defaults.medziagosExpenseObject}
          />
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {WRITE_OFF_KIND_OPTIONS.map((k) => (
          <div key={k.value}>
            <Label htmlFor={`signatories_${k.value}`}>Pasirašo — {k.label}</Label>
            <Textarea
              id={`signatories_${k.value}`}
              name={`signatories_${k.value}`}
              rows={3}
              defaultValue={defaults.signatories[k.value]}
              placeholder="Pareigos | Vardas Pavardė"
            />
          </div>
        ))}
      </div>
      <p className="text-[11px] text-text-muted">
        Vienas asmuo eilutėje, formatu „Pareigos | Vardas Pavardė“. Pakeitimai taikomi naujai formuojamiems aktams — esamų juodraščių
        antraštės keičiamos pačiame akte.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saugoma..." : "Išsaugoti"}
        </Button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

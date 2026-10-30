"use client";

import * as React from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { catalogJobAction, linkCatalogRecord, updateCatalogInboundMode, updateCatalogOutboundMode } from "@/lib/actions/delpro-catalog";
import type { DelproActionResult } from "@/lib/actions/delpro";
import type { CatalogInboundMode, CatalogOutboundMode } from "@/lib/delpro-catalog";

type Option = { value: string; label: string };
type LinkableType = "Diagnosis" | "Drug" | "Treatment";

/** Manual link of an unlinked DelPro diagnosis / drug / treatment template to an unlinked GVET record. */
export function CatalogLinkForm({
  delpro,
  gvet,
}: {
  delpro: Record<LinkableType, Option[]>;
  gvet: Record<LinkableType, Option[]>;
}) {
  const [state, formAction, pending] = useActionState<DelproActionResult | null, FormData>(linkCatalogRecord, null);
  const [type, setType] = React.useState<LinkableType>("Diagnosis");
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="w-36">
        <Label htmlFor="catalog_link_type">Tipas</Label>
        <Select id="catalog_link_type" name="object_type" value={type} onChange={(e) => setType(e.target.value as LinkableType)}>
          <option value="Diagnosis">Diagnozė / liga</option>
          <option value="Drug">Vaistas</option>
          <option value="Treatment">Gydymo šablonas</option>
        </Select>
      </div>
      <div className="min-w-[220px] flex-1">
        <Label htmlFor="catalog_link_delpro">DelPro įrašas</Label>
        <Select id="catalog_link_delpro" name="delpro_key" key={`d-${type}`} defaultValue="">
          <option value="" disabled>
            Pasirinkite…
          </option>
          {delpro[type].map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-[220px] flex-1">
        <Label htmlFor="catalog_link_gvet">GVET įrašas</Label>
        <Select id="catalog_link_gvet" name="gvet_id" key={`g-${type}`} defaultValue="">
          <option value="" disabled>
            Pasirinkite…
          </option>
          {gvet[type].map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Siejama..." : "Susieti"}
      </Button>
      {state?.ok && state.message && <span className="text-[12px] text-success">{state.message}</span>}
      {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
    </form>
  );
}

export function CatalogInboundModeForm({ mode }: { mode: CatalogInboundMode }) {
  const [state, formAction, pending] = useActionState<DelproActionResult | null, FormData>(updateCatalogInboundMode, null);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="min-w-[260px] flex-1">
        <Label htmlFor="delpro_catalog_inbound_mode">DelPro pakeitimai susietiems įrašams</Label>
        <Select id="delpro_catalog_inbound_mode" name="delpro_catalog_inbound_mode" defaultValue={mode}>
          <option value="review">Tvirtinami ranka</option>
          <option value="auto">Pavadinimai ir aktyvumas — automatiškai</option>
        </Select>
        <p className="mt-1 text-[11px] text-text-muted">Karencija ir matavimo vienetai visada tvirtinami ranka.</p>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saugoma..." : "Išsaugoti"}
      </Button>
      {state?.ok && state.message && <span className="text-[12px] text-success">{state.message}</span>}
      {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
    </form>
  );
}

export function CatalogOutboundModeForm({ mode }: { mode: CatalogOutboundMode }) {
  const [state, formAction, pending] = useActionState<DelproActionResult | null, FormData>(updateCatalogOutboundMode, null);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="min-w-[260px] flex-1">
        <Label htmlFor="delpro_catalog_outbound_mode">GVET pakeitimai į DelPro</Label>
        <Select id="delpro_catalog_outbound_mode" name="delpro_catalog_outbound_mode" defaultValue={mode}>
          <option value="manual">Siunčiami ranka („Siųsti į DelPro“, „Sukurti DelPro“)</option>
          <option value="auto">Nauji ir pakeisti GVET įrašai — į eilę automatiškai</option>
        </Select>
        <p className="mt-1 text-[11px] text-text-muted">Eilė vykdoma tik kai rašymas įjungtas ir operacija patikrinta bandomuoju įrašu.</p>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saugoma..." : "Išsaugoti"}
      </Button>
      {state?.ok && state.message && <span className="text-[12px] text-success">{state.message}</span>}
      {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
    </form>
  );
}

/**
 * A create step whose earlier write has an unknown outcome (0037). The worker never
 * adopts a DelPro record by name, so the admin checks DelPro and either assigns the
 * record (it is then read back and compared) or confirms it does not exist.
 */
export function UncertainStepForm({
  jobId,
  step,
  keyProperty,
  candidates,
}: {
  jobId: string;
  step: string;
  keyProperty: string;
  candidates: { key: string; name: string | null }[];
}) {
  const [state, formAction, pending] = useActionState<DelproActionResult | null, FormData>(catalogJobAction, null);
  const listId = `uncertain-${jobId}-${step}`;
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
        const message =
          action === "resend"
            ? "Ar DelPro programoje patikrinote, kad šio įrašo nėra? Jis bus sukurtas iš naujo."
            : "Ar DelPro programoje patikrinote, kad tai tas pats įrašas? Jis bus nuskaitytas ir palygintas su siųstomis reikšmėmis.";
        if (!window.confirm(message)) e.preventDefault();
      }}
      className="mt-1 flex flex-wrap items-center justify-end gap-2"
    >
      <input type="hidden" name="job_id" value={jobId} />
      <input type="hidden" name="step" value={step} />
      <Input name="key" list={listId} placeholder={`DelPro ${keyProperty}`} className="h-8 w-28 text-[12px]" />
      <datalist id={listId}>
        {candidates.map((c) => (
          <option key={c.key} value={c.key}>
            {c.name ?? c.key}
          </option>
        ))}
      </datalist>
      <Button type="submit" size="sm" variant="outline" name="action" value="adopt" disabled={pending}>
        Priskirti įrašą
      </Button>
      <Button type="submit" size="sm" variant="ghost" name="action" value="resend" disabled={pending}>
        Įrašo nėra — siųsti iš naujo
      </Button>
      {state && !state.ok && <span className="w-full text-right text-[11px] text-danger">{state.error}</span>}
    </form>
  );
}

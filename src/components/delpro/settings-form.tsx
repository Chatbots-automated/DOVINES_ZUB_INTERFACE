"use client";

import * as React from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { updateDelproSettings, type DelproActionResult } from "@/lib/actions/delpro";
import type { DelproOutboundMode } from "@/lib/supabase/types";

export function DelproSettingsForm({
  mode,
  delayMinutes,
  defaultTreatmentCode,
}: {
  mode: DelproOutboundMode;
  delayMinutes: string;
  defaultTreatmentCode: string;
}) {
  const [state, formAction, pending] = useActionState<DelproActionResult | null, FormData>(updateDelproSettings, null);
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <Label htmlFor="delpro_outbound_mode">Gydymų siuntimas į DelPro</Label>
        <Select id="delpro_outbound_mode" name="delpro_outbound_mode" defaultValue={mode}>
          <option value="approval">Administratorius tvirtina kiekvieną įrašą</option>
          <option value="auto">Automatiškai (po delsos)</option>
          <option value="off">Išjungta (įrašai nekaupiami)</option>
        </Select>
        <p className="mt-1 text-[11px] text-text-muted">
          Pastebėjus netinkamą siuntimą, siuntimą galima laikinai išjungti (Sutarties 11.4 p.).
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="delpro_auto_delay_minutes">Auto režimo delsa (min.)</Label>
          <Input id="delpro_auto_delay_minutes" name="delpro_auto_delay_minutes" type="number" min="0" defaultValue={delayMinutes} />
        </div>
        <div>
          <Label htmlFor="delpro_default_treatment_code">Numatytasis DelPro gydymo įrašas</Label>
          <Input id="delpro_default_treatment_code" name="delpro_default_treatment_code" defaultValue={defaultTreatmentCode} placeholder="pvz. GYD-01" />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saugoma..." : "Išsaugoti"}
        </Button>
        {state?.ok && state.message && <span className="text-[12px] text-success">{state.message}</span>}
        {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
      </div>
    </form>
  );
}

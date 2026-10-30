"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { DelproOutboundMode } from "@/lib/supabase/types";
import { useDelproAction } from "@/lib/use-delpro-action";

export function DelproSettingsForm({ mode, delayMinutes }: { mode: DelproOutboundMode; delayMinutes: string }) {
  const [state, formAction, pending] = useDelproAction("updateDelproSettings");
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="min-w-[220px] flex-1">
        <Label htmlFor="delpro_outbound_mode">Gydymų siuntimas</Label>
        <Select id="delpro_outbound_mode" name="delpro_outbound_mode" defaultValue={mode}>
          <option value="approval">Tvirtinama ranka</option>
          <option value="auto">Automatiškai po delsos</option>
          <option value="off">Išjungta</option>
        </Select>
      </div>
      <div className="w-32">
        <Label htmlFor="delpro_auto_delay_minutes">Delsa (min.)</Label>
        <Input id="delpro_auto_delay_minutes" name="delpro_auto_delay_minutes" type="number" min="0" defaultValue={delayMinutes} />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saugoma..." : "Išsaugoti"}
      </Button>
      {state?.ok && state.message && <span className="text-[12px] text-success">{state.message}</span>}
      {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
    </form>
  );
}

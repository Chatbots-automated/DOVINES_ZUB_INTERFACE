"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDelproAction } from "@/lib/use-delpro-action";

export function MappingRow({
  kind,
  localId,
  localName,
  code,
  name,
}: {
  kind: "disease" | "product";
  localId: string;
  localName: string;
  code: string | null;
  name: string | null;
}) {
  const [state, formAction, pending] = useDelproAction("saveDelproMapping");
  return (
    <form action={formAction} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.6fr)_auto] items-center gap-2 px-5 py-2">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="local_id" value={localId} />
      <span className="truncate text-[13px] text-text-primary" title={localName}>
        {localName}
      </span>
      <Input name="delpro_name" defaultValue={name ?? ""} placeholder="Pavadinimas DelPro" className="h-8" />
      {kind === "disease" ? (
        <Input name="delpro_code" defaultValue={code ?? ""} placeholder="Kodas" className="h-8" />
      ) : (
        <input type="hidden" name="delpro_code" value={code ?? ""} />
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "..." : "Saugoti"}
        </Button>
        {state?.ok && <span className="text-[11px] text-success">✓</span>}
        {state && !state.ok && <span className="text-[11px] text-danger">{state.error}</span>}
      </div>
    </form>
  );
}

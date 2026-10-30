"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionButton } from "@/components/delpro/action-button";
import type { Database, Unit } from "@/lib/supabase/types";
import { useDelproAction } from "@/lib/use-delpro-action";

// GVET treatment templates (0037) — the GVET side of DelPro's Treatment +
// TreatmentDrugUsage templates. Saved through save_treatment_template(); a
// linked template's changes then show as "Laukia siuntimo į DelPro".

export type TemplateRow = Database["public"]["Views"]["vw_treatment_templates"]["Row"];
export type TemplateProduct = { id: string; name: string; unit: Unit; withdrawal_days_milk: number; withdrawal_days_meat: number };

type Line = {
  id?: string;
  product_id: string;
  dosage: string;
  frequency: string;
  treat_cow_days: string;
  uom: string;
  application_method: string;
  milk_days: string;
  meat_days: string;
};

// Mirrors fn_delpro_uom(): GVET unit -> DelPro UOM (l / kg have none).
const UOM: Partial<Record<Unit, string>> = { ml: "ml", g: "gm", pcs: "pcs", vnt: "pcs", tablet: "pcs", dose: "pcs" };

function lineFor(product: TemplateProduct | undefined, base: Partial<Line> = {}): Line {
  return {
    product_id: product?.id ?? "",
    dosage: "",
    frequency: "1",
    treat_cow_days: "1",
    uom: product ? (UOM[product.unit] ?? "") : "",
    application_method: "",
    milk_days: product ? String(product.withdrawal_days_milk) : "0",
    meat_days: product ? String(product.withdrawal_days_meat) : "0",
    ...base,
  };
}

function TemplateEditor({
  template,
  products,
  diseases,
  onDone,
}: {
  template?: TemplateRow;
  products: TemplateProduct[];
  diseases: { id: string; name: string }[];
  onDone: () => void;
}) {
  const [state, formAction, pending] = useDelproAction("saveTreatmentTemplate");
  const [name, setName] = React.useState(template?.name ?? "");
  const [active, setActive] = React.useState(template?.active ?? true);
  const [type, setType] = React.useState(template?.treatment_type ?? "");
  const [lines, setLines] = React.useState<Line[]>(
    template?.items.map((i) => ({
      id: i.id,
      product_id: i.product_id,
      dosage: String(i.dosage),
      frequency: String(i.frequency),
      treat_cow_days: String(i.treat_cow_days),
      uom: i.uom ?? "",
      application_method: i.application_method ?? "",
      milk_days: String(i.milk_days),
      meat_days: String(i.meat_days),
    })) ?? [lineFor(undefined)],
  );
  const [diseaseIds, setDiseaseIds] = React.useState<string[]>(template?.diseases.map((d) => d.id) ?? []);

  React.useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);

  const update = (n: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, i) => (i === n ? { ...l, ...patch } : l)));
  const payload = JSON.stringify({
    id: template?.id,
    name,
    active,
    treatment_type: type,
    disease_ids: diseaseIds,
    items: lines.map((l) => ({
      id: l.id,
      product_id: l.product_id,
      dosage: l.dosage,
      frequency: l.frequency,
      treat_cow_days: l.treat_cow_days,
      uom: l.uom,
      application_method: l.application_method,
      milk_days: l.milk_days,
      meat_days: l.meat_days,
    })),
  });

  return (
    <form action={formAction} className="space-y-3 rounded-panel border border-border p-3">
      <input type="hidden" name="template" value={payload} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <Label>Pavadinimas</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="w-44">
          <Label>Gydymo tipas (DelPro)</Label>
          <Input value={type} onChange={(e) => setType(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 pb-2 text-[13px]">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Aktyvus
        </label>
      </div>

      <table className="w-full text-[12px]">
        <thead className="text-left text-text-muted">
          <tr>
            <th className="pr-2 font-medium">Vaistas</th>
            <th className="px-1 font-medium">Dozė</th>
            <th className="px-1 font-medium">Mat. vnt.</th>
            <th className="px-1 font-medium">Kartai / d.</th>
            <th className="px-1 font-medium">Dienos</th>
            <th className="px-1 font-medium">Skyrimo būdas</th>
            <th className="px-1 font-medium">Pienas, d.</th>
            <th className="px-1 font-medium">Mėsa, d.</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, n) => (
            <tr key={l.id ?? `new-${n}`}>
              <td className="py-1 pr-2">
                <Select
                  value={l.product_id}
                  onChange={(e) => {
                    const p = products.find((x) => x.id === e.target.value);
                    update(n, lineFor(p, { id: l.id, dosage: l.dosage, frequency: l.frequency, treat_cow_days: l.treat_cow_days }));
                  }}
                  required
                >
                  <option value="" disabled>
                    Pasirinkite…
                  </option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </td>
              {(["dosage", "uom", "frequency", "treat_cow_days", "application_method", "milk_days", "meat_days"] as const).map((f) => (
                <td key={f} className="px-1 py-1">
                  <Input
                    className="h-8"
                    value={l[f]}
                    inputMode={f === "uom" || f === "application_method" ? undefined : "decimal"}
                    onChange={(e) => update(n, { [f]: e.target.value })}
                  />
                </td>
              ))}
              <td className="py-1 pl-1">
                <Button type="button" size="sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((_, i) => i !== n))} disabled={lines.length === 1}>
                  <Trash2 className="size-3.5" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button type="button" size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, lineFor(undefined)])}>
        <Plus className="size-3.5" /> Vaistas
      </Button>

      <div>
        <Label>Rekomenduojamas ligoms (DelPro Diagnosis.RecommendedTreatment)</Label>
        <Select
          multiple
          className="h-28"
          value={diseaseIds}
          onChange={(e) => setDiseaseIds(Array.from(e.target.selectedOptions).map((o) => o.value))}
        >
          {diseases.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saugoma..." : "Išsaugoti šabloną"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Atšaukti
        </Button>
        <span className="text-[11px] text-text-muted">Karencija ir dozės — klinikiniai duomenys: tikrinkite prieš išsaugodami.</span>
        {state && !state.ok && <span className="text-[12px] text-danger">{state.error}</span>}
      </div>
    </form>
  );
}

export function TreatmentTemplates({
  templates,
  products,
  diseases,
}: {
  templates: TemplateRow[];
  products: TemplateProduct[];
  diseases: { id: string; name: string }[];
}) {
  const [editing, setEditing] = React.useState<string | null>(null);
  const close = React.useCallback(() => setEditing(null), []);
  return (
    <div className="space-y-3">
      {editing === "new" ? (
        <TemplateEditor products={products} diseases={diseases} onDone={close} />
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing("new")}>
          <Plus className="size-3.5" /> Naujas šablonas
        </Button>
      )}
      <div className="-mx-4 divide-y divide-border border-t border-border">
        {templates.map((t) =>
          editing === t.id ? (
            <div key={t.id} className="px-4 py-2">
              <TemplateEditor template={t} products={products} diseases={diseases} onDone={close} />
            </div>
          ) : (
            <div key={t.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-2">
              <div className="min-w-0 flex-1 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={t.active ? "font-medium" : "font-medium text-text-muted"}>{t.name}</span>
                  {t.delpro_key ? <Badge tone="success">DelPro {t.delpro_key}</Badge> : <Badge tone="neutral">Nesusietas su DelPro</Badge>}
                  {!t.active && <Badge tone="neutral">Neaktyvus</Badge>}
                </div>
                {t.items.map((i) => (
                  <div key={i.id} className="text-[12px] text-text-secondary">
                    {i.product_name} — {i.dosage} {i.uom ?? i.unit} × {i.frequency} × {i.treat_cow_days} d. (pienas {i.milk_days} d., mėsa {i.meat_days} d.)
                  </div>
                ))}
                {t.diseases.length > 0 && <div className="text-[11px] text-text-muted">Ligoms: {t.diseases.map((d) => d.name).join(", ")}</div>}
              </div>
              <div className="flex items-start gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setEditing(t.id)}>
                  Redaguoti
                </Button>
                {!t.delpro_key && (
                  <ActionButton action="deleteTreatmentTemplate" fields={{ id: t.id }} label="Ištrinti" variant="ghost" confirm={`Ištrinti šabloną „${t.name}“?`} />
                )}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

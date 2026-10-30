"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DelproImportAction, DelproImportPlanRow } from "@/lib/supabase/types";
import { useDelproAction } from "@/lib/use-delpro-action";

const ACTION_LABEL: Record<DelproImportAction, string> = {
  create: "Sukurti GVET",
  link: "Susieti su esamu",
  review: "Reikia peržiūros",
  blocked: "Negalima importuoti",
  linked: "Jau susieta",
};
const ACTION_TONE: Record<DelproImportAction, "success" | "info" | "warning" | "danger" | "neutral"> = {
  create: "success",
  link: "info",
  review: "warning",
  blocked: "danger",
  linked: "neutral",
};
const ORDER: DelproImportAction[] = ["create", "link", "review", "blocked", "linked"];
const TYPE_LABEL = { Diagnosis: "Diagnozės", Drug: "Vaistai" } as const;

const rowId = (r: DelproImportPlanRow) => `${r.object_type}|${r.delpro_key}`;
const selectable = (r: DelproImportPlanRow) => r.action === "create" || r.action === "link";
// inactive DelPro records are offered but not pre-selected
const preselected = (r: DelproImportPlanRow) => selectable(r) && r.delpro_active !== false;

function days(v: number | null | undefined) {
  return v === null || v === undefined ? "?" : `${v} d.`;
}

function Detail({ row }: { row: DelproImportPlanRow }) {
  const v = row.delpro_values;
  return (
    <div className="text-[11.5px] text-text-secondary">
      {row.action === "link" && (
        <div>
          ↔ GVET: <strong>{row.gvet_name}</strong>{" "}
          <span className="text-text-muted">({row.match_source === "mapping" ? "pagal ūkio susiejimą" : "tikslus pavadinimas"}; GVET reikšmės nekeičiamos)</span>
        </div>
      )}
      {row.object_type === "Drug" && row.action !== "linked" && (
        <div>
          DelPro: {v.uom ?? "?"}, karencija pienui {days(v.milk_days)}, mėsai {days(v.meat_days)}
          {v.active_substance ? `, ${v.active_substance}` : ""}
          {v.params_key ? <span className="text-text-muted"> · parametrai {v.params_key}</span> : null}
        </div>
      )}
      {row.reason && <div className={row.action === "blocked" ? "text-danger" : row.action === "review" ? "text-warning" : "text-text-muted"}>{row.reason}</div>}
      {row.action === "review" && row.candidates.length > 0 && (
        <div className="text-text-muted">
          GVET: {row.candidates.map((c) => `${c.name}${c.linked ? " (susietas)" : ""}`).join(", ")} — susiekite ranka žemiau arba palikite.
        </div>
      )}
    </div>
  );
}

/**
 * DelPro -> GVET import (0039): the database's plan for every unlinked DelPro
 * diagnosis / drug, applied only for the rows the admin ticks. Each row carries
 * the fingerprint it was shown with; the database refuses a row whose decision
 * changed since (stale preview), and skips rows already linked (idempotent).
 */
export function CatalogImportPanel({ rows, drugParametersComplete }: { rows: DelproImportPlanRow[]; drugParametersComplete: boolean }) {
  const [state, formAction, pending] = useDelproAction("applyCatalogImport");
  const [type, setType] = React.useState<"Diagnosis" | "Drug">("Diagnosis");
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(rows.filter(preselected).map(rowId)));
  const [showLinked, setShowLinked] = React.useState(false);

  const visible = rows
    .filter((r) => r.object_type === type && (showLinked || r.action !== "linked"))
    .sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action) || (a.delpro_name ?? "").localeCompare(b.delpro_name ?? "", "lt"));
  const count = (t: string, a: DelproImportAction) => rows.filter((r) => r.object_type === t && r.action === a).length;
  const chosen = rows.filter((r) => selectable(r) && selected.has(rowId(r)));
  const items = chosen.map((r) => ({ object_type: r.object_type, delpro_key: r.delpro_key, action: r.action, fingerprint: r.fingerprint }));
  const creates = chosen.filter((r) => r.action === "create").length;
  const links = chosen.length - creates;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const setAll = (on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const r of visible.filter(selectable)) {
        if (on) n.add(rowId(r));
        else n.delete(rowId(r));
      }
      return n;
    });

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(`Importuoti į GVET: sukurti ${creates}, susieti ${links}? Esamų GVET įrašų reikšmės nekeičiamos; skirtumai bus parodyti sprendimui.`)) {
          e.preventDefault();
        }
      }}
      className="space-y-3"
    >
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <div className="flex flex-wrap items-center gap-2">
        {(["Diagnosis", "Drug"] as const).map((t) => (
          <Button key={t} type="button" size="sm" variant={type === t ? "primary" : "outline"} onClick={() => setType(t)}>
            {TYPE_LABEL[t]} ({rows.filter((r) => r.object_type === t && r.action !== "linked").length})
          </Button>
        ))}
        <span className="text-[12px] text-text-muted">
          sukurti {count(type, "create")} · susieti {count(type, "link")} · peržiūrai {count(type, "review")} · negalima {count(type, "blocked")} · jau susieta{" "}
          {count(type, "linked")}
        </span>
      </div>

      {type === "Drug" && !drugParametersComplete && (
        <p className="text-[12px] text-warning">
          DelPro parametrų (DrugParameters) sąrašas gautas nepilnas. Vaistai, kurių parametrai negauti, neimportuojami — vienetas ir karencija nespėjami. Po
          sinchronizacijos su atnaujinta ūkio programa jie bus nuskaityti pagal raktą.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <button type="button" className="text-accent hover:underline" onClick={() => setAll(true)}>
          Pažymėti visus galimus
        </button>
        <button type="button" className="text-accent hover:underline" onClick={() => setAll(false)}>
          Nuimti žymėjimą
        </button>
        <label className="flex items-center gap-1.5 text-text-secondary">
          <input type="checkbox" checked={showLinked} onChange={(e) => setShowLinked(e.target.checked)} /> Rodyti jau susietus
        </label>
      </div>

      <div className="-mx-4 max-h-[520px] divide-y divide-border overflow-y-auto border-y border-border">
        {visible.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-text-muted">Nėra.</p>
        ) : (
          visible.map((r) => (
            <label key={rowId(r)} className={`flex items-start gap-3 px-4 py-2 ${selectable(r) ? "cursor-pointer" : ""}`}>
              <input
                type="checkbox"
                className="mt-1"
                disabled={!selectable(r)}
                checked={selectable(r) && selected.has(rowId(r))}
                onChange={() => toggle(rowId(r))}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] text-text-primary">{r.delpro_name ?? "—"}</span>
                  <span className="text-[11px] text-text-muted">DelPro {r.delpro_key}</span>
                  {r.delpro_active === false && <span className="text-[11px] text-text-muted">(neaktyvus)</span>}
                  <Badge tone={ACTION_TONE[r.action]}>{ACTION_LABEL[r.action]}</Badge>
                </div>
                <Detail row={r} />
              </div>
            </label>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" variant="primary" disabled={pending || items.length === 0}>
          {pending ? "Importuojama…" : `Importuoti pažymėtus (${items.length})`}
        </Button>
        <span className="text-[12px] text-text-muted">Kartoti saugu: jau susieti įrašai praleidžiami, dublikatai nekuriami.</span>
        {state && <span className={`text-[12px] ${state.ok ? "text-success" : "text-danger"}`}>{state.ok ? state.message : state.error}</span>}
      </div>
    </form>
  );
}

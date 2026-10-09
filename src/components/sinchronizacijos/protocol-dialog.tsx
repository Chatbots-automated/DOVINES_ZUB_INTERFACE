"use client";

import * as React from "react";
import { useActionState } from "react";
import { Plus, Trash2, Pill, Dna } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, Select } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { RouteSelect } from "@/components/gydymas/medicine-line";
import { saveSyncProtocol, deleteSyncProtocol, type ActionResult } from "@/lib/actions/sync-protocols";
import type { SyncProductOption, SyncProtocolData } from "@/lib/sync-protocols";
import type { SyncStepKind } from "@/lib/supabase/types";

type DraftMed = { key: string; product_id: string; qty: string; route: string };
type DraftStep = { key: string; day_offset: string; title: string; notes: string; kind: SyncStepKind; meds: DraftMed[] };
type Draft = { name: string; description: string; steps: DraftStep[] };

const newKey = () => crypto.randomUUID();
const newMed = (): DraftMed => ({ key: newKey(), product_id: "", qty: "", route: "" });
const newStep = (day: number, kind: SyncStepKind = "veiksmas"): DraftStep => ({ key: newKey(), day_offset: String(day), title: "", notes: "", kind, meds: [] });

function toDraft(p?: SyncProtocolData): Draft {
  if (!p) return { name: "", description: "", steps: [newStep(0)] };
  return {
    name: p.name,
    description: p.description ?? "",
    steps: p.steps.map((s) => ({
      key: newKey(),
      day_offset: String(s.day_offset),
      title: s.title,
      notes: s.notes ?? "",
      kind: s.kind,
      meds: s.medications.map((m) => ({ key: newKey(), product_id: m.product_id, qty: String(m.qty), route: m.administration_route ?? "" })),
    })),
  };
}

// "Sinchronizacijos protokolas" builder — the farm's own template: dated steps
// (day 0 = the start date) with optional medicine lines per step. Saved by one
// RPC (save_sync_protocol, 0025). Medicine here is only a plan: stock is drawn
// (FEFO) when the vet records the step on its visit, never on save.
export function ProtocolDialog({
  protocol,
  products,
  trigger,
  onSaved,
  onDeleted,
}: {
  /** Omit to create a new protocol. */
  protocol?: SyncProtocolData;
  products: SyncProductOption[];
  trigger?: React.ReactNode;
  /** Fires with the saved protocol's id (created or edited). */
  onSaved?: (id: string) => void;
  onDeleted?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(saveSyncProtocol, null);
  const [deleteState, deleteAction, deletePending] = useActionState<ActionResult | null, FormData>(deleteSyncProtocol, null);
  const [draft, setDraft] = React.useState<Draft>(() => toDraft(protocol));

  const productOptions: ComboboxOption[] = React.useMemo(() => products.map((p) => ({ value: p.id, label: p.name, sublabel: p.unit })), [products]);
  const unitById = React.useMemo(() => new Map(products.map((p) => [p.id, p.unit])), [products]);

  const [handledState, setHandledState] = React.useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.ok) setOpen(false);
  }
  const [handledDelete, setHandledDelete] = React.useState(deleteState);
  if (deleteState !== handledDelete) {
    setHandledDelete(deleteState);
    if (deleteState?.ok) setOpen(false);
  }

  // Tell the host (the protocol picker) after the dialog has closed, outside render.
  const callbacks = React.useRef({ onSaved, onDeleted });
  React.useEffect(() => {
    callbacks.current = { onSaved, onDeleted };
  }, [onSaved, onDeleted]);
  React.useEffect(() => {
    if (state?.ok && state.id) callbacks.current.onSaved?.(state.id);
  }, [state]);
  React.useEffect(() => {
    if (deleteState?.ok) callbacks.current.onDeleted?.();
  }, [deleteState]);

  function patchStep(key: string, patch: Partial<DraftStep>) {
    setDraft((d) => ({ ...d, steps: d.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)) }));
  }
  function patchMed(stepKey: string, medKey: string, patch: Partial<DraftMed>) {
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s) => (s.key === stepKey ? { ...s, meds: s.meds.map((m) => (m.key === medKey ? { ...m, ...patch } : m)) } : s)),
    }));
  }
  function addStep() {
    setDraft((d) => {
      const last = Number(d.steps[d.steps.length - 1]?.day_offset);
      return { ...d, steps: [...d.steps, newStep(Number.isFinite(last) ? last + 1 : 0)] };
    });
  }

  const problems: string[] = [];
  if (!draft.name.trim()) problems.push("Įveskite protokolo pavadinimą.");
  if (draft.steps.length === 0) problems.push("Pridėkite bent vieną žingsnį.");
  if (draft.steps.some((s) => !s.title.trim())) problems.push("Kiekvienam žingsniui įveskite veiksmą.");
  if (draft.steps.some((s) => !Number.isInteger(Number(s.day_offset)) || Number(s.day_offset) < 0 || Number(s.day_offset) > 120)) {
    problems.push("Diena turi būti sveikas skaičius nuo 0 iki 120.");
  }
  if (draft.steps.some((s) => s.meds.some((m) => !m.product_id || !(Number(m.qty) > 0)))) problems.push("Užpildykite visų vaistų produktą ir kiekį.");

  const stepsJson = JSON.stringify(
    draft.steps.map((s) => ({
      day_offset: Number(s.day_offset),
      title: s.title.trim(),
      notes: s.notes.trim() || null,
      kind: s.kind,
      medications: s.kind === "sekinimas" ? [] : s.meds.map((m) => ({ product_id: m.product_id, qty: Number(m.qty), administration_route: m.route || null })),
    })),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(toDraft(protocol));
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" size="sm" variant="outline">
            <Plus className="size-4" /> Naujas protokolas
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{protocol ? `Redaguoti protokolą „${protocol.name}“` : "Naujas sinchronizacijos protokolas"}</DialogTitle>
        </DialogHeader>
        <form action={formAction}>
          <DialogBody className="space-y-5">
            {state && !state.ok && state.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{state.error}</p>}
            {deleteState && !deleteState.ok && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{deleteState.error}</p>}
            {protocol && <input type="hidden" name="id" value={protocol.id} />}
            <input type="hidden" name="steps" value={stepsJson} />

            <div>
              <Label htmlFor="sp_name">Pavadinimas *</Label>
              <Input id="sp_name" name="name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Pvz. Ovsynch" autoFocus />
            </div>
            <div>
              <Label htmlFor="sp_description">Aprašymas</Label>
              <Textarea id="sp_description" name="description" rows={2} value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-semibold">Žingsniai</h3>
                <span className="text-[12px] text-text-muted">Diena 0 = protokolo pradžios data</span>
              </div>

              {draft.steps.map((step, idx) => (
                <div key={step.key} className="space-y-3 rounded-panel border border-border bg-surface-secondary p-3">
                  <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[80px_150px_minmax(0,1.2fr)_minmax(0,1fr)_36px]">
                    <div>
                      <Label className="mb-1">Diena</Label>
                      <Input type="number" min="0" max="120" step="1" value={step.day_offset} onChange={(e) => patchStep(step.key, { day_offset: e.target.value })} />
                    </div>
                    <div>
                      <Label className="mb-1">Tipas</Label>
                      <Select value={step.kind} onChange={(e) => patchStep(step.key, { kind: e.target.value as SyncStepKind, meds: e.target.value === "sekinimas" ? [] : step.meds })}>
                        <option value="veiksmas">Procedūra / vaistas</option>
                        <option value="sekinimas">Sėklinimas</option>
                      </Select>
                    </div>
                    <div>
                      <Label className="mb-1">{idx + 1}. Veiksmas *</Label>
                      <Input value={step.title} onChange={(e) => patchStep(step.key, { title: e.target.value })} placeholder="Pvz. GnRH injekcija" />
                    </div>
                    <div>
                      <Label className="mb-1">Pastabos</Label>
                      <Input value={step.notes} onChange={(e) => patchStep(step.key, { notes: e.target.value })} />
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      disabled={draft.steps.length === 1}
                      onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((s) => s.key !== step.key) }))}
                      aria-label="Pašalinti žingsnį"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>

                  {step.kind === "sekinimas" ? (
                    <p className="flex items-center gap-1.5 border-l-2 border-accent/30 pl-3 text-[12px] text-text-muted">
                      <Dna className="size-3.5" /> Šiam žingsniui bus sukurtas sėklinimo vizitas — sėkla ir pirštinės pasirenkamos įrašant sėklinimą (FEFO).
                    </p>
                  ) : (
                  <div className="space-y-2 border-l-2 border-accent/30 pl-3">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[12px] font-semibold text-text-secondary">
                        <Pill className="size-3.5" /> Vaistai
                      </span>
                      <Button type="button" size="sm" variant="ghost" onClick={() => patchStep(step.key, { meds: [...step.meds, newMed()] })}>
                        <Plus className="size-4" /> Vaistas
                      </Button>
                    </div>
                    {step.meds.length === 0 && <p className="text-[12px] text-text-muted">Be vaistų — tik procedūra (pvz. ultragarsas); vizitą pažymėsite „Atlikta“.</p>}
                    {step.meds.map((m) => (
                      <div key={m.key} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1.6fr)_120px_minmax(0,1fr)_36px]">
                        <div>
                          <Combobox options={productOptions} value={m.product_id || null} onChange={(v) => patchMed(step.key, m.key, { product_id: v })} placeholder="Pasirinkite produktą..." />
                        </div>
                        <div>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={m.qty}
                            onChange={(e) => patchMed(step.key, m.key, { qty: e.target.value })}
                            placeholder={`Dozė${unitById.get(m.product_id) ? ` (${unitById.get(m.product_id)})` : ""}`}
                          />
                        </div>
                        <RouteSelect value={m.route} onChange={(v) => patchMed(step.key, m.key, { route: v })} />
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          onClick={() => patchStep(step.key, { meds: step.meds.filter((x) => x.key !== m.key) })}
                          aria-label="Pašalinti vaistą"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  )}
                </div>
              ))}

              <Button type="button" size="sm" variant="outline" onClick={addStep}>
                <Plus className="size-4" /> Pridėti žingsnį
              </Button>
              <p className="text-[11.5px] text-text-muted">
                Vaistai čia tik planuojami. Atsargos nurašomos (FEFO), kai vizito žingsnis įrašomas. Jau sukurti vizitai nesikeičia, jei protokolą redaguosite ar pašalinsite vėliau.
              </p>
            </div>
          </DialogBody>
          <DialogFooter>
            {protocol && (
              <Button
                type="button"
                variant="ghost"
                disabled={pending || deletePending}
                onClick={() => {
                  if (!window.confirm(`Pašalinti protokolą „${protocol.name}“? Jau sukurti vizitai išliks.`)) return;
                  const fd = new FormData();
                  fd.set("id", protocol.id);
                  React.startTransition(() => deleteAction(fd));
                }}
              >
                <Trash2 className="size-4" /> Pašalinti
              </Button>
            )}
            <p className="mr-auto self-center text-[12px] font-medium text-danger">{problems[0]}</p>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Atšaukti
            </Button>
            <Button type="submit" disabled={pending || deletePending || problems.length > 0}>
              {pending ? "Saugoma..." : "Išsaugoti protokolą"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

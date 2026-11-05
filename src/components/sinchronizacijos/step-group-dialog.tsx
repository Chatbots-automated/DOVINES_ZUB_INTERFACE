"use client";

import * as React from "react";
import { useActionState } from "react";
import { Ban, Pencil, Plus, Trash2, UserPlus, X } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { addSyncAnimals, editSyncSteps, skipSyncSteps, type SyncMassResult } from "@/lib/actions/sync-mass";
import type { SyncAnimal } from "@/lib/sync-mass";
import type { SyncProductOption } from "@/lib/sync-protocols";
import { formatDate } from "@/lib/utils";
import type { SyncOpenStepRow } from "@/lib/supabase/types";

type MedRow = { key: string; product_id: string; qty: string; route: string | null };

const localTime = (iso: string) =>
  new Intl.DateTimeFormat("lt-LT", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Vilnius" }).format(new Date(iso));

function Result({ state }: { state: SyncMassResult | null }) {
  if (!state) return null;
  return state.ok ? (
    <p className="rounded-control bg-success-soft px-3 py-2 text-[12.5px] text-success">{state.message}</p>
  ) : (
    <p className="rounded-control bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{state.error}</p>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5 rounded-panel border border-border p-4">
      <div>
        <h3 className="text-[14px] font-semibold text-text-primary">{title}</h3>
        {hint && <p className="text-[12px] text-text-secondary">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

// "Redaguoti" on a Žingsniai group (one step of one protocol on one day): move it, change its
// medicine / title, skip it for some animals, or add animals to the same group (0066). Only the
// planned visits change — recorded steps and the protocol template stay as they are.
export function StepGroupDialog({
  rows,
  title,
  date,
  protocol,
  products,
  animals,
}: {
  rows: SyncOpenStepRow[];
  title: string;
  date: string;
  protocol: string;
  products: SyncProductOption[];
  animals: SyncAnimal[];
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="ghost">
          <Pencil className="size-3.5" /> Redaguoti
        </Button>
      </DialogTrigger>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>
            {title} · {formatDate(date)}
          </DialogTitle>
        </DialogHeader>
        {/* mounted per open so it starts from the current rows */}
        {open && <Body rows={rows} date={date} protocol={protocol} products={products} animals={animals} title={title} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  rows,
  title,
  date,
  protocol,
  products,
  animals,
}: {
  rows: SyncOpenStepRow[];
  title: string;
  date: string;
  protocol: string;
  products: SyncProductOption[];
  animals: SyncAnimal[];
}) {
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(rows.map((r) => r.visit_id)));
  const [newDate, setNewDate] = React.useState(date);
  const initialTime = rows[0] ? localTime(rows[0].visit_datetime) : "09:00";
  const [newTime, setNewTime] = React.useState(initialTime);
  const [shift, setShift] = React.useState(true);
  const [stepTitle, setStepTitle] = React.useState(title === "—" ? "" : title);
  const [meds, setMeds] = React.useState<MedRow[]>(() =>
    (rows[0]?.planned_medications ?? []).map((m) => ({ key: crypto.randomUUID(), product_id: m.product_id, qty: String(m.qty), route: m.administration_route ?? null })),
  );
  const [editState, editAction, editPending] = useActionState<SyncMassResult | null, FormData>(editSyncSteps, null);
  const [skipState, skipAction, skipPending] = useActionState<SyncMassResult | null, FormData>(skipSyncSteps, null);
  const [addState, addAction, addPending] = useActionState<SyncMassResult | null, FormData>(addSyncAnimals, null);
  const [toAdd, setToAdd] = React.useState<string[]>([]);
  const [addStart, setAddStart] = React.useState("");

  const [handledAdd, setHandledAdd] = React.useState(addState);
  if (addState !== handledAdd) {
    setHandledAdd(addState);
    if (addState?.ok) setToAdd([]);
  }

  const insemination = rows[0]?.procedures.includes("sekinimas");
  const massIds = [...new Set(rows.map((r) => r.mass_application_id).filter(Boolean))] as string[];
  const massId = massIds.length === 1 ? massIds[0] : null;
  const ids = [...selected];
  const unitById = new Map(products.map((p) => [p.id, p.unit]));
  const productOptions: ComboboxOption[] = products.map((p) => ({ value: p.id, label: p.name, sublabel: p.unit }));
  const freeAnimals: ComboboxOption[] = animals
    .filter((a) => !a.open_protocol_name && !toAdd.includes(a.id))
    .map((a) => ({ value: a.id, label: a.animal_no ? `${a.animal_no} · ${a.tag_no}` : a.tag_no, sublabel: a.group_name ?? undefined }));
  const animalById = new Map(animals.map((a) => [a.id, a]));

  const medsJson = JSON.stringify(
    meds.filter((m) => m.product_id).map((m) => ({ product_id: m.product_id, qty: Number(m.qty), unit: unitById.get(m.product_id) ?? "vnt", administration_route: m.route })),
  );
  const [initialMedsJson] = React.useState(medsJson);
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <DialogBody className="space-y-4">
      <p className="text-[12.5px] text-text-secondary">
        Protokolas „{protocol}“. Keičiami tik šie suplanuoti žingsniai — protokolo šablonas ir jau įrašyti žingsniai nesikeičia.
      </p>

      <Section title={`1. Gyvūnai (${selected.size} iš ${rows.length})`} hint="Pakeitimai ir praleidimas taikomi tik pažymėtiems gyvūnams.">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="text-[12.5px] font-medium text-accent hover:underline" onClick={() => setSelected(new Set(rows.map((r) => r.visit_id)))}>
            Visi
          </button>
          <button type="button" className="text-[12.5px] font-medium text-accent hover:underline" onClick={() => setSelected(new Set())}>
            Nė vieno
          </button>
        </div>
        <div className="flex max-h-[180px] flex-wrap gap-1.5 overflow-auto">
          {rows.map((r) => (
            <label
              key={r.visit_id}
              className={`flex cursor-pointer items-center gap-1.5 rounded-control border px-2 py-1 text-[12.5px] ${selected.has(r.visit_id) ? "border-accent bg-accent-soft" : "border-border"}`}
            >
              <input type="checkbox" className="size-3.5" checked={selected.has(r.visit_id)} onChange={() => toggle(r.visit_id)} />
              <span className="font-medium text-text-primary">{r.animal_no ?? r.tag_no}</span>
              {r.group_name && <span className="text-text-muted">{r.group_name}</span>}
            </label>
          ))}
        </div>
      </Section>

      <form action={editAction}>
        <input type="hidden" name="visit_ids" value={JSON.stringify(ids)} />
        <input type="hidden" name="shift_following" value={shift ? "1" : "0"} />
        {/* only what was changed is sent — animals keep their own time if only the date moves */}
        <input type="hidden" name="date" value={newDate !== date ? newDate : ""} />
        <input type="hidden" name="time" value={newTime !== initialTime ? newTime : ""} />
        {!insemination && medsJson !== initialMedsJson && <input type="hidden" name="medications" value={medsJson} />}
        <Section title="2. Data, laikas, vaistai" hint="Pakeiskite, kas reikia, ir spauskite „Išsaugoti pakeitimus“.">
          <div className="grid gap-3 sm:grid-cols-[160px_120px_1fr]">
            <div>
              <Label htmlFor="sg_date">Data</Label>
              <Input id="sg_date" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="sg_time">Laikas</Label>
              <Input id="sg_time" type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="sg_title">Žingsnio pavadinimas</Label>
              <Input id="sg_title" name="title" value={stepTitle} onChange={(e) => setStepTitle(e.target.value)} />
            </div>
          </div>
          <label className="flex items-start gap-2 text-[13px] text-text-secondary">
            <input type="checkbox" className="mt-0.5 size-4" checked={shift} onChange={(e) => setShift(e.target.checked)} />
            <span>
              Kartu perkelti ir <b>vėlesnius</b> šių gyvūnų žingsnius tiek pat dienų (protokolo tarpai išlieka). Vėlesnių žingsnių laikas nesikeičia.
            </span>
          </label>

          {insemination ? (
            <p className="text-[12px] text-text-muted">Sėklinimo žingsnis vaistų neturi — sėkla pasirenkama įrašant sėklinimą.</p>
          ) : (
            <div className="space-y-2">
              <Label className="mb-0">Vaistai (dozė vienam gyvūnui)</Label>
              {meds.length === 0 && <p className="text-[12px] text-text-muted">Vaistų nėra — žingsnis bus pažymėtas atliktu be nurašymo.</p>}
              {meds.map((m) => (
                <div key={m.key} className="grid grid-cols-[1fr_110px_36px] items-center gap-2">
                  <Combobox
                    options={productOptions}
                    value={m.product_id || null}
                    onChange={(v) => setMeds((prev) => prev.map((x) => (x.key === m.key ? { ...x, product_id: v } : x)))}
                    placeholder="Pasirinkite vaistą..."
                  />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={m.qty}
                    placeholder={unitById.get(m.product_id) ?? "kiekis"}
                    onChange={(e) => setMeds((prev) => prev.map((x) => (x.key === m.key ? { ...x, qty: e.target.value } : x)))}
                  />
                  <Button type="button" size="icon" variant="outline" aria-label="Pašalinti vaistą" onClick={() => setMeds((prev) => prev.filter((x) => x.key !== m.key))}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" onClick={() => setMeds((prev) => [...prev, { key: crypto.randomUUID(), product_id: "", qty: "", route: null }])}>
                <Plus className="size-4" /> Pridėti vaistą
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={editPending || ids.length === 0}>
              {editPending ? "Saugoma..." : `Išsaugoti pakeitimus (${ids.length})`}
            </Button>
          </div>
          <Result state={editState} />
        </Section>
      </form>

      <form
        action={skipAction}
        onSubmit={(e) => {
          if (!window.confirm(`Praleisti žingsnį „${title}“ ${ids.length} gyv.? Kiti jų protokolo žingsniai liks suplanuoti.`)) e.preventDefault();
        }}
      >
        <input type="hidden" name="visit_ids" value={JSON.stringify(ids)} />
        <Section title="3. Praleisti šį žingsnį" hint="Žingsnis nebus atliekamas pažymėtiems gyvūnams (pvz. gyvūnas išbrokuotas ar veršinga). Vaistai nenurašomi. Visam protokolui nutraukti — skirtukas „Vykdomi ir istorija“.">
          <Button type="submit" variant="danger" disabled={skipPending || ids.length === 0}>
            <Ban className="size-4" /> {skipPending ? "Saugoma..." : `Praleisti pažymėtiems (${ids.length})`}
          </Button>
          <Result state={skipState} />
        </Section>
      </form>

      <form action={addAction}>
        <input type="hidden" name="mass_application_id" value={massId ?? ""} />
        <input type="hidden" name="animal_ids" value={JSON.stringify(toAdd)} />
        <input type="hidden" name="start_date" value={addStart} />
        <Section
          title="4. Pridėti gyvūnų prie šios grupės"
          hint={
            massId
              ? "Pridėtiems gyvūnams bus suplanuotas visas tas pats protokolas nuo grupės pradžios datos (arba nuo jūsų nurodytos). Rodomi tik gyvūnai, kuriems dabar netaikomas joks protokolas."
              : "Šie gyvūnai pradėti ne masiniu pritaikymu, todėl naujus pridėkite per „Nauja sinchronizacija“."
          }
        >
          {massId && (
            <>
              <Combobox options={freeAnimals} value={null} onChange={(v) => setToAdd((prev) => (prev.includes(v) ? prev : [...prev, v]))} placeholder="Ieškoti gyvūno..." />
              {toAdd.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {toAdd.map((id) => {
                    const a = animalById.get(id);
                    return (
                      <Badge key={id} tone="accent">
                        {a?.animal_no ?? a?.tag_no ?? id}
                        <button type="button" className="ml-1" aria-label="Pašalinti" onClick={() => setToAdd((prev) => prev.filter((x) => x !== id))}>
                          <X className="size-3" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              )}
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <Label htmlFor="sg_add_start">Pradžia (neprivaloma)</Label>
                  <Input id="sg_add_start" type="date" value={addStart} onChange={(e) => setAddStart(e.target.value)} />
                </div>
                <p className="pb-2 text-[12px] text-text-muted">Tuščia = grupės pradžia. Jei ji praeityje, ankstesni žingsniai bus rodomi kaip vėluojantys.</p>
              </div>
              <Button type="submit" disabled={addPending || toAdd.length === 0}>
                <UserPlus className="size-4" /> {addPending ? "Pridedama..." : `Pridėti (${toAdd.length})`}
              </Button>
              <Result state={addState} />
            </>
          )}
        </Section>
      </form>
    </DialogBody>
  );
}

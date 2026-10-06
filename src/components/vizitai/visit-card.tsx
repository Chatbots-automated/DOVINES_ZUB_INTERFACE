"use client";

import * as React from "react";
import { useActionState } from "react";
import Link from "next/link";
import { Check, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/utils";
import { updateVisitStatus, deleteVisit, type ActionResult } from "@/lib/actions/visits";
import { NewTreatmentDialog, animalLabel, type Product } from "@/components/gyvunai/new-treatment-dialog";
import { NewVaccinationDialog } from "@/components/vakcinacijos/new-vaccination-dialog";
import { OPEN_VISIT_STATUSES, VISIT_PROCEDURE_LABELS, VISIT_STATUS_LABELS, VISIT_STATUS_TONE, vilniusDay } from "@/lib/visits";
import type { ProcedureType, VisitProcedure, VisitStatus } from "@/lib/supabase/types";

export type VisitRecord = { kind: "treatment" | "vaccination"; id: string; label: string; detail: string | null };

export type VisitCardData = {
  id: string;
  animal_id: string;
  animal_no: string | null;
  tag_no: string;
  group_name: string | null;
  visit_datetime: string;
  procedures: VisitProcedure[];
  status: VisitStatus;
  temperature: number | null;
  notes: string | null;
  vet_name: string | null;
  next_visit_date: string | null;
  isFollowUp: boolean;
  /** Linked treatments / vaccinations (visit_id). */
  records: VisitRecord[];
  /** Procedure types that already have a linked treatment. */
  treatmentTypes: ProcedureType[];
  hasVaccination: boolean;
  withdrawalMilk: boolean;
  withdrawalMeat: boolean;
};

type Disease = { id: string; name: string };

const TREATMENT_PROCEDURES: ProcedureType[] = ["apziura", "gydymas", "profilaktika"];
const TREATMENT_BUTTON_LABEL: Record<ProcedureType, string> = {
  apziura: "Įrašyti apžiūrą",
  gydymas: "Įrašyti gydymą",
  profilaktika: "Įrašyti profilaktiką",
};

// One visit — the scheduling/status wrapper. Tagged Gydymas / Profilaktika /
// Apžiūra / Vakcina procedures that have no record yet offer a button into
// the normal treatment / vaccination dialog, locked to this visit's animal
// and linked back atomically (create_*_for_visit, 0018) — stock is consumed
// there through FEFO, never by the visit itself.
export function VisitCard({
  visit,
  today,
  diseases,
  treatmentProducts,
  vaccineProducts,
  currentVetName,
  canWrite,
}: {
  visit: VisitCardData;
  today: string;
  diseases: Disease[];
  treatmentProducts: Product[];
  vaccineProducts: Product[];
  currentVetName: string | null;
  canWrite: boolean;
}) {
  const [statusState, statusAction, statusPending] = useActionState<ActionResult | null, FormData>(updateVisitStatus, null);
  const [deleteState, deleteAction, deletePending] = useActionState<ActionResult | null, FormData>(deleteVisit, null);
  const busy = statusPending || deletePending;
  const error = (statusState && !statusState.ok && statusState.error) || (deleteState && !deleteState.ok && deleteState.error) || null;

  const isOpen = OPEN_VISIT_STATUSES.includes(visit.status);
  const isOverdue = isOpen && vilniusDay(visit.visit_datetime) < today;
  const pendingTreatments = visit.procedures.filter(
    (p): p is ProcedureType => (TREATMENT_PROCEDURES as string[]).includes(p) && !visit.treatmentTypes.includes(p as ProcedureType),
  );
  const needsVaccination = visit.procedures.includes("vakcina") && !visit.hasVaccination;

  return (
    <div className={`space-y-2 rounded-panel border p-3 ${isOverdue ? "border-danger/40 bg-danger-soft/30" : "border-border bg-surface"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/veterinarija/gyvunai/${visit.animal_id}`} className="text-[14px] font-semibold text-text-primary hover:underline">
            {animalLabel(visit)}
          </Link>
          {visit.group_name && <span className="ml-1.5 text-[11px] text-text-muted">{visit.group_name}</span>}
          <p className="text-[12px] text-text-muted">{formatDateTime(visit.visit_datetime)}</p>
        </div>
        <Badge tone={isOverdue ? "danger" : VISIT_STATUS_TONE[visit.status]}>{isOverdue ? "Praleistas" : VISIT_STATUS_LABELS[visit.status]}</Badge>
      </div>

      <div className="flex flex-wrap gap-1">
        {visit.procedures.map((p) => (
          <Badge key={p} tone="neutral">
            {VISIT_PROCEDURE_LABELS[p]}
          </Badge>
        ))}
        {visit.isFollowUp && <Badge tone="accent">Pakartotinis</Badge>}
        {visit.withdrawalMilk && <Badge tone="warning">Karencija: pienas</Badge>}
        {visit.withdrawalMeat && <Badge tone="danger">Karencija: mėsa</Badge>}
      </div>

      {visit.temperature != null && <p className="text-[12px] text-text-secondary">Temperatūra: {visit.temperature} °C</p>}
      {visit.notes && <p className="text-[12px] text-text-secondary">{visit.notes}</p>}
      {visit.records.length > 0 && (
        <ul className="space-y-0.5 text-[12px] text-text-secondary">
          {visit.records.map((r) => (
            <li key={`${r.kind}-${r.id}`}>
              <span className="font-medium text-text-primary">{r.label}</span>
              {r.detail ? ` · ${r.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
      {visit.next_visit_date && <p className="text-[12px] text-text-secondary">Kitas vizitas: {formatDate(visit.next_visit_date)}</p>}
      {visit.vet_name && <p className="text-[11px] text-text-muted">{visit.vet_name}</p>}
      {error && <p className="text-[12px] text-danger">{error}</p>}

      {canWrite && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
          {isOpen &&
            pendingTreatments.map((type) => (
              <NewTreatmentDialog
                key={type}
                animalId={visit.animal_id}
                diseases={diseases}
                products={treatmentProducts}
                currentVetName={currentVetName}
                visitId={visit.id}
                fixedProcedureType={type}
                dialogTitle={TREATMENT_BUTTON_LABEL[type]}
                trigger={
                  <Button size="sm" variant="outline">
                    <Plus className="size-4" /> {TREATMENT_BUTTON_LABEL[type]}
                  </Button>
                }
              />
            ))}
          {isOpen && needsVaccination && (
            <NewVaccinationDialog
              animalId={visit.animal_id}
              products={vaccineProducts}
              currentVetName={currentVetName}
              visitId={visit.id}
              trigger={
                <Button size="sm" variant="outline">
                  <Plus className="size-4" /> Įrašyti vakcinaciją
                </Button>
              }
            />
          )}
          {isOpen && (
            <form action={statusAction}>
              <input type="hidden" name="visit_id" value={visit.id} />
              <Button size="sm" variant="outline" name="status" value="baigtas" disabled={busy}>
                <Check className="size-4" /> Atlikta
              </Button>
            </form>
          )}
          {isOpen && (
            <form action={statusAction} className="flex gap-1.5">
              <input type="hidden" name="visit_id" value={visit.id} />
              <Button size="sm" variant="ghost" name="status" value="atsauktas" disabled={busy}>
                Atšaukti
              </Button>
              <Button size="sm" variant="ghost" name="status" value="neivykes" disabled={busy}>
                Neįvyko
              </Button>
            </form>
          )}
          {!isOpen && (
            <form action={statusAction}>
              <input type="hidden" name="visit_id" value={visit.id} />
              <Button size="sm" variant="ghost" name="status" value="planuojamas" disabled={busy}>
                Atnaujinti į planuojamą
              </Button>
            </form>
          )}
          <form
            action={deleteAction}
            className="ml-auto"
            onSubmit={(e) => {
              if (!window.confirm("Pašalinti vizitą? Prie jo susieti gydymo / vakcinacijos įrašai išliks.")) e.preventDefault();
            }}
          >
            <input type="hidden" name="visit_id" value={visit.id} />
            <Button size="icon" variant="ghost" disabled={busy} aria-label="Pašalinti vizitą">
              <Trash2 className="size-4" />
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

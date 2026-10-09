"use client";

import * as React from "react";
import { Dna, Pencil, Pill, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { ProtocolDialog } from "@/components/sinchronizacijos/protocol-dialog";
import { createClient } from "@/lib/supabase/client";
import { TREATMENT_PRODUCT_CATEGORIES } from "@/lib/treatments/catalog";
import { addDays } from "@/lib/visits";
import { stepDayLabel, type SyncProductOption, type SyncProtocolData } from "@/lib/sync-protocols";
import { formatDate } from "@/lib/utils";
import type { SyncStepKind, SyncStepMedication } from "@/lib/supabase/types";

type LoadedProtocol = Omit<SyncProtocolData, "steps"> & { steps: SyncProtocolData["steps"] };

// The farm's sinchronizacijos protokolai (0025) as a select with a dated preview
// of the chosen protocol's steps — and where protocols are created, edited and
// removed ("Naujas protokolas" / "Redaguoti"), so there is no separate screen.
// Loaded each time `open` turns true. Posts `sync_protocol_id`, which
// applySyncProtocol() reads.
export function SyncProtocolPicker({
  open,
  startDate,
  protocolId,
  onChange,
}: {
  /** Load protocols while true (the dialog hosting the picker is open). */
  open: boolean;
  /** Protocol day 0 — used to date the preview rows. */
  startDate: string;
  protocolId: string;
  onChange: (id: string) => void;
}) {
  const [protocols, setProtocols] = React.useState<LoadedProtocol[] | null>(null);
  const [products, setProducts] = React.useState<SyncProductOption[]>([]);
  const [reloadKey, setReloadKey] = React.useState(0);
  const selected = protocols?.find((p) => p.id === protocolId) ?? null;

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const supabase = createClient();
    Promise.all([
      supabase.from("sync_protocols").select("id, name, description, sync_protocol_steps(day_offset, title, notes, sort_order, kind, medications)").order("name"),
      // Same products the treatment dialog can give — a planned medicine must be recordable.
      supabase.from("products").select("id, name, unit").eq("is_active", true).in("category", [...TREATMENT_PRODUCT_CATEGORIES]).order("name"),
    ]).then(([protocolsRes, productsRes]) => {
      if (cancelled) return;
      if (protocolsRes.error || productsRes.error) {
        console.error("[SyncProtocolPicker] load failed:", protocolsRes.error ?? productsRes.error);
        setProtocols([]);
        return;
      }
      type Row = {
        id: string;
        name: string;
        description: string | null;
        sync_protocol_steps: { day_offset: number; title: string; notes: string | null; sort_order: number; kind: SyncStepKind; medications: SyncStepMedication[] }[];
      };
      setProtocols(
        ((protocolsRes.data ?? []) as unknown as Row[]).map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          steps: [...p.sync_protocol_steps]
            .sort((a, b) => a.day_offset - b.day_offset || a.sort_order - b.sort_order)
            .map((s) => ({ day_offset: s.day_offset, title: s.title, notes: s.notes, kind: s.kind, medications: s.medications ?? [] })),
        })),
      );
      setProducts((productsRes.data ?? []) as SyncProductOption[]);
    });
    return () => {
      cancelled = true;
    };
  }, [open, reloadKey]);

  return (
    <div className="space-y-3 rounded-panel border border-accent/30 bg-accent-soft/40 p-3">
      <input type="hidden" name="sync_protocol_id" value={protocolId} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor="sync_protocol" className="mb-0 flex items-center gap-1.5">
          <Repeat className="size-3.5" /> Sinchronizacijos protokolas *
        </Label>
        <div className="flex items-center gap-1.5">
          {selected && (
            <ProtocolDialog
              protocol={selected}
              products={products}
              trigger={
                <Button type="button" size="sm" variant="ghost">
                  <Pencil className="size-4" /> Redaguoti
                </Button>
              }
              onSaved={(id) => {
                setReloadKey((k) => k + 1);
                onChange(id);
              }}
              onDeleted={() => {
                setReloadKey((k) => k + 1);
                onChange("");
              }}
            />
          )}
          <ProtocolDialog
            products={products}
            onSaved={(id) => {
              setReloadKey((k) => k + 1);
              onChange(id);
            }}
          />
        </div>
      </div>

      {protocols === null ? (
        <p className="text-[13px] text-text-muted">Kraunama...</p>
      ) : protocols.length === 0 ? (
        <p className="text-[13px] text-text-secondary">Protokolų dar nėra — sukurkite pirmąjį (pvz. Ovsynch) mygtuku „Naujas protokolas“.</p>
      ) : (
        <Select id="sync_protocol" value={protocolId} onChange={(e) => onChange(e.target.value)}>
          <option value="">Pasirinkite protokolą...</option>
          {protocols.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.steps.length} žingsn.)
            </option>
          ))}
        </Select>
      )}

      {selected && (
        <div className="space-y-1.5">
          {selected.description && <p className="text-[12px] text-text-secondary">{selected.description}</p>}
          <ol className="divide-y divide-border rounded-control border border-border bg-surface">
            {selected.steps.map((s, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-1.5 text-[13px]">
                <span className="w-24 shrink-0 font-semibold tabular-nums text-text-primary">{startDate ? formatDate(addDays(startDate, s.day_offset)) : "—"}</span>
                <span className="w-10 shrink-0 text-[12px] text-text-muted">{stepDayLabel(s.day_offset)}</span>
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                {s.kind === "sekinimas" && (
                  <span className="flex items-center gap-1 text-[12px] text-accent-alt">
                    <Dna className="size-3" /> Sėklinimas
                  </span>
                )}
                {s.medications.length > 0 && (
                  <span className="flex items-center gap-1 text-[12px] text-text-muted">
                    <Pill className="size-3" /> {s.medications.length}
                  </span>
                )}
              </li>
            ))}
          </ol>
          <p className="text-[11.5px] text-text-muted">
            Bus sukurtas po vieną planuojamą vizitą kiekvienam žingsniui. Vaistai nurašomi, kai žingsnis įrašomas vizito kortelėje.
          </p>
        </div>
      )}
    </div>
  );
}

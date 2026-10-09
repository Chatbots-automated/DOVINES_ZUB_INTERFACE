import Link from "next/link";
import { Pill } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ADMINISTRATION_ROUTES } from "@/lib/administration-routes";
import { daysBetween } from "@/lib/treatments/planner";
import { TREATMENT_TYPE_LABELS } from "@/lib/visits";
import { formatDate, formatQty } from "@/lib/utils";
import type { TreatmentHistoryCard } from "@/lib/treatment-history";

const TYPE_TONE = { gydymas: "danger", profilaktika: "success", apziura: "info", sinchronizacija: "accent" } as const;

const routeLabel = (code: string | null) => (code ? (ADMINISTRATION_ROUTES.find((r) => r.code === code)?.label ?? code) : "");

/** 🥛 / 🥩 chip; nothing at all when the treatment carries no karencija (0-day products). */
function Karencija({ kind, until, today }: { kind: "milk" | "meat"; until: string | null; today: string }) {
  if (!until) return null;
  const left = daysBetween(today, until);
  const active = left >= 0;
  const icon = kind === "milk" ? "🥛" : "🥩";
  const tone = active ? (kind === "milk" ? "warning" : "danger") : "neutral";
  return (
    <Badge tone={tone} title={kind === "milk" ? "Pieno karencija" : "Mėsos karencija"}>
      {icon} iki {formatDate(until)}
      {active ? ` · liko ${left} d.` : " · baigėsi"}
    </Badge>
  );
}

// One treatment as a card: who, what was diagnosed, which medicines (and how
// much), karencija, outcome — everything the old journal table spread over 12 columns.
export function TreatmentCard({ card, today }: { card: TreatmentHistoryCard; today: string }) {
  const title = card.animalNo ? `Nr. ${card.animalNo} · ${card.tagNo}` : card.tagNo;
  const diagnosis = [card.disease, card.diagnosis && card.diagnosis !== card.disease ? card.diagnosis : null].filter(Boolean).join(" — ");
  const hasKarencija = !!card.milkUntil || !!card.meatUntil;

  return (
    <div className="space-y-2.5 rounded-panel border border-border bg-surface p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/veterinarija/gyvunai/${card.animalId}`} className="text-[14px] font-semibold text-text-primary hover:underline">
            {title}
          </Link>
          {card.group && <span className="ml-1.5 text-[11px] text-text-muted">{card.group}</span>}
          <p className="text-[12px] text-text-muted">{formatDate(card.regDate)}</p>
        </div>
        <Badge tone={TYPE_TONE[card.procedureType]}>{TREATMENT_TYPE_LABELS[card.procedureType]}</Badge>
      </div>

      {diagnosis && <p className="text-[13px] font-medium text-text-primary">{diagnosis}</p>}

      {card.lines.length > 0 ? (
        <ul className="divide-y divide-border rounded-control border border-border bg-surface-secondary/50">
          {card.lines.map((l, i) => (
            <li key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-[12.5px]">
              <Pill className="size-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate font-medium text-text-primary" title={l.lot ? `Serija ${l.lot}` : undefined}>
                {l.product}
              </span>
              {l.usedOn !== card.regDate && <span className="shrink-0 text-[11px] text-text-muted">{formatDate(l.usedOn)}</span>}
              {l.route && <span className="shrink-0 text-[11px] text-text-muted">{routeLabel(l.route)}</span>}
              <span className="shrink-0 tabular-nums text-text-secondary">{formatQty(l.qty, l.unit)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-text-muted">Be vaistų</p>
      )}

      {hasKarencija && (
        <div className="flex flex-wrap gap-1.5">
          <Karencija kind="milk" until={card.milkUntil} today={today} />
          <Karencija kind="meat" until={card.meatUntil} today={today} />
        </div>
      )}

      {(card.outcome || card.vet) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-secondary">
          {card.outcome && (
            <span>
              Baigtis: <span className="font-medium text-text-primary">{card.outcome}</span>
              {card.outcomeDate ? ` (${formatDate(card.outcomeDate)})` : ""}
            </span>
          )}
          {card.vet && <span className="text-text-muted">{card.vet}</span>}
        </div>
      )}
    </div>
  );
}

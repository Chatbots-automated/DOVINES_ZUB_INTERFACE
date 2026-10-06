import * as React from "react";
import { Beef, Milk, Check } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { TONE_CLASSES, TEAT_LABELS, withdrawalTone, daysUntil, type Tone, type TimelineKind } from "@/lib/animal-profile";

type IconType = React.ComponentType<{ className?: string }>;

/** Card with a coloured, iconed header strip. */
export function SectionCard({
  title,
  icon: Icon,
  tone = "accent",
  aside,
  children,
  className,
}: {
  title: string;
  icon: IconType;
  tone?: Tone;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const t = TONE_CLASSES[tone];
  return (
    <section className={cn("overflow-hidden rounded-panel border bg-surface shadow-soft", t.border, className)}>
      <header className={cn("flex items-center gap-2 px-4 py-2.5", t.soft)}>
        <span className={cn("flex size-7 items-center justify-center rounded-full bg-surface shadow-soft", t.text)}>
          <Icon className="size-4" />
        </span>
        <h3 className={cn("text-[13px] font-bold uppercase tracking-wide", t.text)}>{title}</h3>
        {aside && <div className="ml-auto text-[11px] text-text-secondary">{aside}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Coloured stat tile: label, big value, optional sub line. */
export function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  tone = "accent",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: IconType;
  tone?: Tone;
}) {
  const t = TONE_CLASSES[tone];
  const empty = value === null || value === undefined || value === "—";
  return (
    <div className={cn("rounded-control border p-3", empty ? "border-border bg-surface-secondary/60" : cn(t.border, t.soft))}>
      <div className="mb-1 flex items-center gap-1.5">
        {Icon && <Icon className={cn("size-3.5", empty ? "text-text-muted" : t.text)} />}
        <p className="text-[11px] font-semibold text-text-secondary">{label}</p>
      </div>
      <p className={cn("text-[20px] font-bold leading-tight", empty ? "text-text-muted" : t.text)}>{empty ? "—" : value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-text-secondary">{sub}</p>}
    </div>
  );
}

/** Label / value row used inside info cards. */
export function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  const empty = children === null || children === undefined || children === "" || children === "—";
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 last:border-b-0">
      <dt className="text-[12px] text-text-secondary">{label}</dt>
      <dd className={cn("text-right text-[13px] font-medium", empty ? "text-text-muted" : "text-text-primary")}>{empty ? "—" : children}</dd>
    </div>
  );
}

/** Small filled pill (status chip). */
export function Chip({ tone = "neutral", icon: Icon, children, className }: { tone?: Tone; icon?: IconType; children: React.ReactNode; className?: string }) {
  const t = TONE_CLASSES[tone];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-badge border px-2.5 py-0.5 text-[11.5px] font-semibold", t.border, t.soft, t.text, className)}>
      {Icon && <Icon className="size-3" />}
      {children}
    </span>
  );
}

/**
 * Big karencija countdown: green when clear, amber in the last few days,
 * red while the product still cannot be sold / slaughtered.
 */
export function WithdrawalChip({ kind, active, until }: { kind: "milk" | "meat"; active: boolean; until: string | null }) {
  const left = active ? Math.max(daysUntil(until) ?? 0, 0) : null;
  const tone = withdrawalTone(active, left);
  const t = TONE_CLASSES[tone];
  const Icon = kind === "milk" ? Milk : Beef;
  return (
    <div className={cn("flex items-center gap-3 rounded-panel border-2 px-4 py-3", t.border, t.soft)}>
      <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-full text-white", t.solid)}>
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-wide text-text-secondary">{kind === "milk" ? "Pieno karencija" : "Mėsos karencija"}</p>
        {active ? (
          <>
            <p className={cn("text-[22px] font-extrabold leading-none", t.text)}>
              {left === 0 ? "baigiasi šiandien" : `liko ${left} d.`}
            </p>
            <p className="mt-0.5 text-[11px] text-text-secondary">iki {formatDate(until)}</p>
          </>
        ) : (
          <>
            <p className={cn("flex items-center gap-1 text-[20px] font-extrabold leading-none", t.text)}>
              <Check className="size-5" /> Laisva
            </p>
            <p className="mt-0.5 text-[11px] text-text-secondary">{kind === "milk" ? "pieną galima realizuoti" : "galima skersti"}</p>
          </>
        )}
      </div>
    </div>
  );
}

/** Small inline karencija chip for history cards. */
export function WithdrawalMini({ kind, until }: { kind: "milk" | "meat"; until: string | null }) {
  if (!until) return null;
  const left = daysUntil(until);
  const active = left !== null && left >= 0;
  const tone = withdrawalTone(active, left);
  const Icon = kind === "milk" ? Milk : Beef;
  return (
    <Chip tone={tone} icon={Icon}>
      {formatDate(until)}
      {active && left !== null ? ` · liko ${left} d.` : ""}
    </Chip>
  );
}

/** Progress bar with a tone. */
export function ProgressBar({ value, max, tone = "accent", label }: { value: number; max: number; tone?: Tone; label?: string }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  return (
    <div>
      <div className="h-2 overflow-hidden rounded-badge bg-surface-secondary" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={cn("h-full rounded-badge", TONE_CLASSES[tone].solid)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Udder diagram: 2x2 teats, red = missing / blind, green = ok. */
export function TeatGrid({ missing }: { missing: string[] | null }) {
  const miss = new Set(missing ?? []);
  const cell = (code: "FL" | "FR" | "HL" | "HR") => {
    const bad = miss.has(code);
    return (
      <div
        key={code}
        title={TEAT_LABELS[code]}
        className={cn(
          "flex flex-col items-center rounded-control border px-2 py-1.5 text-center",
          bad ? "border-danger/30 bg-danger-soft text-danger" : "border-success/30 bg-success-soft text-success",
        )}
      >
        <span className="text-[13px] font-bold">{bad ? "✕" : "✓"}</span>
        <span className="text-[10px] font-semibold">{TEAT_LABELS[code]}</span>
      </div>
    );
  };
  return (
    <div>
      <div className="mb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-text-muted">priekis</div>
      <div className="grid max-w-[260px] grid-cols-2 gap-1.5">{(["FL", "FR", "HL", "HR"] as const).map(cell)}</div>
      <div className="mt-1 text-center text-[10px] font-semibold uppercase tracking-wide text-text-muted">galas</div>
    </div>
  );
}

const TIMELINE_TONES: Record<TimelineKind, Tone> = {
  treatment: "danger",
  vaccination: "success",
  insemination: "alt",
  visit: "info",
  hoof: "warning",
  delpro: "accent",
};

/** Vertical timeline; the caller provides the icon per kind. */
export function Timeline({
  items,
  icons,
}: {
  items: Array<{ key: string; kind: TimelineKind; date: string; title: string; detail: string | null }>;
  icons: Record<TimelineKind, IconType>;
}) {
  return (
    <ol className="relative ml-3 border-l-2 border-border">
      {items.map((e) => {
        const tone = TONE_CLASSES[TIMELINE_TONES[e.kind]];
        const Icon = icons[e.kind];
        return (
          <li key={e.key} className="relative mb-4 pl-6 last:mb-0">
            <span className={cn("absolute -left-[15px] top-0 flex size-7 items-center justify-center rounded-full ring-4 ring-surface", tone.solid)}>
              <Icon className="size-3.5 text-white" />
            </span>
            <p className="text-[11px] font-semibold text-text-muted">{formatDate(e.date)}</p>
            <p className="text-[13.5px] font-semibold text-text-primary">{e.title}</p>
            {e.detail && <p className="text-[12px] text-text-secondary">{e.detail}</p>}
          </li>
        );
      })}
    </ol>
  );
}

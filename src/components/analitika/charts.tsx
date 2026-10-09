import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PERIOD_OPTIONS, monthLabel, type PeriodKey } from "@/lib/analytics-period";

// Small server-rendered charts (no chart library): CSS columns and bars that
// follow the dataviz mark specs — ≤24px thick marks, 4px rounded data end on a
// flat baseline, 2px surface gap between touching marks, hairline recessive
// grid, value at the tip, a legend for ≥2 series, hover/focus tooltip per mark.

export function PeriodTabs({ basePath, current }: { basePath: string; current: PeriodKey }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Laikotarpis">
      <span className="mr-1 text-[12px] font-medium text-text-muted">Laikotarpis:</span>
      {PERIOD_OPTIONS.map((p) => (
        <Link
          key={p.value}
          href={`${basePath}?period=${p.value}`}
          role="tab"
          aria-selected={p.value === current}
          className={`rounded-control px-3 py-1.5 text-[13px] font-medium transition-colors ${
            p.value === current ? "bg-accent text-white" : "bg-surface text-text-secondary ring-1 ring-border hover:bg-surface-secondary"
          }`}
        >
          {p.label}
        </Link>
      ))}
    </div>
  );
}

export function ChartCard({
  title,
  subtitle,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {subtitle && <p className="mt-0.5 text-[12px] text-text-muted">{subtitle}</p>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-secondary">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Round a maximum up to 1 / 2 / 2.5 / 5 / 10 × 10^n so ticks read as clean numbers. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / pow;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * pow;
}

export type ColumnSeries = { key: string; label: string; color: string };

/**
 * Columns per month. `grouped` = side-by-side bars per series; `stacked` = one stack.
 * `data[month][seriesKey]` is the value; `format` renders axis ticks and tooltip values.
 */
export function ColumnChart({
  months,
  series,
  data,
  mode,
  format,
  caption,
}: {
  months: string[];
  series: ColumnSeries[];
  data: Record<string, Record<string, number>>;
  mode: "grouped" | "stacked";
  format: (v: number) => string;
  caption: string;
}) {
  const totals = months.map((m) => series.reduce((s, x) => s + (data[m]?.[x.key] ?? 0), 0));
  const rawMax = mode === "stacked" ? Math.max(0, ...totals) : Math.max(0, ...months.flatMap((m) => series.map((s) => data[m]?.[s.key] ?? 0)));
  const max = niceMax(rawMax);
  const ticks = [max, max / 2, 0];
  const pct = (v: number) => (v > 0 ? Math.max(1.5, (v / max) * 100) : 0);

  return (
    <div>
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
      <div className="flex gap-2">
        <div className="flex h-44 w-14 shrink-0 flex-col justify-between text-right text-[11px] tabular-nums text-text-muted">
          {ticks.map((t, i) => (
            <span key={i} className={i === 0 ? "-mt-1.5" : i === 2 ? "-mb-1.5" : ""}>
              {format(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-44">
            <div className="absolute inset-x-0 top-0 border-t border-border" />
            <div className="absolute inset-x-0 top-1/2 border-t border-border" />
            <div className="absolute inset-x-0 bottom-0 border-t border-border-strong" />
          </div>
          <div className="relative flex h-44 items-end gap-1">
            {months.map((m, idx) => {
              const label = monthLabel(m, idx === 0);
              return (
                <div
                  key={m}
                  tabIndex={0}
                  aria-label={`${label.short} ${label.year ?? ""}: ${series.map((s) => `${s.label} ${format(data[m]?.[s.key] ?? 0)}`).join(", ")}`}
                  className="group relative flex h-full min-w-0 flex-1 items-end justify-center rounded-sm outline-none hover:bg-surface-secondary/60 focus-visible:bg-surface-secondary/60"
                >
                  {mode === "grouped" ? (
                    <div className="flex h-full w-full items-end justify-center gap-[2px]">
                      {series.map((s) => (
                        <div
                          key={s.key}
                          className="w-full max-w-6 rounded-t-[4px]"
                          style={{ height: `${pct(data[m]?.[s.key] ?? 0)}%`, background: s.color }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-full w-full max-w-6 flex-col-reverse justify-start gap-[2px]">
                      {series.map((s) => {
                        const v = data[m]?.[s.key] ?? 0;
                        return v > 0 ? <div key={s.key} className="w-full first:rounded-b-none last:rounded-t-[4px]" style={{ height: `${(v / max) * 100}%`, background: s.color, minHeight: 2 }} /> : null;
                      })}
                    </div>
                  )}
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-control border border-border bg-surface px-2.5 py-1.5 text-[12px] shadow-popover group-hover:block group-focus-visible:block">
                    <p className="mb-1 font-medium text-text-secondary">
                      {label.short} {label.year}
                    </p>
                    {series.map((s) => (
                      <p key={s.key} className="flex items-center gap-2">
                        <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                        <span className="font-bold tabular-nums text-text-primary">{format(data[m]?.[s.key] ?? 0)}</span>
                        <span className="text-text-secondary">{s.label}</span>
                      </p>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-1.5 flex gap-1">
            {months.map((m, idx) => {
              const l = monthLabel(m, idx === 0);
              return (
                <div key={m} className="min-w-0 flex-1 text-center text-[11px] leading-tight text-text-muted">
                  <span>{l.short}</span>
                  {l.year && <span className="block text-[10px]">{l.year}</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th>Mėnuo</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m}>
              <td>{m.slice(0, 7)}</td>
              {series.map((s) => (
                <td key={s.key}>{format(data[m]?.[s.key] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type BarRow = { key: string; label: string; sublabel?: string; value: number; valueLabel: string; href?: string };

/** Ranked horizontal bars, one hue; the value sits at the bar's tip. */
export function BarList({ rows, color = "var(--accent)", empty = "Duomenų nėra" }: { rows: BarRow[]; color?: string; empty?: string }) {
  if (rows.length === 0) return <EmptyState title={empty} className="py-8" />;
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const name = (
          <span className="min-w-0 truncate text-[13px] font-medium text-text-primary" title={r.label}>
            {r.label}
          </span>
        );
        return (
          <li key={r.key} className="group" title={`${r.label}: ${r.valueLabel}`}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              {r.href ? (
                <Link href={r.href} className="min-w-0 truncate hover:underline">
                  {name}
                </Link>
              ) : (
                name
              )}
              <span className="shrink-0 text-[13px] font-bold tabular-nums text-text-primary">{r.valueLabel}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-r-[4px] bg-surface-secondary">
              <div className="h-full rounded-r-[4px] transition-opacity group-hover:opacity-80" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: color }} />
            </div>
            {r.sublabel && <p className="mt-0.5 text-[11px] text-text-muted">{r.sublabel}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  tone?: "warning" | "danger";
  href?: string;
}) {
  const chip =
    tone === "danger"
      ? "bg-danger-soft text-danger"
      : tone === "warning"
        ? "bg-warning-soft text-warning"
        : "bg-accent-soft text-accent-hover";
  const body = (
    <div className="flex h-full min-h-[140px] flex-col justify-between gap-4 rounded-panel border border-border bg-surface p-6 transition-all hover:border-border-strong hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[14px] font-medium leading-snug text-text-secondary">{label}</p>
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-control ${chip}`}>
          <Icon className="size-5" />
        </span>
      </div>
      <div>
        <p className="font-display text-[32px] font-bold leading-none tabular-nums tracking-tight text-text-primary">{value}</p>
        {hint && <p className="mt-2 text-[12.5px] leading-snug text-text-muted">{hint}</p>}
      </div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

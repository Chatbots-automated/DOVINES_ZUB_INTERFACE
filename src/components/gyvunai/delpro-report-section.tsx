"use client";

import * as React from "react";
import { Beef, CalendarClock, ChevronDown, FileSpreadsheet, History, Milk, MessageSquare, Pill, Stethoscope } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { createClient } from "@/lib/supabase/client";
import { cn, formatDateTime } from "@/lib/utils";
import { TONE_CLASSES, type Tone } from "@/lib/animal-profile";
import { InfoRow, SectionCard } from "@/components/gyvunai/animal-profile-parts";
import {
  REPORT_HEADLINE_KEYS,
  REPORT_OUTCOME_LABEL,
  daysLeft,
  formatReportValue,
  isCurrent,
  type ReportField,
  type ReportImport,
  type ReportRow,
  type ReportState,
} from "@/lib/delpro-report";
import type { DelproReportValue } from "@/lib/supabase/types";

// DelPro daily Excel report data for one animal (0042): observational — it is
// what DelPro's report said, not a GVET treatment, and it is never sent back.

export type DelproReportData = {
  state: ReportState | null;
  rows: ReportRow[];
  fields: ReportField[];
  imports: Record<string, Pick<ReportImport, "id" | "filename" | "report_at" | "received_at">>;
};

const EMPTY: DelproReportData = { state: null, rows: [], fields: [], imports: {} };

export function useDelproReport(animalId: string | null, active: boolean) {
  const [data, setData] = React.useState<DelproReportData>(EMPTY);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!animalId || !active) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      setLoading(true);
      const [stateRes, rowsRes, fieldsRes] = await Promise.all([
        supabase.from("delpro_report_animal_state").select("*").eq("animal_id", animalId).maybeSingle(),
        supabase.from("delpro_report_rows").select("*").eq("animal_id", animalId).order("report_at", { ascending: false }).limit(60),
        supabase.from("delpro_report_fields").select("*").order("sort_order").order("label"),
      ]);
      const rows = rowsRes.data ?? [];
      const importIds = [...new Set([...rows.map((r) => r.import_id), stateRes.data?.latest_import_id].filter((x): x is string => !!x))];
      const importsRes = importIds.length
        ? await supabase.from("delpro_report_imports").select("id, filename, report_at, received_at").in("id", importIds)
        : { data: [] };
      if (cancelled) return;
      setData({
        state: stateRes.data ?? null,
        rows,
        fields: fieldsRes.data ?? [],
        imports: Object.fromEntries((importsRes.data ?? []).map((i) => [i.id, i])),
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [animalId, active]);

  return { data, loading };
}

function SourceLine({ data }: { data: DelproReportData }) {
  const s = data.state;
  if (!s) return null;
  const imp = s.latest_import_id ? data.imports[s.latest_import_id] : null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-muted">
      <FileSpreadsheet className="size-3.5" />
      <span>Šaltinis: DelPro ataskaita{imp ? ` „${imp.filename}“` : ""}</span>
      <span>· ataskaitos laikas {formatDateTime(s.latest_report_at)}</span>
      <span>· atnaujinta GVET {formatDateTime(s.updated_at)}</span>
    </p>
  );
}

/** A report deadline (karencija iki) as a compact tile — the report's own date, never recalculated. */
function Deadline({ kind, value, current }: { kind: "milk" | "meat"; value: DelproReportValue | undefined; current: boolean }) {
  const left = daysLeft(value);
  const text = formatReportValue(value);
  const tone: Tone = !text || !current ? "neutral" : left !== null && left < 0 ? "success" : left !== null && left <= 2 ? "warning" : "danger";
  const t = TONE_CLASSES[tone];
  const Icon = kind === "milk" ? Milk : Beef;
  return (
    <div className={cn("flex items-center gap-3 rounded-control border px-3 py-2.5", t.border, t.soft)}>
      <Icon className={cn("size-5 shrink-0", t.text)} />
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-text-secondary">{kind === "milk" ? "Pieno išpylimas iki" : "Mėsos sulaikymas iki"}</p>
        <p className={cn("text-[14px] font-bold leading-tight", t.text)}>{text ?? "—"}</p>
        {text && current && left !== null && (
          <p className="text-[11px] text-text-secondary">{left < 0 ? "pasibaigęs" : left === 0 ? "baigiasi šiandien" : `liko ${left} d.`}</p>
        )}
        {text && !current && <p className="text-[11px] text-text-muted">iš senesnės ataskaitos</p>}
      </div>
    </div>
  );
}

/** Keys the report body lays out itself; every other current, visible column is listed after them. */
const BODY_KEYS = new Set(["orn", "latest_diagnosis", "health_event_date", "latest_medicines", "milk_withdrawal_until", "meat_withdrawal_until", "latest_comment"]);

/**
 * The newest report, fully dynamic: diagnosis / medicines / deadlines / comment get
 * their own layout when the report has those columns; every other current column
 * (including ones DelPro adds later) is listed from the field registry.
 */
export function DelproReportBody({ data }: { data: DelproReportData }) {
  const s = data.state;
  if (!s) return null;
  const f = s.fields;
  const has = (k: string) => k in f && isCurrent(f[k], s);
  const val = (k: string) => (has(k) ? formatReportValue(f[k]) : null);
  const registry = new Map(data.fields.map((x) => [x.key, x]));
  const extra = Object.keys(f)
    .filter((k) => !BODY_KEYS.has(k) && has(k) && registry.get(k)?.visible !== false)
    .sort((a, b) => (registry.get(a)?.sort_order ?? 9999) - (registry.get(b)?.sort_order ?? 9999) || a.localeCompare(b));
  const label = (k: string) => registry.get(k)?.label ?? f[k]?.header ?? k;

  return (
    <div className="space-y-3">
      {(has("latest_diagnosis") || has("latest_medicines")) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {has("latest_diagnosis") && (
            <div className="flex items-start gap-2">
              <Stethoscope className="mt-0.5 size-4 shrink-0 text-danger" />
              <div>
                <p className="text-[11px] font-semibold text-text-secondary">{label("latest_diagnosis")}</p>
                <p className="text-[14px] font-semibold text-text-primary">{val("latest_diagnosis") ?? "—"}</p>
                {val("health_event_date") && <p className="text-[11px] text-text-muted">įvykis {val("health_event_date")}</p>}
              </div>
            </div>
          )}
          {has("latest_medicines") && (
            <div className="flex items-start gap-2">
              <Pill className="mt-0.5 size-4 shrink-0 text-accent-alt" />
              <div>
                <p className="text-[11px] font-semibold text-text-secondary">{label("latest_medicines")}</p>
                <p className="text-[14px] font-semibold text-text-primary">{val("latest_medicines") ?? "—"}</p>
              </div>
            </div>
          )}
        </div>
      )}
      {("milk_withdrawal_until" in f || "meat_withdrawal_until" in f) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {"milk_withdrawal_until" in f && <Deadline kind="milk" value={f.milk_withdrawal_until} current={has("milk_withdrawal_until")} />}
          {"meat_withdrawal_until" in f && <Deadline kind="meat" value={f.meat_withdrawal_until} current={has("meat_withdrawal_until")} />}
        </div>
      )}
      {val("latest_comment") && (
        <p className="flex items-start gap-1.5 text-[12px] text-text-secondary">
          <MessageSquare className="mt-0.5 size-3.5 shrink-0" /> {val("latest_comment")}
        </p>
      )}
      {extra.length > 0 && (
        <dl className="grid gap-x-6 sm:grid-cols-2">
          {extra.map((k) => (
            <InfoRow key={k} label={label(k)}>
              {formatReportValue(f[k])}
            </InfoRow>
          ))}
        </dl>
      )}
      <SourceLine data={data} />
    </div>
  );
}

/** The report as its own card (DelPro ataskaita tab). */
export function DelproReportSummary({ data, loading }: { data: DelproReportData; loading: boolean }) {
  const s = data.state;
  if (loading || !s) return null;
  return (
    <SectionCard title="Naujausia DelPro ataskaita" icon={FileSpreadsheet} tone="info" aside={`ataskaita ${formatDateTime(s.latest_report_at)}`}>
      <DelproReportBody data={data} />
    </SectionCard>
  );
}

function FieldList({ keys, data, emptyText }: { keys: string[]; data: DelproReportData; emptyText?: string }) {
  const s = data.state!;
  const label = (k: string) => data.fields.find((f) => f.key === k)?.label ?? s.fields[k]?.header ?? k;
  if (keys.length === 0) return emptyText ? <p className="text-[12px] text-text-muted">{emptyText}</p> : null;
  return (
    <dl className="grid gap-x-6 sm:grid-cols-2">
      {keys.map((k) => (
        <InfoRow key={k} label={label(k)}>
          {formatReportValue(s.fields[k])}
        </InfoRow>
      ))}
    </dl>
  );
}

function HistoryEntry({ row, data, open, onToggle }: { row: ReportRow; data: DelproReportData; open: boolean; onToggle: () => void }) {
  const imp = data.imports[row.import_id];
  const label = (k: string) => data.fields.find((f) => f.key === k)?.label ?? row.fields[k]?.header ?? k;
  const order = (k: string) => data.fields.find((f) => f.key === k)?.sort_order ?? 9999;
  const keys = Object.keys(row.fields).filter((k) => k !== "orn").sort((a, b) => order(a) - order(b));
  const tone: Tone = row.outcome === "stale" || row.outcome === "duplicate" ? "neutral" : row.outcome === "conflict" || row.outcome === "invalid" ? "danger" : "info";
  return (
    <li className="rounded-control border border-border">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-3 py-2 text-left">
        <span className={cn("size-2 shrink-0 rounded-full", TONE_CLASSES[tone].solid)} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-text-primary">
            {formatReportValue(row.fields.latest_diagnosis) ?? "—"}
            {formatReportValue(row.fields.latest_medicines) ? <span className="text-text-secondary"> · {formatReportValue(row.fields.latest_medicines)}</span> : null}
          </span>
          <span className="block text-[11px] text-text-muted">
            ataskaita {formatDateTime(row.report_at)}
            {imp ? ` · ${imp.filename}` : ""}
          </span>
        </span>
        <Badge tone={tone === "info" ? "info" : tone === "danger" ? "danger" : "neutral"}>{REPORT_OUTCOME_LABEL[row.outcome]}</Badge>
        <ChevronDown className={cn("size-4 shrink-0 text-text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <dl className="grid gap-x-6 border-t border-border px-3 py-2 sm:grid-cols-2">
          {keys.map((k) => (
            <InfoRow key={k} label={label(k)}>
              {formatReportValue(row.fields[k]) ?? (row.fields[k]?.type === "empty" ? "tuščia" : null)}
            </InfoRow>
          ))}
        </dl>
      )}
    </li>
  );
}

/** Tab: every current field (known + newly discovered), historical-only fields, and the full snapshot history. */
export function DelproReportTab({ data, loading }: { data: DelproReportData; loading: boolean }) {
  const [open, setOpen] = React.useState<string | null>(null);
  if (loading) return <p className="py-6 text-center text-[12px] text-text-muted">Kraunama…</p>;
  const s = data.state;
  if (!s) {
    return (
      <EmptyState
        icon={FileSpreadsheet}
        title="DelPro ataskaitose šio gyvūno dar nebuvo"
        description="Dieninės DelPro ataskaitos įkeliamos automatiškai; gyvūnas atsiras čia, kai jis bus ataskaitoje."
        className="py-8"
      />
    );
  }
  const registry = new Map(data.fields.map((f) => [f.key, f]));
  const visible = (k: string) => registry.get(k)?.visible !== false;
  const byOrder = (a: string, b: string) => (registry.get(a)?.sort_order ?? 9999) - (registry.get(b)?.sort_order ?? 9999) || a.localeCompare(b);
  const allKeys = Object.keys(s.fields).filter((k) => k !== "orn" && visible(k)).sort(byOrder);
  const currentKnown = allKeys.filter((k) => isCurrent(s.fields[k], s) && (REPORT_HEADLINE_KEYS as readonly string[]).includes(k));
  const currentExtra = allKeys.filter((k) => isCurrent(s.fields[k], s) && !(REPORT_HEADLINE_KEYS as readonly string[]).includes(k));
  const historical = allKeys.filter((k) => !isCurrent(s.fields[k], s));

  return (
    <div className="space-y-4">
      <DelproReportSummary data={data} loading={false} />

      <SectionCard title="Naujausios ataskaitos laukai" icon={CalendarClock} tone="accent" aside={`ORN ${s.orn}`}>
        <FieldList keys={currentKnown} data={data} />
        {currentExtra.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-accent-alt">Papildomi stulpeliai</p>
            <FieldList keys={currentExtra} data={data} />
          </div>
        )}
      </SectionCard>

      {historical.length > 0 && (
        <SectionCard title="Nebėra naujausioje ataskaitoje" icon={History} tone="neutral">
          <dl className="grid gap-x-6 sm:grid-cols-2">
            {historical.map((k) => (
              <InfoRow key={k} label={registry.get(k)?.label ?? s.fields[k]?.header ?? k}>
                {formatReportValue(s.fields[k]) ?? "tuščia"}
                {s.fields[k]?.report_at ? <span className="ml-1 text-[11px] font-normal text-text-muted">({formatDateTime(s.fields[k].report_at!)})</span> : null}
              </InfoRow>
            ))}
          </dl>
        </SectionCard>
      )}

      <SectionCard title={`Ataskaitų istorija (${data.rows.length})`} icon={History} tone="info">
        <ul className="space-y-2">
          {data.rows.map((r) => (
            <HistoryEntry key={r.id} row={r} data={data} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}

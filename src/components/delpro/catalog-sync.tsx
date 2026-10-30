import type { ReactNode } from "react";
import { BookOpen, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { ActionButton } from "@/components/delpro/action-button";
import { CatalogInboundModeForm, CatalogLinkForm } from "@/components/delpro/catalog-controls";
import { CatalogWritePanel, type CatalogJob } from "@/components/delpro/catalog-write";
import { CatalogImportPanel } from "@/components/delpro/catalog-import";
import { TreatmentTemplates, type TemplateProduct, type TemplateRow } from "@/components/delpro/treatment-templates";
import {
  confirmCatalogSuggestions,
  enqueueCatalogCreate,
  importCatalogRecords,
  linkCatalogRecord,
  requestCatalogSync,
  resolveCatalogIssue,
  unlinkCatalogRecord,
} from "@/lib/actions/delpro-catalog";
import {
  CATALOG_ACTION_CONFIRM,
  CATALOG_ACTION_LABEL,
  CATALOG_CLINICAL_FIELDS,
  CATALOG_FIELD_LABEL,
  CATALOG_ISSUE_ACTIONS,
  CATALOG_ISSUE_LABEL,
  CATALOG_ISSUE_TONE,
  CATALOG_OBJECT_LABEL,
  CATALOG_PROBLEM_TYPES,
  catalogValue,
  formatUsages,
  type CatalogInboundMode,
  type CatalogOutboundMode,
} from "@/lib/delpro-catalog";
import { formatDateTime } from "@/lib/utils";
import type { Database, DelproCatalogObjectType, DelproImportPlanRow } from "@/lib/supabase/types";

type Views = Database["public"]["Views"];
export type CatalogIssue = Views["vw_delpro_catalog_issues"]["Row"];
export type CatalogItem = Views["vw_delpro_catalog_items"]["Row"];
export type CatalogSummary = Views["vw_delpro_catalog_summary"]["Row"];
export type CatalogTemplate = Views["vw_delpro_catalog_treatments"]["Row"];
export type CatalogGvetUnlinked = Views["vw_delpro_catalog_gvet_unlinked"]["Row"];
export type CatalogRun = Database["public"]["Tables"]["delpro_catalog_runs"]["Row"];

const objectLabel = (t: string) => CATALOG_OBJECT_LABEL[t as DelproCatalogObjectType] ?? t;

/** DelPro code -> name, for showing references (drugs in template lines, recommended treatments). */
export type CatalogNames = { drugs: Record<string, string>; treatments: Record<string, string> };

function FieldValue({ field, value, names }: { field: string; value: unknown; names: CatalogNames }) {
  if (field === "usages") {
    return (
      <>
        {formatUsages(value, names.drugs).map((line, n) => (
          <div key={n}>{line}</div>
        ))}
      </>
    );
  }
  if (field === "recommended_treatment" && typeof value === "string") {
    return <>{value.startsWith("gvet:") ? "GVET šablonas (nesusietas)" : (names.treatments[value] ?? `Treatment ${value}`)}</>;
  }
  return <>{catalogValue(value)}</>;
}

function FieldTable({ fields, names }: { fields: NonNullable<CatalogIssue["details"]["fields"]>; names: CatalogNames }) {
  return (
    <table className="mt-1.5 text-[11.5px]">
      <thead>
        <tr className="text-text-muted">
          <th className="pr-4 text-left font-medium">Laukas</th>
          <th className="pr-4 text-left font-medium">DelPro</th>
          <th className="pr-4 text-left font-medium">GVET</th>
          <th className="text-left font-medium">Paskutinį kartą suderinta</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(fields).map(([k, f]) => (
          <tr key={k}>
            <td className="pr-4 text-text-secondary">
              {CATALOG_FIELD_LABEL[k] ?? k}
              {CATALOG_CLINICAL_FIELDS.has(k) && <span className="ml-1 text-warning" title="Klinikiniai duomenys — tikrinkite prieš keisdami">●</span>}
            </td>
            <td className="pr-4 align-top font-medium">
              <FieldValue field={k} value={f.delpro} names={names} />
            </td>
            <td className="pr-4 align-top font-medium">
              <FieldValue field={k} value={f.gvet} names={names} />
            </td>
            <td className="align-top text-text-muted">{f.synced === null ? "—" : <FieldValue field={k} value={f.synced} names={names} />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IssueRow({ issue, names }: { issue: CatalogIssue; names: CatalogNames }) {
  const d = issue.details;
  const linkable = ["Diagnosis", "Drug", "Treatment"].includes(issue.object_type);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={CATALOG_ISSUE_TONE[issue.issue_type]}>{CATALOG_ISSUE_LABEL[issue.issue_type]}</Badge>
          <span className="text-[11px] text-text-muted">
            {objectLabel(issue.object_type)}
            {issue.delpro_key ? ` · DelPro ${issue.delpro_key}` : ""}
          </span>
        </div>
        <p className="mt-1 text-[13px] text-text-primary">
          {issue.delpro_name ?? "—"}
          {issue.gvet_name && issue.issue_type !== "ambiguous_match" ? (
            <span className="text-text-secondary"> ↔ GVET: {issue.gvet_name}</span>
          ) : null}
        </p>
        {d.fields && <FieldTable fields={d.fields} names={names} />}
        {issue.issue_type === "outbound_pending" && (
          <p className="mt-1 text-[11.5px] text-text-muted">
            „Siųsti į DelPro“ įtraukia pakeitimą į eilę; vykdoma, kai rašymas įjungtas ir operacija patikrinta.
          </p>
        )}
        {d.missing && (
          <p className="mt-1 text-[11.5px] text-text-secondary">
            Nerasta DelPro: {d.missing.map((m) => `${m.field} → ${objectLabel(m.object_type)} ${m.key}`).join(", ")}
          </p>
        )}
        {issue.issue_type === "ambiguous_match" && (
          <div className="mt-1 text-[11.5px] text-text-secondary">
            {(d.same_name_in_delpro ?? 1) > 1 && <p>DelPro turi {d.same_name_in_delpro} įrašus tokiu pavadinimu.</p>}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span>GVET:</span>
              {(d.candidates ?? []).map((c) =>
                c.linked || !linkable ? (
                  <Badge key={c.gvet_id} tone="neutral" title="Jau susietas su kitu DelPro įrašu">
                    {c.name} (susietas)
                  </Badge>
                ) : (
                  <ActionButton
                    key={c.gvet_id}
                    action={linkCatalogRecord}
                    fields={{ object_type: issue.object_type, delpro_key: issue.delpro_key ?? "", gvet_id: c.gvet_id }}
                    label={`Susieti su „${c.name}“`}
                  />
                ),
              )}
            </div>
          </div>
        )}
        {issue.issue_type === "clinical_review" && d.usages && (
          <div className="mt-1 text-[11.5px] text-text-secondary">
            Importuotas DelPro šablonas — patikrinkite dozes ir karenciją:
            {formatUsages(d.usages, names.drugs).map((line, n) => (
              <div key={n}>{line}</div>
            ))}
          </div>
        )}
        {issue.issue_type === "clinical_review" && !d.usages && (
          <p className="mt-1 text-[11.5px] text-text-secondary">
            Importuota iš DelPro: {catalogValue(d.uom)}, karencija pienui {catalogValue(d.milk_days)} d., mėsai {catalogValue(d.meat_days)} d.
            {d.application_method ? ` (${d.application_method})` : ""}. Palyginkite su vaisto aprašu ir, jei reikia, papildykite karenciją pagal
            skyrimo būdą produkto kortelėje.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {CATALOG_ISSUE_ACTIONS[issue.issue_type].map((a) => (
          <ActionButton
            key={a}
            action={resolveCatalogIssue}
            fields={{ issue_id: issue.id, action: a }}
            label={CATALOG_ACTION_LABEL[a]}
            variant={a === "dismiss" ? "ghost" : a === "confirm" || a === "reviewed" ? "primary" : "outline"}
            confirm={CATALOG_ACTION_CONFIRM[a]}
          />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "danger" | "warning" }) {
  const color = tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text-primary";
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-[16px] font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="text-[12px] text-text-muted">{label}</span>
    </div>
  );
}

export function CatalogSyncSection({
  summary,
  issues,
  unlinkedItems,
  linkedItems,
  gvetUnlinked,
  templates,
  runs,
  writeEnabled,
  workerWriteEnabled,
  workerCatalogSource,
  inboundMode,
  syncRequestedAt,
  names,
  gvetTemplates,
  templateProducts,
  diseases,
  jobs,
  validated,
  outboundMode,
  writeChannel,
  importPlan,
  singleJob,
  animalStats,
}: {
  summary: CatalogSummary[];
  issues: CatalogIssue[];
  unlinkedItems: CatalogItem[];
  linkedItems: CatalogItem[];
  gvetUnlinked: CatalogGvetUnlinked[];
  templates: CatalogTemplate[];
  runs: CatalogRun[];
  writeEnabled: boolean;
  workerWriteEnabled: boolean | null;
  workerCatalogSource: string | null;
  inboundMode: CatalogInboundMode;
  syncRequestedAt: string | null;
  names: CatalogNames;
  gvetTemplates: TemplateRow[];
  templateProducts: TemplateProduct[];
  diseases: { id: string; name: string }[];
  jobs: CatalogJob[];
  validated: string[];
  outboundMode: CatalogOutboundMode;
  writeChannel: string;
  importPlan: { rows: DelproImportPlanRow[]; drug_parameters_complete: boolean } | null;
  singleJob: string | null;
  animalStats: { active: number; withNumber: number };
}) {
  const sum = (t: DelproCatalogObjectType) => summary.find((s) => s.object_type === t);
  const lastRun = runs[0] ?? null;
  const lastCompleted = runs.find((r) => r.status === "completed") ?? null;
  const count = (types: string[]) => issues.filter((i) => types.includes(i.issue_type)).length;
  const suggestions = count(["suggested_match"]);
  const problems = count(CATALOG_PROBLEM_TYPES);
  const outbound = count(["outbound_pending"]);
  const lastErrors = lastRun ? Object.entries(lastRun.stats).filter(([, s]) => (s.invalid ?? 0) > 0) : [];
  const incomplete = summary.filter((s) => s.items > 0 && !s.complete);
  const requestPending = syncRequestedAt !== null && (!lastRun || new Date(syncRequestedAt) > new Date(lastRun.started_at));

  const delproOptions = (t: string) => unlinkedItems.filter((i) => i.object_type === t).map((i) => ({ value: i.delpro_key, label: `${i.name ?? "—"} (${i.delpro_key})` }));
  const gvetOptions = (t: string) => gvetUnlinked.filter((g) => g.object_type === t).map((g) => ({ value: g.gvet_id, label: g.name }));
  const linkOptions = {
    delpro: { Diagnosis: delproOptions("Diagnosis"), Drug: delproOptions("Drug"), Treatment: delproOptions("Treatment") },
    gvet: { Diagnosis: gvetOptions("Diagnosis"), Drug: gvetOptions("Drug"), Treatment: gvetOptions("Treatment") },
  };
  const queuedCreate = (g: CatalogGvetUnlinked) =>
    jobs.find(
      (j) => !j.is_test && j.operation === "create" && ["queued", "processing", "needs_review"].includes(j.status) && j.object_type === g.object_type &&
        (j.disease_id ?? j.product_id ?? j.template_id) === g.gvet_id,
    );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 py-3">
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="size-4 text-text-muted" />
          Katalogo sinchronizacija (DelPro ↔ GVET)
        </CardTitle>
        <div className="flex flex-wrap items-start gap-2">
          {suggestions > 0 && (
            <ActionButton
              action={confirmCatalogSuggestions}
              fields={{}}
              label={`Patvirtinti pasiūlymus (${suggestions})`}
              confirm={`Susieti ${suggestions} DelPro įrašus su to paties pavadinimo GVET įrašais?`}
            />
          )}
          <ActionButton
            action={requestCatalogSync}
            fields={{}}
            variant="primary"
            label={
              <>
                <RefreshCw className="size-3.5" /> Sinchronizuoti dabar
              </>
            }
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-text-secondary">Paskutinė sinchronizacija</span>
            {lastCompleted ? (
              <span className="text-[13px] font-medium">{formatDateTime(lastCompleted.finished_at ?? lastCompleted.started_at)}</span>
            ) : (
              <Badge tone="neutral">Dar nebuvo</Badge>
            )}
            {lastRun && lastRun.status !== "completed" && (
              <Badge tone={lastRun.status === "running" ? "info" : "danger"}>{lastRun.status === "running" ? "Vyksta" : "Nepavyko"}</Badge>
            )}
            {requestPending && <Badge tone="info">Laukia ūkio kompiuterio</Badge>}
          </div>
          <Stat label="ligų susieta" value={`${sum("Diagnosis")?.linked ?? 0}/${sum("Diagnosis")?.items ?? 0}`} />
          <Stat label="vaistų susieta" value={`${sum("Drug")?.linked ?? 0}/${sum("Drug")?.items ?? 0}`} />
          <Stat label="gydymo šablonų" value={sum("Treatment")?.items ?? 0} />
          <Stat label="nesusieta DelPro" value={(sum("Diagnosis")?.unlinked ?? 0) + (sum("Drug")?.unlinked ?? 0)} />
          <Stat label="GVET be DelPro" value={gvetUnlinked.length} />
          <Stat label="klaidos / konfliktai" value={problems} tone={problems > 0 ? "danger" : undefined} />
          <Stat label="laukia siuntimo į DelPro" value={outbound} tone={outbound > 0 ? "warning" : undefined} />
          <div className="flex items-center gap-2" title="GVET → DelPro katalogo rašymas (CreateData / UpdateData)">
            <span className="text-[13px] text-text-secondary">Rašymas į DelPro</span>
            <Badge tone={writeEnabled ? "warning" : "neutral"}>{writeEnabled ? "Įjungtas" : "Išjungtas"}</Badge>
            {workerWriteEnabled !== null && workerWriteEnabled !== writeEnabled && (
              <span className="text-[11px] text-warning">kompiuteryje: {workerWriteEnabled ? "įjungtas" : "išjungtas"}</span>
            )}
          </div>
        </div>

        {workerCatalogSource === "off" && (
          <p className="text-[12px] text-warning">Ūkio kompiuteryje katalogo skaitymas išjungtas (CATALOG_SOURCE=off) — sinchronizacija nevyks.</p>
        )}
        {incomplete.length > 0 && (
          <p className="text-[12px] text-warning">
            DelPro grąžino galimai ne visus įrašus: {incomplete.map((s) => objectLabel(s.object_type)).join(", ")}. Įrašai iš GVET nešalinami, kol
            gaunamas pilnas sąrašas.
          </p>
        )}
        {lastRun?.error && <p className="text-[12px] text-danger">Klaida: {lastRun.error}</p>}
        {(lastCompleted?.stats.Animal?.received ?? 0) > 0 && (lastCompleted?.stats.Animal?.matched ?? 0) + (lastCompleted?.stats.Animal?.unchanged ?? 0) === 0 && (
          <p className="text-[12px] text-warning">
            DelPro grąžino {lastCompleted?.stats.Animal?.received} gyvulių ID, bet nė vienas nesusietas: GVET turi tik {animalStats.active} aktyvių gyvulių, iš jų{" "}
            {animalStats.withNumber} su bandos numeriu. Gyvuliai susiejami tik pagal DelPro numerį su aktyviu GVET gyvuliu — pirmiausia reikia bandos
            sinchronizacijos (DELPRO_SOURCE) arba VIC importo. Dviprasmiški numeriai ({lastCompleted?.stats.Animal?.ambiguous ?? 0}) niekada nesusiejami
            automatiškai.
          </p>
        )}
        {lastErrors.map(([t, s]) => (
          <p key={t} className="text-[12px] text-danger">
            {objectLabel(t)}: {s.invalid} netinkami įrašai praleisti
            {s.errors?.length ? ` (pvz. ${s.errors[0].key ?? "?"}: ${s.errors[0].error})` : ""}.
          </p>
        ))}

        <CollapsibleSection defaultOpen={issues.length > 0} title={`Reikia sprendimo (${issues.length})`}>
          {issues.length === 0 ? (
            <p className="text-[12px] text-text-muted">Nėra.</p>
          ) : (
            <div className="-mx-4 -my-4 divide-y divide-border">
              {issues.map((i) => (
                <IssueRow key={i.id} issue={i} names={names} />
              ))}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          defaultOpen={(importPlan?.rows ?? []).some((r) => r.action === "create" || r.action === "link")}
          title={`Importas iš DelPro į GVET (${(importPlan?.rows ?? []).filter((r) => r.action !== "linked").length})`}
        >
          {importPlan ? (
            <CatalogImportPanel rows={importPlan.rows} drugParametersComplete={importPlan.drug_parameters_complete} />
          ) : (
            <p className="text-[12px] text-danger">Importo peržiūros nepavyko gauti (ar pritaikyta 0039 migracija?).</p>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          defaultOpen={false}
          title={`Rankinis susiejimas ir DelPro šablonai (${unlinkedItems.filter((i) => i.object_type === "Treatment").length})`}
        >
          <div className="space-y-4">
            <CatalogLinkForm delpro={linkOptions.delpro} gvet={linkOptions.gvet} />
            <div className="-mx-4 divide-y divide-border border-t border-border">
              {unlinkedItems.filter((i) => i.object_type === "Treatment").map((i) => (
                <div key={i.id} className="flex items-center justify-between gap-3 px-4 py-1.5">
                  <span className="min-w-0 truncate text-[13px]">
                    <span className="text-text-muted">{objectLabel(i.object_type)} {i.delpro_key} · </span>
                    {i.name ?? "—"}
                    {i.active === false && <span className="ml-1 text-[11px] text-text-muted">(neaktyvus)</span>}
                  </span>
                  <ActionButton
                    action={importCatalogRecords}
                    fields={{ object_type: i.object_type, delpro_keys: JSON.stringify([i.delpro_key]) }}
                    label="Importuoti į GVET"
                    confirm="Sukurti GVET gydymo šabloną iš DelPro? Jo vaistai turi būti susieti; dozes ir karenciją reikės patikrinti."
                  />
                </div>
              ))}
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection defaultOpen={false} title={`Susieti įrašai (${linkedItems.length})`}>
          <div className="-mx-4 -my-4 divide-y divide-border">
            {linkedItems.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-3 px-4 py-1.5">
                <span className="min-w-0 truncate text-[13px]">
                  <span className="text-text-muted">{objectLabel(i.object_type)} {i.delpro_key} · </span>
                  {i.name ?? "—"} <span className="text-text-secondary">↔ {i.gvet_name}</span>
                  {i.link_origin === "imported" && <span className="ml-1 text-[11px] text-text-muted">(importuota)</span>}
                </span>
                <ActionButton action={unlinkCatalogRecord} fields={{ link_id: i.link_id ?? "" }} label="Atsieti" variant="ghost" confirm={CATALOG_ACTION_CONFIRM.unlink} />
              </div>
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection defaultOpen={false} title={`GVET be DelPro atitikmens (${gvetUnlinked.length})`}>
          <p className="mb-2 text-[12px] text-text-muted">
            Šių ligų, vaistų ir šablonų DelPro neturi arba jie nesusieti. „Sukurti DelPro“ įtraukia į eilę; vykdoma tik kai rašymas įjungtas ir operacija
            patikrinta. Jei DelPro įrašas jau yra — susiekite, o ne kurkite.
          </p>
          <div className="-mx-4 divide-y divide-border border-t border-border">
            {gvetUnlinked.map((g) => {
              const job = queuedCreate(g);
              return (
                <div key={`${g.gvet_table}-${g.gvet_id}`} className="flex items-center justify-between gap-3 px-4 py-1.5">
                  <span className="min-w-0 truncate text-[13px]">
                    <span className="text-text-muted">{objectLabel(g.object_type)} · </span>
                    {g.name}
                  </span>
                  {job ? (
                    <Badge tone="info">Eilėje</Badge>
                  ) : (
                    <ActionButton action={enqueueCatalogCreate} fields={{ object_type: g.object_type, gvet_id: g.gvet_id }} label="Sukurti DelPro" />
                  )}
                </div>
              );
            })}
          </div>
        </CollapsibleSection>

        <CollapsibleSection defaultOpen={false} title={`GVET gydymo šablonai (${gvetTemplates.length})`}>
          <TreatmentTemplates templates={gvetTemplates} products={templateProducts} diseases={diseases} />
        </CollapsibleSection>

        <CollapsibleSection
          defaultOpen={false}
          title={`Rašymas į DelPro (${jobs.filter((j) => !j.is_test && ["queued", "processing", "needs_review", "failed", "verification_failed"].includes(j.status)).length})`}
        >
          <CatalogWritePanel
            writeEnabled={writeEnabled}
            workerWriteEnabled={workerWriteEnabled}
            validated={validated}
            outboundMode={outboundMode}
            writeChannel={writeChannel}
            jobs={jobs}
            singleJob={singleJob}
          />
        </CollapsibleSection>

        <CollapsibleSection defaultOpen={false} title={`DelPro gydymo šablonai (${templates.length})`}>
          <p className="mb-2 text-[12px] text-text-muted">Tik peržiūra: DelPro šablonai (Treatment / TreatmentDrugUsage), ne gyvulių gydymo įrašai.</p>
          <table className="w-full text-[12px]">
            <thead className="border-b border-border text-left text-text-muted">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Kodas</th>
                <th className="px-2 py-1.5 font-medium">Šablonas</th>
                <th className="px-2 py-1.5 font-medium">Vaistai (dozė × kartai × d.)</th>
                <th className="px-2 py-1.5 font-medium">Diagnozių</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {templates.map((t) => (
                <tr key={t.code} className={t.removed_at || t.active === false ? "text-text-muted" : ""}>
                  <td className="py-1.5 pr-2 align-top">{t.code}</td>
                  <td className="px-2 py-1.5 align-top">
                    {t.name ?? "—"}
                    {t.removed_at && " (pašalintas)"}
                  </td>
                  <td className="px-2 py-1.5">
                    {t.drug_usages.length === 0
                      ? "—"
                      : t.drug_usages.map((u) => (
                          <div key={u.key}>
                            {u.drug_name ?? `Drug ${u.drug_code ?? "?"}`} — {catalogValue(u.dosage)} {u.uom ?? ""} × {catalogValue(u.frequency)} × {catalogValue(u.treat_cow_days)} d.
                            <span className="text-text-muted">
                              {" "}
                              (pienas {catalogValue(u.dump_milk_days)} d., mėsa {catalogValue(u.meat_withhold_days)} d.)
                            </span>
                          </div>
                        ))}
                  </td>
                  <td className="px-2 py-1.5 align-top">{t.recommended_for}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CollapsibleSection>

        <CollapsibleSection defaultOpen={false} title={`Katalogo sinchronizacijų istorija (${runs.length})`}>
          <div className="space-y-4">
            <CatalogInboundModeForm mode={inboundMode} />
            {runs.length === 0 ? (
              <p className="text-[12px] text-text-muted">Dar nebuvo.</p>
            ) : (
              <table className="w-full text-[12px]">
                <thead className="border-b border-border text-left text-text-muted">
                  <tr>
                    <th className="py-1.5 pr-2 font-medium">Pradėta</th>
                    <th className="px-2 py-1.5 font-medium">Būsena</th>
                    <th className="px-2 py-1.5 font-medium">Gauta (nauji / pakeisti / pašalinti)</th>
                    <th className="px-2 py-1.5 font-medium">Atidaryta / uždaryta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="py-1.5 pr-2 align-top text-text-secondary">{formatDateTime(r.started_at)}</td>
                      <td className="px-2 py-1.5 align-top">
                        {r.status === "completed" ? "Baigta" : r.status === "running" ? "Vyksta" : "Nepavyko"}
                        {r.error && <div className="text-danger">{r.error}</div>}
                      </td>
                      <td className="px-2 py-1.5">
                        {Object.entries(r.stats)
                          .filter(([t]) => t !== "Animal")
                          .map(([t, s]) => (
                            <div key={t} className={s.complete === false ? "text-warning" : ""}>
                              {objectLabel(t)}: {s.received ?? 0} ({s.inserted ?? 0} / {s.changed ?? 0} / {s.removed ?? 0})
                              {s.invalid ? `, netinkami ${s.invalid}` : ""}
                              {s.complete === false ? ` — nepilnas${s.note ? ` (${s.note})` : ""}` : ""}
                            </div>
                          ))}
                        {r.stats.Animal && (
                          <div className="text-text-muted">
                            Gyvulių ID: susieta {r.stats.Animal.matched ?? 0}, nerasta {r.stats.Animal.unmatched ?? 0}
                            {(r.stats.Animal.ambiguous ?? 0) > 0 ? `, dviprasmiški ${r.stats.Animal.ambiguous}` : ""}
                            {(r.stats.Animal.conflicts ?? 0) > 0 ? `, konfliktai ${r.stats.Animal.conflicts}` : ""}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 align-top">{r.reconcile ? `${r.reconcile.opened} / ${r.reconcile.closed}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CollapsibleSection>
      </CardContent>
    </Card>
  );
}

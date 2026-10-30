import { FileSpreadsheet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { ActionButton } from "@/components/delpro/action-button";
import { ReportTokenForm } from "@/components/delpro/report-token-form";
import { REPORT_REVIEW_LABEL, type ReportFailure, type ReportField, type ReportImport, type ReportReview, type ReportToken } from "@/lib/delpro-report";
import { formatDateTime } from "@/lib/utils";

// DelPro daily Excel reports (0042) — admin view: uploads, results, conflicts,
// the dynamic field registry and the farm PC's upload tokens.

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "danger" | "warning" }) {
  const color = tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text-primary";
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-[16px] font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="text-[12px] text-text-muted">{label}</span>
    </div>
  );
}

function reviewDetails(r: ReportReview) {
  const d = r.details as Record<string, unknown>;
  if (r.kind === "birth_date_conflict") return `GVET ${String(d.gvet)}, ataskaitoje ${String(d.report)}`;
  if (r.kind === "ambiguous_animal") return `GVET gyvūnai: ${((d.animals as { tag_no: string }[]) ?? []).map((a) => a.tag_no).join(", ")}`;
  if (r.kind === "duplicate_orn_row") return `${String(d.copies)} eilutės su tuo pačiu ORN (${String(d.sheet ?? "")} ${String(d.row ?? "")})`;
  return `Reikšmė „${String(d.value ?? "")}“ (${String(d.sheet ?? "")} eil. ${String(d.row ?? "")})`;
}

export function ReportImportsSection({
  imports,
  failures,
  reviews,
  fields,
  tokens,
  endpointUrl,
  endpointAltUrl,
  endpointIsLocal,
  animalsWithReport,
}: {
  imports: ReportImport[];
  failures: ReportFailure[];
  reviews: ReportReview[];
  fields: ReportField[];
  tokens: ReportToken[];
  endpointUrl: string;
  endpointAltUrl: string;
  endpointIsLocal: boolean;
  animalsWithReport: number;
}) {
  const last = imports[0] ?? null;
  const activeTokens = tokens.filter((t) => !t.revoked_at);
  const newFields = fields.filter((f) => !f.known);

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="size-4 text-text-muted" />
          DelPro Excel ataskaitos (dieninės)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-text-secondary">Paskutinis importas</span>
            {last ? (
              <span className="text-[13px] font-medium">
                {formatDateTime(last.received_at)} · {last.filename}
              </span>
            ) : (
              <Badge tone="neutral">Dar nebuvo</Badge>
            )}
          </div>
          <Stat label="failų" value={imports.length} />
          <Stat label="gyvūnų su ataskaita" value={animalsWithReport} />
          <Stat label="atviri konfliktai" value={reviews.length} tone={reviews.length > 0 ? "warning" : undefined} />
          <Stat label="nepavykę įkėlimai" value={failures.length} tone={failures.length > 0 ? "danger" : undefined} />
          <Stat label="nauji stulpeliai" value={newFields.length} />
          {activeTokens.length === 0 && <Badge tone="warning">Nėra įkėlimo rakto</Badge>}
        </div>
        <p className="text-[12px] text-text-muted">
          Ataskaitos tik stebimos: iš jų nekuriami gydymai, karencija ar DelPro užduotys. Gyvūnas randamas pagal ORN (ausies įsagą); nežinomas ORN sukuria
          laikiną gyvūną („DelPro ataskaita“). Gyvūnai, kurių nėra ataskaitoje, nekeičiami.
        </p>

        <CollapsibleSection defaultOpen={imports.length === 0 || activeTokens.length === 0} title={`Įkėlimas ir raktai (${activeTokens.length})`}>
          <div className="space-y-3 text-[12px]">
            <p className="text-text-secondary">
              Adresas: <code className="rounded bg-surface-secondary px-1.5 py-0.5 font-mono">POST {endpointUrl}</code> · antraštės{" "}
              <code className="font-mono">Authorization: Bearer …</code>, <code className="font-mono">X-GVET-Report-Filename</code>,{" "}
              <code className="font-mono">X-GVET-Report-SHA256</code>, <code className="font-mono">X-GVET-Report-Type: daily-health</code>.
            </p>
            <p className="text-text-secondary">
              Tas pats priėmimas ir per <code className="rounded bg-surface-secondary px-1.5 py-0.5 font-mono">POST {endpointAltUrl}</code>.
            </p>
            {endpointIsLocal && (
              <p className="text-warning">
                Puslapis atidarytas lokaliai: ūkio kompiuteriui naudokite Netlify svetainės https adresą. Lokaliai veikia tik /api/delpro/report-upload
                (/.netlify/functions/… veikia tik Netlify).
              </p>
            )}
            <ReportTokenForm />
            {tokens.length > 0 && (
              <table className="w-full">
                <thead className="border-b border-border text-left text-text-muted">
                  <tr>
                    <th className="py-1.5 pr-2 font-medium">Raktas</th>
                    <th className="px-2 py-1.5 font-medium">Sukurtas</th>
                    <th className="px-2 py-1.5 font-medium">Paskutinį kartą naudotas</th>
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tokens.map((t) => (
                    <tr key={t.id} className={t.revoked_at ? "text-text-muted" : ""}>
                      <td className="py-1.5 pr-2">
                        {t.label} <span className="font-mono text-text-muted">…{t.token_hint}</span>
                      </td>
                      <td className="px-2 py-1.5">{formatDateTime(t.created_at)}</td>
                      <td className="px-2 py-1.5">{t.last_used_at ? formatDateTime(t.last_used_at) : "—"}</td>
                      <td className="px-2 py-1.5 text-right">
                        {t.revoked_at ? (
                          <Badge tone="neutral">Atšauktas</Badge>
                        ) : (
                          <ActionButton
                            action="revokeReportUploadToken"
                            fields={{ token_id: t.id }}
                            label="Atšaukti"
                            variant="ghost"
                            confirm="Atšaukti raktą? Ūkio kompiuteris nebegalės įkelti ataskaitų, kol jame nebus naujo rakto."
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection defaultOpen={imports.length > 0} title={`Importuoti failai (${imports.length})`}>
          {imports.length === 0 ? (
            <p className="text-[12px] text-text-muted">Dar nėra.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="border-b border-border text-left text-text-muted">
                  <tr>
                    <th className="py-1.5 pr-2 font-medium">Failas</th>
                    <th className="px-2 py-1.5 font-medium">Ataskaitos laikas</th>
                    <th className="px-2 py-1.5 font-medium">Eilutės</th>
                    <th className="px-2 py-1.5 font-medium">Rasta / sukurta / atnaujinta</th>
                    <th className="px-2 py-1.5 font-medium">Senesnės / konfliktai</th>
                    <th className="px-2 py-1.5 font-medium">Gauta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {imports.map((i) => (
                    <tr key={i.id} className="align-top">
                      <td className="py-1.5 pr-2">
                        <div className="font-medium">{i.filename}</div>
                        <div className="font-mono text-[10.5px] text-text-muted" title={i.sha256}>
                          SHA-256 {i.sha256.slice(0, 16)}…
                        </div>
                        {i.supersedes_import_id && <div className="text-[11px] text-info">nauja to paties failo versija</div>}
                        {i.errors.length > 0 && (
                          <div className="text-[11px] text-warning">
                            {i.errors.slice(0, 3).map((e, n) => (
                              <div key={n}>
                                {e.sheet ? `${e.sheet} ` : ""}
                                {e.row ? `eil. ${e.row}: ` : ""}
                                {e.error}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {formatDateTime(i.report_at)}
                        <div className="text-[11px] text-text-muted">{i.report_at_source === "filename" ? "iš failo vardo" : "gavimo laikas"}</div>
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">
                        {i.rows_received}
                        {i.footer_rows ? <span className="text-text-muted"> (+{i.footer_rows} suma)</span> : null}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">
                        {i.matched} / {i.created} / {i.updated}
                      </td>
                      <td className={`px-2 py-1.5 tabular-nums ${i.conflicts > 0 ? "text-warning" : ""}`}>
                        {i.stale} / {i.conflicts}
                      </td>
                      <td className="px-2 py-1.5 text-text-secondary">{formatDateTime(i.received_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection defaultOpen={reviews.length > 0} title={`Konfliktai ir neatpažinti įrašai (${reviews.length})`}>
          {reviews.length === 0 ? (
            <p className="text-[12px] text-text-muted">Nėra.</p>
          ) : (
            <div className="-mx-4 -my-4 divide-y divide-border">
              {reviews.map((r) => (
                <div key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1 text-[12px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="warning">{REPORT_REVIEW_LABEL[r.kind]}</Badge>
                      {r.orn && <span className="font-mono">{r.orn}</span>}
                      <span className="text-text-muted">{formatDateTime(r.created_at)}</span>
                    </div>
                    <p className="mt-1 text-text-secondary">{reviewDetails(r)}</p>
                  </div>
                  <div className="flex gap-2">
                    <ActionButton action="resolveReportReview" fields={{ review_id: r.id, status: "resolved" }} label="Išspręsta" />
                    <ActionButton action="resolveReportReview" fields={{ review_id: r.id, status: "dismissed" }} label="Atmesti" variant="ghost" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CollapsibleSection>

        {failures.length > 0 && (
          <CollapsibleSection defaultOpen={false} title={`Nepavykę įkėlimai (${failures.length})`}>
            <ul className="space-y-1 text-[12px]">
              {failures.map((f) => (
                <li key={f.id}>
                  <span className="text-text-muted">{formatDateTime(f.created_at)}</span> · {f.filename ?? "—"} · <Badge tone="danger">{f.stage}</Badge>{" "}
                  <span className="text-danger">{f.error}</span>
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        )}

        <CollapsibleSection defaultOpen={false} title={`Ataskaitos laukai (${fields.length})`}>
          <p className="mb-2 text-[12px] text-text-muted">
            Nauji Excel stulpeliai užregistruojami automatiškai ir rodomi gyvūno kortelėje. Čia galima paslėpti lauką; žinomi laukai atpažįstami ir pagal kitus
            pavadinimus (sinonimus).
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="border-b border-border text-left text-text-muted">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Laukas</th>
                  <th className="px-2 py-1.5 font-medium">Tipas</th>
                  <th className="px-2 py-1.5 font-medium">Excel antraštės</th>
                  <th className="px-2 py-1.5 font-medium">Paskutinį kartą</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {fields.map((f) => (
                  <tr key={f.key} className={f.visible ? "" : "text-text-muted"}>
                    <td className="py-1.5 pr-2">
                      {f.label} {!f.known && <Badge tone="info">naujas</Badge>}
                      <div className="font-mono text-[10.5px] text-text-muted">{f.key}</div>
                    </td>
                    <td className="px-2 py-1.5">{f.data_type}</td>
                    <td className="px-2 py-1.5">{f.headers_seen.length ? f.headers_seen.join("; ") : "—"}</td>
                    <td className="px-2 py-1.5">{f.last_seen_at ? formatDateTime(f.last_seen_at) : "—"}</td>
                    <td className="px-2 py-1.5 text-right">
                      {f.key !== "orn" && (
                        <ActionButton
                          action="updateReportField"
                          fields={{ key: f.key, visible: f.visible ? "0" : "1" }}
                          label={f.visible ? "Slėpti" : "Rodyti"}
                          variant="ghost"
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CollapsibleSection>
      </CardContent>
    </Card>
  );
}

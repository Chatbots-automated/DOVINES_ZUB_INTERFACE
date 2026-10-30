import { redirect } from "next/navigation";
import { Activity } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { DelproSettingsForm } from "@/components/delpro/settings-form";
import { DelproSyncQueue, type QueueJob } from "@/components/delpro/sync-queue";
import { MappingRow } from "@/components/delpro/mapping-row";
import { CatalogSyncSection } from "@/components/delpro/catalog-sync";
import type { CatalogInboundMode, CatalogOutboundMode } from "@/lib/delpro-catalog";
import { formatDateTime } from "@/lib/utils";
import type { DelproOutboundMode } from "@/lib/supabase/types";

// The worker heartbeats on every poll (every minute or so); anything older
// than this means the farm PC / worker is down (contract §7.5).
const WORKER_STALE_MINUTES = 15;

function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

// DelPro integracija (Priedas §3-§4) — admin only.
export default async function DelproPage() {
  const session = await getCurrentProfile();
  if (session?.profile.role !== "admin") redirect("/veterinarija");

  const supabase = await createClient();
  const [settingsRes, jobsRes, runsRes, diseasesRes, productsRes, mappingsRes, animalsRes] = await Promise.all([
    supabase.from("system_settings").select("setting_key, setting_value").like("setting_key", "delpro_%"),
    supabase.from("vw_delpro_sync_jobs").select("*").order("created_at", { ascending: false }).limit(500),
    supabase.from("delpro_sync_runs").select("*").order("created_at", { ascending: false }).limit(15),
        supabase.from("diseases").select("id, name").order("name"),
    supabase.from("products").select("id, name").eq("is_active", true).in("category", ["medicines", "vakcina", "profilaktika", "boliusai"]).order("name"),
    supabase.from("delpro_mappings").select("*"),
    supabase.from("animals").select("id", { count: "exact", head: true }).eq("source", "delpro").eq("active", true),
  ]);
  // Catalog sync (0036): DelPro Diagnosis/Drug/Treatment mirror, links and what needs a decision.
  const [catSummaryRes, catIssuesRes, catItemsRes, catGvetRes, catTemplatesRes, catRunsRes, catNamesRes, gvetTemplatesRes, templateProductsRes, catJobsRes] = await Promise.all([
    supabase.from("vw_delpro_catalog_summary").select("*"),
    supabase.from("vw_delpro_catalog_issues").select("*").eq("status", "open").order("issue_type").order("created_at").limit(1000),
    supabase.from("vw_delpro_catalog_items").select("*").in("object_type", ["Diagnosis", "Drug", "Treatment"]).is("removed_at", null).order("object_type").order("name").limit(1000),
    supabase.from("vw_delpro_catalog_gvet_unlinked").select("*").order("object_type").order("name").limit(1000),
    supabase.from("vw_delpro_catalog_treatments").select("*").is("removed_at", null).order("name").limit(1000),
    supabase.from("delpro_catalog_runs").select("*").order("started_at", { ascending: false }).limit(10),
    supabase.from("delpro_catalog_items").select("object_type, delpro_key, name").in("object_type", ["Drug", "Treatment"]).limit(1000),
    supabase.from("vw_treatment_templates").select("*").order("name").limit(1000),
    supabase
      .from("products")
      .select("id, name, unit, withdrawal_days_milk, withdrawal_days_meat")
      .eq("is_active", true)
      .in("category", ["medicines", "vakcina", "profilaktika", "boliusai"])
      .order("name"),
    supabase.from("delpro_catalog_jobs").select("*").order("created_at", { ascending: false }).limit(100),
  ]);
  const catNames = { drugs: {} as Record<string, string>, treatments: {} as Record<string, string> };
  for (const n of catNamesRes.data ?? []) (n.object_type === "Drug" ? catNames.drugs : catNames.treatments)[n.delpro_key] = n.name ?? n.delpro_key;
  const catItems = catItemsRes.data ?? [];

  const settings = new Map((settingsRes.data ?? []).map((s) => [s.setting_key, s.setting_value]));
  const lastSeen = settings.get("delpro_worker_last_seen_at") ?? null;
  const lastSeenMin = minutesSince(lastSeen);
  const workerOnline = lastSeenMin !== null && lastSeenMin <= WORKER_STALE_MINUTES;
  let workerInfo: Record<string, unknown> | null = null;
  try {
    workerInfo = JSON.parse(settings.get("delpro_worker_info") ?? "null");
  } catch {
    workerInfo = null;
  }

  const mappingFor = (kind: string, id: string) => (mappingsRes.data ?? []).find((m) => m.kind === kind && m.local_id === id);
  const jobs = (jobsRes.data ?? []) as QueueJob[];
  const runs = runsRes.data ?? [];

  const countOf = (...statuses: string[]) => jobs.filter((j) => statuses.includes(j.status)).length;
  const workerLabel = workerOnline ? "Veikia" : lastSeen ? "Neatsako" : "Neprisijungė";

  return (
    <div className="flex flex-col">
      <PageHeader title="DelPro" />
      <div className="space-y-4 px-4 py-6 sm:px-6 lg:px-8">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 py-3">
            <div className="flex items-center gap-2" title={lastSeen ? `Paskutinis signalas ${formatDateTime(lastSeen)}` : undefined}>
              <Activity className="size-4 text-text-muted" />
              <span className="text-[13px] text-text-secondary">Ūkio kompiuteris</span>
              <Badge tone={workerOnline ? "success" : "danger"}>{workerLabel}</Badge>
              {workerInfo?.version ? <span className="text-[11px] text-text-muted">v{String(workerInfo.version)}</span> : null}
            </div>
            <Stat label="Gyvulių iš DelPro" value={animalsRes.count ?? 0} />
            <Stat label="Perduota" value={countOf("success")} />
            <Stat label="Laukia patvirtinimo" value={countOf("pending_approval")} />
            <Stat label="Laukia perdavimo" value={countOf("approved", "processing")} />
            <Stat label="Klaidos" value={countOf("error", "verification_failed")} tone={countOf("error", "verification_failed") > 0 ? "danger" : undefined} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="py-3">
            <CardTitle>Gydymų perdavimas</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DelproSyncQueue jobs={jobs} workerOnline={workerOnline} />
          </CardContent>
        </Card>

        <CatalogSyncSection
          summary={catSummaryRes.data ?? []}
          issues={catIssuesRes.data ?? []}
          unlinkedItems={catItems.filter((i) => !i.link_id)}
          linkedItems={catItems.filter((i) => i.link_id)}
          gvetUnlinked={catGvetRes.data ?? []}
          templates={catTemplatesRes.data ?? []}
          runs={catRunsRes.data ?? []}
          writeEnabled={settings.get("delpro_catalog_write_enabled") === "true"}
          workerWriteEnabled={typeof workerInfo?.catalog_write_enabled === "boolean" ? workerInfo.catalog_write_enabled : null}
          workerCatalogSource={typeof workerInfo?.catalog_source === "string" ? workerInfo.catalog_source : null}
          inboundMode={(settings.get("delpro_catalog_inbound_mode") ?? "review") as CatalogInboundMode}
          syncRequestedAt={settings.get("delpro_catalog_sync_requested_at") ?? null}
          names={catNames}
          gvetTemplates={gvetTemplatesRes.data ?? []}
          templateProducts={templateProductsRes.data ?? []}
          diseases={diseasesRes.data ?? []}
          jobs={catJobsRes.data ?? []}
          validated={(settings.get("delpro_catalog_validated_operations") ?? "").split(",").filter(Boolean)}
          outboundMode={(settings.get("delpro_catalog_outbound_mode") ?? "manual") as CatalogOutboundMode}
          writeChannel={settings.get("delpro_write_channel") ?? "ui_script"}
        />

        <CollapsibleSection defaultOpen={false} title="Nustatymai">
          <DelproSettingsForm mode={(settings.get("delpro_outbound_mode") ?? "approval") as DelproOutboundMode} delayMinutes={settings.get("delpro_auto_delay_minutes") ?? "10"} />
        </CollapsibleSection>

        <CollapsibleSection defaultOpen={false} title={`Gyvulių sinchronizacijos (${runs.length})`}>
          {runs.length === 0 ? (
            <p className="text-[12px] text-text-muted">Dar nebuvo.</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="border-b border-border text-left text-text-muted">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Laikas</th>
                  <th className="px-2 py-1.5 font-medium">Gauta</th>
                  <th className="px-2 py-1.5 font-medium">Nauji</th>
                  <th className="px-2 py-1.5 font-medium">Atnaujinti</th>
                  <th className="px-2 py-1.5 font-medium">Išėję</th>
                  <th className="px-2 py-1.5 font-medium">Praleisti</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 pr-2 text-text-secondary">{formatDateTime(r.created_at)}</td>
                    <td className="px-2 py-1.5">{r.received_rows}</td>
                    <td className="px-2 py-1.5">{r.inserted}</td>
                    <td className="px-2 py-1.5">{r.updated}</td>
                    <td className="px-2 py-1.5">{r.deactivated}</td>
                    <td className={r.skipped > 0 ? "px-2 py-1.5 font-semibold text-warning" : "px-2 py-1.5"}>{r.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>

        <div id="susiejimai" className="space-y-2">
          <CollapsibleSection defaultOpen={false} title={`Kitokie pavadinimai DelPro: ligos (${(diseasesRes.data ?? []).length})`}>
            <div className="-mx-4 divide-y divide-border">
              {(diseasesRes.data ?? []).map((d) => {
                const m = mappingFor("disease", d.id);
                return <MappingRow key={d.id} kind="disease" localId={d.id} localName={d.name} code={m?.delpro_code ?? null} name={m?.delpro_name ?? null} />;
              })}
            </div>
          </CollapsibleSection>
          <CollapsibleSection defaultOpen={false} title={`Kitokie pavadinimai DelPro: vaistai (${(productsRes.data ?? []).length})`}>
            <div className="-mx-4 divide-y divide-border">
              {(productsRes.data ?? []).map((p) => {
                const m = mappingFor("product", p.id);
                return <MappingRow key={p.id} kind="product" localId={p.id} localName={p.name} code={m?.delpro_code ?? null} name={m?.delpro_name ?? null} />;
              })}
            </div>
          </CollapsibleSection>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-[16px] font-semibold tabular-nums ${tone === "danger" ? "text-danger" : "text-text-primary"}`}>{value}</span>
      <span className="text-[12px] text-text-muted">{label}</span>
    </div>
  );
}

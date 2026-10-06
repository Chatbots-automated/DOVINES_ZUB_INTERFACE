import { redirect } from "next/navigation";
import { Activity, ArrowDownToLine, ArrowUpFromLine, Link2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { DelproSettingsForm } from "@/components/delpro/settings-form";
import { DelproSyncQueue, type QueueJob } from "@/components/delpro/sync-queue";
import { MappingRow } from "@/components/delpro/mapping-row";
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
  const [settingsRes, jobsRes, runsRes, groupsRes, diseasesRes, productsRes, mappingsRes, animalsRes] = await Promise.all([
    supabase.from("system_settings").select("setting_key, setting_value").like("setting_key", "delpro_%"),
    supabase.from("vw_delpro_sync_jobs").select("*").order("created_at", { ascending: false }).limit(500),
    supabase.from("delpro_sync_runs").select("*").order("created_at", { ascending: false }).limit(15),
    supabase.from("delpro_groups").select("id, name, delpro_group_id, active").order("name"),
    supabase.from("diseases").select("id, name").order("name"),
    supabase.from("products").select("id, name").eq("is_active", true).in("category", ["medicines", "vakcina"]).order("name"),
    supabase.from("delpro_mappings").select("*"),
    supabase.from("animals").select("id", { count: "exact", head: true }).eq("source", "delpro").eq("active", true),
  ]);

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

  return (
    <div className="flex flex-col">
      <PageHeader title="DelPro integracija" description="Gyvulių duomenų gavimas iš DelPro ir gydymų perdavimas į DelPro" />
      <div className="space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="py-4">
              <p className="mb-1 flex items-center gap-1.5 text-[12px] text-text-secondary">
                <Activity className="size-3.5" /> Ūkio kompiuterio darbininkas
              </p>
              <Badge tone={workerOnline ? "success" : "danger"}>{workerOnline ? "Veikia" : lastSeen ? "Neatsako" : "Dar neprisijungė"}</Badge>
              <p className="mt-1 text-[11px] text-text-muted">
                {lastSeen ? `Paskutinis signalas ${formatDateTime(lastSeen)}` : "Darbininkas diegiamas ūkio kompiuteryje (delpro-worker/)."}
                {workerInfo?.version ? ` · v${String(workerInfo.version)}` : ""}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <p className="mb-1 flex items-center gap-1.5 text-[12px] text-text-secondary">
                <ArrowDownToLine className="size-3.5" /> DelPro → GVET
              </p>
              <p className="text-[22px] font-display font-bold tabular-nums text-text-primary">{animalsRes.count ?? 0}</p>
              <p className="text-[11px] text-text-muted">
                aktyvių gyvulių iš DelPro · {settings.get("delpro_last_inbound_at") ? `atnaujinta ${formatDateTime(settings.get("delpro_last_inbound_at"))}` : "dar negauta"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <p className="mb-1 flex items-center gap-1.5 text-[12px] text-text-secondary">
                <ArrowUpFromLine className="size-3.5" /> GVET → DelPro
              </p>
              <p className="text-[22px] font-display font-bold tabular-nums text-text-primary">
                {jobs.filter((j) => j.status === "success").length}
                <span className="text-[13px] font-medium text-text-muted"> perduota</span>
              </p>
              <p className="text-[11px] text-text-muted">
                {jobs.filter((j) => j.status === "pending_approval").length} laukia ·{" "}
                {jobs.filter((j) => j.status === "error" || j.status === "verification_failed").length} klaidų
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Gydymų perdavimas į DelPro</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DelproSyncQueue jobs={jobs} />
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Nustatymai</CardTitle>
            </CardHeader>
            <CardContent>
              <DelproSettingsForm
                mode={(settings.get("delpro_outbound_mode") ?? "approval") as DelproOutboundMode}
                delayMinutes={settings.get("delpro_auto_delay_minutes") ?? "10"}
                defaultTreatmentCode={settings.get("delpro_default_treatment_code") ?? ""}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Gyvulių sinchronizacijos (DelPro → GVET)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {runs.length === 0 ? (
                <EmptyState icon={ArrowDownToLine} title="Sinchronizacijų dar nebuvo" className="py-8" />
              ) : (
                <table className="w-full text-[12px]">
                  <thead className="border-b border-border text-left text-text-muted">
                    <tr>
                      <th className="px-5 py-2 font-medium">Laikas</th>
                      <th className="px-2 py-2 font-medium">Gauta</th>
                      <th className="px-2 py-2 font-medium">Nauji</th>
                      <th className="px-2 py-2 font-medium">Atnaujinti</th>
                      <th className="px-2 py-2 font-medium">Išėję</th>
                      <th className="px-2 py-2 font-medium">Praleisti</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {runs.map((r) => (
                      <tr key={r.id}>
                        <td className="px-5 py-2 text-text-secondary">{formatDateTime(r.created_at)}</td>
                        <td className="px-2 py-2">{r.received_rows}</td>
                        <td className="px-2 py-2">{r.inserted}</td>
                        <td className="px-2 py-2">{r.updated}</td>
                        <td className="px-2 py-2">{r.deactivated}</td>
                        <td className={r.skipped > 0 ? "px-2 py-2 font-semibold text-warning" : "px-2 py-2"}>{r.skipped}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="size-4" /> Susiejimai su DelPro (Priedas §4.3)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-[12px] text-text-muted">
              Kokiu DelPro diagnozės / gydymo įrašu perduodamas GVET įrašas. Nesusietos ligos perduodamos pavadinimu, nesusieti vaistai —
              numatytuoju DelPro gydymo įrašu.
            </p>
            <CollapsibleSection defaultOpen={false} title={`Ligos / diagnozės (${(diseasesRes.data ?? []).length})`}>
              <div className="divide-y divide-border rounded-control border border-border">
                {(diseasesRes.data ?? []).map((d) => {
                  const m = mappingFor("disease", d.id);
                  return <MappingRow key={d.id} kind="disease" localId={d.id} localName={d.name} code={m?.delpro_code ?? null} name={m?.delpro_name ?? null} />;
                })}
              </div>
            </CollapsibleSection>
            <CollapsibleSection defaultOpen={false} title={`Vaistai (${(productsRes.data ?? []).length})`}>
              <div className="divide-y divide-border rounded-control border border-border">
                {(productsRes.data ?? []).map((p) => {
                  const m = mappingFor("product", p.id);
                  return <MappingRow key={p.id} kind="product" localId={p.id} localName={p.name} code={m?.delpro_code ?? null} name={m?.delpro_name ?? null} />;
                })}
              </div>
            </CollapsibleSection>
            <CollapsibleSection title={`DelPro grupės (${(groupsRes.data ?? []).length})`}>
              <div className="flex flex-wrap gap-1.5">
                {(groupsRes.data ?? []).length === 0 && <span className="text-[12px] text-text-muted">Grupės atsiras po pirmos sinchronizacijos.</span>}
                {(groupsRes.data ?? []).map((g) => (
                  <Badge key={g.id} tone={g.active ? "accent" : "neutral"}>
                    {g.name}
                    {g.delpro_group_id ? ` · #${g.delpro_group_id}` : ""}
                  </Badge>
                ))}
              </div>
            </CollapsibleSection>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

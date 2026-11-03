import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { CmsNewSeparation, type CmsDraft, type CmsDraftSummary } from "@/components/cms/new-separation";
import { CmsHistory } from "@/components/cms/separation-history";
import { CmsActiveSeparations, type CmsActiveRow } from "@/components/cms/active-separations";
import { CmsActivationPanel } from "@/components/cms/activation-panel";
import { CMS_OPEN_STATUSES } from "@/lib/cms/status";
import { emptySettings, toVilniusLocal, type CmsDraftRow, type CmsSettings } from "@/lib/cms/separation";
import { cn } from "@/lib/utils";
import type { CmsAnimalLiveCheckRow, CmsLiveActionSettingRow, CmsMode, CmsSeparationJobView } from "@/lib/supabase/types";

// CMS atskyrimai (0048, farm's request — billed separately, not in Priedas Nr. 1).
const TABS = [
  { id: "naujas", label: "Naujas atskyrimas" },
  { id: "istorija", label: "Laukia perdavimo / istorija" },
  { id: "aktyvus", label: "Aktyvūs atskyrimai" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const asSettings = (v: unknown, fallback: Partial<CmsSettings> = {}): CmsSettings => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const base = { ...emptySettings(), ...fallback };
  return {
    mode: (["period", "ongoing", "once"].includes(String(o.mode)) ? o.mode : base.mode) as CmsMode,
    start_local: typeof o.start_local === "string" ? o.start_local : base.start_local,
    end_local: typeof o.end_local === "string" ? o.end_local : base.end_local,
    sessions: Array.isArray(o.sessions) ? o.sessions.map(Number).filter((n) => Number.isInteger(n)) : base.sessions,
    sort_area_key: typeof o.sort_area_key === "string" ? o.sort_area_key : base.sort_area_key,
    note: typeof o.note === "string" ? o.note : base.note,
  };
};

export default async function CmsAtskyrimaiPage({ searchParams }: { searchParams: Promise<{ tab?: string; batch?: string }> }) {
  const sp = await searchParams;
  const tab: TabId = TABS.some((t) => t.id === sp.tab) ? (sp.tab as TabId) : "naujas";
  const session = await getCurrentProfile();
  const role = session?.profile.role;
  const isAdmin = role === "admin";
  const canWrite = role === "admin" || role === "vet" || role === "tech";
  const supabase = await createClient();

  const [areasRes, statusRes] = await Promise.all([supabase.from("cms_sort_areas").select("*").order("area_number"), supabase.rpc("cms_status", {})]);
  const sortAreas = areasRes.data ?? [];
  const status = statusRes.data;
  const migrationMissing = !!areasRes.error;

  let body: React.ReactNode = null;

  if (migrationMissing) {
    body = <p className="text-[13px] text-danger">CMS atskyrimų lentelių nėra — pritaikykite 0048 migraciją.</p>;
  } else if (tab === "naujas") {
    const [groupsRes, draftsRes] = await Promise.all([
      supabase.from("delpro_groups").select("name").eq("active", true).order("name"),
      supabase.from("cms_separation_batches").select("id, note, created_at, created_by").eq("status", "draft").order("created_at", { ascending: false }).limit(20),
    ]);
    const draftIds = (draftsRes.data ?? []).map((d) => d.id);
    const countsRes = draftIds.length ? await supabase.from("cms_separation_jobs").select("batch_id").in("batch_id", draftIds) : { data: [] as { batch_id: string }[] };
    const drafts: CmsDraftSummary[] = (draftsRes.data ?? []).map((d) => ({
      id: d.id,
      note: d.note,
      created_at: d.created_at,
      items: (countsRes.data ?? []).filter((c) => c.batch_id === d.id).length,
      mine: d.created_by === session?.profile.id,
    }));

    let draft: CmsDraft | null = null;
    const batch = sp.batch ? (draftsRes.data ?? []).find((d) => d.id === sp.batch) : null;
    if (batch) {
      const [batchRes, jobsRes] = await Promise.all([
        supabase.from("cms_separation_batches").select("*").eq("id", batch.id).single(),
        supabase.from("vw_cms_separation_jobs").select("*").eq("batch_id", batch.id).order("tag_no"),
      ]);
      const jobs = (jobsRes.data ?? []) as CmsSeparationJobView[];
      const animalIds = jobs.map((j) => j.animal_id);
      const live = new Map<string, string>();
      const open = new Map<string, string>();
      const now = new Date().toISOString();
      for (let i = 0; i < animalIds.length; i += 200) {
        const chunk = animalIds.slice(i, i + 200);
        const [l, o] = await Promise.all([
          supabase.from("cms_live_action_settings").select("action_key, animal_id, end_at").in("animal_id", chunk).eq("action_type", "SortCow").eq("active", true).is("removed_at", null),
          supabase.from("cms_separation_jobs").select("animal_id, status, batch_id").in("animal_id", chunk).in("status", CMS_OPEN_STATUSES),
        ]);
        for (const x of l.data ?? []) if (x.animal_id && (!x.end_at || x.end_at > now)) live.set(x.animal_id, x.action_key);
        for (const x of o.data ?? []) if (x.batch_id !== batch.id) open.set(x.animal_id, x.status);
      }
      draft = {
        batch_id: batch.id,
        note: batch.note ?? "",
        common: asSettings(batchRes.data?.common_settings),
        rows: jobs.map(
          (j): CmsDraftRow => ({
            animal_id: j.animal_id,
            tag_no: j.tag_no,
            animal_no: j.animal_no,
            animal_name: j.animal_name,
            group_name: j.group_name,
            delpro_object_guid: j.delpro_object_guid,
            live_action_key: live.get(j.animal_id) ?? null,
            open_job_status: open.get(j.animal_id) ?? null,
            settings: asSettings(j.requested_settings, {
              mode: j.mode,
              start_local: toVilniusLocal(j.start_at),
              end_local: toVilniusLocal(j.end_at),
              sessions: j.sessions ?? [],
              sort_area_key: j.sort_area_key ?? "",
              note: j.note ?? "",
            }),
            source: j.is_override ? "override" : "common",
            existing_decision: j.existing_decision,
          }),
        ),
      };
    }
    body = (
      <CmsNewSeparation
        key={draft?.batch_id ?? "new"}
        sortAreas={sortAreas}
        groups={(groupsRes.data ?? []).map((g) => g.name)}
        draft={draft}
        drafts={drafts}
        canWrite={canWrite}
      />
    );
  } else if (tab === "istorija") {
    const jobsRes = await supabase.from("vw_cms_separation_jobs").select("*").neq("status", "draft").order("created_at", { ascending: false }).limit(1000);
    body = (
      <CmsHistory
        jobs={(jobsRes.data ?? []) as CmsSeparationJobView[]}
        isAdmin={isAdmin}
        canWrite={canWrite}
        focusBatch={sp.batch ?? null}
        gate={{
          verifiedModes: status?.verified_modes ?? [],
          singleJobId: status?.single_job_id ?? null,
          workerMode: status?.worker_cms_mode ?? null,
          workerSeenAt: status?.worker_seen_at ?? null,
        }}
      />
    );
  } else {
    // 0051: GVET's own animals only — SortCow rows the worker read per animal (or the optional full scan) tied to a GVET animal,
    // plus GVET-written records not read back yet. Every row carries when its animal was last read from DelPro.
    const live: CmsLiveActionSettingRow[] = [];
    for (let from = 0; from < 10000; from += 1000) {
      const { data } = await supabase
        .from("cms_live_action_settings")
        .select("*")
        .eq("action_type", "SortCow")
        .is("removed_at", null)
        .not("animal_id", "is", null)
        .order("start_at", { ascending: false })
        .order("action_key")
        .range(from, from + 999);
      live.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    const liveKeys = new Set(live.map((l) => l.action_key));
    const written = await supabase
      .from("cms_separation_jobs")
      .select("id, animal_id, action_key, start_at, end_at, sessions, milk_setting_key, verified_at")
      .eq("status", "success")
      .not("action_key", "is", null)
      .order("verified_at", { ascending: false })
      .limit(500);
    const unread = (written.data ?? []).filter((j) => j.action_key && !liveKeys.has(j.action_key));
    const animalIds = [...new Set([...live.map((l) => l.animal_id), ...unread.map((j) => j.animal_id)].filter((x): x is string => !!x))];
    const keys = live.map((l) => l.action_key);
    const animals = new Map<string, { tag_no: string; animal_no: string | null }>();
    const checks = new Map<string, CmsAnimalLiveCheckRow>();
    const gvet = new Map<string, string>();
    for (let i = 0; i < Math.max(animalIds.length, keys.length); i += 200) {
      const ids = animalIds.slice(i, i + 200);
      const [a, c, g] = await Promise.all([
        ids.length ? supabase.from("animals").select("id, tag_no, animal_no").in("id", ids) : null,
        ids.length ? supabase.from("cms_animal_live_checks").select("*").in("animal_id", ids) : null,
        keys.length > i ? supabase.from("cms_separation_jobs").select("id, action_key").in("action_key", keys.slice(i, i + 200)).eq("status", "success") : null,
      ]);
      for (const x of a?.data ?? []) animals.set(x.id, { tag_no: x.tag_no, animal_no: x.animal_no });
      for (const x of c?.data ?? []) checks.set(x.animal_id, x);
      for (const x of g?.data ?? []) if (x.action_key) gvet.set(x.action_key, x.id);
    }
    const check = (id: string | null) => {
      const c = id ? checks.get(id) : undefined;
      return { checked_at: c?.checked_at ?? null, check_ok: c?.ok ?? null, check_error: c?.error ?? null, requested_at: c?.requested_at ?? null };
    };
    const rows: CmsActiveRow[] = [
      ...live.map((l) => ({
        animal_id: l.animal_id,
        action_key: l.action_key,
        milk_setting_key: l.milk_setting_key,
        active: l.active,
        start_at: l.start_at,
        end_at: l.end_at,
        sessions: l.sessions ?? [],
        last_updated_at: l.last_updated_at,
        seen_at: l.seen_at,
        tag_no: l.animal_id ? (animals.get(l.animal_id)?.tag_no ?? null) : null,
        animal_no: l.animal_id ? (animals.get(l.animal_id)?.animal_no ?? null) : null,
        gvet_job_id: gvet.get(l.action_key) ?? null,
        unread: false,
        ...check(l.animal_id),
      })),
      ...unread.map((j) => ({
        animal_id: j.animal_id,
        action_key: j.action_key!,
        milk_setting_key: j.milk_setting_key,
        active: true,
        start_at: j.start_at,
        end_at: j.end_at,
        sessions: j.sessions ?? [],
        last_updated_at: null,
        seen_at: j.verified_at ?? "",
        tag_no: animals.get(j.animal_id)?.tag_no ?? null,
        animal_no: animals.get(j.animal_id)?.animal_no ?? null,
        gvet_job_id: j.id,
        unread: true,
        ...check(j.animal_id),
      })),
    ];
    body = (
      <CmsActiveSeparations
        rows={rows}
        sortAreas={sortAreas}
        targeted={status?.targeted_last_refresh ?? null}
        fullScan={status?.live_last_refresh ?? null}
        requestedAt={status?.live_requested_at ?? null}
        pendingAnimals={status?.pending_animal_requests ?? 0}
        canRequest={canWrite}
      />
    );
  }

  return (
    <div className="flex flex-col">
      <PageHeader title="CMS atskyrimai" />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-border" aria-label="Skiltys">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={`/veterinarija/cms-atskyrimai?tab=${t.id}`}
              className={cn(
                "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[14px] font-medium transition-colors",
                tab === t.id ? "border-accent text-text-primary" : "border-transparent text-text-secondary hover:text-text-primary",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        {!migrationMissing && <CmsActivationPanel status={status ?? null} isAdmin={isAdmin} canWrite={canWrite} compact={tab !== "istorija"} />}
        {body}
      </div>
    </div>
  );
}

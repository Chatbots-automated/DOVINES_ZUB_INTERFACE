// What a DelPro SortCow record means right now — the UI mirror of actionStatus() in delpro-worker/src/cms-separation.js
// (keep both in sync). Pure (no imports): supabase/tests/cms-separation.test.mjs tests it.

export type CmsActionStatus = "effective" | "scheduled" | "no_sessions" | "ended" | "inactive" | "unknown";

export const CMS_ACTION_STATUS_LABEL: Record<CmsActionStatus, string> = {
  effective: "Galioja",
  scheduled: "Prasidės vėliau",
  no_sessions: "Aktyvus, be sesijų",
  ended: "Baigėsi",
  inactive: "Išjungtas",
  unknown: "Nežinoma",
};

export function cmsActionStatus(a: { active: boolean | null; start_at: string | null; end_at: string | null; sessions: number[] | null }, now = Date.now()): CmsActionStatus {
  if (a.active === null || a.active === undefined) return "unknown";
  const start = a.start_at ? Date.parse(a.start_at) : null;
  const end = a.end_at ? Date.parse(a.end_at) : null;
  if ((start !== null && Number.isNaN(start)) || (end !== null && Number.isNaN(end))) return "unknown";
  if (!a.active) return "inactive";
  if (end !== null && end <= now) return "ended";
  if ((a.sessions ?? []).length === 0) return "no_sessions";
  if (start !== null && start > now) return "scheduled";
  return "effective";
}

/** How old a per-animal DelPro read is before the page calls it stale (the worker re-reads its CMS animals hourly). */
export const CMS_STALE_AFTER_MIN = 120;

export type CmsFreshness = "fresh" | "stale" | "failed" | "never" | "pending";

export function cmsFreshness(
  c: { checked_at: string | null; ok: boolean | null; requested_at: string | null } | null | undefined,
  now = Date.now(),
): CmsFreshness {
  if (c?.requested_at && (!c.checked_at || Date.parse(c.requested_at) > Date.parse(c.checked_at))) return "pending";
  if (!c?.checked_at) return "never";
  if (c.ok === false) return "failed";
  return now - Date.parse(c.checked_at) > CMS_STALE_AFTER_MIN * 60_000 ? "stale" : "fresh";
}

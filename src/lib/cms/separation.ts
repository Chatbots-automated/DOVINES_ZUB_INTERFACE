// CMS atskyrimai (0048) — the draft editor's pure logic: common settings, per-animal overrides, copying,
// client-side validation (a mirror of fn_cms_job_problems; the database decides) and the schedule text.
// No imports on purpose: supabase/tests/cms-separation.test.mjs transpiles and tests this file directly.

export type CmsMode = "period" | "ongoing" | "once";

export type CmsSettings = {
  mode: CmsMode;
  /** Europe/Vilnius wall clock, "YYYY-MM-DDTHH:MM" (datetime-local); converted to UTC by the database. */
  start_local: string;
  end_local: string;
  sessions: number[];
  sort_area_key: string;
  note: string;
};

export type CmsDraftRow = {
  animal_id: string;
  tag_no: string;
  animal_no: string | null;
  animal_name: string | null;
  group_name: string | null;
  delpro_object_guid: string | null;
  /** DelPro's own active SortCow (last live read), if any. */
  live_action_key: string | null;
  /** an unfinished GVET instruction for this animal elsewhere */
  open_job_status: string | null;
  settings: CmsSettings;
  /** "common" = last set from Bendri nustatymai; "override" = edited / copied for this animal */
  source: "common" | "override";
  existing_decision: "skip" | "modify" | null;
};

export const SESSION_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export const CMS_MODE_LABEL: Record<CmsMode, string> = {
  period: "Nurodytam laikotarpiui",
  ongoing: "Neterminuotas",
  once: "Vienkartinis (Sort Once)",
};

/** Modes the Gateway action can express at all (dates + sessions). "once" is never sendable. */
export const CMS_SENDABLE_MODES: CmsMode[] = ["period", "ongoing"];

/** Nothing pre-selected: no default dates, no default sessions. */
export function emptySettings(): CmsSettings {
  return { mode: "period", start_local: "", end_local: "", sessions: [], sort_area_key: "", note: "" };
}

const cloneSettings = (s: CmsSettings): CmsSettings => ({ ...s, sessions: [...s.sessions].sort((a, b) => a - b) });

export function sameSettings(a: CmsSettings, b: CmsSettings): boolean {
  const sa = [...a.sessions].sort((x, y) => x - y).join(",");
  const sb = [...b.sessions].sort((x, y) => x - y).join(",");
  return a.mode === b.mode && a.start_local === b.start_local && a.end_local === b.end_local && sa === sb &&
    a.sort_area_key === b.sort_area_key && a.note === b.note;
}

/** How many of the target rows carry individual settings that applying the template would replace. */
export function overridesAffected(rows: CmsDraftRow[], ids: Iterable<string>, template: CmsSettings): number {
  const set = new Set(ids);
  return rows.filter((r) => set.has(r.animal_id) && r.source === "override" && !sameSettings(r.settings, template)).length;
}

/** Bendri nustatymai -> the given rows (all or the marked ones). The caller confirms overridesAffected() first. */
export function applyTemplate(rows: CmsDraftRow[], ids: Iterable<string>, template: CmsSettings): CmsDraftRow[] {
  const set = new Set(ids);
  return rows.map((r) => (set.has(r.animal_id) ? { ...r, settings: cloneSettings(template), source: "common" } : r));
}

/** Copy one animal's settings to others; the targets become individual settings. */
export function copySettings(rows: CmsDraftRow[], sourceId: string, targetIds: Iterable<string>): CmsDraftRow[] {
  const src = rows.find((r) => r.animal_id === sourceId);
  if (!src) return rows;
  const set = new Set(targetIds);
  set.delete(sourceId);
  return rows.map((r) => (set.has(r.animal_id) ? { ...r, settings: cloneSettings(src.settings), source: "override" } : r));
}

/** An edit on one animal's row makes it individual. */
export function updateRow(rows: CmsDraftRow[], id: string, patch: Partial<CmsSettings>): CmsDraftRow[] {
  return rows.map((r) => (r.animal_id === id ? { ...r, settings: cloneSettings({ ...r.settings, ...patch }), source: "override" } : r));
}

export function toggleSession(sessions: number[], n: number): number[] {
  return sessions.includes(n) ? sessions.filter((x) => x !== n) : [...sessions, n].sort((a, b) => a - b);
}

/** "YYYY-MM-DDTHH:MM" + whole days, same wall-clock time (no time-zone arithmetic needed). */
export function addDaysLocal(local: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m || !Number.isInteger(days)) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days, +m[4], +m[5]));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Client mirror of the database checks — for instant feedback only. */
export function settingsProblems(s: CmsSettings, nowLocal?: string): string[] {
  const p: string[] = [];
  if (s.mode === "once") p.push("Vienkartinis atskyrimas per DelPro Gateway nepatikrintas — siųsti negalima.");
  if (!s.start_local) p.push("Nenurodyta pradžia.");
  else if (!LOCAL.test(s.start_local)) p.push("Netinkama pradžia.");
  if (s.mode === "period") {
    if (!s.end_local) p.push("Nenurodyta pabaiga.");
    else if (!LOCAL.test(s.end_local)) p.push("Netinkama pabaiga.");
    else if (s.start_local && s.end_local <= s.start_local) p.push("Pabaiga turi būti vėliau nei pradžia.");
  }
  if (s.mode === "ongoing" && s.end_local) p.push("Neterminuotas atskyrimas neturi pabaigos.");
  if (nowLocal && s.end_local && LOCAL.test(s.end_local) && s.end_local <= nowLocal) p.push("Pabaiga jau praėjo.");
  if (s.sessions.length === 0) p.push("Nepasirinkta nė viena melžimo sesija.");
  if (s.sessions.some((n) => !Number.isInteger(n) || n < 1 || n > 10) || new Set(s.sessions).size !== s.sessions.length) {
    p.push("Melžimo sesijos turi būti 1–10.");
  }
  if (s.sort_area_key) p.push("Konkrečios rūšiavimo vietos parinkimas per Gateway nepatikrintas — tokio nustatymo siųsti negalima.");
  return p;
}

export function rowProblems(r: CmsDraftRow, nowLocal?: string): string[] {
  const p: string[] = [];
  if (!r.delpro_object_guid) p.push("Gyvulys nesusietas su DelPro (nėra ObjectGuid).");
  if (r.open_job_status) p.push("Šiam gyvuliui jau yra neužbaigtas GVET atskyrimas.");
  if (r.live_action_key && !r.existing_decision) p.push("DelPro jau turi aktyvų atskyrimą — pasirinkite: praleisti arba prašyti pakeitimo.");
  if (r.live_action_key && r.existing_decision === "skip") return p; // excluded on purpose
  return [...p, ...settingsProblems(r.settings, nowLocal)];
}

const fmtLocal = (l: string) => (LOCAL.test(l) ? l.replace("T", " ") : "—");

/** The exact effective schedule in words (Europe/Vilnius). */
export function describeSchedule(s: CmsSettings): string {
  const sessions = s.sessions.length ? `sesijos ${[...s.sessions].sort((a, b) => a - b).join(", ")}` : "sesijos nepasirinktos";
  if (s.mode === "once") return `Vienkartinis — nesiunčiamas; ${sessions}`;
  if (s.mode === "ongoing") return `Nuo ${fmtLocal(s.start_local)} be pabaigos; ${sessions}`;
  return `${fmtLocal(s.start_local)} → ${fmtLocal(s.end_local)}; ${sessions}`;
}

/** Rows -> cms_save_batch items. */
export function toItems(rows: CmsDraftRow[]) {
  return rows.map((r) => ({
    animal_id: r.animal_id,
    mode: r.settings.mode,
    start_local: r.settings.start_local,
    end_local: r.settings.mode === "ongoing" ? "" : r.settings.end_local,
    sessions: r.settings.sessions,
    sort_area_key: r.settings.sort_area_key,
    note: r.settings.note,
    existing_decision: r.existing_decision,
    is_override: r.source === "override",
  }));
}

/** Current Europe/Vilnius wall clock as "YYYY-MM-DDTHH:MM". */
export function vilniusNowLocal(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Vilnius", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** A stored timestamptz shown in Europe/Vilnius (the server runs in UTC). */
export function formatVilnius(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("lt-LT", { timeZone: "Europe/Vilnius", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

/** A stored timestamptz back to the datetime-local value (Europe/Vilnius) — for reopening a draft. */
export function toVilniusLocal(value: string | null | undefined): string {
  return value ? vilniusNowLocal(new Date(value)) : "";
}

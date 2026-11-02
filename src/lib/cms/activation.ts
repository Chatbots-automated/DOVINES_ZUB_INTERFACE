// CMS atskyrimai (0049) — the activation checklist. Pure (no imports): supabase/tests/cms-separation.test.mjs tests it.
// "Fully active" is shown only when every check passes; each check is evidence from the farm PC's heartbeat or GVET settings.

export type ActivationStatus = {
  verified_modes: string[];
  live_last_refresh: { finished_at?: string; complete?: boolean } | null;
  worker_cms_mode: string | null;
  worker_seen_at: string | null;
  outbound_enabled: boolean;
  destination_verified: { by_name?: string | null; at?: string; note?: string } | null;
  worker: { has_cms?: boolean; started_by?: string | null; gateway_ok_at?: string | null; gateway_error?: string | null; version?: string | null } | null;
};

export type ActivationCheck = { id: string; label: string; ok: boolean; detail: string };

const MIN = 60_000;
// Postgres text timestamps ("2026-11-02 21:45:12.48+00") -> ISO that Date parses
const parse = (v: string) => Date.parse(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
const ageMin = (iso: string | null | undefined, now: number) => {
  const t = iso ? parse(iso) : NaN;
  return Number.isFinite(t) ? (now - t) / MIN : Infinity;
};

export function activationChecks(s: ActivationStatus | null, now = Date.now()): ActivationCheck[] {
  const w = s?.worker ?? null;
  const seen = ageMin(s?.worker_seen_at, now);
  const gw = ageMin(w?.gateway_ok_at, now);
  const live = s?.live_last_refresh ?? null;
  const liveAge = ageMin(live?.finished_at, now);
  return [
    { id: "installed", label: "CMS darbininkas įdiegtas", ok: !!w?.has_cms, detail: w?.has_cms ? `versija ${w.version ?? "?"}` : "ūkio kompiuteryje veikia senesnė versija be CMS" },
    { id: "gvet", label: "GVET API ryšys", ok: seen < 5, detail: Number.isFinite(seen) ? `paskutinis signalas prieš ${Math.round(seen)} min.` : "signalo nėra" },
    { id: "gateway", label: "DelPro Gateway ryšys", ok: gw < 30, detail: w?.gateway_error ? `klaida: ${w.gateway_error}` : Number.isFinite(gw) ? `patikrinta prieš ${Math.round(gw)} min.` : "nepatikrinta" },
    {
      id: "live",
      label: "CMS būsena nuskaityta pilnai",
      ok: !!live?.complete && liveAge < 26 * 60,
      detail: !live ? "dar nenuskaityta" : live.complete ? (liveAge < 26 * 60 ? "pilnas nuskaitymas" : "senesnis nei para") : "paskutinis nuskaitymas nepilnas",
    },
    {
      id: "auto",
      label: "Automatinis darbininkas veikia",
      ok: w?.started_by === "task" && seen < 5,
      detail: w?.started_by === "task" ? "paleistas Windows užduoties" : w?.started_by === "manual" ? "paleistas ranka (ne automatiškai)" : "nežinoma",
    },
    { id: "local", label: "CMS siuntimas įjungtas ūkio kompiuteryje", ok: s?.worker_cms_mode === "gateway", detail: `CMS_OUTBOUND_MODE=${s?.worker_cms_mode ?? "?"}` },
    { id: "gvet_switch", label: "CMS siuntimas įjungtas GVET", ok: !!s?.outbound_enabled, detail: s?.outbound_enabled ? "įjungta" : "sustabdyta" },
    { id: "mode", label: "Režimas patvirtintas GVET", ok: (s?.verified_modes ?? []).length > 0, detail: (s?.verified_modes ?? []).join(", ") || "nė vienas" },
    {
      id: "destination",
      label: "Fizinė atskyrimo vieta patikrinta",
      ok: !!s?.destination_verified,
      detail: s?.destination_verified ? `${s.destination_verified.note ?? ""}${s.destination_verified.by_name ? ` (${s.destination_verified.by_name})` : ""}` : "ūkio operatorius dar nepatvirtino",
    },
  ];
}

export function fullyActive(checks: ActivationCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.ok);
}

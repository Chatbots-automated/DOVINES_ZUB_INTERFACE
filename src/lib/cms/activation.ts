// CMS atskyrimai — the activation checklist (0049, simplified in 0051). Pure (no imports): supabase/tests/cms-separation.test.mjs tests it.
// Farm-wide operational readiness only. The historical full DelPro scan is NOT a condition (0051): the worker checks each animal
// (identity, its one milk setting, its existing SortCow records) right before writing — that per-job check is shown as a note,
// never as a global green tick. "Fully active" = every check below passes.

export type ActivationStatus = {
  verified_modes: string[];
  worker_cms_mode: string | null;
  worker_seen_at: string | null;
  outbound_enabled: boolean;
  destination_verified: { by_name?: string | null; at?: string; note?: string } | null;
  worker: { has_cms?: boolean; started_by?: string | null; gateway_ok_at?: string | null; gateway_error?: string | null; version?: string | null } | null;
};

export type ActivationCheck = { id: string; label: string; ok: boolean; detail: string };

export const PER_JOB_CHECK_NOTE =
  "Prieš kiekvieną įrašymą darbininkas iš naujo patikrina tą karvę DelPro: tapatybę (ObjectGuid + ORN / Nr.), vienintelį melžimo nustatymą ir esamus SortCow — esant abejonei karvei nieko nesiunčia.";

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
  const running = !!w?.has_cms && w?.started_by === "task" && seen < 5;
  return [
    {
      id: "worker",
      label: "Darbininkas veikia (automatiškai)",
      ok: running,
      detail: !w?.has_cms
        ? "ūkio kompiuteryje veikia senesnė versija be CMS"
        : w.started_by !== "task"
          ? w.started_by === "manual" ? "paleistas ranka (ne Windows užduoties)" : "nežinoma, kaip paleistas"
          : seen < 5 ? `versija ${w.version ?? "?"}, paskutinis signalas prieš ${Math.round(seen)} min.` : "signalo nėra ilgiau nei 5 min.",
    },
    { id: "gateway", label: "DelPro Gateway pasiekiamas", ok: gw < 30, detail: w?.gateway_error && !(gw < 30) ? `klaida: ${w.gateway_error}` : Number.isFinite(gw) ? `atsakė prieš ${Math.round(gw)} min.` : "nepatikrinta" },
    { id: "gvet", label: "GVET API pasiekiamas", ok: seen < 5, detail: Number.isFinite(seen) ? `paskutinis signalas prieš ${Math.round(seen)} min.` : "signalo nėra" },
    { id: "local", label: "CMS_OUTBOUND_MODE=gateway", ok: s?.worker_cms_mode === "gateway", detail: `ūkio kompiuteryje: ${s?.worker_cms_mode ?? "?"}` },
    { id: "gvet_switch", label: "CMS siuntimas įjungtas GVET", ok: !!s?.outbound_enabled, detail: s?.outbound_enabled ? "įjungta" : "sustabdyta" },
    { id: "mode", label: "Režimas patvirtintas", ok: (s?.verified_modes ?? []).length > 0, detail: (s?.verified_modes ?? []).join(", ") || "nė vienas" },
    {
      id: "destination",
      label: "Fizinė vieta ir elgsena patikrinta",
      ok: !!s?.destination_verified,
      detail: s?.destination_verified ? `${s.destination_verified.note ?? ""}${s.destination_verified.by_name ? ` (${s.destination_verified.by_name})` : ""}` : "ūkio operatorius dar nepatvirtino",
    },
  ];
}

export function fullyActive(checks: ActivationCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.ok);
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Wand2 } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { formatDate } from "@/lib/utils";
import type { DelproQuickFix, DelproQuickFixes, DelproQuickFixResult, DelproQuickProblem } from "@/lib/supabase/types";

// DelPro → "Greitas taisymas" (0067): what is wrong, what GVET will do about it, one button that
// does it and sends the record again. The database decides what is wrong (delpro_quick_fixes) and
// applies everything in one transaction (delpro_apply_quick_fix) — this file only asks for the
// values a person has to choose (which DelPro record, how many ml in 1 vnt, …).

/** What the person picked for one problem. `mode` switches between alternative fixes. */
type Choice = { on: boolean; mode: string; key: string; freq: string; days: string; factor: string; tag: string };

const REFRESH_TEXT: Record<string, string> = {
  medicine_params_missing: "GVET dar neturi šio vaisto DelPro nustatymų (vieneto ir karencijos).",
  withdrawal_changed_in_delpro: "Vaisto karencija DelPro buvo pakeista po paskutinio duomenų atnaujinimo.",
  drug_not_in_delpro: "DelPro neberanda vaisto, su kuriuo GVET jį susiejo (gal ištrintas ar pakeistas).",
  diagnosis_not_in_delpro: "DelPro neberanda diagnozės, su kuria GVET susiejo ligą.",
  animal_not_in_delpro: "DelPro neberanda šio gyvulio (gal jis išbrauktas ar perkeltas).",
  animal_number_mismatch: "DelPro gyvulio numeris nesutampa su GVET.",
  no_treatment_protocol: "DelPro diagnozė neturi priskirto gydymo protokolo (DelPro: diagnozė → „Rekomenduojamas gydymas“).",
};

function initialChoice(p: DelproQuickProblem): Choice {
  const f = p.fix;
  const c: Choice = { on: f.kind !== "manual", mode: f.kind, key: "", freq: "", days: "", factor: "", tag: "" };
  if (f.kind === "link_drug" || f.kind === "link_diagnosis") {
    const best = f.candidates[0];
    if (best && best.score >= 60) c.key = best.key;
    else if (!best || best.score === 0) c.mode = "refresh_catalog";
  }
  if (f.kind === "set_schedule") {
    c.freq = String(f.frequency_per_day ?? 1);
    c.days = String(f.course_days ?? 1);
  }
  if (f.kind === "dose_factor") c.factor = f.factor != null ? String(f.factor) : "";
  if (f.kind === "fix_tag") c.tag = f.tag_no;
  return c;
}

/** The fix to send for one problem, or a reason it can't be sent yet. */
function payloadFor(p: DelproQuickProblem, c: Choice): { fix?: Record<string, unknown>; missing?: string } {
  const f = p.fix;
  if (!c.on || f.kind === "manual") return {};
  if (c.mode === "refresh_catalog") return { fix: { kind: "refresh_catalog" } };
  if (c.mode === "reject") return { fix: { kind: "reject", reason: "Greitas taisymas: bandomasis / nereikalingas įrašas" } };
  switch (f.kind) {
    case "link_drug":
      return c.key ? { fix: { kind: "link_drug", product_id: f.product_id, delpro_key: c.key } } : { missing: `Pasirinkite DelPro vaistą „${f.product_name}“.` };
    case "link_diagnosis":
      return c.key ? { fix: { kind: "link_diagnosis", disease_id: f.disease_id, delpro_key: c.key } } : { missing: `Pasirinkite DelPro diagnozę ligai „${f.disease_name}“.` };
    case "set_schedule": {
      const freq = Number(c.freq);
      const days = Number(c.days);
      if (!Number.isInteger(freq) || freq < 1 || !Number.isInteger(days) || days < 1) return { missing: `„${f.product_name}“: įveskite kartus per dieną ir dienas (sveiki skaičiai nuo 1).` };
      return { fix: { kind: "set_schedule", product_id: f.product_id, frequency_per_day: freq, course_days: days } };
    }
    case "take_delpro_withdrawal":
      return { fix: { kind: "take_delpro_withdrawal", product_id: f.product_id } };
    case "dose_factor": {
      const n = Number(c.factor.replace(",", "."));
      if (!(n > 0)) return { missing: `„${f.product_name}“: įrašykite, kiek ${f.delpro_uom} yra 1 ${f.gvet_unit}.` };
      return { fix: { kind: "dose_factor", product_id: f.product_id, factor: n } };
    }
    case "fix_tag":
      return { fix: { kind: "fix_tag", tag_no: c.tag } };
    default:
      return { fix: { kind: f.kind } };
  }
}

function Choose({ value, options, onChange }: { value: string; options: { value: string; label: React.ReactNode }[]; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-start gap-2 text-[13px] text-text-primary">
          <input type="radio" className="mt-0.5 size-4" checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

function Will({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-control bg-accent-soft/50 px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
      <span className="font-semibold text-text-primary">Ką padarysime: </span>
      {children}
    </p>
  );
}

function ProblemCard({ p, c, set, status }: { p: DelproQuickProblem; c: Choice; set: (patch: Partial<Choice>) => void; status: string }) {
  const f: DelproQuickFix = p.fix;
  const body = (() => {
    switch (f.kind) {
      case "link_drug":
      case "link_diagnosis": {
        const what = f.kind === "link_drug" ? "vaistą" : "diagnozę";
        const gvetName = f.kind === "link_drug" ? f.product_name : f.disease_name;
        const best = f.candidates[0];
        return (
          <>
            <p className="text-[12.5px] text-text-secondary">
              GVET {f.kind === "link_drug" ? "vaistas" : "liga"} <b>„{gvetName}“</b> dar neturi poros DelPro sąraše, todėl DelPro nežino, ką įrašyti.
              {best && best.score === 100 && " DelPro yra lygiai tokiu pat pavadinimu — jis jau pasirinktas."}
            </p>
            <Choose
              value={c.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: f.kind, label: `Susieti su esamu DelPro ${f.kind === "link_drug" ? "vaistu" : "diagnoze"}` },
                { value: "refresh_catalog", label: `DelPro tokio dar nėra — sukūriau ${what} DelPro, atnaujinkite duomenis` },
              ]}
            />
            {c.mode === f.kind ? (
              <>
                <Combobox
                  options={f.candidates.map((x) => ({ value: x.key, label: x.name, sublabel: x.score === 100 ? "tas pats pavadinimas" : x.score >= 60 ? "panašus pavadinimas" : `DelPro kodas ${x.key}` }))}
                  value={c.key || null}
                  onChange={(key) => set({ key })}
                  placeholder={`Pasirinkite DelPro ${what}...`}
                />
                <Will>
                  susiesime „{gvetName}“ su pasirinktu DelPro įrašu. Tai daroma vieną kartą — visi kiti gydymai su šiuo {f.kind === "link_drug" ? "vaistu" : "liga"} irgi bus
                  siunčiami be klaidos. {f.kind === "link_drug" && "GVET pasiims DelPro karenciją, jei ji skiriasi."}
                </Will>
              </>
            ) : (
              <Will>
                paprašysime ūkio kompiuterio iš naujo nuskaityti DelPro sąrašą. Jei DelPro {what} pavadinote lygiai taip pat kaip GVET („{gvetName}“), jis susies
                pats, o šis įrašas bus išsiųstas iš naujo. Jei pavadinimas kitoks — vėl atsidarykite šį langą ir pasirinkite jį iš sąrašo.
              </Will>
            )}
          </>
        );
      }
      case "set_schedule":
        return (
          <>
            <p className="text-[12.5px] text-text-secondary">
              DelPro kiekvienam vaistui reikia žinoti, kiek kartų per dieną ir kiek dienų jis duodamas. Šis gydymas įvestas prieš atsirandant šiems laukams.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label>Kartai per dieną</Label>
                <Input className="w-28" type="number" min={1} step={1} value={c.freq} onChange={(e) => set({ freq: e.target.value })} />
              </div>
              <div>
                <Label>Kiek dienų</Label>
                <Input className="w-28" type="number" min={1} step={1} value={c.days} onChange={(e) => set({ days: e.target.value })} />
              </div>
            </div>
            <Will>
              įrašysime į gydymą, kad „{f.product_name}“ duotas {c.freq || "?"} k. per dieną {c.days || "?"} d. Atsargos ir karencija nesikeičia.
            </Will>
          </>
        );
      case "take_delpro_withdrawal":
        return (
          <>
            <p className="text-[12.5px] text-text-secondary">
              „{f.product_name}“ karencija skiriasi: GVET pienas {f.gvet_milk ?? "—"} / mėsa {f.gvet_meat ?? "—"} d., DelPro pienas {f.delpro_milk ?? "—"} / mėsa{" "}
              {f.delpro_meat ?? "—"} d.
            </p>
            <Choose
              value={c.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: "take_delpro_withdrawal", label: "Teisinga DelPro reikšmė — perimti ją į GVET (rekomenduojama, DelPro yra pagrindinis)" },
                { value: "refresh_catalog", label: "Teisinga GVET reikšmė — pataisiau DelPro, atnaujinkite duomenis" },
              ]}
            />
            <Will>
              {c.mode === "take_delpro_withdrawal"
                ? `GVET vaistui „${f.product_name}“ nustatysime DelPro karenciją (pienas ${f.delpro_milk ?? "—"}, mėsa ${f.delpro_meat ?? "—"} d.). GVET pats perskaičiuos visų šio vaisto gydymų karencijos datas. Tada įrašas bus išsiųstas.`
                : "paprašysime ūkio kompiuterio nuskaityti DelPro iš naujo. Kai DelPro reikšmė sutaps su GVET, įrašas bus išsiųstas pats."}
            </Will>
          </>
        );
      case "dose_factor": {
        const n = Number(c.factor.replace(",", "."));
        return (
          <>
            <p className="text-[12.5px] text-text-secondary">
              GVET „{f.product_name}“ skaičiuoja <b>{f.gvet_unit}</b>, o DelPro — <b>{f.delpro_uom}</b>. Be perskaičiavimo DelPro gautų neteisingą dozę.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label>
                  Kiek {f.delpro_uom} yra 1 {f.gvet_unit}?
                </Label>
                <Input className="w-32" inputMode="decimal" value={c.factor} onChange={(e) => set({ factor: e.target.value })} placeholder="pvz. 19" />
              </div>
              <span className="pb-2 text-[12px] text-text-muted">Žiūrėkite pakuotę: pvz. 1 švirkštas = 19 ml.</span>
            </div>
            <Choose
              value={c.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: "dose_factor", label: `Perskaičiuoti dozę į ${f.delpro_uom} (rekomenduojama)` },
                { value: "refresh_catalog", label: `Pakeičiau vienetą DelPro į ${f.gvet_unit} — atnaujinkite duomenis` },
              ]}
            />
            <Will>
              {c.mode === "dose_factor"
                ? `į DelPro siųsime dozę ${f.delpro_uom}: ${f.gvet_qty ?? 1} ${f.gvet_unit} → ${n > 0 ? +(Number(f.gvet_qty ?? 1) * n).toFixed(3) : "?"} ${f.delpro_uom}. Taip bus ir visiems kitiems „${f.product_name}“ gydymams. GVET atsargos, sąskaitos ir nurašymo aktai lieka ${f.gvet_unit}.`
                : "paprašysime ūkio kompiuterio nuskaityti DelPro iš naujo. Kai vienetai sutaps, įrašas bus išsiųstas pats."}
            </Will>
          </>
        );
      }
      case "fix_tag":
        return (
          <>
            <p className="text-[12.5px] text-text-secondary">
              DelPro nerado gyvulio <b>{f.tag_no}</b>. GVET gali siųsti tik DelPro žinomam gyvuliui, o susieja jį pagal ausies numerį.
            </p>
            <Choose
              value={c.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: "fix_tag", label: "Tikra karvė — patikrinti / pataisyti ausies numerį" },
                { value: "reject", label: "Bandomasis ar nereikalingas įrašas — atmesti" },
              ]}
            />
            {c.mode === "fix_tag" ? (
              <>
                <div>
                  <Label>Ausies numeris, lygiai kaip DelPro</Label>
                  <Input className="w-56 font-mono" value={c.tag} onChange={(e) => set({ tag: e.target.value })} />
                </div>
                <Will>
                  {c.tag.replace(/\s+/g, "").toUpperCase() !== f.tag_no ? `pakeisime ausies numerį į ${c.tag.replace(/\s+/g, "").toUpperCase()}, ` : ""}
                  paprašysime ūkio kompiuterio nuskaityti DelPro gyvulius. Kai jis ras šią karvę, įrašas bus išsiųstas pats. Jei ir tada neras — karvės DelPro nėra
                  arba numeris kitoks; patikrinkite DelPro.
                </Will>
              </>
            ) : (
              <Will>įrašas nebus siunčiamas į DelPro. Gydymas GVET lieka toks pat.</Will>
            )}
          </>
        );
      case "reject":
        return (
          <>
            <p className="text-[12.5px] text-text-secondary">
              {f.tag_no && !f.tag_valid
                ? `Ausies numeris „${f.tag_no}“ nėra tikras (tikras atrodo taip: LT000012345678) — tai bandomasis gyvulys, DelPro jo neturi.`
                : "Šio įrašo į DelPro nusiųsti negalima — jame nėra ką siųsti."}
            </p>
            <Will>įrašas bus atmestas ir nebus siunčiamas į DelPro. Gydymas GVET lieka toks pat.</Will>
          </>
        );
      case "refresh_catalog":
        if (f.reason === "params_lost") {
          return f.delpro_lost ? (
            <>
              <p className="text-[12.5px] text-text-secondary">
                DelPro vaistas <b>„{f.product_name}“</b> rodo į savo nustatymų įrašą Nr. {f.params_key} (vienetas, karencija), bet DelPro to įrašo nebėra. Taip
                nutinka, kai DelPro vaisto nustatymai buvo pakeisti ar ištrinti. Be jų DelPro neleidžia įrašyti vaisto, o GVET pats DelPro vaisto taisyti negali.
              </p>
              <ol className="list-decimal space-y-0.5 pl-5 text-[12.5px] text-text-secondary">
                <li>DelPro atsidarykite vaistą „{f.product_name}“.</li>
                <li>Patikrinkite vienetą ir karenciją (pienui, mėsai) ir spauskite „Išsaugoti“ — DelPro sukurs naują nustatymų įrašą.</li>
                <li>Grįžkite čia ir spauskite mygtuką apačioje.</li>
              </ol>
              <Will>paprašysime ūkio kompiuterio nuskaityti DelPro vaistus iš naujo. Kai jis baigs (kelios minutės), įrašas bus išsiųstas pats.</Will>
            </>
          ) : (
            <>
              <p className="text-[12.5px] text-text-secondary">
                Ūkio kompiuteris, prieš įrašydamas, patikrino DelPro ir nerado vaisto „{f.product_name}“ nustatymų (įrašas Nr. {f.params_key}). GVET turimi DelPro
                duomenys greičiausiai pasenę — pvz. vaistas DelPro buvo ką tik pakeistas.
              </p>
              <Will>
                paprašysime ūkio kompiuterio iš naujo nuskaityti DelPro vaistus (kelios minutės). Kai baigs, įrašas bus išsiųstas pats. Jei DelPro šių nustatymų
                tikrai nebėra, čia vėl atsiras ši klaida su tiksliu nurodymu, ką paspausti DelPro.
              </Will>
            </>
          );
        }
        return (
          <>
            <p className="text-[12.5px] text-text-secondary">{REFRESH_TEXT[f.reason] ?? "GVET turimi DelPro duomenys pasenę."}</p>
            {f.reason === "no_treatment_protocol" && (
              <p className="text-[12.5px] text-text-secondary">Pirmiausia DelPro ligai „{f.disease_name ?? "—"}“ priskirkite gydymo protokolą.</p>
            )}
            <Will>paprašysime ūkio kompiuterio iš naujo nuskaityti DelPro duomenis (kelios minutės). Kai baigs, įrašas bus išsiųstas iš naujo pats.</Will>
          </>
        );
      case "retry":
        return status === "verification_failed" ? (
          <>
            <p className="text-[12.5px] text-text-secondary">
              Ūkio kompiuteris įrašą įrašė, bet perskaitęs atgal rado skirtumą. Pažiūrėkite šio gyvulio įrašą DelPro — gal ten kas nors pakeitė ranka.
            </p>
            <Will>
              išsiųsime tą patį įrašą dar kartą. Kompiuteris pirmiausia ieško jau įrašyto įrašo pagal GVET žymę, todėl antras įrašas DelPro neatsiras.
            </Will>
          </>
        ) : (
          <>
            <p className="text-[12.5px] text-text-secondary">Klaida įvyko pačio siuntimo metu (ryšys, DelPro buvo užimtas ar išjungtas). GVET duomenys tvarkingi.</p>
            <Will>išsiųsime tą patį įrašą dar kartą. Jei kartosis — patikrinkite, ar ūkio kompiuteris ir DelPro įjungti.</Will>
          </>
        );
      case "resend":
        return <Will>išsiųsime įrašą iš naujo su dabartiniais gydymo ir susiejimų duomenimis.</Will>;
      case "manual":
        return (
          <p className="text-[12.5px] text-text-secondary">
            {f.where === "treatment"
              ? "Gydyme nepasirinkta liga, o DelPro įrašui ji būtina. Atsidarykite gydymą „Gydymų istorijoje“, pasirinkite ligą ir grįžkite čia."
              : f.where === "settings"
                ? "Siuntimas į DelPro išjungtas. Įjunkite jį skirtuke „Nustatymai“."
                : "Šios klaidos GVET pats ištaisyti negali. Žr. „Jei kas nors neveikia“ viršuje dešinėje."}
          </p>
        );
    }
  })();

  return (
    <section className={`space-y-2.5 rounded-panel border p-4 ${c.on ? "border-border" : "border-border opacity-60"}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-semibold text-danger">{p.message}</p>
        {f.kind !== "manual" && (
          <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-text-secondary">
            <input type="checkbox" className="size-4" checked={c.on} onChange={() => set({ on: !c.on })} /> taisyti
          </label>
        )}
      </div>
      {c.on && body}
    </section>
  );
}

type Loaded = { data?: DelproQuickFixes; error?: string };

async function fetchFixes(jobId: string): Promise<Loaded> {
  try {
    const res = await fetch(`/api/delpro/quick-fix?job=${jobId}`, { credentials: "same-origin", cache: "no-store" });
    const json = (await res.json().catch(() => null)) as Loaded | null;
    return json?.data ? json : { error: json?.error ?? `Serverio klaida (HTTP ${res.status}).` };
  } catch {
    return { error: "Nepavyko susisiekti su serveriu." };
  }
}

const DONE_STATUS = new Set(["success"]);
const SENDING_STATUS = new Set(["approved", "processing"]);

function Body({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [data, setData] = React.useState<DelproQuickFixes | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [choices, setChoices] = React.useState<Choice[]>([]);
  const [result, setResult] = React.useState<{ ok: boolean; text: string; outcome?: DelproQuickFixResult["outcome"] } | null>(null);
  const [pending, setPending] = React.useState(false);

  const take = React.useCallback((r: Loaded, resetChoices: boolean) => {
    if (!r.data) {
      setLoadError(r.error ?? "Klaida.");
      return null;
    }
    setLoadError(null);
    setData(r.data);
    if (resetChoices) setChoices(r.data.problems.map(initialChoice));
    return r.data;
  }, []);
  const load = React.useCallback(async (resetChoices: boolean) => take(await fetchFixes(jobId), resetChoices), [jobId, take]);

  React.useEffect(() => {
    let alive = true;
    fetchFixes(jobId).then((r) => {
      if (alive) take(r, true);
    });
    return () => {
      alive = false;
    };
  }, [jobId, take]);

  // after a fix: follow the record until the PC reports (sent / waiting for DelPro data / failed again)
  const following = data && result?.ok && (SENDING_STATUS.has(data.status) || !!data.waiting_catalog_since);
  React.useEffect(() => {
    if (!following) return;
    const t = window.setInterval(async () => {
      const d = await load(false);
      if (d && (DONE_STATUS.has(d.status) || (!SENDING_STATUS.has(d.status) && !d.waiting_catalog_since))) {
        router.refresh();
        if (d.status !== "success") setChoices(d.problems.map(initialChoice));
      }
    }, 5000);
    return () => window.clearInterval(t);
  }, [following, load, router]);

  if (loadError) return <p className="rounded-control bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{loadError}</p>;
  if (!data) return <p className="flex items-center gap-2 text-[13px] text-text-muted"><Loader2 className="size-4 animate-spin" /> Tikrinama...</p>;

  const visible = data.problems.map((p, i) => ({ p, i })).filter(({ p }) => !p.duplicate);
  const built = visible.map(({ p, i }) => payloadFor(p, choices[i] ?? initialChoice(p)));
  const missing = built.map((b) => b.missing).filter(Boolean) as string[];
  let fixes = built.map((b) => b.fix).filter(Boolean) as Record<string, unknown>[];
  const rejecting = fixes.some((f) => f.kind === "reject");
  if (rejecting) fixes = fixes.filter((f) => f.kind === "reject").slice(0, 1);
  else fixes = fixes.filter((f, i, all) => all.findIndex((g) => JSON.stringify(g) === JSON.stringify(f)) === i);

  async function apply() {
    setPending(true);
    setResult(null);
    try {
      const res = await fetch("/api/delpro/quick-fix", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job_id: jobId, fixes }),
      });
      const json = (await res.json().catch(() => null)) as { data?: DelproQuickFixResult; error?: string } | null;
      if (!json?.data) {
        setResult({ ok: false, text: json?.error ?? `Serverio klaida (HTTP ${res.status}).` });
      } else {
        setResult({ ok: json.data.outcome !== "remaining", text: json.data.message, outcome: json.data.outcome });
        router.refresh();
        await load(json.data.outcome === "remaining");
      }
    } catch {
      setResult({ ok: false, text: "Nepavyko susisiekti su serveriu." });
    } finally {
      setPending(false);
    }
  }

  const finished = data.status === "success" || data.status === "rejected";
  const showForm = !finished && !(result?.ok && (SENDING_STATUS.has(data.status) || data.waiting_catalog_since));

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-text-secondary">
        {data.animal !== data.tag_no ? `Nr. ${data.animal} · ` : ""}
        {data.tag_no} · gydyta {formatDate(data.reg_date)}
        {data.disease ? ` · ${data.disease}` : ""}
        {data.attempts > 0 ? ` · bandyta ${data.attempts} k.` : ""}
      </p>

      {data.status === "success" && (
        <p className="flex items-center gap-2 rounded-control bg-success-soft px-3 py-2 text-[13px] font-medium text-success">
          <CheckCircle2 className="size-4" /> Perduota į DelPro ir patikrinta. Viskas.
        </p>
      )}
      {data.status === "rejected" && <p className="rounded-control bg-surface-secondary px-3 py-2 text-[13px] text-text-secondary">Įrašas atmestas — į DelPro nebus siunčiamas.</p>}
      {result && (
        <p className={`rounded-control px-3 py-2 text-[12.5px] ${result.ok ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>{result.text}</p>
      )}
      {!finished && SENDING_STATUS.has(data.status) && (
        <p className="flex items-center gap-2 text-[12.5px] text-text-secondary">
          <Loader2 className="size-4 animate-spin" /> Ūkio kompiuteris {data.status === "processing" ? "dabar įrašo" : "netrukus įrašys"} šį gydymą į DelPro. Langą galite
          uždaryti — rezultatą matysite sąraše.
        </p>
      )}
      {!finished && data.waiting_catalog_since && (
        <p className="flex items-center gap-2 text-[12.5px] text-text-secondary">
          <Loader2 className="size-4 animate-spin" /> Laukiama, kol ūkio kompiuteris atnaujins DelPro duomenis. Tada įrašas bus išsiųstas pats. Langą galite uždaryti.
        </p>
      )}

      {showForm && (
        <>
          {visible.length === 0 && <p className="text-[13px] text-text-secondary">GVET klaidų nemato.</p>}
          {visible.map(({ p, i }) => (
            <ProblemCard
              key={i}
              p={p}
              c={choices[i] ?? initialChoice(p)}
              status={data.status}
              set={(patch) => setChoices((prev) => prev.map((c, k) => (k === i ? { ...c, ...patch } : c)))}
            />
          ))}
          {missing.length > 0 && <p className="text-[12px] text-warning">{missing[0]}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending || data.status === "verification_failed"}
              onClick={() => {
                if (window.confirm("Atmesti šį įrašą? Į DelPro jis nebus siunčiamas. Gydymas GVET lieka.")) {
                  setChoices((prev) => prev.map((c) => ({ ...c, on: false })));
                  void (async () => {
                    setPending(true);
                    const res = await fetch("/api/delpro/quick-fix", {
                      method: "POST",
                      credentials: "same-origin",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ job_id: jobId, fixes: [{ kind: "reject", reason: "Greitas taisymas: atmesta" }] }),
                    });
                    const json = (await res.json().catch(() => null)) as { data?: DelproQuickFixResult; error?: string } | null;
                    setResult(json?.data ? { ok: true, text: json.data.message } : { ok: false, text: json?.error ?? "Klaida." });
                    setPending(false);
                    router.refresh();
                    await load(false);
                  })();
                }
              }}
            >
              Atmesti šį įrašą
            </Button>
            <Button type="button" onClick={apply} disabled={pending || fixes.length === 0 || missing.length > 0}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
              {pending ? "Taisoma..." : rejecting ? "Atmesti" : "Pataisyti ir siųsti iš naujo"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** "Greitas taisymas" button + dialog for one DelPro transfer. */
export function QuickFixButton({ jobId, waiting }: { jobId: string; waiting?: boolean }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={waiting ? "outline" : "primary"}>
          {waiting ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />} {waiting ? "Laukia DelPro duomenų" : "Greitas taisymas"}
        </Button>
      </DialogTrigger>
      <DialogContent size="wide" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Greitas taisymas <Badge tone="info">DelPro</Badge>
          </DialogTitle>
        </DialogHeader>
        <DialogBody>{open && <Body jobId={jobId} />}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}

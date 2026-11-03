"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Search, Split } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { cmsPost } from "@/lib/cms/client";
import { formatVilnius } from "@/lib/cms/separation";
import { CMS_ACTION_STATUS_LABEL, CMS_STALE_AFTER_MIN, cmsActionStatus, cmsFreshness, type CmsActionStatus } from "@/lib/cms/live-status";
import type { CmsLiveRefreshInfo, CmsSortAreaRow, CmsTargetedRefreshInfo } from "@/lib/supabase/types";

export type CmsActiveRow = {
  animal_id: string | null;
  action_key: string;
  milk_setting_key: string | null;
  active: boolean | null;
  start_at: string | null;
  end_at: string | null;
  sessions: number[];
  last_updated_at: string | null;
  seen_at: string;
  tag_no: string | null;
  animal_no: string | null;
  /** set when this DelPro record was written (and verified) by a GVET job */
  gvet_job_id: string | null;
  /** GVET wrote it, but the animal has not been read from DelPro since — values are what GVET sent, not DelPro's */
  unread: boolean;
  // the animal's last targeted DelPro read (0051)
  checked_at: string | null;
  check_ok: boolean | null;
  check_error: string | null;
  requested_at: string | null;
};

const PAGE = 50;
const STATUS_TONE: Record<CmsActionStatus, "warning" | "info" | "neutral" | "danger"> = {
  effective: "warning",
  scheduled: "info",
  no_sessions: "neutral",
  ended: "neutral",
  inactive: "neutral",
  unknown: "danger",
};

function Freshness({ r, now }: { r: CmsActiveRow; now: number }) {
  const f = cmsFreshness({ checked_at: r.checked_at, ok: r.check_ok, requested_at: r.requested_at }, now);
  if (f === "pending") return <Badge tone="info">Laukiama nuskaitymo…</Badge>;
  if (f === "never") return <span className="text-text-muted">{r.unread ? "dar nenuskaityta (rodoma, ką GVET išsiuntė)" : "dar netikrinta šiam gyvuliui"}</span>;
  if (f === "failed") {
    return (
      <span className="text-danger" title={r.check_error ?? undefined}>
        nepavyko {formatVilnius(r.checked_at)} — rodoma ankstesnė būsena
      </span>
    );
  }
  return <span className={f === "stale" ? "text-warning" : "text-text-secondary"}>{formatVilnius(r.checked_at)}{f === "stale" ? " (sena)" : ""}</span>;
}

/** GVET's CMS animals: GVET-written separations + DelPro's own ones on GVET animals, as last read per animal. Never the whole DelPro herd. */
export function CmsActiveSeparations({
  rows,
  sortAreas,
  targeted,
  fullScan,
  requestedAt,
  pendingAnimals,
  canRequest,
}: {
  rows: CmsActiveRow[];
  sortAreas: CmsSortAreaRow[];
  targeted: CmsTargetedRefreshInfo | null;
  fullScan: CmsLiveRefreshInfo | null;
  requestedAt: string | null;
  pendingAnimals: number;
  canRequest: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [now] = React.useState(() => Date.now());
  const [show, setShow] = React.useState<"current" | "all">("current");
  const [q, setQ] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [orn, setOrn] = React.useState("");

  const lastRound = [targeted?.finished_at, fullScan?.finished_at].filter(Boolean).sort().at(-1) ?? null;
  const pending = (!!requestedAt && (!lastRound || Date.parse(requestedAt) > Date.parse(lastRound))) || pendingAnimals > 0;
  const status = (r: CmsActiveRow) => cmsActionStatus(r, now);
  const current = (r: CmsActiveRow) => ["effective", "scheduled", "no_sessions", "unknown"].includes(status(r));
  const needle = q.trim().toUpperCase();
  const filtered = rows.filter((r) => (show === "all" || current(r)) && (!needle || `${r.tag_no ?? ""} ${r.animal_no ?? ""} ${r.action_key}`.toUpperCase().includes(needle)));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(Math.min(page, pages - 1) * PAGE, Math.min(page, pages - 1) * PAGE + PAGE);
  const animalsOf = (list: CmsActiveRow[]) => [...new Set(list.map((r) => r.animal_id).filter((x): x is string => !!x))];

  async function run(key: string, op: string, payload: Record<string, unknown> = {}) {
    setBusy(key);
    const res = await cmsPost<{ message: string }>(op, payload);
    setBusy(null);
    setMessage(res.ok ? { ok: true, text: res.data.message } : { ok: false, text: res.error });
    if (res.ok) {
      setSelected(new Set());
      router.refresh();
    }
  }

  const toggle = (id: string | null) => {
    if (!id) return;
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
        <span className="text-text-secondary">
          Paskutinis nuskaitymas iš DelPro: <b className="text-text-primary">{targeted?.finished_at ? formatVilnius(targeted.finished_at) : "dar niekada"}</b>
          {targeted?.finished_at && (
            <span className="ml-2 text-text-muted">
              · gyvulių {targeted.round?.targets ?? (targeted.ok ?? 0) + (targeted.failed ?? 0)}, nepavyko {targeted.failed ?? 0}
            </span>
          )}
        </span>
        {pending && <Badge tone="info">Laukiama ūkio kompiuterio…</Badge>}
        <Button type="button" size="sm" variant="outline" className="ml-auto" disabled={!canRequest || !!busy} onClick={() => run("all", "request_live")}>
          {busy === "all" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Atnaujinti iš DelPro
        </Button>
        <p className="w-full text-[12px] text-text-muted">
          Skaitomi tik GVET atskyrimų gyvuliai (partijose, laukiantys, GVET įrašyti, turintys galiojantį DelPro atskyrimą) — kiekvienas atskirai, ne visa DelPro
          banda. Automatiškai kas valandą; būsena senesnė nei {CMS_STALE_AFTER_MIN / 60} val. pažymima. Rodoma paskutinė nuskaityta būsena, ne tiesioginė.
        </p>
        <form
          className="flex w-full flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (orn.trim()) void run("orn", "request_animals", { tags: [orn.trim()] }).then(() => setOrn(""));
          }}
        >
          <Input value={orn} onChange={(e) => setOrn(e.target.value)} placeholder="ORN, pvz. LT000007300337" className="h-8 w-56" maxLength={30} aria-label="Gyvulio ORN" />
          <Button type="submit" size="sm" variant="ghost" disabled={!canRequest || !!busy || !orn.trim()}>
            {busy === "orn" ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} Patikrinti gyvulį DelPro
          </Button>
        </form>
        {message && <p className={message.ok ? "w-full text-success" : "w-full text-danger"}>{message.text}</p>}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[13px]">
          {(
            [
              ["current", `Galiojantys ir būsimi (${rows.filter(current).length})`],
              ["all", `Visi (${rows.length})`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setShow(k);
                setPage(0);
              }}
              className={show === k ? "rounded-control bg-ink px-2.5 py-1 text-text-on-ink" : "rounded-control px-2.5 py-1 text-text-secondary hover:bg-surface-secondary"}
            >
              {label}
            </button>
          ))}
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
            placeholder="Ieškoti ORN / Nr. / rakto"
            className="h-8 w-48"
            aria-label="Paieška"
          />
          <span className="ml-auto flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canRequest || !!busy || selected.size === 0}
              onClick={() => run("sel", "request_animals", { animal_ids: [...selected] })}
            >
              {busy === "sel" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Atnaujinti pažymėtus ({selected.size})
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canRequest || !!busy || shown.length === 0}
              onClick={() => run("page", "request_animals", { animal_ids: animalsOf(shown) })}
            >
              {busy === "page" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Atnaujinti šį puslapį
            </Button>
          </span>
        </div>
        {shown.length === 0 ? (
          <EmptyState icon={Split} title="Atskyrimų nerasta" description="Rodoma tai, ką ūkio kompiuteris paskutinį kartą nuskaitė iš DelPro GVET gyvuliams." className="py-10" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-surface-secondary text-left text-[12px] text-text-muted">
                <tr>
                  <th className="w-8 px-4 py-2" aria-label="Pažymėti" />
                  <th className="px-2 py-2 font-medium">ORN</th>
                  <th className="px-2 py-2 font-medium">DelPro Nr.</th>
                  <th className="px-2 py-2 font-medium">Raktas</th>
                  <th className="px-2 py-2 font-medium">Būsena</th>
                  <th className="px-2 py-2 font-medium">Pradžia → pabaiga</th>
                  <th className="px-2 py-2 font-medium">Sesijos</th>
                  <th className="px-2 py-2 font-medium">Keista DelPro</th>
                  <th className="px-2 py-2 font-medium">Nuskaityta</th>
                  <th className="px-2 py-2 font-medium">Šaltinis</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.map((r) => {
                  const st = status(r);
                  return (
                    <tr key={r.action_key}>
                      <td className="px-4 py-1.5">
                        <input type="checkbox" aria-label={`Pažymėti ${r.tag_no ?? r.action_key}`} disabled={!r.animal_id} checked={!!r.animal_id && selected.has(r.animal_id)} onChange={() => toggle(r.animal_id)} />
                      </td>
                      <td className="px-2 py-1.5 font-medium text-text-primary">{r.tag_no ?? <span className="text-text-muted">Nežinoma</span>}</td>
                      <td className="px-2 py-1.5 text-text-secondary">{r.animal_no ?? "—"}</td>
                      <td className="px-2 py-1.5 font-mono text-[12px]">{r.action_key}</td>
                      <td className="px-2 py-1.5">{r.unread ? <Badge tone="neutral">Nenuskaityta</Badge> : <Badge tone={STATUS_TONE[st]}>{CMS_ACTION_STATUS_LABEL[st]}</Badge>}</td>
                      <td className="px-2 py-1.5">
                        {formatVilnius(r.start_at)} → {r.end_at ? formatVilnius(r.end_at) : "be pabaigos"}
                      </td>
                      <td className="px-2 py-1.5">{r.sessions.join(", ") || "—"}</td>
                      <td className="px-2 py-1.5 text-text-secondary">{formatVilnius(r.last_updated_at)}</td>
                      <td className="px-2 py-1.5 text-[12px]">
                        <Freshness r={r} now={now} />
                      </td>
                      <td className="px-2 py-1.5">{r.gvet_job_id ? <Badge tone="accent">GVET</Badge> : <span className="text-text-muted">DelPro</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2 text-[12px] text-text-secondary">
            <Button type="button" size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Ankstesnis
            </Button>
            {Math.min(page, pages - 1) + 1} / {pages}
            <Button type="button" size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
              Kitas
            </Button>
          </div>
        )}
      </Card>

      <Card className="px-4 py-3 text-[12px] text-text-secondary">
        <p className="font-medium text-text-primary">DelPro rūšiavimo vietos</p>
        {sortAreas.length === 0 ? (
          <p>Nenuskaityta.</p>
        ) : (
          <p>{sortAreas.map((a) => `${a.area_name ?? "—"} (Nr. ${a.area_number ?? "?"}, raktas ${a.area_key})`).join(" · ")}</p>
        )}
        <p className="mt-1 text-text-muted">Į kurią vietą DelPro nukreipia SortCow atskyrimą, per Gateway nenustatyta — tai matosi tik DelPro / CMS nustatymuose.</p>
        {fullScan?.finished_at && (
          <p className="mt-1 text-text-muted">
            Pilnas istorinis DelPro nuskaitymas (tik diagnostika, siuntimui nereikalingas): {formatVilnius(fullScan.finished_at)}, {fullScan.complete ? "pilnas" : "nepilnas"}.
          </p>
        )}
      </Card>
    </div>
  );
}

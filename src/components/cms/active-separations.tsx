"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Split } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { cmsPost } from "@/lib/cms/client";
import { formatVilnius } from "@/lib/cms/separation";
import type { CmsLiveRefreshInfo, CmsSortAreaRow } from "@/lib/supabase/types";

export type CmsActiveRow = {
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
};

export type CmsLiveRefresh = CmsLiveRefreshInfo | null;

/** DelPro's own SortCow settings as last read by the farm PC (Animal → AnimalMilkSetting → AnimalActionSetting). */
export function CmsActiveSeparations({
  rows,
  sortAreas,
  refresh,
  requestedAt,
  canRequest,
}: {
  rows: CmsActiveRow[];
  sortAreas: CmsSortAreaRow[];
  refresh: CmsLiveRefresh;
  requestedAt: string | null;
  canRequest: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  const pending = !!requestedAt && (!refresh?.finished_at || requestedAt > refresh.finished_at);
  const [now] = React.useState(() => new Date().toISOString());
  const [show, setShow] = React.useState<"effective" | "matched">("effective");
  const effective = (r: CmsActiveRow) => !!r.active && (!r.end_at || r.end_at > now) && r.sessions.length > 0;
  const shown = rows.filter((r) => show === "matched" || effective(r));
  const reasons = refresh?.unmatched_reasons;

  async function request() {
    setBusy(true);
    const res = await cmsPost<{ message: string }>("request_live");
    setBusy(false);
    setMessage(res.ok ? { ok: true, text: res.data.message } : { ok: false, text: res.error });
    if (res.ok) router.refresh();
  }

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
        <span className="text-text-secondary">
          Nuskaityta iš DelPro: <b className="text-text-primary">{refresh?.finished_at ? formatVilnius(refresh.finished_at) : "dar niekada"}</b>
          {refresh?.complete === false && <Badge tone="warning" className="ml-2">Nepilnas nuskaitymas</Badge>}
          {refresh?.received != null && (
            <span className="ml-2 text-text-muted">
              · SortCow įrašų {refresh.received}, susieta su GVET {refresh.matched ?? "?"}, galioja {refresh.effective_active ?? "?"}
            </span>
          )}
        </span>
        {pending && <Badge tone="info">Laukiama ūkio kompiuterio…</Badge>}
        <Button type="button" size="sm" variant="outline" className="ml-auto" disabled={!canRequest || busy} onClick={request}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Atnaujinti iš DelPro
        </Button>
        {message && <p className={message.ok ? "w-full text-success" : "w-full text-danger"}>{message.text}</p>}
        {(refresh?.errors ?? []).length > 0 && <p className="w-full text-[12px] text-danger">{refresh!.errors!.join(" ")}</p>}
        {reasons && (refresh?.unmatched_animals ?? 0) > 0 && (
          <p className="w-full text-[12px] text-text-muted">
            Be GVET gyvulio {refresh!.unmatched_animals}: gyvulys DelPro sąraše nerastas {reasons.animal_not_in_gvet ?? 0} (dažniausiai išbrokuoti / parduoti), melžimo
            nustatymas be gyvulio {reasons.milk_setting_without_animal ?? 0}, gyvulys GVET neaktyvus {reasons.animal_inactive_in_gvet ?? 0}.
          </p>
        )}
        <div className="flex w-full flex-wrap gap-1">
          {(
            [
              ["effective", `Galiojantys (${rows.filter(effective).length})`],
              ["matched", `Visi GVET gyvulių įrašai (${rows.length})`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setShow(k)}
              className={show === k ? "rounded-control bg-ink px-2.5 py-1 text-text-on-ink" : "rounded-control px-2.5 py-1 text-text-secondary hover:bg-surface-secondary"}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden">
        {shown.length === 0 ? (
          <EmptyState icon={Split} title="Aktyvių atskyrimų nerasta" description="Rodoma tai, ką ūkio kompiuteris paskutinį kartą nuskaitė iš DelPro." className="py-10" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-surface-secondary text-left text-[12px] text-text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">ORN</th>
                  <th className="px-2 py-2 font-medium">DelPro Nr.</th>
                  <th className="px-2 py-2 font-medium">Raktas</th>
                  <th className="px-2 py-2 font-medium">Aktyvus</th>
                  <th className="px-2 py-2 font-medium">Pradžia → pabaiga</th>
                  <th className="px-2 py-2 font-medium">Sesijos</th>
                  <th className="px-2 py-2 font-medium">Atnaujinta DelPro</th>
                  <th className="px-2 py-2 font-medium">Šaltinis</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.map((r) => {
                  const live = r.active && (!r.end_at || r.end_at > now);
                  return (
                    <tr key={r.action_key}>
                      <td className="px-4 py-1.5 font-medium text-text-primary">{r.tag_no ?? <span className="text-text-muted">Nežinoma</span>}</td>
                      <td className="px-2 py-1.5 text-text-secondary">{r.animal_no ?? "—"}</td>
                      <td className="px-2 py-1.5 font-mono text-[12px]">{r.action_key}</td>
                      <td className="px-2 py-1.5">
                        {r.active == null ? "Nežinoma" : live ? <Badge tone="warning">Taip</Badge> : <Badge tone="neutral">{r.active ? "Baigėsi" : "Ne"}</Badge>}
                      </td>
                      <td className="px-2 py-1.5">
                        {formatVilnius(r.start_at)} → {r.end_at ? formatVilnius(r.end_at) : "be pabaigos"}
                      </td>
                      <td className="px-2 py-1.5">{r.sessions.join(", ") || "—"}</td>
                      <td className="px-2 py-1.5 text-text-secondary">{formatVilnius(r.last_updated_at)}</td>
                      <td className="px-2 py-1.5">{r.gvet_job_id ? <Badge tone="accent">GVET</Badge> : <span className="text-text-muted">DelPro (nežinoma)</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
      </Card>
    </div>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronUp, Copy, Eye, Loader2, Save, Search, Send, Trash2, Undo2, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CmsSettingsFields } from "@/components/cms/settings-fields";
import { cn } from "@/lib/utils";
import { cmsPost, cmsSearch, type CmsSearchAnimal } from "@/lib/cms/client";
import {
  CMS_MODE_LABEL,
  applyTemplate,
  copySettings,
  describeSchedule,
  emptySettings,
  overridesAffected,
  rowProblems,
  toItems,
  updateRow,
  vilniusNowLocal,
  formatVilnius,
  type CmsDraftRow,
  type CmsSettings,
} from "@/lib/cms/separation";
import { CMS_STATUS_LABEL } from "@/lib/cms/status";
import type { CmsCheckResult, CmsJobStatus, CmsProblem, CmsSortAreaRow } from "@/lib/supabase/types";

export type CmsDraft = { batch_id: string; note: string; common: CmsSettings; rows: CmsDraftRow[] };
export type CmsDraftSummary = { id: string; note: string | null; created_at: string; items: number; mine: boolean };

type Confirm = { title: string; message: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void> };

function toRow(a: CmsSearchAnimal, common: CmsSettings): CmsDraftRow {
  return {
    animal_id: a.id,
    tag_no: a.tag_no,
    animal_no: a.animal_no,
    animal_name: a.name,
    group_name: a.group_name,
    delpro_object_guid: a.delpro_object_guid,
    live_action_key: a.live_action_key,
    open_job_status: a.open_job_status,
    settings: { ...common, sessions: [...common.sessions] },
    source: "common",
    existing_decision: null,
  };
}

function DelproBadge({ guid }: { guid: string | null }) {
  return guid ? <Badge tone="success">Susieta</Badge> : <Badge tone="danger">Nesusieta</Badge>;
}

function StateBadges({ live, open }: { live: string | null; open: string | null }) {
  return (
    <span className="flex flex-wrap gap-1">
      {live && <Badge tone="warning" title={`DelPro SortCow ${live}`}>Aktyvus DelPro ({live})</Badge>}
      {open && <Badge tone="info">GVET: {CMS_STATUS_LABEL[open as CmsJobStatus] ?? open}</Badge>}
      {!live && !open && <span className="text-[12px] text-text-muted">—</span>}
    </span>
  );
}

export function CmsNewSeparation({
  sortAreas,
  groups,
  draft,
  drafts,
  canWrite,
}: {
  sortAreas: CmsSortAreaRow[];
  groups: string[];
  draft: CmsDraft | null;
  drafts: CmsDraftSummary[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const nowLocal = React.useMemo(() => vilniusNowLocal(), []);

  // --- batch (draft) state --------------------------------------------------
  const [batchId, setBatchId] = React.useState<string | null>(draft?.batch_id ?? null);
  const [note, setNote] = React.useState(draft?.note ?? "");
  const [common, setCommon] = React.useState<CmsSettings>(draft?.common ?? emptySettings());
  const [rows, setRows] = React.useState<CmsDraftRow[]>(draft?.rows ?? []);
  const [marked, setMarked] = React.useState<Set<string>>(new Set());
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [copySource, setCopySource] = React.useState<string | null>(null);
  const [rowFilter, setRowFilter] = React.useState<"all" | "invalid" | "override" | "existing">("all");
  const [serverProblems, setServerProblems] = React.useState<Map<string, CmsProblem[]>>(new Map());
  const [confirm, setConfirm] = React.useState<Confirm | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = React.useState<CmsCheckResult[] | null>(null);

  // --- search state -----------------------------------------------------------
  const [q, setQ] = React.useState("");
  const [group, setGroup] = React.useState("");
  const [delpro, setDelpro] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [results, setResults] = React.useState<CmsSearchAnimal[]>([]);
  const [count, setCount] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(50);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      const res = await cmsSearch({ q, group, delpro, page });
      if (cancelled) return;
      setSearching(false);
      if (!res.ok) {
        setSearchError(res.error);
        return;
      }
      setSearchError(null);
      setResults(res.animals);
      setCount(res.count);
      setPageSize(res.pageSize);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, group, delpro, page]);

  const inBatch = React.useMemo(() => new Set(rows.map((r) => r.animal_id)), [rows]);
  const problemsOf = React.useCallback(
    (r: CmsDraftRow) => {
      const local = rowProblems(r, nowLocal);
      const server = (serverProblems.get(r.animal_id) ?? []).map((p) => p.message).filter((m) => !local.includes(m));
      return [...local, ...server];
    },
    [nowLocal, serverProblems],
  );

  // --- selection --------------------------------------------------------------
  function addAnimals(list: CmsSearchAnimal[]) {
    setRows((prev) => {
      const have = new Set(prev.map((r) => r.animal_id));
      return [...prev, ...list.filter((a) => !have.has(a.id)).map((a) => toRow(a, common))];
    });
    setPreview(null);
  }
  function removeAnimals(ids: string[]) {
    const set = new Set(ids);
    setRows((prev) => prev.filter((r) => !set.has(r.animal_id)));
    setMarked((prev) => new Set([...prev].filter((id) => !set.has(id))));
    if (expanded && set.has(expanded)) setExpanded(null);
    setPreview(null);
  }
  function toggleAnimal(a: CmsSearchAnimal) {
    if (inBatch.has(a.id)) removeAnimals([a.id]);
    else addAnimals([a]);
  }
  const pageAllIn = results.length > 0 && results.every((a) => inBatch.has(a.id));

  async function addAllMatching() {
    setBusy("all");
    const res = await cmsSearch({ q, group, delpro, all: true });
    setBusy(null);
    if (!res.ok) {
      setMessage({ ok: false, text: res.error });
      return;
    }
    const fresh = res.animals.filter((a) => !inBatch.has(a.id));
    setConfirm({
      title: "Pažymėti visus atitinkančius?",
      confirmLabel: `Pridėti ${fresh.length}`,
      message: (
        <div className="space-y-2 text-[13px]">
          <p>
            Filtrą atitinka <b>{res.count}</b> gyvul. Bus pridėta <b>{fresh.length}</b> (kiti jau pasirinkti).
          </p>
          {res.truncated && <p className="text-warning">Rodoma tik pirmi {res.pageSize} — susiaurinkite filtrą.</p>}
          {res.animals.filter((a) => !a.delpro_object_guid).length > 0 && (
            <p className="text-danger">{res.animals.filter((a) => !a.delpro_object_guid).length} iš jų nesusieti su DelPro — jų pateikti nebus galima.</p>
          )}
        </div>
      ),
      onConfirm: () => addAnimals(fresh),
    });
  }

  // --- bulk settings ------------------------------------------------------------
  function applyCommon(ids: string[], what: string) {
    if (ids.length === 0) return;
    const n = overridesAffected(rows, ids, common);
    const run = () => {
      setRows((prev) => applyTemplate(prev, ids, common));
      setPreview(null);
      setMessage({ ok: true, text: `Bendri nustatymai pritaikyti: ${ids.length} gyvul.` });
    };
    if (n === 0) return run();
    setConfirm({
      title: `${what}?`,
      confirmLabel: `Pakeisti (${n})`,
      danger: true,
      message: (
        <p className="text-[13px]">
          <b>{n}</b> gyvul. turi individualius nustatymus — jie bus pakeisti bendraisiais. Kiti {ids.length - n} gyvul. bus nustatyti iš naujo.
        </p>
      ),
      onConfirm: run,
    });
  }
  function startCopy(id: string) {
    setCopySource(id);
    setMessage(null);
  }
  function doCopy(targets: string[]) {
    if (!copySource) return;
    const src = rows.find((r) => r.animal_id === copySource);
    const real = targets.filter((t) => t !== copySource);
    const n = overridesAffected(rows, real, src?.settings ?? common);
    const run = () => {
      setRows((prev) => copySettings(prev, copySource, real));
      setCopySource(null);
      setPreview(null);
      setMessage({ ok: true, text: `Nustatymai nukopijuoti ${real.length} gyvul.` });
    };
    if (n === 0) return run();
    setConfirm({
      title: "Kopijuoti nustatymus?",
      confirmLabel: `Kopijuoti (${real.length})`,
      danger: true,
      message: <p className="text-[13px]">Bus pakeisti <b>{n}</b> gyvul. individualūs nustatymai.</p>,
      onConfirm: run,
    });
  }

  const visibleRows = rows.filter((r) => {
    if (rowFilter === "invalid") return problemsOf(r).length > 0;
    if (rowFilter === "override") return r.source === "override";
    if (rowFilter === "existing") return !!r.live_action_key;
    return true;
  });
  const markedIds = [...marked].filter((id) => inBatch.has(id));
  const allVisibleMarked = visibleRows.length > 0 && visibleRows.every((r) => marked.has(r.animal_id));
  const invalidCount = rows.filter((r) => problemsOf(r).length > 0).length;

  // --- server calls -------------------------------------------------------------
  async function save(submit: boolean) {
    setBusy(submit ? "submit" : "save");
    setMessage(null);
    const res = await cmsPost<{ batch_id: string; counts: Record<string, number> }>("save", {
      data: { batch_id: batchId, note, common_settings: common, submit, items: toItems(rows) },
    });
    setBusy(null);
    if (!res.ok) {
      const details = Array.isArray(res.details) ? (res.details as { animal_id: string; problems: CmsProblem[] }[]) : [];
      if (details.length) setServerProblems(new Map(details.map((d) => [d.animal_id, d.problems])));
      setMessage({ ok: false, text: res.error });
      return false;
    }
    if (submit) {
      setPreview(null);
      router.push(`/veterinarija/cms-atskyrimai?tab=istorija&batch=${res.data.batch_id}`);
      router.refresh();
      return true;
    }
    // a submitted draft is gone; a saved one keeps its id (it was replaced as a whole)
    setBatchId(res.data.batch_id);
    router.replace(`/veterinarija/cms-atskyrimai?tab=naujas&batch=${res.data.batch_id}`, { scroll: false });
    setMessage({ ok: true, text: "Juodraštis išsaugotas." });
    return true;
  }

  async function runPreview() {
    setBusy("preview");
    setMessage(null);
    const res = await cmsPost<CmsCheckResult[]>("check", { items: toItems(rows) });
    setBusy(null);
    if (!res.ok) {
      setMessage({ ok: false, text: res.error });
      return;
    }
    setServerProblems(new Map(res.data.map((r) => [r.animal_id, r.problems])));
    setPreview(res.data);
  }

  async function deleteDraft() {
    if (!batchId) {
      setRows([]);
      setMarked(new Set());
      return;
    }
    setBusy("delete");
    const res = await cmsPost("delete_draft", { batch_id: batchId });
    setBusy(null);
    if (!res.ok) return setMessage({ ok: false, text: res.error });
    router.push("/veterinarija/cms-atskyrimai?tab=naujas");
    router.refresh();
  }

  // --- render ----------------------------------------------------------------------
  const pages = Math.max(1, Math.ceil(count / pageSize));

  return (
    <div className="space-y-5">
      {drafts.length > 0 && (
        <Card className="flex flex-wrap items-center gap-2 px-4 py-3 text-[13px]">
          <span className="text-text-muted">Juodraščiai:</span>
          {drafts.map((d) => (
            <a
              key={d.id}
              href={`/veterinarija/cms-atskyrimai?tab=naujas&batch=${d.id}`}
              className={cn(
                "rounded-control border px-2 py-1 hover:bg-surface-secondary",
                d.id === batchId ? "border-accent text-accent-hover" : "border-border text-text-secondary",
              )}
            >
              {formatVilnius(d.created_at)} · {d.items} gyv.{d.note ? ` · ${d.note}` : ""}
            </a>
          ))}
          {batchId && (
            <a href="/veterinarija/cms-atskyrimai?tab=naujas" className="ml-auto text-accent-hover hover:underline">
              + Naujas
            </a>
          )}
        </Card>
      )}

      {/* 1. Gyvulių paieška ir pasirinkimas */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          <div className="min-w-[220px] flex-1">
            <Label htmlFor="cms-q">Paieška (ORN, DelPro Nr., vardas)</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-text-muted" />
              <Input
                id="cms-q"
                value={q}
                placeholder="LT0000… arba 337"
                className="pl-8"
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(0);
                }}
              />
            </div>
          </div>
          <div className="w-44">
            <Label htmlFor="cms-group">Grupė</Label>
            <Select
              id="cms-group"
              value={group}
              onChange={(e) => {
                setGroup(e.target.value);
                setPage(0);
              }}
            >
              <option value="">Visos</option>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-44">
            <Label htmlFor="cms-delpro">DelPro ryšys</Label>
            <Select
              id="cms-delpro"
              value={delpro}
              onChange={(e) => {
                setDelpro(e.target.value);
                setPage(0);
              }}
            >
              <option value="">Visi</option>
              <option value="linked">Susieti</option>
              <option value="unlinked">Nesusieti</option>
            </Select>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addAllMatching} disabled={!canWrite || busy === "all" || count === 0}>
            {busy === "all" ? <Loader2 className="size-4 animate-spin" /> : <Users className="size-4" />} Pažymėti visus atitinkančius ({count})
          </Button>
        </div>
        {searchError && <p className="px-4 py-2 text-[12px] text-danger">{searchError}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-secondary text-left text-[12px] text-text-muted">
              <tr>
                <th className="w-10 px-4 py-2">
                  <input
                    type="checkbox"
                    aria-label="Pažymėti puslapį"
                    disabled={!canWrite || results.length === 0}
                    checked={pageAllIn}
                    onChange={() => (pageAllIn ? removeAnimals(results.map((a) => a.id)) : addAnimals(results))}
                  />
                </th>
                <th className="px-2 py-2 font-medium">ORN</th>
                <th className="px-2 py-2 font-medium">DelPro Nr.</th>
                <th className="hidden px-2 py-2 font-medium sm:table-cell">Gyvulys</th>
                <th className="px-2 py-2 font-medium">DelPro</th>
                <th className="px-2 py-2 font-medium">Atskyrimas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {results.map((a) => (
                <tr key={a.id} className={cn("hover:bg-surface-secondary/60", inBatch.has(a.id) && "bg-accent-soft/40")}>
                  <td className="px-4 py-1.5">
                    <input type="checkbox" aria-label={`Pasirinkti ${a.tag_no}`} disabled={!canWrite} checked={inBatch.has(a.id)} onChange={() => toggleAnimal(a)} />
                  </td>
                  <td className="px-2 py-1.5 font-medium text-text-primary">{a.tag_no}</td>
                  <td className="px-2 py-1.5 text-text-secondary">{a.animal_no ?? "—"}</td>
                  <td className="hidden px-2 py-1.5 text-text-secondary sm:table-cell">{[a.name, a.group_name].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="px-2 py-1.5">
                    <DelproBadge guid={a.delpro_object_guid} />
                  </td>
                  <td className="px-2 py-1.5">
                    <StateBadges live={a.live_action_key} open={a.open_job_status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!searching && results.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-text-muted">Gyvulių nerasta.</p>}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 text-[12px] text-text-muted">
          <span className="flex items-center gap-2">
            {searching && <Loader2 className="size-3.5 animate-spin" />}
            Rasta {count} · pasirinkta {rows.length}
          </span>
          <span className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ‹
            </Button>
            {page + 1} / {pages}
            <Button type="button" variant="ghost" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              ›
            </Button>
          </span>
        </div>
      </Card>

      {/* 2. Bendri atskyrimo nustatymai */}
      <Card className="px-4 py-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-text-primary">Bendri atskyrimo nustatymai</h2>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={!canWrite || rows.length === 0} onClick={() => applyCommon(rows.map((r) => r.animal_id), "Taikyti visiems")}>
              Taikyti visiems ({rows.length})
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={!canWrite || markedIds.length === 0} onClick={() => applyCommon(markedIds, "Taikyti pažymėtiems")}>
              Taikyti pažymėtiems ({markedIds.length})
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!canWrite || markedIds.filter((id) => rows.find((r) => r.animal_id === id)?.source === "override").length === 0}
              onClick={() => applyCommon(markedIds.filter((id) => rows.find((r) => r.animal_id === id)?.source === "override"), "Atstatyti individualius nustatymus")}
            >
              <Undo2 className="size-4" /> Atstatyti individualius
            </Button>
          </div>
        </div>
        <CmsSettingsFields idPrefix="common" value={common} onChange={(p) => setCommon((c) => ({ ...c, ...p }))} sortAreas={sortAreas} nowLocal={nowLocal} />
        <p className="mt-2 text-[12px] text-text-muted">
          Rūšiavimo vietos GVET nevaldo: DelPro Gateway sąsaja tarp SortCow ir konkrečios vietos nepatikrinta. Vienkartinio atskyrimo (Sort Once) siųsti
          negalima.
        </p>
      </Card>

      {/* 3. Kiekvieno gyvulio nustatymai */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <h2 className="mr-auto text-[15px] font-semibold text-text-primary">
            Gyvulių nustatymai <span className="font-normal text-text-muted">({rows.length})</span>
          </h2>
          <Select className="h-8 w-48 text-[13px]" value={rowFilter} onChange={(e) => setRowFilter(e.target.value as typeof rowFilter)} aria-label="Rodyti">
            <option value="all">Visi ({rows.length})</option>
            <option value="invalid">Su klaidomis ({invalidCount})</option>
            <option value="override">Individualūs ({rows.filter((r) => r.source === "override").length})</option>
            <option value="existing">Su esamu DelPro atskyrimu ({rows.filter((r) => r.live_action_key).length})</option>
          </Select>
          <Button type="button" size="sm" variant="ghost" disabled={markedIds.length === 0} onClick={() => setMarked(new Set())}>
            <X className="size-4" /> Nuimti žymėjimą
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={!canWrite || markedIds.length === 0} onClick={() => removeAnimals(markedIds)}>
            <Trash2 className="size-4" /> Pašalinti pažymėtus
          </Button>
        </div>

        {copySource && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-info-soft px-4 py-2 text-[13px]">
            <Copy className="size-4 text-info" />
            Kopijuoti {rows.find((r) => r.animal_id === copySource)?.tag_no} nustatymus:
            <Button type="button" size="sm" onClick={() => doCopy(markedIds)} disabled={markedIds.filter((id) => id !== copySource).length === 0}>
              Į pažymėtus ({markedIds.filter((id) => id !== copySource).length})
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => doCopy(rows.map((r) => r.animal_id))}>
              Į visus ({rows.length - 1})
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCopySource(null)}>
              Atšaukti
            </Button>
          </div>
        )}

        {rows.length === 0 ? (
          <EmptyState icon={Users} title="Gyvulių nepasirinkta" description="Pažymėkite gyvulius paieškos lentelėje." className="py-10" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-surface-secondary text-left text-[12px] text-text-muted">
                <tr>
                  <th className="w-10 px-4 py-2">
                    <input
                      type="checkbox"
                      aria-label="Pažymėti rodomus"
                      checked={allVisibleMarked}
                      onChange={() =>
                        setMarked((prev) => {
                          const next = new Set(prev);
                          for (const r of visibleRows) {
                            if (allVisibleMarked) next.delete(r.animal_id);
                            else next.add(r.animal_id);
                          }
                          return next;
                        })
                      }
                    />
                  </th>
                  <th className="px-2 py-2 font-medium">Gyvulys</th>
                  <th className="px-2 py-2 font-medium">Nustatymai</th>
                  <th className="px-2 py-2 font-medium">Esamas atskyrimas</th>
                  <th className="px-2 py-2 font-medium">Būsena</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleRows.map((r) => {
                  const problems = problemsOf(r);
                  const open = expanded === r.animal_id;
                  return (
                    <React.Fragment key={r.animal_id}>
                      <tr className={cn(marked.has(r.animal_id) && "bg-accent-soft/40", copySource === r.animal_id && "bg-info-soft")}>
                        <td className="px-4 py-2 align-top">
                          <input
                            type="checkbox"
                            aria-label={`Pažymėti ${r.tag_no}`}
                            checked={marked.has(r.animal_id)}
                            onChange={() =>
                              setMarked((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.animal_id)) next.delete(r.animal_id);
                                else next.add(r.animal_id);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-2 align-top">
                          <p className="font-medium text-text-primary">{r.tag_no}</p>
                          <p className="text-[12px] text-text-muted">
                            Nr. {r.animal_no ?? "—"} · <DelproBadge guid={r.delpro_object_guid} />
                          </p>
                        </td>
                        <td className="px-2 py-2 align-top">
                          <p className="text-text-primary">{CMS_MODE_LABEL[r.settings.mode]}</p>
                          <p className="text-[12px] text-text-secondary">{describeSchedule(r.settings)}</p>
                          <Badge tone={r.source === "override" ? "accent" : "neutral"} className="mt-0.5">
                            {r.source === "override" ? "Individualūs" : "Bendri"}
                          </Badge>
                        </td>
                        <td className="px-2 py-2 align-top">
                          {r.live_action_key ? (
                            <div className="space-y-1">
                              <Badge tone="warning">DelPro SortCow {r.live_action_key}</Badge>
                              <Select
                                className="h-8 text-[12px]"
                                aria-label="Sprendimas dėl esamo atskyrimo"
                                value={r.existing_decision ?? ""}
                                disabled={!canWrite}
                                onChange={(e) => {
                                  const v = (e.target.value || null) as CmsDraftRow["existing_decision"];
                                  setRows((prev) => prev.map((x) => (x.animal_id === r.animal_id ? { ...x, existing_decision: v } : x)));
                                  setPreview(null);
                                }}
                              >
                                <option value="">— pasirinkite —</option>
                                <option value="skip">Praleisti šį gyvulį</option>
                                <option value="modify">Prašyti pakeitimo (nesiunčiama)</option>
                              </Select>
                            </div>
                          ) : (
                            <StateBadges live={null} open={r.open_job_status} />
                          )}
                        </td>
                        <td className="px-2 py-2 align-top">
                          {problems.length === 0 ? (
                            <Badge tone="success">{r.live_action_key && r.existing_decision === "skip" ? "Bus praleista" : "Tinka"}</Badge>
                          ) : (
                            <div className="space-y-0.5">
                              <Badge tone="danger">Klaidų: {problems.length}</Badge>
                              <ul className="max-w-xs text-[11px] text-danger">
                                {problems.slice(0, 3).map((p) => (
                                  <li key={p}>{p}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right align-top">
                          <Button type="button" size="sm" variant="ghost" disabled={!canWrite} onClick={() => setExpanded(open ? null : r.animal_id)}>
                            {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />} Keisti
                          </Button>
                          <Button type="button" size="sm" variant="ghost" disabled={!canWrite} onClick={() => startCopy(r.animal_id)} title="Kopijuoti šio gyvulio nustatymus">
                            <Copy className="size-4" />
                          </Button>
                          <Button type="button" size="sm" variant="ghost" disabled={!canWrite} onClick={() => removeAnimals([r.animal_id])} title="Pašalinti">
                            <Trash2 className="size-4" />
                          </Button>
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={6} className="bg-surface-secondary/50 px-4 py-3">
                            <CmsSettingsFields
                              idPrefix={`row-${r.animal_id}`}
                              value={r.settings}
                              sortAreas={sortAreas}
                              nowLocal={nowLocal}
                              onChange={(p) => {
                                setRows((prev) => updateRow(prev, r.animal_id, p));
                                setPreview(null);
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 4. Išsaugoti / peržiūrėti / pateikti */}
      <Card className="flex flex-wrap items-end gap-3 px-4 py-3">
        <div className="min-w-[220px] flex-1">
          <Label htmlFor="cms-note">Partijos pastaba</Label>
          <Input id="cms-note" value={note} maxLength={300} disabled={!canWrite} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button type="button" variant="outline" disabled={!canWrite || rows.length === 0 || !!busy} onClick={() => save(false)}>
          {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Išsaugoti juodraštį
        </Button>
        <Button type="button" disabled={!canWrite || rows.length === 0 || !!busy} onClick={runPreview}>
          {busy === "preview" ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />} Peržiūrėti ir pateikti
        </Button>
        {(batchId || rows.length > 0) && (
          <Button
            type="button"
            variant="ghost"
            disabled={!canWrite || !!busy}
            onClick={() =>
              setConfirm({
                title: batchId ? "Ištrinti juodraštį?" : "Išvalyti pasirinkimą?",
                confirmLabel: batchId ? "Ištrinti" : "Išvalyti",
                danger: true,
                message: <p className="text-[13px]">Visi {rows.length} gyvulių nustatymai bus pašalinti.</p>,
                onConfirm: deleteDraft,
              })
            }
          >
            <Trash2 className="size-4" /> {batchId ? "Ištrinti juodraštį" : "Išvalyti"}
          </Button>
        )}
        {message && <p className={cn("w-full text-[13px]", message.ok ? "text-success" : "text-danger")}>{message.text}</p>}
      </Card>

      {preview && (
        <PreviewDialog
          rows={rows}
          checks={preview}
          sortAreas={sortAreas}
          busy={busy === "submit"}
          onClose={() => setPreview(null)}
          onSubmit={() => save(true)}
        />
      )}

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.title}</DialogTitle>
          </DialogHeader>
          <DialogBody>{confirm?.message}</DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>
              Atšaukti
            </Button>
            <Button
              type="button"
              variant={confirm?.danger ? "danger" : "primary"}
              onClick={async () => {
                const c = confirm;
                setConfirm(null);
                await c?.onConfirm();
              }}
            >
              {confirm?.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PreviewDialog({
  rows,
  checks,
  sortAreas,
  busy,
  onClose,
  onSubmit,
}: {
  rows: CmsDraftRow[];
  checks: CmsCheckResult[];
  sortAreas: CmsSortAreaRow[];
  busy: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const byId = new Map(checks.map((c) => [c.animal_id, c]));
  const status = (r: CmsDraftRow) => {
    const c = byId.get(r.animal_id);
    const live = c?.live?.action_key ?? null;
    if (live && r.existing_decision === "skip") return "skip" as const;
    const blocking = (c?.problems ?? []).filter((p) => p.code !== "modification_unsupported");
    if (blocking.length) return "blocked" as const;
    if (live && r.existing_decision === "modify") return "hold" as const;
    return "ready" as const;
  };
  const counts = { ready: 0, blocked: 0, skip: 0, hold: 0 };
  for (const r of rows) counts[status(r)] += 1;
  const conflicts = rows.filter((r) => byId.get(r.animal_id)?.live).length;
  const areaName = (k: string) => sortAreas.find((a) => a.area_key === k)?.area_name ?? k;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>Peržiūra prieš pateikiant</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              ["Pasirinkta", rows.length, "neutral"],
              ["Tinka", counts.ready, "success"],
              ["Blokuota", counts.blocked, "danger"],
              ["Esami atskyrimai", conflicts, "warning"],
              ["Bus pateikta tvirtinti", counts.ready, "info"],
            ].map(([label, n, tone]) => (
              <div key={label as string} className="rounded-control border border-border px-3 py-2">
                <p className="text-[11px] text-text-muted">{label}</p>
                <p className={cn("text-[18px] font-semibold", tone === "danger" && Number(n) > 0 ? "text-danger" : "text-text-primary")}>{n}</p>
              </div>
            ))}
          </div>
          {(counts.skip > 0 || counts.hold > 0) && (
            <p className="text-[12px] text-text-secondary">
              Praleidžiama: {counts.skip}. Pakeitimo prašymai (į DelPro nesiunčiami, laukia peržiūros): {counts.hold}.
            </p>
          )}
          <div className="max-h-[50vh] overflow-auto rounded-control border border-border">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-surface-secondary text-left text-text-muted">
                <tr>
                  <th className="px-2 py-1.5 font-medium">ORN</th>
                  <th className="px-2 py-1.5 font-medium">DelPro Nr.</th>
                  <th className="px-2 py-1.5 font-medium">DelPro ObjectGuid</th>
                  <th className="px-2 py-1.5 font-medium">AnimalMilkSetting</th>
                  <th className="px-2 py-1.5 font-medium">Vieta</th>
                  <th className="px-2 py-1.5 font-medium">Režimas</th>
                  <th className="px-2 py-1.5 font-medium">Pradžia → pabaiga</th>
                  <th className="px-2 py-1.5 font-medium">Sesijos</th>
                  <th className="px-2 py-1.5 font-medium">Esamas SortCow</th>
                  <th className="px-2 py-1.5 font-medium">Patikra</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const c = byId.get(r.animal_id);
                  const st = status(r);
                  return (
                    <tr key={r.animal_id} className={st === "blocked" ? "bg-danger-soft/40" : ""}>
                      <td className="px-2 py-1.5 font-medium">{r.tag_no}</td>
                      <td className="px-2 py-1.5">{r.animal_no ?? "—"}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px]">{r.delpro_object_guid ?? <span className="text-danger">nėra</span>}</td>
                      <td className="px-2 py-1.5 text-text-muted">nustatoma siunčiant</td>
                      <td className="px-2 py-1.5">{r.settings.sort_area_key ? <span className="text-danger">{areaName(r.settings.sort_area_key)}</span> : "Nevaldoma"}</td>
                      <td className="px-2 py-1.5">{CMS_MODE_LABEL[r.settings.mode]}</td>
                      <td className="px-2 py-1.5">
                        {formatVilnius(c?.start_at)} → {r.settings.mode === "ongoing" ? "be pabaigos" : formatVilnius(c?.end_at)}
                      </td>
                      <td className="px-2 py-1.5">{r.settings.sessions.join(", ") || "—"}</td>
                      <td className="px-2 py-1.5">{c?.live ? `${c.live.action_key} (nuo ${formatVilnius(c.live.start_at)})` : "—"}</td>
                      <td className="px-2 py-1.5">
                        {st === "ready" && <Badge tone="success">Tinka</Badge>}
                        {st === "skip" && <Badge tone="neutral">Praleidžiama</Badge>}
                        {st === "hold" && <Badge tone="warning">Pakeitimo prašymas</Badge>}
                        {st === "blocked" && (
                          <span className="text-danger">{(c?.problems ?? []).filter((p) => p.code !== "modification_unsupported").map((p) => p.message).join(" ")}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[12px] text-text-muted">
            Laikai — Vilniaus laiku (DelPro gauna UTC). AnimalMilkSetting raktą ūkio kompiuteris nustato pagal DelPro ObjectGuid prieš rašydamas; jei jo nėra arba yra
            keli, nieko nerašoma.
          </p>
          {counts.blocked > 0 && (
            <p className="flex items-center gap-2 text-[13px] text-danger">
              <AlertTriangle className="size-4" /> Pataisykite arba pašalinkite blokuotus gyvulius — partija su klaidomis nepateikiama.
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Grįžti taisyti
          </Button>
          <Button type="button" disabled={busy || counts.blocked > 0 || counts.ready + counts.hold === 0} onClick={onSubmit}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Pateikti tvirtinti ({counts.ready + counts.hold})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

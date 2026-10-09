import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { BarList, ChartCard, ColumnChart, PeriodTabs, StatCard, type BarRow } from "@/components/analitika/charts";
import { monthStarts, resolvePeriod } from "@/lib/analytics-period";
import { TREATMENT_TYPE_LABELS, OPEN_VISIT_STATUSES, VISIT_PROCEDURE_LABELS, addDays, vilniusDay } from "@/lib/visits";
import { formatDate, formatEur, formatQty } from "@/lib/utils";
import { loadMoneyOverview } from "@/lib/money-overview";
import { PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";
import {
  PawPrint,
  AlertTriangle,
  Boxes,
  RefreshCw,
  ArrowRight,
  Stethoscope,
  Repeat,
  CalendarClock,
  CalendarX2,
  Waypoints,
  Syringe,
  ShieldAlert,
  Pill,
  Wallet,
  TrendingDown,
} from "lucide-react";
import type { ProcedureType, ProductCategory, VisitProcedure, VisitStatus } from "@/lib/supabase/types";

const categoryLabel = (c: string) => PRODUCT_CATEGORY_LABELS[c as ProductCategory] ?? c;

// Fixed slot per treatment type (categorical colours follow the entity, never its rank).
const TREATMENT_SERIES: { key: ProcedureType; color: string }[] = [
  { key: "gydymas", color: "var(--series-1)" },
  { key: "profilaktika", color: "var(--series-2)" },
  { key: "sinchronizacija", color: "var(--series-3)" },
  { key: "apziura", color: "var(--series-4)" },
];

type OpenVisit = {
  id: string;
  animal_id: string;
  visit_datetime: string;
  procedures: VisitProcedure[];
  status: VisitStatus;
  sync_application_id: string | null;
  sync_step_title: string | null;
  sync_step_no: number | null;
  sync_step_total: number | null;
  animals: { tag_no: string; animal_no: string | null } | null;
};

function daysLeft(until: string, today: string): number {
  return Math.round((Date.parse(`${until}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
}

export default async function VeterinarijaDashboardPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const period = resolvePeriod(sp.period, "90d");
  const session = await getCurrentProfile();
  const supabase = await createClient();

  const today = period.today;
  const [
    { data: withdrawalActive },
    { data: stock },
    { data: recentTreatments },
    { count: pendingSyncCount },
    { count: dueDoseCount },
    { count: activeCourseCount },
    { data: openVisitRows },
    { data: treatmentsByMonth },
    { data: topDiseases },
    { data: byGroup },
    { data: antimicrobial },
    money,
  ] = await Promise.all([
      supabase
        .from("vw_withdrawal_status")
        .select("*")
        .or("milk_active.eq.true,meat_active.eq.true")
        .order("tag_no"),
      supabase.from("stock_by_product").select("*"),
      supabase
        .from("treatments")
        .select("id, reg_date, diagnosis, animals(tag_no, animal_no)")
        .order("reg_date", { ascending: false })
        .limit(6),
      supabase
        .from("delpro_sync_jobs")
        .select("id", { count: "exact", head: true })
        .in("status", ["pending_approval", "error", "verification_failed"]),
      supabase
        .from("course_doses")
        .select("id", { count: "exact", head: true })
        .eq("administered", false)
        .lte("scheduled_date", today),
      supabase.from("treatment_courses").select("id", { count: "exact", head: true }).eq("status", "active"),
      supabase
        .from("animal_visits")
        .select("id, animal_id, visit_datetime, procedures, status, sync_application_id, sync_step_title, sync_step_no, sync_step_total, animals(tag_no, animal_no)")
        .in("status", OPEN_VISIT_STATUSES)
        .order("visit_datetime")
        .limit(1000),
      supabase.rpc("analytics_treatments_by_month", { p_from: period.from, p_to: period.to }),
      supabase.rpc("analytics_top_diseases", { p_from: period.from, p_to: period.to, p_limit: 8 }),
      supabase.rpc("analytics_treatments_by_group", { p_from: period.from, p_to: period.to, p_limit: 8 }),
      supabase.rpc("analytics_antimicrobial", { p_from: period.from, p_to: period.to, p_limit: 6 }),
      loadMoneyOverview(supabase, period),
    ]);

  // Animals under karencija, with their number (the status view only has the tag).
  const underWithdrawal = (withdrawalActive ?? []).slice().sort((a, b) => {
    const ka = [a.milk_active ? a.milk_until : null, a.meat_active ? a.meat_until : null].filter(Boolean).sort().pop() ?? "";
    const kb = [b.milk_active ? b.milk_until : null, b.meat_active ? b.meat_until : null].filter(Boolean).sort().pop() ?? "";
    return ka.localeCompare(kb);
  });
  const shownWithdrawal = underWithdrawal.slice(0, 8);
  const { data: withdrawalAnimals } = shownWithdrawal.length
    ? await supabase.from("animals").select("id, animal_no, group_name").in("id", shownWithdrawal.map((w) => w.animal_id))
    : { data: [] as { id: string; animal_no: string | null; group_name: string | null }[] };
  const animalById = new Map((withdrawalAnimals ?? []).map((a) => [a.id, a]));

  // Visits: overdue / next 7 days / open sync-protocol steps.
  const openVisits = (openVisitRows ?? []) as unknown as OpenVisit[];
  const weekEnd = addDays(today, 7);
  const dayOf = (v: OpenVisit) => vilniusDay(v.visit_datetime);
  const overdue = openVisits.filter((v) => dayOf(v) < today);
  const upcoming = openVisits.filter((v) => dayOf(v) >= today && dayOf(v) <= weekEnd);
  const openSyncSteps = openVisits.filter((v) => v.sync_application_id !== null);
  const visitList = [...overdue.slice(0, 4), ...upcoming.slice(0, 8 - Math.min(4, overdue.length))];

  const lowStock = (stock ?? []).filter((s) => s.min_stock_alert != null && s.qty_left <= s.min_stock_alert);

  const months = monthStarts(period.from, period.to);
  const typeData: Record<string, Record<string, number>> = {};
  let treatmentTotal = 0;
  const typesPresent = new Set<string>();
  for (const r of treatmentsByMonth ?? []) {
    (typeData[r.month] ??= {})[r.procedure_type] = Number(r.n);
    treatmentTotal += Number(r.n);
    typesPresent.add(r.procedure_type);
  }
  const treatmentSeries = TREATMENT_SERIES.filter((t) => typesPresent.has(t.key)).map((t) => ({ key: t.key, label: TREATMENT_TYPE_LABELS[t.key], color: t.color }));

  const diseaseRows: BarRow[] = (topDiseases ?? []).map((d) => ({ key: d.name, label: d.name, sublabel: `${d.animals} gyv.`, value: Number(d.n), valueLabel: String(d.n) }));
  const groupRows: BarRow[] = (byGroup ?? []).map((g) => ({ key: g.animal_group, label: g.animal_group, sublabel: `${g.animals} gyv.`, value: Number(g.n), valueLabel: String(g.n) }));
  const amrRows: BarRow[] = (antimicrobial ?? []).map((a) => ({
    key: a.product_name,
    label: a.product_name,
    sublabel: [a.active_substance, `${a.uses} kartai`].filter(Boolean).join(" · "),
    value: Number(a.qty),
    valueLabel: formatQty(Number(a.qty), a.unit),
  }));

  // Money (€): quantity × batch purchase price, see src/lib/money-overview.ts.
  const monthData: Record<string, Record<string, number>> = {};
  for (const m of money.monthly) monthData[m.month] = { purchased: Number(m.purchased), consumed: Number(m.consumed) };
  const spendRows: BarRow[] = money.byCategory
    .filter((c) => Number(c.spent) > 0)
    .map((c) => ({ key: c.category, label: categoryLabel(c.category), sublabel: `${c.uses} nurašymų`, value: Number(c.spent), valueLabel: formatEur(Number(c.spent)) }));
  const stockRows: BarRow[] = money.stock
    .filter((c) => c.usable_value > 0 || c.expired_value > 0)
    .map((c) => ({
      key: c.category,
      label: categoryLabel(c.category),
      sublabel: c.expired_value > 0 ? `Iš jų pasibaigę: ${formatEur(Number(c.expired_value))}` : `${c.usable_batches} part.`,
      value: Number(c.usable_value) + Number(c.expired_value),
      valueLabel: formatEur(Number(c.usable_value) + Number(c.expired_value)),
    }));
  const topRows: BarRow[] = money.top.map((p) => ({
    key: p.product_id,
    label: p.product_name,
    sublabel: `${formatQty(Number(p.qty), p.unit)} · ${categoryLabel(p.category)}`,
    value: Number(p.spent),
    valueLabel: formatEur(Number(p.spent)),
  }));

  type TreatmentRow = { id: string; reg_date: string; diagnosis: string | null; animals: { tag_no: string; animal_no: string | null } | null };
  const treatmentRows = (recentTreatments ?? []) as unknown as TreatmentRow[];

  const animalName = (a: { tag_no: string; animal_no: string | null } | null) => (a ? (a.animal_no ? `Nr. ${a.animal_no}` : a.tag_no) : "—");

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Pagrindinis"
        description={session ? `Sveiki, ${session.profile.full_name?.split(" ")[0] ?? session.email}` : undefined}
      />
      <div className="space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <PeriodTabs basePath="/veterinarija" current={period.key} />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-2">
            <StatCard icon={Pill} label="Vaistų atsargų vertė" value={formatEur(money.drugStockValue)} hint="vaistai, vakcinos, profilaktika, boliusai" href="/apskaita/atsargos" />
          </div>
          <div className="lg:col-span-2">
            <StatCard icon={Wallet} label="Visų atsargų vertė" value={formatEur(money.usableValue)} hint="tinkamų naudoti, pagal pirkimo kainą" href="/apskaita/atsargos" />
          </div>
          <div className="lg:col-span-2">
            <StatCard
              icon={AlertTriangle}
              label="Pasibaigusių vertė"
              value={formatEur(money.expiredValue)}
              hint={money.expiredBatches > 0 ? `${money.expiredBatches} part. nurašytinos` : "nėra"}
              tone={money.expiredBatches > 0 ? "danger" : undefined}
            />
          </div>
          <div className="lg:col-span-3">
            <StatCard icon={TrendingDown} label="Išleista (sunaudota)" value={formatEur(money.consumed)} hint={`visos atsargos · ${period.label}`} href="/apskaita" />
          </div>
          <div className="lg:col-span-3">
            <StatCard icon={Pill} label="Vaistams išleista" value={formatEur(money.drugSpent)} hint={`vaistai, vakcinos, profilaktika, boliusai · ${period.label}`} href="/apskaita" />
          </div>
        </div>
        {money.unpriced > 0 && (
          <p className="flex items-center gap-2 rounded-control bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
            <AlertTriangle className="size-4 shrink-0" /> {money.unpriced} partijų be pirkimo kainos — jos skaičiuojamos kaip 0 €, todėl sumos gali būti nepilnos.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon={PawPrint} label="Aktyvi karencija" value={String(underWithdrawal.length)} hint="gyvūnų dabar" tone={underWithdrawal.length > 0 ? "warning" : undefined} />
          <StatCard
            icon={AlertTriangle}
            label="Mažai atsargų"
            value={String(lowStock.length)}
            tone={lowStock.length > 0 ? "warning" : undefined}
            href="/apskaita"
          />
          <StatCard
            icon={Repeat}
            label="Kurso dozės šiandien"
            value={String(dueDoseCount ?? 0)}
            hint={`aktyvių kursų: ${activeCourseCount ?? 0}`}
            tone={(dueDoseCount ?? 0) > 0 ? "warning" : undefined}
            href="/veterinarija/gydymo-kursai"
          />
          <StatCard
            icon={RefreshCw}
            label="DelPro: laukia / klaidos"
            value={String(pendingSyncCount ?? 0)}
            tone={(pendingSyncCount ?? 0) > 0 ? "warning" : undefined}
            href="/veterinarija/delpro"
          />
          <StatCard icon={Stethoscope} label="Įrašų per laikotarpį" value={String(treatmentTotal)} hint={`gydymai, profilaktika… · ${period.label}`} href="/veterinarija/gydymo-istorija" />
          <StatCard
            icon={CalendarX2}
            label="Praleisti vizitai"
            value={String(overdue.length)}
            tone={overdue.length > 0 ? "danger" : undefined}
            href="/veterinarija/vizitai"
          />
          <StatCard icon={CalendarClock} label="Vizitai per 7 d." value={String(upcoming.length)} hint="įskaitant šiandien" href="/veterinarija/vizitai" />
          <StatCard icon={Waypoints} label="Sinchronizacijos žingsniai" value={String(openSyncSteps.length)} hint="neatlikti" href="/veterinarija/vizitai" />
        </div>

        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <ChartCard title="Pirkimai ir sunaudojimas pagal mėnesį" subtitle="Nupirkta (pagal sąskaitos datą) ir sunaudota (pagal panaudojimo datą), EUR" className="viz-root">
            <ColumnChart
              months={months}
              mode="grouped"
              series={[
                { key: "purchased", label: "Nupirkta", color: "var(--series-1)" },
                { key: "consumed", label: "Sunaudota", color: "var(--series-2)" },
              ]}
              data={monthData}
              format={(v) => formatEur(v).replace(",00", "")}
              caption="Pirkimai ir sunaudojimas pagal mėnesį, EUR"
            />
          </ChartCard>
          <ChartCard title="Daugiausiai išleista produktams" subtitle={`Top 8 pagal sunaudojimo vertę · ${period.label}`}>
            <BarList rows={topRows} empty="Šiuo laikotarpiu sunaudojimo nėra" />
          </ChartCard>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <ChartCard title="Kiek išleista pagal kategoriją" subtitle={`Sunaudota ${period.label}`}>
            <BarList rows={spendRows} empty="Šiuo laikotarpiu sunaudojimo nėra" />
          </ChartCard>
          <ChartCard title="Kiek turima pagal kategoriją" subtitle="Dabartinių atsargų vertė (kartu su pasibaigusiomis)">
            <BarList rows={stockRows} color="var(--accent-alt)" empty="Atsargų nėra" />
          </ChartCard>
        </div>

        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <ChartCard title="Įrašai pagal mėnesį" subtitle={`Gydymai, profilaktika, sinchronizacija, apžiūros · ${period.label}`} className="viz-root">
            {treatmentTotal === 0 ? (
              <EmptyState icon={Stethoscope} title="Šiuo laikotarpiu įrašų nėra" className="py-10" />
            ) : (
              <ColumnChart
                months={months}
                mode="stacked"
                series={treatmentSeries}
                data={typeData}
                format={(v) => String(Math.round(v))}
                caption="Gydymo įrašai pagal mėnesį ir tipą"
              />
            )}
          </ChartCard>
          <ChartCard title="Dažniausios diagnozės" subtitle={`Gydymai pagal ligą / diagnozę · ${period.label}`}>
            <BarList rows={diseaseRows} empty="Šiuo laikotarpiu gydymų nėra" />
          </ChartCard>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <ChartCard title="Gydymai pagal grupę" subtitle={`Pagal DelPro grupę gydymo metu · ${period.label}`}>
            <BarList rows={groupRows} color="var(--accent-alt)" empty="Šiuo laikotarpiu gydymų nėra" />
          </ChartCard>
          <ChartCard title="Antimikrobinių vartojimas" subtitle={`Sunaudotas kiekis · ${period.label}`}>
            <BarList rows={amrRows} color="var(--danger)" empty="Antimikrobinių nenaudota" />
          </ChartCard>
          <Card>
            <CardHeader>
              <CardTitle>Gyvūnai su karencija</CardTitle>
              <Badge tone={underWithdrawal.length > 0 ? "warning" : "success"}>{underWithdrawal.length}</Badge>
            </CardHeader>
            <CardContent className="p-0">
              {shownWithdrawal.length === 0 ? (
                <EmptyState icon={ShieldAlert} title="Karencijos nėra" className="py-10" />
              ) : (
                <div className="divide-y divide-border">
                  {shownWithdrawal.map((w) => {
                    const a = animalById.get(w.animal_id);
                    return (
                      <Link key={w.animal_id} href={`/veterinarija/gyvunai/${w.animal_id}`} className="flex items-center justify-between gap-2 px-5 py-2.5 hover:bg-surface-secondary/60">
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium text-text-primary">{a?.animal_no ? `Nr. ${a.animal_no}` : w.tag_no}</p>
                          <p className="truncate text-[11.5px] text-text-muted">{a?.group_name ?? w.tag_no}</p>
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-1">
                          {w.milk_active && w.milk_until && <Badge tone="warning">🥛 liko {daysLeft(w.milk_until, today)} d.</Badge>}
                          {w.meat_active && w.meat_until && <Badge tone="danger">🥩 liko {daysLeft(w.meat_until, today)} d.</Badge>}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
              {underWithdrawal.length > shownWithdrawal.length && (
                <div className="border-t border-border px-5 py-3">
                  <Link href="/veterinarija/gyvunai" className="inline-flex items-center gap-1 text-[13px] text-accent-hover hover:underline">
                    Dar {underWithdrawal.length - shownWithdrawal.length} gyvūnai <ArrowRight className="size-3.5" />
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Vizitai: praleisti ir artimiausi</CardTitle>
              <Link href="/veterinarija/vizitai" className="inline-flex items-center gap-1 text-[13px] text-accent-hover hover:underline">
                Visi <ArrowRight className="size-3.5" />
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              {visitList.length === 0 ? (
                <EmptyState icon={CalendarClock} title="Artimiausių vizitų nėra" className="py-10" />
              ) : (
                <div className="divide-y divide-border">
                  {visitList.map((v) => {
                    const late = dayOf(v) < today;
                    return (
                      <Link key={v.id} href={`/veterinarija/gyvunai/${v.animal_id}`} className="flex items-center justify-between gap-2 px-5 py-2.5 hover:bg-surface-secondary/60">
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium text-text-primary">{animalName(v.animals)}</p>
                          <p className="truncate text-[11.5px] text-text-muted">
                            {v.sync_step_title
                              ? `Sinchronizacija ${v.sync_step_no ?? ""}/${v.sync_step_total ?? ""} · ${v.sync_step_title}`
                              : v.procedures.map((p) => VISIT_PROCEDURE_LABELS[p] ?? p).join(", ")}
                          </p>
                        </div>
                        <Badge tone={late ? "danger" : dayOf(v) === today ? "warning" : "info"}>{late ? `praleistas ${formatDate(dayOf(v))}` : formatDate(dayOf(v))}</Badge>
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Naujausi gydymai</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {treatmentRows.length === 0 ? (
                <EmptyState icon={Syringe} title="Gydymų dar nėra" className="py-10" />
              ) : (
                <div className="divide-y divide-border">
                  {treatmentRows.map((t) => (
                    <div key={t.id} className="flex items-center justify-between px-5 py-3">
                      <div>
                        <p className="text-[14px] font-medium text-text-primary">{animalName(t.animals)}</p>
                        <p className="text-[12px] text-text-muted">
                          {t.diagnosis ?? "Diagnozė nenurodyta"} · {formatDate(t.reg_date)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-border px-5 py-3">
                <Link href="/veterinarija/gydymo-istorija" className="inline-flex items-center gap-1 text-[13px] text-accent-hover hover:underline">
                  Visa gydymų istorija <ArrowRight className="size-3.5" />
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Atsargų perspėjimai</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {lowStock.length === 0 ? (
                <EmptyState icon={Boxes} title="Atsargų lygis normalus" className="py-10" />
              ) : (
                <div className="divide-y divide-border">
                  {lowStock.map((s) => (
                    <div key={s.product_id} className="flex items-center justify-between px-5 py-3">
                      <span className="text-[14px] text-text-primary">{s.product_name}</span>
                      <Badge tone="warning">
                        {s.qty_left} {s.unit}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-border px-5 py-3">
                <Link href="/apskaita" className="inline-flex items-center gap-1 text-[13px] text-accent-hover hover:underline">
                  Išlaidos ir atsargos <ArrowRight className="size-3.5" />
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

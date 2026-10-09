import Link from "next/link";
import { AlertTriangle, ArrowRight, Boxes, FileText, PackagePlus, TrendingDown, Wallet } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { BarList, ChartCard, ColumnChart, PeriodTabs, StatCard, type BarRow } from "@/components/analitika/charts";
import { monthStarts, resolvePeriod } from "@/lib/analytics-period";
import { loadMoneyOverview } from "@/lib/money-overview";
import { PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";
import { formatDate, formatEur, formatQty } from "@/lib/utils";
import type { ProductCategory } from "@/lib/supabase/types";

const categoryLabel = (c: string) => PRODUCT_CATEGORY_LABELS[c as ProductCategory] ?? c;

// Apskaita "Pagrindinis" (farm's request, 2026-10; 0032_analytics.sql): what was
// spent (stock consumed, valued at the batches' per-unit purchase price), what
// was bought, and what is on hand — usable vs expired. Aggregated in the
// database (analytics_* functions, vw_stock_*), so it is not row-capped.
export default async function ApskaitaDashboardPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const period = resolvePeriod(sp.period, "12m");
  const supabase = await createClient();

  const [money, alertsRes, stockByProductRes, invoicesRes] = await Promise.all([
    loadMoneyOverview(supabase, period),
    supabase.from("vw_stock_batch_alerts").select("*").limit(30),
    supabase.from("stock_by_product").select("*"),
    supabase.from("invoices").select("id", { count: "exact", head: true }).gte("invoice_date", period.from).lte("invoice_date", period.to),
  ]);

  const { monthly, byCategory, top, stock, consumed, usableValue, expiredValue, expiredBatches, unpriced } = money;
  const alerts = alertsRes.data ?? [];
  const lowStock = (stockByProductRes.data ?? []).filter((s) => s.min_stock_alert != null && s.qty_left <= s.min_stock_alert);

  const months = monthStarts(period.from, period.to);
  const monthData: Record<string, Record<string, number>> = {};
  for (const m of monthly) monthData[m.month] = { purchased: Number(m.purchased), consumed: Number(m.consumed) };

  const spendRows: BarRow[] = byCategory
    .filter((c) => Number(c.spent) > 0)
    .map((c) => ({ key: c.category, label: categoryLabel(c.category), sublabel: `${c.uses} nurašymų`, value: Number(c.spent), valueLabel: formatEur(Number(c.spent)) }));
  const stockRows: BarRow[] = stock
    .filter((c) => c.usable_value > 0 || c.expired_value > 0)
    .map((c) => ({
      key: c.category,
      label: categoryLabel(c.category),
      sublabel: c.expired_value > 0 ? `Iš jų pasibaigę: ${formatEur(Number(c.expired_value))} (${c.expired_batches} part.)` : `${c.usable_batches} part.`,
      value: Number(c.usable_value) + Number(c.expired_value),
      valueLabel: formatEur(Number(c.usable_value) + Number(c.expired_value)),
    }));
  const topRows: BarRow[] = top.map((p) => ({
    key: p.product_id,
    label: p.product_name,
    sublabel: `${formatQty(Number(p.qty), p.unit)} · ${categoryLabel(p.category)}${p.is_antimicrobial ? " · antimikrobinis" : ""}`,
    value: Number(p.spent),
    valueLabel: formatEur(Number(p.spent)),
  }));

  return (
    <>
      <PageHeader title="Pagrindinis" description={`Išlaidos ir atsargos — ${formatDate(period.from)} – ${formatDate(period.to)}`} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <PeriodTabs basePath="/apskaita" current={period.key} />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon={TrendingDown} label="Išleista (sunaudota)" value={formatEur(consumed)} hint={`atsargų vertė · ${period.label}`} />
          <StatCard icon={Wallet} label="Turima atsargų" value={formatEur(usableValue)} hint="tinkamų naudoti" href="/apskaita/atsargos" />
          <StatCard
            icon={AlertTriangle}
            label="Pasibaigusių vertė"
            value={formatEur(expiredValue)}
            hint={expiredBatches > 0 ? `${expiredBatches} part. nurašytinos` : "nėra"}
            tone={expiredBatches > 0 ? "danger" : undefined}
          />
          <StatCard icon={FileText} label="Sąskaitos faktūros" value={String(invoicesRes.count ?? 0)} hint={period.label} />
        </div>
        {unpriced > 0 && (
          <p className="flex items-center gap-2 rounded-control bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
            <AlertTriangle className="size-4 shrink-0" /> {unpriced} partijų be pirkimo kainos — jos skaičiuojamos kaip 0 €, todėl sumos gali būti nepilnos.
          </p>
        )}

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

        <div className="grid gap-6 lg:grid-cols-2">
          <ChartCard title="Kiek išleista pagal kategoriją" subtitle={`Sunaudota ${period.label}`}>
            <BarList rows={spendRows} empty="Šiuo laikotarpiu sunaudojimo nėra" />
          </ChartCard>
          <ChartCard title="Kiek turima pagal kategoriją" subtitle="Dabartinių atsargų vertė (kartu su pasibaigusiomis)">
            <BarList rows={stockRows} color="var(--accent-alt)" empty="Atsargų nėra" />
          </ChartCard>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <ChartCard title="Daugiausiai išleista produktams" subtitle={`Top 8 pagal sunaudojimo vertę · ${period.label}`}>
            <BarList rows={topRows} empty="Šiuo laikotarpiu sunaudojimo nėra" />
          </ChartCard>

          <Card>
            <CardHeader>
              <CardTitle>Galiojimas ir likučiai</CardTitle>
              <Link href="/apskaita/atsargos" className="inline-flex items-center gap-1 text-[13px] text-accent-hover hover:underline">
                Visos atsargos <ArrowRight className="size-3.5" />
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              {alerts.length === 0 && lowStock.length === 0 ? (
                <EmptyState icon={Boxes} title="Pasibaigiančių partijų ir mažų likučių nėra" className="py-10" />
              ) : (
                <div className="divide-y divide-border">
                  {alerts.map((a) => (
                    <div key={a.batch_id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-text-primary">{a.product_name}</p>
                        <p className="text-[11.5px] text-text-muted">
                          Serija {a.lot ?? "—"} · {formatQty(Number(a.qty_left), a.unit)} · {formatEur(Number(a.value))}
                        </p>
                      </div>
                      <Badge tone={a.days_left < 0 ? "danger" : "warning"}>
                        {a.days_left < 0 ? `pasibaigė ${formatDate(a.expiry_date)}` : `iki ${formatDate(a.expiry_date)} (${a.days_left} d.)`}
                      </Badge>
                    </div>
                  ))}
                  {lowStock.map((s) => (
                    <div key={s.product_id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                      <span className="truncate text-[13px] text-text-primary">{s.product_name}</span>
                      <Badge tone="warning">
                        mažai: {formatQty(Number(s.qty_left), s.unit)}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <p className="flex items-center gap-1.5 text-[12px] text-text-muted">
          <PackagePlus className="size-3.5" /> Vertės = kiekis × partijos pirkimo kaina už vienetą. Naujos prekės pridedamos per Pajamavimą.
        </p>
      </div>
    </>
  );
}

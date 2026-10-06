import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils";
import { PawPrint, AlertTriangle, Boxes, RefreshCw, ArrowRight, Stethoscope, Repeat } from "lucide-react";

export default async function VeterinarijaDashboardPage() {
  const session = await getCurrentProfile();
  const supabase = await createClient();

  const today = new Date().toISOString().slice(0, 10);
  const [{ data: withdrawalActive }, { data: stock }, { data: recentTreatments }, { count: pendingSyncCount }, { count: dueDoseCount }] =
    await Promise.all([
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
    ]);

  const lowStock = (stock ?? []).filter((s) => s.min_stock_alert != null && s.qty_left <= s.min_stock_alert);

  type TreatmentRow = { id: string; reg_date: string; diagnosis: string | null; animals: { tag_no: string; animal_no: string | null } | null };
  const treatmentRows = (recentTreatments ?? []) as unknown as TreatmentRow[];

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Pagrindinis"
        description={session ? `Sveiki, ${session.profile.full_name?.split(" ")[0] ?? session.email}` : undefined}
      />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon={PawPrint} label="Aktyvi karencija" value={String((withdrawalActive ?? []).length)} />
          <StatCard
            icon={AlertTriangle}
            label="Mažai atsargų"
            value={String(lowStock.length)}
            tone={lowStock.length > 0 ? "warning" : undefined}
          />
          <StatCard
            icon={Repeat}
            label="Kurso dozės šiandien"
            value={String(dueDoseCount ?? 0)}
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
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <Card>
            <CardHeader>
              <CardTitle>Naujausi gydymai</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {treatmentRows.length === 0 ? (
                <EmptyState icon={Stethoscope} title="Gydymų dar nėra" className="py-10" />
              ) : (
                <div className="divide-y divide-border">
                  {treatmentRows.map((t) => (
                    <div key={t.id} className="flex items-center justify-between px-5 py-3">
                      <div>
                        <p className="text-[14px] font-medium text-text-primary">
                          {t.animals ? (t.animals.animal_no ? `Nr. ${t.animals.animal_no}` : t.animals.tag_no) : "—"}
                        </p>
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
                <Link href="/apskaita/atsargos" className="inline-flex items-center gap-1 text-[13px] text-accent-hover hover:underline">
                  Visos atsargos <ArrowRight className="size-3.5" />
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone?: "warning";
  href?: string;
}) {
  const body = (
    <div className="h-full rounded-panel border border-border bg-surface p-5 transition-colors hover:border-border-strong">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[13px] text-text-secondary">{label}</p>
        <Icon className={`size-4 ${tone === "warning" ? "text-warning" : "text-text-muted"}`} />
      </div>
      <p className="text-[28px] font-display font-bold tabular-nums tracking-tight text-text-primary">{value}</p>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

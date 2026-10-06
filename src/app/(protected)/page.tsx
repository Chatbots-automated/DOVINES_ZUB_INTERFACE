import Link from "next/link";
import { ArrowRight, Calculator, Stethoscope } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/profile";
import { BrandMark } from "@/components/layout/brand-mark";
import { SignOutButton } from "@/components/layout/sign-out-button";
import { formatEur } from "@/lib/utils";
import { FARM_NAME, PRODUCT_NAME } from "@/lib/brand";

// Not a render-purity concern — computed once per request to bound the
// month-scoped KPI query below.
function getMonthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

// Same dark "ink" hero as the login screen (BrandMark dark/lg, rippled-water
// backdrop) — the other gateway screen, so it gets the same branded moment.
export default async function ModuleSelectorPage() {
  const session = await getCurrentProfile();
  const displayName = session?.profile.full_name || session?.email || "";
  const supabase = await createClient();
  const monthStart = getMonthStart();

  const [animalsRes, withdrawalRes, invoicesRes, productsRes] = await Promise.all([
    supabase.from("animals").select("id", { count: "exact", head: true }).eq("active", true),
    supabase.from("vw_withdrawal_status").select("animal_id").or("milk_active.eq.true,meat_active.eq.true"),
    supabase.from("invoices").select("total_gross").gte("invoice_date", monthStart),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("is_active", true),
  ]);

  const activeAnimals = animalsRes.count ?? 0;
  const activeWithdrawal = (withdrawalRes.data ?? []).length;
  const monthSpend = (invoicesRes.data ?? []).reduce((sum, inv) => sum + (inv.total_gross ?? 0), 0);
  const activeProducts = productsRes.count ?? 0;

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-ink px-4 py-8">
      <div
        aria-hidden
        className="bg-ripples pointer-events-none absolute inset-0 opacity-[0.05]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 size-[640px] -translate-x-1/2 rounded-full bg-accent/25 blur-[120px]"
      />

      <div className="relative z-10 mx-auto flex w-full max-w-3xl items-center justify-end">
        <div className="flex items-center gap-3">
          {session && (
            <div className="text-right">
              <p className="text-[13px] font-medium text-text-on-ink">{displayName}</p>
              <p className="text-[11px] text-text-on-ink/50">{roleLabel(session.profile.role)}</p>
            </div>
          )}
          <SignOutButton />
        </div>
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-10 py-8">
        <div className="flex flex-col items-center gap-4">
          <BrandMark dark size="lg" />
          <p className="text-[14px] text-text-on-ink/55">Pasirinkite modulį</p>
        </div>

        <div className="grid w-full gap-5 sm:grid-cols-2">
          <ModuleCard
            href="/veterinarija"
            icon={Stethoscope}
            title="Veterinarija"
            subtitle="Gyvūnų sveikata ir gydymas"
            bg="bg-accent"
            stats={[
              { label: "Aktyvūs gyvūnai", value: String(activeAnimals) },
              { label: "Aktyvi karencija", value: String(activeWithdrawal) },
            ]}
          />
          <ModuleCard
            href="/apskaita"
            icon={Calculator}
            title="Apskaita"
            subtitle="Pajamavimas, atsargos, žurnalai, nurašymo aktai"
            bg="bg-accent-alt"
            stats={[
              { label: "Pajamavimas šį mėn.", value: formatEur(monthSpend) },
              { label: "Aktyvūs produktai", value: String(activeProducts) },
            ]}
          />
        </div>
      </div>

      <p className="relative z-10 mx-auto w-full max-w-3xl text-center text-[12px] text-text-on-ink/35">
        {PRODUCT_NAME} · {FARM_NAME}
      </p>
    </div>
  );
}

function ModuleCard({
  href,
  icon: Icon,
  title,
  subtitle,
  bg,
  stats,
}: {
  href: string;
  icon: typeof Stethoscope;
  title: string;
  subtitle: string;
  bg: string;
  stats: { label: string; value: string }[];
}) {
  return (
    <Link
      href={href}
      className={`group relative flex flex-col overflow-hidden rounded-panel p-6 shadow-elevated transition-all hover:-translate-y-1 ${bg}`}
    >
      <div
        aria-hidden
        className="bg-ripples pointer-events-none absolute inset-x-0 bottom-0 h-24 opacity-[0.12] transition-transform duration-500 group-hover:translate-x-4"
      />

      <div className="relative flex size-12 items-center justify-center rounded-[14px] border border-white/20 bg-white/10 backdrop-blur-sm">
        <Icon className="size-6 text-white" strokeWidth={1.75} />
      </div>

      <h2 className="relative mt-4 text-[24px] font-bold tracking-tight text-white">{title}</h2>
      <p className="relative mt-1 text-[13px] text-white/70">{subtitle}</p>

      <div className="relative mt-6 flex gap-6 border-t border-white/20 pt-4">
        {stats.map((stat) => (
          <div key={stat.label}>
            <p className="font-display text-[20px] font-bold tabular-nums text-white">{stat.value}</p>
            <p className="mt-0.5 text-[11px] text-white/60">{stat.label}</p>
          </div>
        ))}
      </div>

      <div className="relative mt-5 flex items-center gap-1.5 text-[13px] font-semibold text-white">
        Atidaryti
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

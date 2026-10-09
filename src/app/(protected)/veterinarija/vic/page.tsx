import { redirect } from "next/navigation";
import { KeyRound, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { VicLoginKind } from "@/lib/supabase/types";
import { VicSettingsForm } from "@/components/vic/vic-settings-form";
import { formatDateTime } from "@/lib/utils";

// Integracija → VIC — sėklinimo + veterinaro logins, admin only (0013, 0024).
export default async function VicPage() {
  const session = await getCurrentProfile();
  if (session?.profile.role !== "admin") redirect("/veterinarija");

  const supabase = await createClient();
  const [{ data: seklData, error: seklError }, { data: vetData, error: vetError }] = await Promise.all([
    supabase.rpc("vic_get_settings", { p_kind: "seklinimas" }),
    supabase.rpc("vic_get_settings", { p_kind: "veterinaras" }),
  ]);
  const sekl = seklData?.[0] ?? null;
  const current = vetData?.[0] ?? null; // sync status belongs to the veterinarian login
  const { data: runsData } = await supabase.from("vic_sync_runs").select("*").order("created_at", { ascending: false }).limit(7);
  const runs = runsData ?? [];

  return (
    <div className="flex flex-col">
      <PageHeader title="VIC" description="VIC prisijungimo duomenys: sėklinimo ir veterinaro" />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid max-w-6xl gap-6 lg:grid-cols-2 xl:grid-cols-3">
        <LoginCard
          title="Sėklinimo prisijungimai"
          kind="seklinimas"
          current={sekl}
          error={seklError?.message}
        />
        <LoginCard
          title="Veterinaro prisijungimai"
          kind="veterinaras"
          current={current}
          error={vetError?.message}
          hint="Naudojami kasdieniam gyvulių importui iš VIC."
        />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="size-4" /> Kasdienė gyvulių sinchronizacija
              {current?.last_error ? (
                <Badge tone="danger">Klaida</Badge>
              ) : current?.last_sync_at ? (
                <Badge tone="success">Veikia</Badge>
              ) : (
                <Badge tone="warning">Dar nevykdyta</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-[13px] text-text-secondary">
            <p>
              Paskutinė sėkminga: <span className="font-medium text-text-primary">{current?.last_sync_at ? formatDateTime(current.last_sync_at) : "—"}</span>
            </p>
            {current?.last_error && <p className="rounded-control bg-danger-soft px-3 py-2 text-danger">{current.last_error}</p>}
            {runs.length > 0 && (
              <table className="w-full text-left text-[12px]">
                <thead className="text-text-muted">
                  <tr>
                    <th className="py-1 font-medium">Data</th>
                    <th className="py-1 font-medium">Gauta</th>
                    <th className="py-1 font-medium">Nauji</th>
                    <th className="py-1 font-medium">Papildyti</th>
                    <th className="py-1 font-medium">Išjungti</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="py-1">{formatDateTime(r.created_at)}</td>
                      <td className="py-1 tabular-nums">{r.received_rows}</td>
                      <td className="py-1 tabular-nums">{r.inserted}</td>
                      <td className="py-1 tabular-nums">{r.enriched}</td>
                      <td className="py-1 tabular-nums">{r.deactivated}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
        </div>
      </div>
    </div>
  );
}

type Settings = {
  vic_username: string;
  vic_farm_code: string | null;
  password_set: boolean;
  is_active: boolean;
  updated_at: string;
  updated_by_name: string | null;
} | null;

function LoginCard({
  title,
  kind,
  current,
  error,
  hint,
}: {
  title: string;
  kind: VicLoginKind;
  current: Settings;
  error?: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> {title}
          {current ? (
            <Badge tone={current.is_active ? "success" : "neutral"}>{current.is_active ? "Aktyvus" : "Išjungtas"}</Badge>
          ) : (
            <Badge tone="warning">Nesukonfigūruota</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {hint && <p className="text-[12px] text-text-muted">{hint}</p>}
        {error && <p className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
        <VicSettingsForm
          kind={kind}
          username={current?.vic_username ?? ""}
          farmCode={current?.vic_farm_code ?? ""}
          passwordSet={current?.password_set ?? false}
          isActive={current?.is_active ?? true}
        />
        {current && (
          <p className="text-[11px] text-text-muted">
            Paskutinį kartą atnaujinta {formatDateTime(current.updated_at)}
            {current.updated_by_name ? ` · ${current.updated_by_name}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

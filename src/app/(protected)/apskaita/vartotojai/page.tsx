import { redirect } from "next/navigation";
import { getCurrentProfile, roleLabel } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ShieldCheck } from "lucide-react";
import { NewUserDialog } from "@/components/vartotojai/new-user-dialog";
import { UserStatusToggle } from "@/components/vartotojai/user-status-toggle";
import { formatDate } from "@/lib/utils";

export default async function VartotojaiPage() {
  const session = await getCurrentProfile();
  if (!session) redirect("/login");
  if (session.profile.role !== "admin") redirect("/");

  const supabase = await createClient();
  const { data: users } = await supabase.from("users").select("*").order("created_at");

  return (
    <div className="flex flex-col">
      <PageHeader title="Vartotojų valdymas" description="Sistemos vartotojai ir jų rolės" actions={<NewUserDialog />} />
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        {(users ?? []).length === 0 ? (
          <EmptyState icon={ShieldCheck} title="Vartotojų nėra" />
        ) : (
          <div className="overflow-x-auto rounded-panel border border-border bg-surface">
            <table className="w-full min-w-[720px] text-left text-[14px]">
              <thead className="border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-4 py-3 font-medium">Vardas</th>
                  <th className="px-4 py-3 font-medium">El. paštas</th>
                  <th className="px-4 py-3 font-medium">Rolė</th>
                  <th className="px-4 py-3 font-medium">Sukurta</th>
                  <th className="px-4 py-3 font-medium">Būsena</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(users ?? []).map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3 font-medium text-text-primary">{u.full_name ?? "—"}</td>
                    <td className="px-4 py-3 text-text-secondary">{u.email}</td>
                    <td className="px-4 py-3 text-text-secondary">{roleLabel(u.role)}</td>
                    <td className="px-4 py-3 text-text-secondary">{formatDate(u.created_at)}</td>
                    <td className="px-4 py-3">
                      <UserStatusToggle userId={u.id} isFrozen={u.is_frozen} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

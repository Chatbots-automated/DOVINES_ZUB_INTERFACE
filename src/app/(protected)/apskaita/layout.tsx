import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";

export default async function ApskaitaLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentProfile();
  if (!session) redirect("/login");

  return (
    <AppShell profile={session.profile} moduleId="apskaita">
      {children}
    </AppShell>
  );
}

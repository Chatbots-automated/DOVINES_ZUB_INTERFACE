import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";

// Every page under here reads cookies-based auth (getCurrentProfile /
// createClient) and live per-user DB data, so none of it should ever be
// statically prerendered — but opennextjs-netlify's own build-time static
// vs. dynamic detection can disagree with Next.js's (works fine on Vercel
// and locally; only Netlify gets it wrong), which silently breaks Server
// Action POSTs on the misdetected pages with a bare 403
// ("An unexpected response was received from the server.") — confirmed
// live on /apskaita/pajamavimas. Forcing it explicitly here closes that
// off for the whole protected tree at once, not just that one page. See
// https://github.com/opennextjs/opennextjs-netlify/issues/2411.
export const dynamic = "force-dynamic";

// Shared auth gate for the module selector ("/") and both modules
// ("/veterinarija/*", "/apskaita/*"). Each module has its own nested
// layout that renders the AppShell with a module-specific nav; this
// layout only enforces that the user is signed in and active.
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentProfile();
  if (!session) redirect("/login");

  if (session.profile.is_frozen) {
    redirect("/login?deactivated=1");
  }

  return <>{children}</>;
}

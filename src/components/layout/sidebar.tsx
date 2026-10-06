"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { SidebarHeader, SidebarNav } from "@/components/layout/sidebar-nav";
import type { NavGroup, ModuleId } from "@/components/layout/nav-config";
import { roleLabel } from "@/lib/profile";
import type { Profile } from "@/lib/profile";

export function Sidebar({
  profile,
  navGroups,
  moduleId,
  moduleLabel,
}: {
  profile: Profile;
  navGroups: NavGroup[];
  moduleId: ModuleId;
  moduleLabel: string;
}) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <aside className="hidden w-64 shrink-0 flex-col bg-ink lg:flex">
      <SidebarHeader moduleId={moduleId} moduleLabel={moduleLabel} />

      <SidebarNav groups={navGroups} role={profile.role} moduleId={moduleId} />

      <div className="border-t border-ink-line p-3">
        <div className="flex items-center gap-2.5 rounded-control px-2 py-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink-soft font-display text-[13px] font-bold text-text-on-ink ring-1 ring-ink-line">
            {(profile.full_name ?? profile.email).charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-text-on-ink">{profile.full_name ?? profile.email}</p>
            <p className="truncate text-[11px] capitalize text-text-on-ink/45">{roleLabel(profile.role)}</p>
          </div>
          <button
            onClick={signOut}
            title="Atsijungti"
            aria-label="Atsijungti"
            className="shrink-0 rounded-control p-2 text-text-on-ink/50 transition-colors hover:bg-white/[0.06] hover:text-text-on-ink"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

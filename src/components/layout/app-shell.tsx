"use client";

import * as React from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileSidebar } from "@/components/layout/mobile-sidebar";
import { apskaitaNavGroups, vetNavGroups, type ModuleId } from "@/components/layout/nav-config";
import type { Profile } from "@/lib/profile";

export const MobileNavContext = React.createContext<{ open: () => void }>({ open: () => {} });

// `navGroups` holds Lucide icon components (forwardRef exotic objects),
// which can't cross the Server -> Client Component prop boundary. Server
// layouts only pass a plain `moduleId` string; the actual nav config
// (icons included) is resolved here, entirely on the client.
export function AppShell({
  profile,
  moduleId,
  children,
}: {
  profile: Profile;
  moduleId: ModuleId;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const navGroups = moduleId === "veterinarija" ? vetNavGroups : apskaitaNavGroups;
  const moduleLabel = moduleId === "veterinarija" ? "Veterinarija" : "Apskaita";

  return (
    <MobileNavContext.Provider value={{ open: () => setMobileOpen(true) }}>
      <div className="flex h-dvh w-full overflow-hidden">
        <Sidebar profile={profile} navGroups={navGroups} moduleId={moduleId} moduleLabel={moduleLabel} />
        <MobileSidebar
          profile={profile}
          navGroups={navGroups}
          moduleId={moduleId}
          moduleLabel={moduleLabel}
          open={mobileOpen}
          onOpenChange={setMobileOpen}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto scrollbar-thin">{children}</div>
        </div>
      </div>
    </MobileNavContext.Provider>
  );
}

export function useMobileNav() {
  return React.useContext(MobileNavContext);
}

"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { SidebarHeader, SidebarNav } from "@/components/layout/sidebar-nav";
import type { NavGroup, ModuleId } from "@/components/layout/nav-config";
import type { Profile } from "@/lib/profile";

export function MobileSidebar({
  profile,
  navGroups,
  moduleId,
  moduleLabel,
  open,
  onOpenChange,
}: {
  profile: Profile;
  navGroups: NavGroup[];
  moduleId: ModuleId;
  moduleLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/50 backdrop-blur-[2px] lg:hidden" />
        <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-ink lg:hidden">
          <DialogPrimitive.Title className="sr-only">Navigacija</DialogPrimitive.Title>
          <SidebarHeader moduleId={moduleId} moduleLabel={moduleLabel} onNavigate={() => onOpenChange(false)} />
          <SidebarNav groups={navGroups} role={profile.role} moduleId={moduleId} onNavigate={() => onOpenChange(false)} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

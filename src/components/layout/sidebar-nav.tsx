"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, Calculator, Stethoscope } from "lucide-react";
import { cn } from "@/lib/utils";
import { moduleTheme, type NavGroup, type ModuleId } from "@/components/layout/nav-config";
import type { Profile } from "@/lib/profile";
import { FARM_NAME } from "@/lib/brand";

type UserRole = Profile["role"];

function isActivePath(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

// Top of the dark sidebar (desktop + mobile): module badge, farm name, and
// the way back to the module picker.
export function SidebarHeader({
  moduleId,
  moduleLabel,
  onNavigate,
}: {
  moduleId: ModuleId;
  moduleLabel: string;
  onNavigate?: () => void;
}) {
  const ModuleIcon = moduleId === "veterinarija" ? Stethoscope : Calculator;
  const theme = moduleTheme[moduleId];

  return (
    <div className="px-4 pt-5 pb-3">
      <div className="flex items-center gap-3 px-1">
        <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-[12px]", theme.badge)}>
          <ModuleIcon className="size-5 text-white" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <p className="truncate font-display text-[16px] font-bold leading-tight tracking-tight text-text-on-ink">
            {FARM_NAME}
          </p>
          <p className={cn("text-[12px] font-medium", theme.icon)}>{moduleLabel}</p>
        </div>
      </div>

      <Link
        href="/"
        onClick={onNavigate}
        className="mt-4 flex items-center justify-between rounded-control border border-ink-line px-3 py-2 text-[13px] font-medium text-text-on-ink/70 transition-colors hover:border-text-on-ink/30 hover:text-text-on-ink"
      >
        Keisti modulį
        <ArrowLeftRight className="size-3.5" />
      </Link>
    </div>
  );
}

// Dark sidebar nav list — group labels as small eyebrows, active item gets a
// translucent fill plus a module-coloured bar on its left edge.
export function SidebarNav({
  groups,
  role,
  moduleId,
  onNavigate,
}: {
  groups: NavGroup[];
  role: UserRole;
  moduleId: ModuleId;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const theme = moduleTheme[moduleId];

  return (
    <nav className="flex-1 overflow-y-auto scrollbar-thin px-3 py-2">
      {groups.map((group, groupIdx) => {
        const items = group.items.filter((item) => !item.minRole || item.minRole === role);
        if (items.length === 0) return null;
        return (
          <div key={group.id} className={cn(groupIdx > 0 && "mt-5")}>
            <p className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-text-on-ink/35">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {items.map((item) => {
                const exact = item.href === "/veterinarija" || item.href === "/apskaita";
                const active = isActivePath(pathname, item.href, exact);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      "relative flex items-center gap-3 rounded-control px-3 py-2 text-[14px] font-medium transition-colors",
                      active
                        ? "bg-white/[0.08] text-white"
                        : "text-text-on-ink/65 hover:bg-white/[0.04] hover:text-text-on-ink",
                    )}
                  >
                    {active && (
                      <span className={cn("absolute inset-y-2 left-0 w-[3px] rounded-full", theme.bar)} aria-hidden />
                    )}
                    <Icon className={cn("size-[17px] shrink-0", active ? theme.icon : "text-text-on-ink/40")} />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

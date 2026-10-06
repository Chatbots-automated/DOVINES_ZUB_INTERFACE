"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMobileNav } from "@/components/layout/app-shell";

export function PageHeader({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  const { open } = useMobileNav();
  const isApskaita = usePathname().startsWith("/apskaita");

  return (
    <div className={cn("border-b border-border bg-surface px-4 py-5 sm:px-6 lg:px-8", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <button
            onClick={open}
            className="mt-0.5 shrink-0 rounded-control p-1.5 text-text-secondary hover:bg-surface-secondary lg:hidden"
          >
            <Menu className="size-5" />
          </button>
          <div className="min-w-0">
            <p
              className={cn(
                "mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em]",
                isApskaita ? "text-accent-alt" : "text-accent",
              )}
            >
              <span className={cn("size-1.5 rounded-full", isApskaita ? "bg-accent-alt" : "bg-accent")} aria-hidden />
              {isApskaita ? "Apskaita" : "Veterinarija"}
            </p>
            <h1 className="text-[22px] font-bold leading-tight tracking-tight text-text-primary sm:text-[26px]">{title}</h1>
            {description && <p className="mt-1 text-[13px] text-text-secondary">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

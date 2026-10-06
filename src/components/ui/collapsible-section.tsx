"use client";

import * as React from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function CollapsibleSection({
  title,
  icon: Icon,
  badge,
  defaultOpen = true,
  className,
  children,
}: {
  title: React.ReactNode;
  icon?: LucideIcon;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className={cn("overflow-hidden rounded-panel border border-border", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 bg-surface-secondary px-4 py-2.5 text-left transition-colors hover:bg-surface-secondary/70"
      >
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-text-primary">
          {Icon && <Icon className="size-4 shrink-0 text-text-muted" />}
          <span className="truncate">{title}</span>
          {badge}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="p-4">{children}</div>}
    </div>
  );
}

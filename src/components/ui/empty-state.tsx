import * as React from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-16 text-center", className)}>
      {Icon && (
        <div className="mb-2 flex size-11 items-center justify-center rounded-full bg-accent-soft">
          <Icon className="size-5 text-accent-hover" />
        </div>
      )}
      <p className="text-[15px] font-medium text-text-primary">{title}</p>
      {description && <p className="max-w-sm text-[13px] text-text-secondary">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

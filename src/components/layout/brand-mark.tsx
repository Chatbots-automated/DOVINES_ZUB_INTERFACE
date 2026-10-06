import { cn } from "@/lib/utils";
import { FARM_NAME, PRODUCT_NAME } from "@/lib/brand";

/**
 * Dovinės ŽŪB glyph — a milk drop with a ripple through it (dairy farm on
 * the Dovinė). Drawn in currentColor so it can sit on any badge. Same
 * geometry as src/app/icon.svg; change both together.
 */
export function DropGlyph({ className, strokeWidth = 1.75 }: { className?: string; strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 2.75c-2.9 3.6-6.75 8.2-6.75 11.9a6.75 6.75 0 0 0 13.5 0c0-3.7-3.85-8.3-6.75-11.9Z" />
      <path d="M7.9 15.4c1.05 0 1.05-.9 2.05-.9s1.05.9 2.05.9 1.05-.9 2.05-.9 1.05.9 2.05.9" />
    </svg>
  );
}

/**
 * Dovinės ŽŪB brand mark: squircle badge with the drop glyph + wordmark.
 * No farm logo supplied yet; if one arrives, swap the badge for an <Image>.
 */
export function BrandMark({
  collapsed,
  dark,
  size = "sm",
}: {
  collapsed?: boolean;
  dark?: boolean;
  size?: "sm" | "lg";
}) {
  if (size === "lg") {
    return (
      <div className="flex flex-col items-center gap-4">
        <div className="relative flex size-20 shrink-0 items-center justify-center rounded-[28px] bg-accent shadow-elevated ring-1 ring-white/15">
          <DropGlyph className="size-10 text-white" strokeWidth={1.5} />
        </div>
        <div className="text-center">
          <p
            className={cn(
              "font-display text-[26px] font-bold leading-none tracking-tight",
              dark ? "text-text-on-ink" : "text-text-primary",
            )}
          >
            {FARM_NAME}
          </p>
          <p
            className={cn(
              "mt-2 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.28em]",
              dark ? "text-accent-border" : "text-accent",
            )}
          >
            <span className="h-px w-5 bg-current opacity-60" aria-hidden />
            {PRODUCT_NAME}
            <span className="h-px w-5 bg-current opacity-60" aria-hidden />
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 overflow-hidden">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-accent">
        <DropGlyph className="size-5 text-white" />
      </div>
      {!collapsed && (
        <span
          className={cn(
            "truncate font-display text-[17px] font-bold leading-tight tracking-tight",
            dark ? "text-text-on-ink" : "text-text-primary",
          )}
        >
          {FARM_NAME}
        </span>
      )}
    </div>
  );
}

"use client";

import * as React from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  sublabel?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Pasirinkite...",
  disabled,
  className,
}: {
  options: ComboboxOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);

  // Defensive de-dup by value: callers occasionally hand us an `options`
  // array with the same value twice for a moment (e.g. an inline "create
  // new" flow that optimistically appends the new row locally right
  // before/after a server revalidation delivers the same row again) —
  // rendering both would violate React's unique-key requirement.
  const dedupedOptions = React.useMemo(() => {
    const seen = new Set<string>();
    return options.filter((o) => {
      if (seen.has(o.value)) return false;
      seen.add(o.value);
      return true;
    });
  }, [options]);

  const selected = dedupedOptions.find((o) => o.value === value);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return dedupedOptions;
    const q = query.toLowerCase();
    return dedupedOptions.filter(
      (o) => o.label.toLowerCase().includes(q) || o.sublabel?.toLowerCase().includes(q),
    );
  }, [dedupedOptions, query]);

  React.useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-control border border-border-strong bg-surface px-3 text-left text-[14px] disabled:opacity-50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
        )}
      >
        <span className={cn("truncate", !selected && "text-text-muted")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className="size-4 shrink-0 text-text-muted" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-panel border border-border bg-surface shadow-popover">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-3.5 text-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ieškoti..."
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-text-muted"
            />
          </div>
          <div className="max-h-64 overflow-y-auto scrollbar-thin py-1">
            {filtered.length === 0 && (
              <div className="px-3 py-3 text-[13px] text-text-muted">Nerasta rezultatų</div>
            )}
            {filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  setQuery("");
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[14px] hover:bg-surface-secondary"
              >
                <span>
                  <span className="block text-text-primary">{option.label}</span>
                  {option.sublabel && <span className="block text-[12px] text-text-muted">{option.sublabel}</span>}
                </span>
                {option.value === value && <Check className="size-4 shrink-0 text-accent" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

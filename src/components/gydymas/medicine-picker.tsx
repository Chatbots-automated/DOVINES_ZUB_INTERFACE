"use client";

import * as React from "react";
import { Check, ChevronDown, Search, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate, formatQty } from "@/lib/utils";
import type { CatalogProduct } from "@/lib/treatments/planner";
import { PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";
import type { ProductCategory } from "@/lib/supabase/types";

/** "12 ml" / "Atsargų nėra" chip tone for a product's usable stock. */
export function stockTone(product: CatalogProduct): "success" | "warning" | "danger" | "neutral" {
  if (product.usable_qty === null) return "neutral";
  if (product.usable_qty <= 0) return "danger";
  return "success";
}

/**
 * Searchable product picker for treatments: only products with usable
 * (non-expired) stock are offered, each row showing the stock left, the
 * lot FEFO would take first, its expiry and an antimicrobial flag. The
 * currently selected product stays visible even if its stock ran out.
 */
export function MedicinePicker({
  catalog,
  value,
  onChange,
  loading,
  compact,
  placeholder = "Ieškoti vaisto...",
}: {
  catalog: CatalogProduct[];
  value: string;
  onChange: (id: string) => void;
  loading?: boolean;
  compact?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const selected = catalog.find((p) => p.id === value);
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((p) => {
      if (p.usable_qty !== null && p.usable_qty <= 0 && p.id !== value) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || (p.active_substance ?? "").toLowerCase().includes(q);
    });
  }, [catalog, query, value]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-control border border-border-strong bg-surface px-3 text-left text-[14px]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
          compact ? "h-8" : "h-9",
        )}
      >
        <span className={cn("flex min-w-0 items-center gap-2", !selected && "text-text-muted")}>
          <span className="truncate">{selected ? selected.name : loading ? "Kraunami vaistai..." : placeholder}</span>
          {selected?.is_antimicrobial && <ShieldAlert className="size-3.5 shrink-0 text-danger" aria-label="Antimikrobinis" />}
        </span>
        <ChevronDown className="size-4 shrink-0 text-text-muted" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[300px] overflow-hidden rounded-panel border border-border bg-surface shadow-popover">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-3.5 text-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Pavadinimas arba veiklioji medžiaga..."
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-text-muted"
            />
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin py-1">
            {filtered.length === 0 && (
              <div className="px-3 py-3 text-[13px] text-text-muted">
                {loading ? "Kraunama..." : "Nerasta vaistų su atsargomis"}
              </div>
            )}
            {filtered.map((p) => {
              const first = p.lots[0];
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onChange(p.id);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-accent-soft/60"
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[14px] font-medium text-text-primary">{p.name}</span>
                      {p.is_antimicrobial && (
                        <Badge tone="danger" className="px-1.5 py-0 text-[10.5px]">
                          Antimikrobinis
                        </Badge>
                      )}
                      {p.category && p.category !== "medicines" && (
                        <Badge tone="info" className="px-1.5 py-0 text-[10.5px]">
                          {PRODUCT_CATEGORY_LABELS[p.category as ProductCategory] ?? p.category}
                        </Badge>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] text-text-muted">
                      {first ? (
                        <>
                          FEFO partija {first.lot ?? "—"} · galioja iki {formatDate(first.expiry_date)}
                        </>
                      ) : p.usable_qty === null ? (
                        "Atsargų informacija nepasiekiama"
                      ) : (
                        "Nėra galiojančių atsargų"
                      )}
                      {p.active_substance && <> · {p.active_substance}</>}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {p.usable_qty !== null && (
                      <Badge tone={p.usable_qty > 0 ? "success" : "danger"}>{formatQty(p.usable_qty, p.unit)}</Badge>
                    )}
                    {p.id === value && <Check className="size-4 text-accent" />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

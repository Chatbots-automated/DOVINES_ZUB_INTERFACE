"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Syringe } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/gydymo-kursai/administer-dose-impl";

/**
 * "Skirti dozę" — administers one planned dose, or (with `doseIds`) every
 * dose of a course day, one request each through the existing Route
 * Handler (stock is deducted FEFO per dose, in its own transaction).
 */
export function AdministerDoseButton({
  doseId,
  doseIds,
  label,
  variant = "outline",
}: {
  doseId?: string;
  doseIds?: string[];
  label?: string;
  variant?: "outline" | "primary" | "danger";
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ids = doseIds ?? (doseId ? [doseId] : []);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      for (const id of ids) {
        const response = await fetch("/api/gydymo-kursai/administer-dose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doseId: id }),
        });
        const result: ActionResult = await response.json();
        if (!result.ok) {
          setError(result.error);
          break;
        }
      }
    } catch (err) {
      console.error("[AdministerDoseButton] request failed:", err);
      setError(err instanceof Error ? err.message : "Nepavyko suteikti dozės. Bandykite dar kartą.");
    } finally {
      setPending(false);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant={variant} onClick={handleClick} disabled={pending || ids.length === 0}>
        <Syringe className="size-4" />
        {pending ? "Suteikiama..." : (label ?? "Skirti dozę")}
      </Button>
      {error && <p className="max-w-[260px] text-right text-[11px] text-danger">{error}</p>}
    </div>
  );
}

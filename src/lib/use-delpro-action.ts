"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import type { DelproActionResult } from "@/lib/actions/delpro";
import type { DelproOp } from "@/lib/delpro-ops";

/**
 * Drop-in for useActionState(serverAction, null) on the DelPro screens: the
 * form's FormData goes to /api/delpro/action (see src/lib/delpro-ops.ts) and
 * the page is refreshed after a successful change. Any non-JSON answer
 * (redirect to the login page, proxy error) becomes a readable error instead
 * of a crash.
 */
export function useDelproAction(op: DelproOp) {
  const router = useRouter();
  return useActionState<DelproActionResult | null, FormData>(async (_prev, formData) => {
    formData.set("_op", op);
    let res: Response;
    try {
      res = await fetch("/api/delpro/action", { method: "POST", body: formData, credentials: "same-origin" });
    } catch {
      return { ok: false, error: "Nepavyko susisiekti su serveriu." };
    }
    const json = (await res.json().catch(() => null)) as DelproActionResult | null;
    if (!json || typeof json.ok !== "boolean") {
      return {
        ok: false,
        error: res.redirected && new URL(res.url).pathname.startsWith("/login") ? "Sesija baigėsi — prisijunkite iš naujo." : `Serverio klaida (HTTP ${res.status}).`,
      };
    }
    if (json.ok) router.refresh();
    return json;
  }, null);
}

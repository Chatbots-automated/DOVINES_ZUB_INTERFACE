"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/vartotojai/set-user-frozen-impl";

export function UserStatusToggle({ userId, isFrozen }: { userId: string; isFrozen: boolean }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function toggle() {
    setPending(true);
    try {
      const response = await fetch("/api/vartotojai/set-frozen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, isFrozen: !isFrozen }),
      });
      const result: ActionResult = await response.json();
      if (result.ok) router.refresh();
    } catch (err) {
      console.error("[UserStatusToggle] request failed:", err);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Badge tone={isFrozen ? "danger" : "success"}>{isFrozen ? "Užšaldyta" : "Aktyvi"}</Badge>
      <Button size="sm" variant="outline" disabled={pending} onClick={toggle}>
        {isFrozen ? "Atšaldyti" : "Užšaldyti"}
      </Button>
    </div>
  );
}

"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      onClick={signOut}
      className={cn(
        "inline-flex items-center gap-2 rounded-control px-3 py-2 text-[13px] font-medium text-text-on-ink/60 transition-colors hover:bg-ink-soft hover:text-text-on-ink",
        className,
      )}
    >
      <LogOut className="size-4" />
      Atsijungti
    </button>
  );
}

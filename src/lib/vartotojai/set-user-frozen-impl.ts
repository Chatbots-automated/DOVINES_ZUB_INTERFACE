import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

// Deliberately NOT a Server Action — see the big comment in
// src/lib/pajamavimas/batch-impl.ts for why (called directly from
// user-status-toggle.tsx, not via useActionState + <form action>, so it's
// exposed to the same Netlify Server-Action-POST-dropping bug).

// Freeze/unfreeze an account (blocks login via fn_is_authenticated_active()/
// fn_is_active_staff() in RLS) without deleting its history.
export async function setUserFrozenImpl(userId: string, isFrozen: boolean): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user: currentUser },
  } = await supabase.auth.getUser();
  if (!currentUser) return { ok: false, error: "Neprisijungęs vartotojas." };

  const { data: currentProfile } = await supabase.from("users").select("role").eq("id", currentUser.id).single();
  if (currentProfile?.role !== "admin") {
    return { ok: false, error: "Tik administratorius gali valdyti vartotojus." };
  }

  const { error } = await supabase.from("users").update({ is_frozen: isFrozen }).eq("id", userId);
  if (error) {
    console.error("[vartotojai] freeze toggle failed:", error);
    return { ok: false, error: "Nepavyko atnaujinti vartotojo būsenos." };
  }

  return { ok: true };
}

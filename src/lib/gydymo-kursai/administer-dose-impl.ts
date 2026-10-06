import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Deliberately NOT a Server Action ("use server") — see the big comment in
 * src/lib/pajamavimas/batch-impl.ts for why: a Server Action called
 * directly (not via useActionState + <form action>) risks Netlify silently
 * dropping the POST (empty-body 403). Called via a Route Handler instead.
 */

// "Suteikti dozę" — marks one planned course day as given. Stock is deducted
// now (FEFO at administration time — the batch on hand in N days isn't
// known up front), in the same transaction (administer_course_dose, 0004).
export async function administerCourseDoseImpl(doseId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("administer_course_dose", { p_dose_id: doseId });
  if (error) {
    console.error("[gydymo-kursai] administer_course_dose failed:", error);
    return { ok: false, error: error.message || "Nepavyko pažymėti dozės." };
  }
  return { ok: true };
}

import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/profile";

export type { Profile };
export { roleLabel } from "@/lib/profile";

type Session = { userId: string; email: string | null; profile: Profile };

// Web-standard base64 decode matching encodeSessionHeader() in
// src/lib/supabase/middleware.ts.
function decodeSessionHeader(encoded: string): Session | null {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes)) as Session;
  } catch {
    return null;
  }
}

// Wrapped in React's cache() so the (fallback-path) Supabase round-trips
// this does happen at most ONCE per request, no matter how many Server
// Components call getCurrentProfile() in the same render tree — before
// this, a single page load could trigger it 2-3x (the root protected
// layout, the module layout, and often the page itself all called it
// independently), each redundant call being pure added latency.
//
// The actual fast path reads the session middleware (src/lib/supabase/
// middleware.ts) already fetched for this exact request from a forwarded
// header instead of hitting Supabase again at all — middleware runs as a
// separate Edge Function invocation on Netlify, so cache() alone can't
// dedupe across that boundary; the header is what closes the gap. Together
// this took navigation from up to ~4 redundant Supabase round-trips down
// to the 1 middleware already needed to do — the main cause of navigation
// feeling sluggish compared to sibling projects that don't repeat this
// check.
export const getCurrentProfile = cache(async (): Promise<Session | null> => {
  const forwarded = (await headers()).get("x-zub-session");
  if (forwarded) {
    const session = decodeSessionHeader(forwarded);
    if (session) return session;
  }

  // Fallback for any request middleware didn't run on (matcher gap, local
  // quirk, etc.) — correct, just not the fast path.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase.from("users").select("*").eq("id", user.id).single();
  if (!profile) return null;

  return { userId: user.id, email: user.email ?? null, profile };
});

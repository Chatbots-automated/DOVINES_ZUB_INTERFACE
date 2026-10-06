import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/auth"];

// Web-standard base64 helpers (no Buffer — this runs on Netlify's Edge
// runtime, which doesn't have Node's Buffer). unescape/encodeURIComponent
// round-trip keeps this safe for UTF-8 names (ą, č, š, ž, ...).
function encodeSessionHeader(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
            supabaseResponse = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options),
            );
          },
        },
      },
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      console.error("[Middleware] supabase.auth.getUser() error:", userError.message);
    }

    const isPublicPath = PUBLIC_PATHS.some((path) => request.nextUrl.pathname.startsWith(path));

    // A Supabase auth session can outlive its matching `public.users` profile
    // row (e.g. the profile table was wiped/reset, or the account was
    // deleted, while the browser still holds a valid session cookie). If we
    // only checked `user` here, an authenticated-but-profile-less visitor
    // would bounce forever: middleware lets them through to "/" because
    // `user` is truthy, the protected layout can't find a profile and
    // redirects to "/login", middleware sees `user` is still truthy on
    // "/login" and redirects back to "/" — an infinite ERR_TOO_MANY_REDIRECTS
    // loop. Same failure mode for a frozen account. So middleware is the
    // single source of truth for "is this session actually usable", and it
    // signs out (clearing cookies) whenever it isn't, which breaks the loop.
    let hasUsableProfile = false;
    if (user) {
      const { data: profile } = await supabase
        .from("users")
        .select("*")
        .eq("id", user.id)
        .maybeSingle();
      hasUsableProfile = !!profile && !profile.is_frozen;
      if (!hasUsableProfile) {
        await supabase.auth.signOut();
      } else {
        // Forward what we just fetched to the actual page render via a
        // request header, so getCurrentProfile() (src/lib/auth.ts) can
        // skip its own auth.getUser() + users-table round trip entirely
        // instead of redoing the exact same lookup a second time. This is
        // half of the navigation-latency fix — the other half is
        // getCurrentProfile() itself being wrapped in React's cache() so
        // repeat calls within one render tree dedupe too. Together these
        // cut what used to be up to ~4 sequential Supabase round-trips per
        // navigation (this check, plus 1-3 redundant getCurrentProfile()
        // calls across nested layouts/pages) down to just this one.
        request.headers.set("x-zub-session", encodeSessionHeader({ userId: user.id, email: user.email ?? null, profile }));
        const cookiesToCarry = supabaseResponse.cookies.getAll();
        supabaseResponse = NextResponse.next({ request });
        cookiesToCarry.forEach((cookie) => supabaseResponse.cookies.set(cookie));
      }
    }

    if (!hasUsableProfile && !isPublicPath) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      const redirectResponse = NextResponse.redirect(url);
      // Carry over any cookies supabase just set (refreshed session tokens,
      // or the sign-out above clearing a stale one) — NextResponse.redirect()
      // creates a brand-new response, so without this the cookie mutations
      // above would silently never reach the browser.
      supabaseResponse.cookies.getAll().forEach((cookie) => redirectResponse.cookies.set(cookie));
      return redirectResponse;
    }

    if (hasUsableProfile && request.nextUrl.pathname === "/login") {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      const redirectResponse = NextResponse.redirect(url);
      supabaseResponse.cookies.getAll().forEach((cookie) => redirectResponse.cookies.set(cookie));
      return redirectResponse;
    }

    return supabaseResponse;
  } catch (err) {
    // A thrown/rejected error here would otherwise crash this Edge Function
    // invocation with no useful trace client-side. Log and let the request
    // through rather than fail closed on every request.
    console.error(
      "[Middleware] UNCAUGHT ERROR:",
      err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : err,
    );
    return supabaseResponse;
  }
}

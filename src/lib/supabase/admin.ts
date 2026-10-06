import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

/**
 * Service-role client. Bypasses RLS entirely — only ever use this from
 * trusted server code (route handlers / server actions) for operations
 * that legitimately need to act outside a user's own permissions
 * (e.g. creating auth users from the Vartotojai admin screen, or the
 * DelPro sync worker upserting animals/jobs).
 *
 * Never import this from a Client Component or expose its key to the browser.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

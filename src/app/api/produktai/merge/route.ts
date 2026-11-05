import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";

export const dynamic = "force-dynamic";

// Produktai → Sujungti dublikatus (0062). Route Handler + fetch, not a Server
// Action (AGENTS.md: Netlify empty-body 403). merge_products() checks admin itself.
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin && host) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost && originHost !== host) {
      return NextResponse.json({ error: "Neteisingas užklausos šaltinis." }, { status: 403 });
    }
  }

  let keep = "";
  let remove = "";
  try {
    const body = await request.json();
    keep = String(body?.keep ?? "");
    remove = String(body?.remove ?? "");
  } catch {
    return NextResponse.json({ error: "Neteisingi užklausos duomenys." }, { status: 400 });
  }
  if (!keep || !remove) return NextResponse.json({ error: "Pasirinkite produktus." }, { status: 400 });

  const supabase = await createClient();
  const { error } = await supabase.rpc("merge_products", { p_keep: keep, p_remove: remove });
  if (error) {
    console.error("[ProductMergeRoute] merge_products failed:", error);
    return NextResponse.json({ error: error.message || "Nepavyko sujungti produktų." });
  }
  revalidateUsageViews();
  return NextResponse.json({ error: null });
}

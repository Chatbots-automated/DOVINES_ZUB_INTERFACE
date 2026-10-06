import { NextResponse, type NextRequest } from "next/server";
import { administerCourseDoseImpl, type ActionResult } from "@/lib/gydymo-kursai/administer-dose-impl";
import { revalidateUsageViews } from "@/lib/revalidate";

export const dynamic = "force-dynamic";

// Plain Route Handler (hit via fetch from the client), not a Server Action
// — see src/lib/pajamavimas/batch-impl.ts for why.
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
      console.error("[AdministerDoseRoute] Origin/Host mismatch", { origin, host });
      return NextResponse.json({ ok: false, error: "Neteisingas užklausos šaltinis." } satisfies ActionResult, { status: 403 });
    }
  }

  let doseId: string;
  try {
    const body = await request.json();
    doseId = String(body?.doseId ?? "");
  } catch (err) {
    console.error("[AdministerDoseRoute] Invalid JSON body:", err);
    return NextResponse.json({ ok: false, error: "Neteisingi užklausos duomenys." } satisfies ActionResult, { status: 400 });
  }

  if (!doseId) {
    return NextResponse.json({ ok: false, error: "Trūksta dozės ID." } satisfies ActionResult, { status: 400 });
  }

  try {
    const result = await administerCourseDoseImpl(doseId);
    if (result.ok) revalidateUsageViews();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[AdministerDoseRoute] Unexpected error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Nežinoma serverio klaida." } satisfies ActionResult,
      { status: 500 },
    );
  }
}

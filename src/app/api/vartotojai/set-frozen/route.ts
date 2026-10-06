import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { setUserFrozenImpl, type ActionResult } from "@/lib/vartotojai/set-user-frozen-impl";

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
      console.error("[SetUserFrozenRoute] Origin/Host mismatch", { origin, host });
      return NextResponse.json({ ok: false, error: "Neteisingas užklausos šaltinis." } satisfies ActionResult, { status: 403 });
    }
  }

  let userId: string;
  let isFrozen: boolean;
  try {
    const body = await request.json();
    userId = String(body?.userId ?? "");
    isFrozen = Boolean(body?.isFrozen);
  } catch (err) {
    console.error("[SetUserFrozenRoute] Invalid JSON body:", err);
    return NextResponse.json({ ok: false, error: "Neteisingi užklausos duomenys." } satisfies ActionResult, { status: 400 });
  }

  if (!userId) {
    return NextResponse.json({ ok: false, error: "Trūksta vartotojo ID." } satisfies ActionResult, { status: 400 });
  }

  try {
    const result = await setUserFrozenImpl(userId, isFrozen);
    if (result.ok) revalidatePath("/apskaita/vartotojai");
    return NextResponse.json(result);
  } catch (err) {
    console.error("[SetUserFrozenRoute] Unexpected error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Nežinoma serverio klaida." } satisfies ActionResult,
      { status: 500 },
    );
  }
}

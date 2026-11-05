import { NextResponse, type NextRequest } from "next/server";
import { RECEIPT_EDIT_OPS, receiptEditImpl, type ReceiptEditOp } from "@/lib/pajamavimas/batch-impl";
import { revalidateUsageViews } from "@/lib/revalidate";

export const dynamic = "force-dynamic";

// Pajamavimas → Redagavimas (0058). Plain Route Handler (hit via fetch from the
// client), not a Server Action — see the big comment in batch-impl.ts for why.
export async function POST(request: NextRequest) {
  // Route Handlers don't get Next.js's automatic Server-Action-style
  // Origin/Host CSRF check, so do the equivalent by hand.
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
      console.error("[ReceiptEditRoute] Origin/Host mismatch", { origin, host });
      return NextResponse.json({ error: "Neteisingas užklausos šaltinis." }, { status: 403 });
    }
  }

  let input: { op?: string; data?: Record<string, unknown> };
  try {
    input = await request.json();
  } catch (err) {
    console.error("[ReceiptEditRoute] Invalid JSON body:", err);
    return NextResponse.json({ error: "Neteisingi užklausos duomenys." }, { status: 400 });
  }
  const op = input.op as ReceiptEditOp;
  if (!RECEIPT_EDIT_OPS.includes(op) || !input.data || typeof input.data !== "object") {
    return NextResponse.json({ error: "Neteisinga užklausa." }, { status: 400 });
  }

  try {
    const result = await receiptEditImpl(op, input.data);
    if (!result.error) revalidateUsageViews();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[ReceiptEditRoute] Unexpected error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Nežinoma serverio klaida." },
      { status: 500 },
    );
  }
}

import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { receiveInvoiceImpl, type ReceiveInvoiceInput } from "@/lib/pajamavimas/batch-impl";

export const dynamic = "force-dynamic";

// Plain Route Handler (hit via fetch from the client), not a Server Action
// — see the big comment in batch-impl.ts for why.
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
      console.error("[ConfirmInvoiceRoute] Origin/Host mismatch", { origin, host });
      return NextResponse.json({ error: "Neteisingas užklausos šaltinis." }, { status: 403 });
    }
  }

  let input: ReceiveInvoiceInput;
  try {
    input = await request.json();
  } catch (err) {
    console.error("[ConfirmInvoiceRoute] Invalid JSON body:", err);
    return NextResponse.json({ error: "Neteisingi užklausos duomenys." }, { status: 400 });
  }

  try {
    const result = await receiveInvoiceImpl({ ...input, mode: "pdf" });
    if (!result.error) {
      revalidatePath("/", "layout");
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[ConfirmInvoiceRoute] Unexpected error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Nežinoma serverio klaida." },
      { status: 500 },
    );
  }
}

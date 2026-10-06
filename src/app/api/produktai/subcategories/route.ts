import { NextResponse, type NextRequest } from "next/server";
import { createSubcategoryImpl, type CreateSubcategoryResult } from "@/lib/actions/product-subcategories";

export const dynamic = "force-dynamic";

// Inline "create subcategory" from the product form. A Route Handler hit via
// fetch (not a Server Action): see AGENTS.md (Netlify empty-body 403).
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
      return NextResponse.json({ ok: false, error: "Neteisingas užklausos šaltinis." } satisfies CreateSubcategoryResult, { status: 403 });
    }
  }

  let category: string;
  let name: string;
  try {
    const body = await request.json();
    category = String(body?.category ?? "");
    name = String(body?.name ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "Neteisingi užklausos duomenys." } satisfies CreateSubcategoryResult, { status: 400 });
  }

  try {
    return NextResponse.json(await createSubcategoryImpl(category, name));
  } catch (err) {
    console.error("[ProductSubcategoriesRoute] Unexpected error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Nežinoma serverio klaida." } satisfies CreateSubcategoryResult,
      { status: 500 },
    );
  }
}

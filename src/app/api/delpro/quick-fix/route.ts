import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { revalidateUsageViews } from "@/lib/revalidate";

export const dynamic = "force-dynamic";

// DelPro → "Greitas taisymas" (0067). GET ?job= = the proposed fixes, POST {job_id, fixes} = apply
// them and send again. Admin rule lives in the RPCs (fn_is_admin); plain Route Handler for the same
// reason as /api/delpro/action (src/lib/delpro-ops.ts).
export async function GET(request: NextRequest) {
  const job = request.nextUrl.searchParams.get("job") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(job)) return NextResponse.json({ error: "Neteisingas įrašas." }, { status: 400 });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_quick_fixes", { p_job_id: job });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data });
}

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
    if (originHost && originHost !== host) return NextResponse.json({ error: "Neteisingas užklausos šaltinis." }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Neteisingi užklausos duomenys." }, { status: 400 });
  }
  if (typeof body.job_id !== "string" || !Array.isArray(body.fixes)) return NextResponse.json({ error: "Neteisinga užklausa." }, { status: 400 });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delpro_apply_quick_fix", { p_data: { job_id: body.job_id, fixes: body.fixes } });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  revalidatePath("/veterinarija/delpro");
  revalidatePath("/veterinarija");
  revalidateUsageViews();
  return NextResponse.json({ data });
}

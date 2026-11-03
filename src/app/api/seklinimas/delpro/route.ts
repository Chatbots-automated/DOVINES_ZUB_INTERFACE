import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Sėklinimas ← DelPro (0053). Route Handler + fetch (AGENTS.md: directly called Server Actions can vanish on Netlify).
// Authorization lives in the RPCs (fn_is_active_staff); this file only checks the origin and the session.
//   { op: "request", tags?: string[], animal_ids?: string[] }  -> the farm PC re-reads those animals from DelPro
//   { op: "dismiss_duplicate", id }                             -> "Palikti abu"
//   { op: "set_semen_name", semen_key, name }                   -> shared name for every insemination with that Semen key (0055)

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()).slice(0, 500) : []);

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return fail("Netinkamas šaltinis.", 403);
  const session = await getCurrentProfile();
  if (!session) return fail("Neprisijungta.", 401);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.op !== "string") return fail("Netinkama užklausa.");
  const supabase = await createClient();

  if (body.op === "request") {
    const tags = strings(body.tags);
    const animal_ids = strings(body.animal_ids);
    if (!tags.length && !animal_ids.length) return fail("Nurodykite gyvulį.");
    const { data, error } = await supabase.rpc("delpro_insemination_request", { p_body: { tags, animal_ids } });
    if (error) return fail(error.message);
    revalidatePath("/veterinarija/sekinimas");
    return NextResponse.json({ ok: true, data });
  }
  if (body.op === "dismiss_duplicate") {
    if (typeof body.id !== "string") return fail("Nurodykite įrašą.");
    const { data, error } = await supabase.rpc("delpro_insemination_dismiss_duplicate", { p_id: body.id });
    if (error) return fail(error.message);
    revalidatePath("/veterinarija/sekinimas");
    return NextResponse.json({ ok: true, data: { ...data, message: "Pažymėta: tai du skirtingi sėklinimai." } });
  }
  if (body.op === "set_semen_name") {
    if (typeof body.semen_key !== "string" || typeof body.name !== "string") return fail("Nurodykite spermą ir pavadinimą.");
    const { data, error } = await supabase.rpc("delpro_semen_set_name", { p_semen_key: body.semen_key, p_name: body.name });
    if (error) return fail(error.message);
    revalidatePath("/veterinarija/sekinimas");
    return NextResponse.json({ ok: true, data });
  }
  return fail("Nežinomas veiksmas.");
}

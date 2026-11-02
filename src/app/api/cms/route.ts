import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { CMS_OPEN_STATUSES } from "@/lib/cms/status";

export const dynamic = "force-dynamic";

// CMS atskyrimai (0048). Plain Route Handler + fetch (see AGENTS.md: directly called Server Actions can vanish on
// Netlify). Every write is a database RPC run with the caller's session — authorization lives there (fn_is_admin /
// fn_is_active_staff), never in this file. GET = paged animal search for "Naujas atskyrimas".

const PAGE_SIZE = 50;
const ALL_LIMIT = 2000;

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

const fail = (error: string, status = 400, details?: unknown) => NextResponse.json({ ok: false, error, details }, { status });

// PostgREST or() filter: strip the characters that have syntax meaning there.
const clean = (q: string) => q.replace(/[,()*%\\:"']/g, " ").trim().slice(0, 60);

export async function GET(request: NextRequest) {
  const session = await getCurrentProfile();
  if (!session) return fail("Neprisijungta.", 401);
  const sp = request.nextUrl.searchParams;
  const q = clean(sp.get("q") ?? "");
  const group = sp.get("group") ?? "";
  const delpro = sp.get("delpro") ?? "";
  const all = sp.get("all") === "1";
  const page = Math.max(0, Number(sp.get("page") ?? 0) || 0);

  const supabase = await createClient();
  let query = supabase
    .from("animals")
    .select("id, tag_no, animal_no, name, group_name, delpro_object_guid", { count: "exact" })
    .eq("active", true);
  if (q) query = query.or(`tag_no.ilike.%${q}%,animal_no.ilike.%${q}%,name.ilike.%${q}%`);
  if (group) query = query.eq("group_name", group);
  if (delpro === "linked") query = query.not("delpro_object_guid", "is", null);
  if (delpro === "unlinked") query = query.is("delpro_object_guid", null);
  query = query.order("tag_no");
  query = all ? query.limit(ALL_LIMIT) : query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  const { data, count, error } = await query;
  if (error) return fail(error.message, 500);
  const animals = data ?? [];

  // DelPro's own active SortCow (last live read) + unfinished GVET instructions, per listed animal
  const ids = animals.map((a) => a.id);
  const live = new Map<string, string>();
  const open = new Map<string, string>();
  const now = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [liveRes, openRes] = await Promise.all([
      supabase
        .from("cms_live_action_settings")
        .select("action_key, animal_id, end_at")
        .in("animal_id", chunk)
        .eq("action_type", "SortCow")
        .eq("active", true)
        .is("removed_at", null),
      supabase.from("cms_separation_jobs").select("animal_id, status").in("animal_id", chunk).in("status", CMS_OPEN_STATUSES),
    ]);
    for (const l of liveRes.data ?? []) if (l.animal_id && (!l.end_at || l.end_at > now)) live.set(l.animal_id, l.action_key);
    for (const o of openRes.data ?? []) open.set(o.animal_id, o.status);
  }

  return NextResponse.json({
    ok: true,
    count: count ?? animals.length,
    page,
    pageSize: all ? ALL_LIMIT : PAGE_SIZE,
    truncated: all && (count ?? 0) > ALL_LIMIT,
    animals: animals.map((a) => ({ ...a, live_action_key: live.get(a.id) ?? null, open_job_status: open.get(a.id) ?? null })),
  });
}

type Body = { op?: string } & Record<string, unknown>;

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return fail("Neteisingas užklausos šaltinis.", 403);
  const session = await getCurrentProfile();
  if (!session) return fail("Sesija baigėsi — prisijunkite iš naujo.", 401);
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return fail("Neteisingi užklausos duomenys.");
  }
  const supabase = await createClient();
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

  const call = async () => {
    switch (body.op) {
      case "check":
        return supabase.rpc("cms_check_items", { p_items: (body.items as Record<string, unknown>[]) ?? [] });
      case "save":
        return supabase.rpc("cms_save_batch", { p_data: (body.data as Record<string, unknown>) ?? {} });
      case "delete_draft":
        return supabase.rpc("cms_delete_draft", { p_batch_id: String(body.batch_id ?? "") });
      case "approve":
        return supabase.rpc("cms_approve_jobs", { p_job_ids: ids(body.job_ids), p_confirm: body.confirm === true });
      case "cancel":
        return supabase.rpc("cms_cancel_jobs", { p_job_ids: ids(body.job_ids), p_reason: typeof body.reason === "string" ? body.reason : null });
      case "job_action":
        return supabase.rpc("cms_job_action", {
          p_job_id: String(body.job_id ?? ""),
          p_action: body.action as "retry" | "confirm_absent" | "adopt",
          p_key: typeof body.key === "string" ? body.key : null,
        });
      case "release_single":
        return supabase.rpc("cms_release_single_job", { p_job_id: typeof body.job_id === "string" && body.job_id ? body.job_id : null });
      case "set_mode_verified":
        return supabase.rpc("cms_set_mode_verified", {
          p_mode: body.mode as "period" | "ongoing",
          p_verified: body.verified === true,
          p_confirm: body.confirm === true,
        });
      case "request_live":
        return supabase.rpc("cms_request_live_refresh", {});
      default:
        return null;
    }
  };

  try {
    const res = await call();
    if (!res) return fail("Nežinomas veiksmas.");
    if (res.error) {
      let details: unknown = undefined;
      try {
        details = res.error.details ? JSON.parse(res.error.details) : undefined;
      } catch {
        details = res.error.details;
      }
      return fail(res.error.message, 400, details);
    }
    return NextResponse.json({ ok: true, data: res.data });
  } catch (err) {
    console.error(`[CmsRoute] ${body.op} failed:`, err);
    return fail("Serverio klaida.", 500);
  }
}

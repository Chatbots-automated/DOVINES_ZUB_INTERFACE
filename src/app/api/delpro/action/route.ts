import { NextResponse, type NextRequest } from "next/server";
import * as delpro from "@/lib/actions/delpro";
import * as catalog from "@/lib/actions/delpro-catalog";
import type { DelproActionResult } from "@/lib/actions/delpro";
import { DELPRO_OPS, type DelproOp } from "@/lib/delpro-ops";

export const dynamic = "force-dynamic";

type Handler = (prev: DelproActionResult | null, formData: FormData) => Promise<DelproActionResult>;

// Same functions the forms used as Server Actions; authorization stays in the
// database RPCs (fn_is_admin / fn_can_approve_delpro), the session comes from
// the request cookies (createClient()).
const HANDLERS: Record<DelproOp, Handler> = {
  approveDelproJobs: delpro.approveDelproJobs,
  confirmDelproTransfer: delpro.confirmDelproTransfer,
  rejectDelproJob: delpro.rejectDelproJob,
  retryDelproJob: delpro.retryDelproJob,
  updateDelproSettings: delpro.updateDelproSettings,
  saveDelproMapping: delpro.saveDelproMapping,
  requestCatalogSync: catalog.requestCatalogSync,
  confirmCatalogSuggestions: catalog.confirmCatalogSuggestions,
  resolveCatalogIssue: catalog.resolveCatalogIssue,
  linkCatalogRecord: catalog.linkCatalogRecord,
  unlinkCatalogRecord: catalog.unlinkCatalogRecord,
  importCatalogRecords: catalog.importCatalogRecords,
  applyCatalogImport: catalog.applyCatalogImport,
  createPilotDrug: catalog.createPilotDrug,
  releaseSingleCatalogJob: catalog.releaseSingleCatalogJob,
  updateCatalogInboundMode: catalog.updateCatalogInboundMode,
  enqueueCatalogCreate: catalog.enqueueCatalogCreate,
  createCatalogTestJob: catalog.createCatalogTestJob,
  markCatalogValidated: catalog.markCatalogValidated,
  unvalidateCatalogOperation: catalog.unvalidateCatalogOperation,
  setCatalogWriteEnabled: catalog.setCatalogWriteEnabled,
  catalogJobAction: catalog.catalogJobAction,
  updateCatalogOutboundMode: catalog.updateCatalogOutboundMode,
  saveTreatmentTemplate: catalog.saveTreatmentTemplate,
  deleteTreatmentTemplate: catalog.deleteTreatmentTemplate,
};

const fail = (error: string, status: number) => NextResponse.json({ ok: false, error } satisfies DelproActionResult, { status });

// Plain Route Handler hit via fetch (src/lib/use-delpro-action.ts) — see src/lib/delpro-ops.ts for why.
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
      console.error("[DelproActionRoute] Origin/Host mismatch", { origin, host });
      return fail("Neteisingas užklausos šaltinis.", 403);
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (err) {
    console.error("[DelproActionRoute] Invalid form body:", err);
    return fail("Neteisingi užklausos duomenys.", 400);
  }
  const op = String(formData.get("_op") ?? "");
  if (!(DELPRO_OPS as readonly string[]).includes(op)) return fail("Nežinomas veiksmas.", 400);
  formData.delete("_op");

  try {
    return NextResponse.json(await HANDLERS[op as DelproOp](null, formData));
  } catch (err) {
    console.error(`[DelproActionRoute] ${op} failed:`, err);
    return fail(err instanceof Error ? err.message : "Nežinoma serverio klaida.", 500);
  }
}

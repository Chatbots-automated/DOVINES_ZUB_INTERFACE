import type { NextRequest } from "next/server";
// Same handler as the Netlify function (netlify/functions/delpro-report-upload.mjs):
// identical contract and responses. This path also works under `next dev` and is
// outside the auth middleware (/api/ is excluded), so a test upload can never be
// redirected to /login.
import { handleUpload } from "../../../../../netlify/functions/delpro-report-upload.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    return await handleUpload(request);
  } catch (err) {
    console.error("[DelproReportUploadRoute]", err);
    return Response.json({ status: "error", error: "server_error", message: "Serverio klaida — failas neimportuotas." }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handleUpload(request);
}

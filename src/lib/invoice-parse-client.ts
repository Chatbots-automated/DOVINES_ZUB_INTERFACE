"use client";

/**
 * Client-side call to the invoice-PDF-parsing n8n webhook (Priedas §2.11).
 *
 * Dovinės ŽŪB reuses the shared n8n host at n8n-up8s.onrender.com (same
 * one monika/oksana/gerda_gintariniai_zirgai run their invoice-parsing
 * workflow on) rather than provisioning fresh n8n infra — see README's
 * "Known gaps", now resolved. Hardcoded rather than an env var: this isn't
 * a real secret (see below), and every sibling project on this host does
 * the same (see gerda_gintariniai_zirgai's src/lib/invoice-parse-client.ts).
 *
 * Called directly from the browser (not proxied through a Next.js Route
 * Handler) so a slow n8n cold start isn't bounded by a serverless
 * function's execution ceiling — see gerda_gintariniai_zirgai's
 * src/lib/invoice-parse-client.ts for the fuller rationale. No database
 * write happens from this call; it only returns parsed PDF text to the
 * same logged-in user who uploaded it. The actual write happens via the
 * authenticated confirmParsedInvoice Server Action, protected by RLS.
 */
const N8N_INVOICE_WEBHOOK_URL =
  "https://n8n-up8s.onrender.com/webhook/36549f46-a08b-4790-212asabf5919-40cdc919e1a121aas";

export type ParseInvoiceResult = { data: Record<string, unknown> } | { error: string; status?: number };

function normalizeInvoicePayload(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    const first = data[0];
    if (first && typeof first === "object" && "payload" in first) {
      return (first as { payload: unknown }).payload as Record<string, unknown>;
    }
    return first as Record<string, unknown>;
  }
  if (data && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  return null;
}

export async function parseInvoicePdf(file: File, filename: string): Promise<ParseInvoiceResult> {
  const arrayBuffer = await file.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    return { error: "Tuščias failas." };
  }

  let response: Response;
  try {
    response = await fetch(N8N_INVOICE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "X-Filename": filename },
      body: arrayBuffer,
      // Generous timeout: a free-tier n8n host can take 30-60s to wake up
      // from a cold start before the actual AI/OCR processing even starts.
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Nežinoma klaida";
    if (/abort|timeout/i.test(errorMsg)) {
      return { error: "Skenavimo serveris per ilgai neatsako (timeout). Bandykite dar kartą po minutės.", status: 504 };
    }
    return { error: "Nepavyko pasiekti sąskaitų skenavimo serverio. Patikrinkite interneto ryšį.", status: 502 };
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("[Invoice Parse] n8n error:", response.status, errorText.slice(0, 200));
    return {
      error: `Skenavimo klaida (${response.status}). ${errorText && !errorText.includes("<") ? errorText.slice(0, 150) : "Serveris grąžino klaidą."}`,
      status: response.status,
    };
  }

  const text = await response.text();
  if (!text.trim()) {
    return { error: "Serveris grąžino tuščią atsakymą.", status: 502 };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (parseError) {
    console.error("[Invoice Parse] JSON parse error:", parseError);
    return { error: "Serveris grąžino netinkamą atsakymą. Bandykite dar kartą po kelių sekundžių.", status: 502 };
  }

  const invoiceObject = normalizeInvoicePayload(data);
  if (!invoiceObject) {
    return { error: "Netinkamas atsakymo formatas.", status: 502 };
  }
  if (!Array.isArray(invoiceObject.items) || invoiceObject.items.length === 0) {
    return { error: "Atsakyme nerasta prekių sąrašo.", status: 502 };
  }

  return { data: invoiceObject };
}

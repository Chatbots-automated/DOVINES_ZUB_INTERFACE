import { createClient } from "@/lib/supabase/server";

/**
 * Pajamavimas write logic — deliberately NOT a Server Action ("use
 * server"): on Netlify, Server Action POSTs came back as an empty-body 403
 * that never reached our code (same failure ZUB's sibling projects hit).
 * It is called from Route Handlers (src/app/api/pajamavimas/*) via a plain
 * client-side fetch(), which Netlify routes differently.
 *
 * Everything is one Postgres RPC (receive_invoice, 0015): supplier match/
 * create, invoice header, a batch per line and the invoice lines commit or
 * roll back together. Before 0015 this was several PostgREST calls from
 * here, and a failure midway left an invoice with no stock.
 */

export type SimpleResult = { error: string | null; batchId?: string; invoiceId?: string };

export interface ReceiveItemInput {
  product_id: string;
  description?: string;
  sku?: string;
  qty?: number | string;
  package_size?: number | string | null;
  package_count?: number | string | null;
  line_total?: number | string | null;
  unit_price?: number | string | null;
  lot?: string;
  expiry_date?: string;
}

export interface ReceiveInvoiceInput {
  mode: "pdf" | "manual";
  supplier_id?: string;
  supplier?: { name?: string; code?: string; vat_code?: string };
  invoice?: {
    number?: string;
    date?: string;
    currency?: string;
    total_net?: number | null;
    total_vat?: number | null;
    total_gross?: number | null;
  };
  pdf_filename?: string;
  raw_parsed?: unknown;
  items: ReceiveItemInput[];
}

export async function receiveInvoiceImpl(input: ReceiveInvoiceInput): Promise<SimpleResult> {
  if (!input || !Array.isArray(input.items) || input.items.length === 0) {
    return { error: "Pasirinkite bent vieną prekės eilutę." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("receive_invoice", { p_data: input as unknown as Record<string, unknown> });
  if (error) {
    console.error("[pajamavimas] receive_invoice failed:", error);
    return { error: error.message || "Nepavyko priimti atsargų." };
  }
  const result = data as { invoice_id: string | null } | null;
  return { error: null, invoiceId: result?.invoice_id ?? undefined };
}

export async function deleteInvoiceImpl(invoiceId: string): Promise<SimpleResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_invoice", { p_invoice_id: invoiceId });
  if (error) return { error: error.message };
  return { error: null };
}

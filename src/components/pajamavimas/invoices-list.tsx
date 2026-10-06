"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FileText, Trash2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatEur } from "@/lib/utils";

export type InvoiceListRow = {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier_name: string | null;
  total_net: number | null;
  pdf_filename: string | null;
  lines: number;
};

// Recent invoices + undo for a mis-parsed upload. The database refuses the
// delete once any of the invoice's stock has been used (delete_invoice, 0015).
export function InvoicesList({ invoices }: { invoices: InvoiceListRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function remove(inv: InvoiceListRow) {
    if (!window.confirm(`Ištrinti sąskaitą ${inv.invoice_number ?? ""} ir jos priimtas atsargas?`)) return;
    setBusyId(inv.id);
    setError(null);
    try {
      const response = await fetch("/api/pajamavimas/delete-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: inv.id }),
      });
      const result: { error: string | null } = await response.json();
      if (result.error) setError(result.error);
      else router.refresh();
    } catch {
      setError("Nepavyko ištrinti sąskaitos.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pajamuotos sąskaitos</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {error && <p className="px-4 pt-3 text-[13px] text-danger">{error}</p>}
        {invoices.length === 0 ? (
          <EmptyState icon={FileText} title="Sąskaitų dar nėra" className="py-10" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[14px]">
              <thead className="border-b border-border bg-surface-secondary text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-4 py-3 font-medium">Sąskaita</th>
                  <th className="px-4 py-3 font-medium">Data</th>
                  <th className="px-4 py-3 font-medium">Tiekėjas</th>
                  <th className="px-4 py-3 font-medium">Eilučių</th>
                  <th className="px-4 py-3 font-medium">Suma be PVM</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-4 py-3 font-medium text-text-primary">
                      {inv.invoice_number ?? "—"}
                      {inv.pdf_filename && <span className="ml-2 text-[11px] font-normal text-text-muted">{inv.pdf_filename}</span>}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{formatDate(inv.invoice_date)}</td>
                    <td className="px-4 py-3 text-text-secondary">{inv.supplier_name ?? "—"}</td>
                    <td className="px-4 py-3 tabular-nums text-text-secondary">{inv.lines}</td>
                    <td className="px-4 py-3 tabular-nums text-text-secondary">{inv.total_net != null ? formatEur(inv.total_net) : "—"}</td>
                    <td className="px-4 py-3 text-right">
                      <Button type="button" size="icon" variant="ghost" className="h-8 w-8" disabled={busyId === inv.id} onClick={() => remove(inv)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

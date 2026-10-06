"use client";

import * as React from "react";
import { Droplet, Search } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate, formatQty } from "@/lib/utils";

export type BiocideUsageRow = {
  id: string;
  name: string;
  registration_code: string | null;
  unit: string;
  use_date: string;
  purpose: string | null;
  work_scope: string | null;
  qty: number | null;
  used_by_name: string | null;
  batch_number: string | null;
  expiry_date: string | null;
};

export type BiocideReceiptRow = {
  id: string;
  name: string;
  unit: string;
  receipt_date: string;
  supplier_name: string | null;
  invoice_number: string | null;
  received_qty: number;
  batch_number: string | null;
  expiry_date: string | null;
  quantity_remaining: number;
};

// Biocidai tab: usage log + receiving/remaining per batch, with product /
// date-range / free-text filters (Priedas §2.10 search). The legal journal
// forms (Priedas §2.8, print/PDF) live under Apskaita -> Žurnalai.
export function BiocideLog({ usage, receipts, today }: { usage: BiocideUsageRow[]; receipts: BiocideReceiptRow[]; today: string }) {
  const [search, setSearch] = React.useState("");
  const [product, setProduct] = React.useState("all");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");

  const products = React.useMemo(() => Array.from(new Set([...usage.map((u) => u.name), ...receipts.map((r) => r.name)])).sort(), [usage, receipts]);

  const term = search.trim().toLowerCase();
  const inRange = (d: string) => (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo);

  const usageRows = usage.filter(
    (u) =>
      (product === "all" || u.name === product) &&
      inRange(u.use_date) &&
      (!term || [u.name, u.purpose, u.work_scope, u.used_by_name, u.batch_number].join(" ").toLowerCase().includes(term)),
  );
  const receiptRows = receipts.filter(
    (r) =>
      (product === "all" || r.name === product) &&
      inRange(r.receipt_date) &&
      (!term || [r.name, r.supplier_name, r.invoice_number, r.batch_number].join(" ").toLowerCase().includes(term)),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ieškoti pagal tikslą, vietą, atlikėją, seriją, tiekėją..." className="pl-8" />
        </div>
        <Select value={product} onChange={(e) => setProduct(e.target.value)} className="w-auto" aria-label="Produktas">
          <option value="all">Visi produktai</option>
          {products.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" aria-label="Nuo" />
        <span className="text-[13px] text-text-muted">—</span>
        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" aria-label="Iki" />
      </div>

      <Tabs defaultValue="usage">
        <TabsList>
          <TabsTrigger value="usage">Panaudojimas ({usageRows.length})</TabsTrigger>
          <TabsTrigger value="receipts">Gavimas ir likutis ({receiptRows.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="usage">
          <Card>
            <CardContent className="p-0">
              {usageRows.length === 0 ? (
                <EmptyState icon={Droplet} title="Biocidų panaudojimo įrašų nerasta" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="journal-table w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-border text-left text-text-muted">
                        <th className="px-5 py-2 font-medium">Data</th>
                        <th className="px-5 py-2 font-medium">Produktas</th>
                        <th className="px-5 py-2 font-medium">Serija</th>
                        <th className="px-5 py-2 font-medium">Galioja iki</th>
                        <th className="px-5 py-2 font-medium">Tikslas</th>
                        <th className="px-5 py-2 font-medium">Darbų apimtis</th>
                        <th className="px-5 py-2 text-right font-medium">Kiekis</th>
                        <th className="px-5 py-2 font-medium">Atliko</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usageRows.map((r) => (
                        <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-secondary">
                          <td className="px-5 py-2">{formatDate(r.use_date)}</td>
                          <td className="px-5 py-2 font-semibold text-text-primary">
                            {r.name}
                            {r.registration_code && <span className="ml-1.5 text-[11px] font-normal text-text-muted">{r.registration_code}</span>}
                          </td>
                          <td className="px-5 py-2">{r.batch_number ?? "—"}</td>
                          <td className="px-5 py-2">{formatDate(r.expiry_date)}</td>
                          <td className="px-5 py-2">{r.purpose ?? "—"}</td>
                          <td className="px-5 py-2">{r.work_scope ?? "—"}</td>
                          <td className="px-5 py-2 text-right tabular-nums">{formatQty(r.qty, r.unit)}</td>
                          <td className="px-5 py-2">{r.used_by_name ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="receipts">
          <Card>
            <CardContent className="p-0">
              {receiptRows.length === 0 ? (
                <EmptyState icon={Droplet} title="Gautų biocidų partijų nerasta" description="Biocidai pajamuojami per Apskaita → Pajamavimas." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="journal-table w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-border text-left text-text-muted">
                        <th className="px-5 py-2 font-medium">Gauta</th>
                        <th className="px-5 py-2 font-medium">Produktas</th>
                        <th className="px-5 py-2 font-medium">Tiekėjas</th>
                        <th className="px-5 py-2 font-medium">Sąskaita</th>
                        <th className="px-5 py-2 font-medium">Serija</th>
                        <th className="px-5 py-2 font-medium">Galioja iki</th>
                        <th className="px-5 py-2 text-right font-medium">Gauta kiekis</th>
                        <th className="px-5 py-2 text-right font-medium">Likutis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receiptRows.map((r) => (
                        <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-secondary">
                          <td className="px-5 py-2">{formatDate(r.receipt_date)}</td>
                          <td className="px-5 py-2 font-semibold text-text-primary">{r.name}</td>
                          <td className="px-5 py-2">{r.supplier_name ?? "—"}</td>
                          <td className="px-5 py-2">{r.invoice_number ?? "—"}</td>
                          <td className="px-5 py-2">{r.batch_number ?? "—"}</td>
                          <td className={`px-5 py-2 ${r.expiry_date && r.expiry_date < today && r.quantity_remaining > 0 ? "font-semibold text-danger" : ""}`}>
                            {formatDate(r.expiry_date)}
                          </td>
                          <td className="px-5 py-2 text-right tabular-nums">{formatQty(r.received_qty, r.unit)}</td>
                          <td className="px-5 py-2 text-right tabular-nums">{formatQty(r.quantity_remaining, r.unit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

import { FARM_NAME } from "@/lib/brand";

// Client-side export helpers for journals / nurašymo aktai (Priedas §2.8,
// §2.9). The exact layout per document follows the farm's templates
// ("pagal projekto metu pateiktus ir suderintus šablonus"); these produce
// the plain tabular form until those templates are agreed.

function escapeCsv(value: string) {
  return /[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Semicolon-separated + UTF-8 BOM: opens correctly in Lithuanian-locale Excel. */
export function downloadCsv(filename: string, headers: string[], rows: string[][]) {
  const body = [headers, ...rows].map((r) => r.map(escapeCsv).join(";")).join("\r\n");
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Opens a clean, print-only document (farm letterhead + title + table) in a
 * new window and triggers the browser's print dialog — "Save as PDF" there
 * gives the PDF. Kept outside the app chrome so no sidebar/buttons print.
 */
export function printDocument({
  title,
  subtitle,
  headers,
  rows,
  footerHtml,
  landscape = true,
}: {
  title: string;
  subtitle?: string;
  headers: string[];
  rows: string[][];
  footerHtml?: string;
  landscape?: boolean;
}) {
  const w = window.open("", "_blank");
  if (!w) return;
  const head = ["Eil. Nr.", ...headers].map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((r, i) => `<tr><td class="n">${i + 1}</td>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  w.document.write(`<!doctype html><html lang="lt"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  @page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 12mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10px; color: #000; }
  .farm { font-size: 11px; margin-bottom: 10px; }
  h1 { font-size: 14px; text-align: center; margin: 8px 0 2px; text-transform: uppercase; }
  .sub { text-align: center; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #000; padding: 3px 4px; vertical-align: top; }
  th { background: #eee; font-weight: bold; text-align: center; }
  td.n { text-align: center; width: 28px; }
  tr { page-break-inside: avoid; }
  thead { display: table-header-group; }
  .sign { margin-top: 28px; display: flex; justify-content: space-between; gap: 40px; }
  .sign div { flex: 1; border-top: 1px solid #000; padding-top: 3px; text-align: center; font-size: 9px; }
  .footer { margin-top: 18px; }
</style></head><body>
<div class="farm">${escapeHtml(FARM_NAME)}</div>
<h1>${escapeHtml(title)}</h1>
${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ""}
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
${footerHtml ? `<div class="footer">${footerHtml}</div>` : ""}
<div class="sign"><div>Atsakingas asmuo (pareigos, vardas, pavardė)</div><div>Parašas</div><div>Data</div></div>
<script>window.onload = () => { window.print(); };</script>
</body></html>`);
  w.document.close();
}

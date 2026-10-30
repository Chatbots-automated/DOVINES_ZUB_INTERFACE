// DelPro daily Excel report (XLSX) -> the body of delpro_report_ingest (0042).
//
// Server-side only (Netlify function delpro-report-upload). No spreadsheet
// library: an .xlsx is a ZIP of XML parts, read here with node:zlib and
// fast-xml-parser, so cell types and Excel date serials are under our control.
//
// What it does
//   * reads every worksheet; the header row is found by the ORN column
//     ("Oficialus reg. Nr. (ORN)"), anywhere in the first 50 rows;
//   * columns are taken by HEADER, not position: reordered / renamed / new
//     columns all work; mapping header -> field happens in the database
//     (delpro_report_fields aliases), so new aliases need no code change;
//   * each cell is typed: date | timestamp_local (Europe/Vilnius wall clock,
//     converted in the database) | timestamp (explicit offset) | number |
//     boolean | text | empty — and keeps its original text in `raw`;
//   * the ORN cell is always text (leading zeros / letters preserved);
//   * a listed cell with t="empty" is an explicitly empty cell of a column the
//     sheet has; columns the sheet doesn't have are simply not listed;
//   * footer / total rows (e.g. a lone "21") are counted, not imported.

import zlib from "node:zlib";
import { XMLParser } from "fast-xml-parser";

export class ReportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid_xlsx | no_orn_column | too_large
  }
}

const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
const HEADER_SCAN_ROWS = 50;

// --- ZIP -------------------------------------------------------------------

function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new ReportError("invalid_xlsx", "Failas nėra XLSX (ZIP) dokumentas.");
  }
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ReportError("invalid_xlsx", "Pažeistas XLSX failas (nėra ZIP katalogo).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > 5000 || p >= buf.length) throw new ReportError("invalid_xlsx", "Pažeistas XLSX failas (ZIP katalogas).");
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ReportError("invalid_xlsx", "Pažeistas XLSX failas (ZIP įrašas).");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  let total = 0;
  return {
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw new ReportError("invalid_xlsx", `Pažeistas XLSX įrašas ${name}.`);
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.subarray(start, start + e.compSize);
      if (e.size > MAX_ENTRY_BYTES) throw new ReportError("too_large", `XLSX dalis ${name} per didelė.`);
      let out;
      if (e.method === 0) out = data;
      else if (e.method === 8) {
        try {
          out = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
        } catch {
          throw new ReportError("invalid_xlsx", `Nepavyko išskleisti XLSX dalies ${name}.`);
        }
      } else throw new ReportError("invalid_xlsx", `Nepalaikomas ZIP glaudinimas (${e.method}).`);
      total += out.length;
      if (total > MAX_TOTAL_BYTES) throw new ReportError("too_large", "XLSX turinys per didelis.");
      return out.toString("utf8");
    },
  };
}

// --- XML -------------------------------------------------------------------

const ARRAYS = new Set(["sheet", "row", "c", "si", "r", "xf", "numFmt", "Relationship"]);
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => ARRAYS.has(name),
});

function parseXml(text, what) {
  try {
    return xml.parse(text);
  } catch {
    throw new ReportError("invalid_xlsx", `Pažeistas XLSX XML (${what}).`);
  }
}

const textOf = (node) => {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return node["#text"] != null ? String(node["#text"]) : "";
};

const richText = (si) => (si?.t != null ? textOf(si.t) : (si?.r ?? []).map((r) => textOf(r.t)).join(""));

// --- Number formats ----------------------------------------------------------

const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 22, 32, 33, 45, 46, 47, 55, 56]);

/** "date" | "datetime" | null for a number format. */
export function formatKind(numFmtId, code) {
  if (code == null) {
    if (numFmtId === 22) return "datetime";
    if (BUILTIN_DATE.has(numFmtId)) return "date";
    if (BUILTIN_TIME.has(numFmtId)) return "datetime";
    return null;
  }
  const s = String(code)
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, "")
    .split(";")[0];
  if (/general/i.test(s) && !/[dy]/i.test(s.replace(/general/gi, ""))) return null;
  const hasDate = /[dy]/i.test(s) || /m{3,}/i.test(s);
  const hasTime = /[hs]/i.test(s) || /\[[hms]+\]/i.test(s);
  if (hasDate && hasTime) return "datetime";
  if (hasDate) return "date";
  if (hasTime) return "datetime";
  return null;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Excel serial -> { date: "YYYY-MM-DD", time: "HH:MM:SS" } (wall clock, no time zone). */
export function excelSerialToParts(serial, date1904 = false) {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round((base + serial * 86400000) / 1000) * 1000;
  const d = new Date(ms);
  return {
    date: `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  };
}

function validDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 2200 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** A text cell that is really a date / time stamp. */
export function typeText(raw) {
  const s = raw.trim();
  if (s === "") return { t: "empty", v: null, raw };
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/) ?? null;
  if (m && validDate(+m[1], +m[2], +m[3])) return { t: "date", v: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, raw };
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m && validDate(+m[3], +m[2], +m[1])) return { t: "date", v: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, raw };
  m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m && validDate(+m[1], +m[2], +m[3]) && +m[4] < 24) {
    const local = `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4])}:${m[5]}:${m[6] ?? "00"}`;
    if (m[7]) return { t: "timestamp", v: `${local.replace(" ", "T")}${m[7].toUpperCase() === "Z" ? "Z" : m[7]}`, raw };
    return { t: "timestamp_local", v: local, raw };
  }
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m && validDate(+m[3], +m[2], +m[1]) && +m[4] < 24) {
    return { t: "timestamp_local", v: `${m[3]}-${pad(m[2])}-${pad(m[1])} ${pad(m[4])}:${m[5]}:${m[6] ?? "00"}`, raw };
  }
  return { t: "text", v: s, raw };
}

// --- Workbook ----------------------------------------------------------------

const colIndex = (ref) => {
  const letters = String(ref).match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
const colLetter = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** -> { date1904, sheets: [{ name, rows: Map<rowNumber, Map<colIndex, cell>> }] } */
export function readWorkbook(buf) {
  const zip = readZip(buf);
  const wbText = zip.read("xl/workbook.xml");
  if (!wbText) throw new ReportError("invalid_xlsx", "XLSX neturi xl/workbook.xml.");
  const wb = parseXml(wbText, "workbook").workbook ?? {};
  const date1904 = ["1", "true"].includes(String(wb.workbookPr?.["@_date1904"] ?? "").toLowerCase());
  const rels = new Map(
    (parseXml(zip.read("xl/_rels/workbook.xml.rels") ?? "<Relationships/>", "rels").Relationships?.Relationship ?? []).map((r) => [
      r["@_Id"],
      String(r["@_Target"]).replace(/^\/?xl\//, "").replace(/^\//, ""),
    ]),
  );

  const shared = (parseXml(zip.read("xl/sharedStrings.xml") ?? "<sst/>", "sharedStrings").sst?.si ?? []).map(richText);

  const styles = parseXml(zip.read("xl/styles.xml") ?? "<styleSheet/>", "styles").styleSheet ?? {};
  const customFmts = new Map((styles.numFmts?.numFmt ?? []).map((f) => [Number(f["@_numFmtId"]), f["@_formatCode"]]));
  const xfKinds = (styles.cellXfs?.xf ?? []).map((xf) => {
    const id = Number(xf["@_numFmtId"] ?? 0);
    return formatKind(id, customFmts.has(id) ? customFmts.get(id) : null);
  });

  const sheets = [];
  for (const s of wb.sheets?.sheet ?? []) {
    const target = rels.get(s["@_id"]) ?? rels.get(s["@_r:id"]);
    const text = target ? zip.read(`xl/${target}`) : null;
    if (!text) continue;
    const ws = parseXml(text, `sheet ${s["@_name"]}`).worksheet ?? {};
    const rows = new Map();
    let rowSeq = 0;
    for (const row of ws.sheetData?.row ?? []) {
      const rn = Number(row["@_r"] ?? rowSeq + 1);
      rowSeq = rn;
      const cells = new Map();
      let colSeq = -1;
      for (const c of row.c ?? []) {
        const ci = c["@_r"] ? colIndex(c["@_r"]) : colSeq + 1;
        colSeq = ci;
        const t = c["@_t"];
        const v = c.v != null ? textOf(c.v) : null;
        let cell;
        if (t === "s") cell = typeText(shared[Number(v)] ?? "");
        else if (t === "inlineStr") cell = typeText(richText(c.is));
        else if (t === "str" || t === "e") cell = typeText(v ?? "");
        else if (t === "b") cell = v == null ? { t: "empty", v: null, raw: null } : { t: "boolean", v: v === "1" || v === "true", raw: v };
        else if (t === "d") cell = typeText(v ?? "");
        else if (v == null || v === "") cell = { t: "empty", v: null, raw: null };
        else {
          const num = Number(v);
          const kind = xfKinds[Number(c["@_s"] ?? 0)] ?? null;
          if (!Number.isFinite(num)) cell = typeText(v);
          else if (kind) {
            const parts = excelSerialToParts(num, date1904);
            const hasTime = kind === "datetime" && parts.time !== "00:00:00";
            cell = hasTime || (kind === "datetime" && num < 1)
              ? { t: "timestamp_local", v: `${parts.date} ${parts.time}`, raw: v }
              : { t: "date", v: parts.date, raw: v };
          } else cell = { t: "number", v: num, raw: v };
        }
        cells.set(ci, cell);
      }
      rows.set(rn, cells);
    }
    sheets.push({ name: String(s["@_name"] ?? `Sheet${sheets.length + 1}`), rows });
  }
  if (sheets.length === 0) throw new ReportError("invalid_xlsx", "XLSX neturi darbalapių.");
  return { date1904, sheets };
}

// --- Report detection ----------------------------------------------------------

/** Same folding as fn_report_header_norm() in 0042. */
export function headerNorm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[ąäà]/g, "a").replace(/č/g, "c").replace(/[ęė]/g, "e").replace(/į/g, "i").replace(/š/g, "s")
    .replace(/[ųūü]/g, "u").replace(/ž/g, "z").replace(/[öõ]/g, "o")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The header row is the one with the ORN column; the database maps the rest.
export const isOrnHeader = (text) => {
  const n = headerNorm(text);
  return n === "orn" || /\born\b/.test(n) || n.startsWith("oficialus reg");
};

const cellText = (c) => (c == null || c.t === "empty" ? "" : c.t === "number" ? String(c.raw ?? c.v) : String(c.raw ?? c.v ?? ""));
const TOTAL_WORDS = /(is viso|viso|total|suma|eiluciu|irasu)/;

/**
 * -> { sheets: [{name, header_row, rows}], columns: [{header}], rows: [{sheet, row, cells}],
 *      footer_rows, errors: [{sheet, row, error}] }
 */
export function extractReport(workbook) {
  const columns = [];
  const colIndexByHeader = new Map();
  const out = { sheets: [], columns, rows: [], footer_rows: 0, errors: [] };

  for (const sheet of workbook.sheets) {
    const rowNums = [...sheet.rows.keys()].sort((a, b) => a - b);
    const headerRow = rowNums.slice(0, HEADER_SCAN_ROWS).find((rn) => [...sheet.rows.get(rn).values()].some((c) => isOrnHeader(cellText(c))));
    if (headerRow == null) continue;

    // header cells -> global column index (by header text; repeated header in a sheet gets " (2)")
    const sheetCols = new Map(); // sheet column index -> global column index
    const seen = new Map();
    const headerCells = sheet.rows.get(headerRow);
    const dataCols = new Set();
    for (const rn of rowNums) if (rn > headerRow) for (const [ci, c] of sheet.rows.get(rn)) if (c.t !== "empty") dataCols.add(ci);
    const allCols = [...new Set([...headerCells.keys(), ...dataCols])].sort((a, b) => a - b);
    let ornCol = null;
    for (const ci of allCols) {
      let header = cellText(headerCells.get(ci)).replace(/\s+/g, " ").trim();
      if (!header) {
        if (!dataCols.has(ci)) continue;
        header = `Stulpelis ${colLetter(ci)}`;
      }
      const times = (seen.get(header) ?? 0) + 1;
      seen.set(header, times);
      if (times > 1) header = `${header} (${times})`;
      if (!colIndexByHeader.has(header)) {
        colIndexByHeader.set(header, columns.length);
        columns.push({ header });
      }
      sheetCols.set(ci, colIndexByHeader.get(header));
      if (ornCol == null && isOrnHeader(header)) ornCol = ci;
    }

    let imported = 0;
    for (const rn of rowNums) {
      if (rn <= headerRow) continue;
      const cells = sheet.rows.get(rn);
      const nonEmpty = [...sheetCols.keys()].map((ci) => cells.get(ci)).filter((c) => c && c.t !== "empty");
      if (nonEmpty.length === 0) continue;
      const ornCell = cells.get(ornCol);
      const ornText = cellText(ornCell).trim();
      if (!/^[A-Za-z]{2}/.test(ornText)) {
        const footerLike = nonEmpty.length <= 2 && nonEmpty.every((c) => c.t === "number" || /^\d+$/.test(cellText(c).trim()) || TOTAL_WORDS.test(headerNorm(cellText(c))));
        if (footerLike) {
          out.footer_rows += 1;
          continue;
        }
        if (!ornText) {
          out.errors.push({ sheet: sheet.name, row: rn, error: "Eilutė be ORN — praleista." });
          continue;
        }
      }
      const rowCells = [];
      for (const [ci, gi] of sheetCols) {
        const c = cells.get(ci) ?? { t: "empty", v: null, raw: null };
        // the ORN is an identifier: always text, never a number or a date
        rowCells.push(ci === ornCol ? { c: gi, t: ornText ? "text" : "empty", v: ornText || null, raw: c.raw ?? null } : { c: gi, t: c.t, v: c.v, raw: c.raw ?? null });
      }
      out.rows.push({ sheet: sheet.name, row: rn, cells: rowCells });
      imported += 1;
    }
    out.sheets.push({ name: sheet.name, header_row: headerRow, rows: imported });
  }
  if (out.sheets.length === 0) throw new ReportError("no_orn_column", "Nerastas stulpelis „Oficialus reg. Nr. (ORN)“ nė viename darbalapyje.");
  return out;
}

/** "Gvet_20261030 121001.xlsx" -> "2026-10-30 12:10:01" (Europe/Vilnius wall clock), else null. */
export function reportTimeFromFilename(filename) {
  const m = String(filename).match(/(\d{4})(\d{2})(\d{2})[ _T-]?(\d{2})(\d{2})(\d{2})?/);
  if (!m || !validDate(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? "00"}`;
}

/** Wall-clock "YYYY-MM-DD HH:MM:SS" in Europe/Vilnius for an instant (fallback report time). */
export function vilniusLocal(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Vilnius", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Parse an uploaded report into the delpro_report_ingest body (without token / hash). */
export function parseReport(buf, { filename, receivedAt = new Date() } = {}) {
  const report = extractReport(readWorkbook(buf));
  const fromName = reportTimeFromFilename(filename);
  return {
    ...report,
    report_at_local: fromName ?? vilniusLocal(receivedAt),
    report_at_source: fromName ? "filename" : "received",
  };
}

// Test helper: writes real XLSX files (deflated ZIP + SpreadsheetML), the way
// Excel / DelPro's report export stores them — shared strings, inline strings,
// date number formats (built-in 14 and a custom "yyyy-mm-dd hh:mm"), numbers.
//
// cell: null | "text" | 123 | { date: serial } | { datetime: serial } | { inline: "text" } | { bool: true }
// sheets: [{ name, rows: [[cell, ...], ...] }]   (row arrays start at column A, row 1)
import zlib from "node:zlib";

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, "utf8");
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const col = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function buildXlsx({ sheets, date1904 = false }) {
  const shared = [];
  const sharedIdx = new Map();
  const ss = (s) => {
    if (!sharedIdx.has(s)) {
      sharedIdx.set(s, shared.length);
      shared.push(s);
    }
    return sharedIdx.get(s);
  };
  const sheetXml = sheets.map((sh) => {
    const rows = sh.rows
      .map((cells, r) => {
        const cs = cells
          .map((v, c) => {
            const ref = `${col(c)}${r + 1}`;
            if (v == null) return "";
            if (typeof v === "string") return `<c r="${ref}" t="s"><v>${ss(v)}</v></c>`;
            if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
            if (v.date != null) return `<c r="${ref}" s="1"><v>${v.date}</v></c>`;
            if (v.datetime != null) return `<c r="${ref}" s="2"><v>${v.datetime}</v></c>`;
            if (v.inline != null) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v.inline)}</t></is></c>`;
            if (v.bool != null) return `<c r="${ref}" t="b"><v>${v.bool ? 1 : 0}</v></c>`;
            return "";
          })
          .join("");
        return `<row r="${r + 1}">${cs}</row>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${date1904 ? ' date1904="1"' : ""}/><sheets>${sheets
        .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("")}</Relationships>`,
    ],
    [
      "xl/styles.xml",
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    ],
    ...sheetXml.map((x, i) => [`xl/worksheets/sheet${i + 1}.xml`, x]),
  ];
  // shared strings last so every sheet's strings are collected
  files.push([
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
      .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
      .join("")}</sst>`,
  ]);
  return zip(files);
}

/** Excel serial for a Vilnius wall-clock date/time (no time zone: Excel stores wall clock). */
export function serial(y, m, d, hh = 0, mm = 0) {
  return (Date.UTC(y, m - 1, d, hh, mm) - Date.UTC(1899, 11, 30)) / 86400000;
}

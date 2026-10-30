import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { buildRequestData, createGatewayClient, fetchWsdl } from "./gateway.js";
import { CATALOG_TYPES } from "./catalog.js";

// On-site Gateway discovery (read-only): saves the WSDL (+ imported schemas),
// and for each catalog type a small GetData sample — the request document,
// the raw SOAP response and the decoded result — under discovery/, so the
// client and parser can be checked against the farm's real Gateway. Request
// files hold only xmlData: credentials are never written to disk.
//
//   npm run gateway-discover               -> WSDL + 5 rows of every catalog type + Animal
//   npm run gateway-discover -- Diagnosis  -> only that type
//   SAMPLE_TOP=200 npm run gateway-discover -- Diagnosis

const OUT = path.join(ROOT, "discovery");
const top = Number(process.env.SAMPLE_TOP ?? 5);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const wsdl = await fetchWsdl();
  fs.writeFileSync(path.join(OUT, "GatewaySoapService.wsdl"), wsdl);
  const ops = [...new Set([...wsdl.matchAll(/<(?:\w+:)?operation\s+name="([^"]+)"/g)].map((m) => m[1]))];
  console.log(`WSDL: ${wsdl.length} simbolių, operacijos: ${ops.join(", ") || "(nerasta)"}`);
  for (const [, loc] of wsdl.matchAll(/schemaLocation="([^"]+)"/g)) {
    const url = loc.replace(/&amp;/g, "&");
    const xsd = await fetchWsdl(url);
    const name = `schema-${(url.split("=").pop() || "xsd").replace(/[^\w.-]/g, "_")}.xsd`;
    fs.writeFileSync(path.join(OUT, name), xsd);
    console.log(`Schema: ${name}`);
  }

  let raw = null;
  const client = createGatewayClient({ onResponse: (_op, text) => (raw = text) });
  const wanted = process.argv.slice(2);
  const targets = [
    ...CATALOG_TYPES.map((t) => ({ objectName: t.objectName, properties: Object.values(t.fields).map(([p]) => p) })),
    { objectName: "Animal", properties: ["ObjectGuid", "Number"] },
  ].filter((t) => wanted.length === 0 || wanted.includes(t.objectName));

  for (const t of targets) {
    const request = buildRequestData({ ...t, top });
    fs.writeFileSync(path.join(OUT, `${t.objectName}.request.xml`), request);
    try {
      const result = await client.getDataXml(request);
      fs.writeFileSync(path.join(OUT, `${t.objectName}.soap-response.xml`), raw ?? "");
      fs.writeFileSync(path.join(OUT, `${t.objectName}.result.xml`), result);
      const rows = (result.match(/<object\b/g) || []).length;
      console.log(`${t.objectName}: ${rows} eil. (top=${top})`);
    } catch (err) {
      if (raw) fs.writeFileSync(path.join(OUT, `${t.objectName}.soap-response.xml`), raw);
      console.log(`${t.objectName}: KLAIDA ${err.code ?? ""} ${err.message}`);
    }
    raw = null;
  }
  console.log(`\nFailai: ${OUT}  (Gateway ${config.gateway.url})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

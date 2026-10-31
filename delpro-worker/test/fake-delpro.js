import { randomUUID } from "node:crypto";
import { GatewayError, escapeXml, parseDdmData } from "../src/gateway.js";

// In-memory stand-in for the parts of the DelPro Gateway the write paths use
// (GetData with <equal> filters, CreateData, UpdateData identified by the key
// property). A TEST DOUBLE for our own logic — it is not evidence of how the
// real Gateway behaves; that is what the on-farm test jobs establish.
const KEY = { Diagnosis: "Code", Drug: "Code", Treatment: "Code", DrugParameters: "Key", TreatmentDrugUsage: "Key", DiagnosesAndTreatmentEvent: "ObjectGuid", Animal: "ObjectGuid" };
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function fakeDelpro({ onCreate, timeoutAfterCreate = 0 } = {}) {
  const db = {};
  const calls = [];
  let seq = 1000;
  let timeouts = timeoutAfterCreate;
  const rows = (name) => (db[name] ??= {});

  return {
    db,
    calls,
    async getDataXml(req) {
      calls.push(["GetData", req]);
      const name = req.match(/<object name="(\w+)"/)[1];
      const props = [...req.matchAll(/<property name="(\w+)"\/>/g)].map((m) => m[1]);
      let found = Object.values(rows(name));
      for (const [, k, v] of req.matchAll(/<equal name="(\w+)">([^<]*)<\/equal>/g)) found = found.filter((r) => String(r[k] ?? "") === unescape(v));
      const objs = found
        .map((r) => `<object name="${name}">${props.map((p) => (r[p] == null || r[p] === "" ? `<property name="${p}" />` : `<property name="${p}">${escapeXml(r[p])}</property>`)).join("")}</object>`)
        .join("");
      return `<ddmData>${objs}</ddmData>`;
    },
    async createData(xml) {
      calls.push(["CreateData", xml]);
      const [o] = parseDdmData(xml);
      const kp = KEY[o.objectName] ?? "ObjectGuid";
      const key = kp === "ObjectGuid" ? randomUUID() : String(seq++);
      const row = { [kp]: key };
      for (const [n, p] of Object.entries(o.properties)) row[n] = p.value;
      onCreate?.(o.objectName, row);
      rows(o.objectName)[key] = row;
      if (o.objectName === "TreatmentDrugUsage" && row.Treatment && rows("Treatment")[row.Treatment]) {
        const t = rows("Treatment")[row.Treatment];
        t.DrugUsages = [t.DrugUsages, key].filter(Boolean).join(",");
      }
      if (timeouts > 0) {
        timeouts -= 1;
        throw new GatewayError("TIMEOUT", "Gateway CreateData: baigėsi laukimo laikas", { retryable: true, outcomeUnknown: true });
      }
      return { status: "OK", created: [{ type: o.objectName, keyProperty: kp, keyValue: key, id: "0" }] };
    },
    async updateData(xml) {
      calls.push(["UpdateData", xml]);
      const [o] = parseDdmData(xml);
      const kp = KEY[o.objectName];
      const row = rows(o.objectName)[o.properties[kp]?.value];
      if (!row) throw new GatewayError("WRITE_REJECTED", "not found");
      for (const [n, p] of Object.entries(o.properties)) if (n !== kp) row[n] = p.value;
      return { status: "OK", created: [] };
    },
  };
}

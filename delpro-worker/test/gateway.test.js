// DelPro Gateway SOAP client + catalog parsing, against the verbatim Gateway
// documents in fixtures/gateway (captured on the farm PC). Where a test needs
// a whole SOAP *response* envelope (never captured), it builds a minimal
// standard SOAP 1.1 one and says so — those tests check our handling of the
// SOAP standard, not a claim about the Gateway's exact bytes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GatewayError,
  buildRequestData,
  createGatewayClient,
  escapeXml,
  extractSoapResult,
  parseDdmData,
  parseWriteResponse,
  soapEnvelope,
} from "../src/gateway.js";
import { CATALOG_TYPES, fetchMissingRefs, normalizeRecord, readCatalogType } from "../src/catalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, "fixtures/gateway", name), "utf8");
const squash = (xml) => xml.replace(/>\s+</g, "><").trim();
const typeOf = (name) => CATALOG_TYPES.find((t) => t.objectName === name);

// Minimal SOAP 1.1 response in the WCF shape (<OpResponse><OpResult>escaped</OpResult>) — test scaffolding only.
const soapResponse = (op, resultXml) =>
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${op}Response xmlns="http://tempuri.org/"><${op}Result>${escapeXml(resultXml)}</${op}Result></${op}Response></s:Body></s:Envelope>`;

test("request documents match the verified GetData requests exactly", () => {
  assert.equal(
    buildRequestData({ objectName: "Animal", properties: ["ObjectGuid", "Number"], where: [{ name: "Number", value: "337" }], top: 1 }),
    squash(fixture("animal-337.request.xml")),
  );
  assert.equal(
    buildRequestData({
      objectName: "TreatmentDrugUsage",
      properties: ["Key", "Treatment", "Drug", "DrugParams", "Dosage", "Frequency", "TreatCowDays"],
      where: [{ op: "equal", name: "Key", value: 197 }],
      top: 1,
    }),
    squash(fixture("tdu-197.request.xml")),
  );
  // values are escaped, names are validated (no XML injection through a property/object name)
  assert.match(buildRequestData({ objectName: "Diagnosis", properties: ["Name"], where: [{ name: "Name", value: `A<&"B` }] }), /A&lt;&amp;&quot;B/);
  assert.throws(() => buildRequestData({ objectName: 'Drug" top="1', properties: ["Name"] }));
  assert.throws(() => buildRequestData({ objectName: "Drug", properties: ["Name/><x"] }));
});

test("envelope carries clientId, user, password, xmlData in order, xmlData as escaped text", () => {
  const env = soapEnvelope("GetData", { clientId: "GUID", user: "HerdNav", password: "", xmlData: squash(fixture("animal-337.request.xml")) });
  assert.match(env, /^<s:Envelope xmlns:s="http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\/"><s:Body><GetData xmlns="http:\/\/tempuri\.org\/">/);
  assert.match(env, /<clientId>GUID<\/clientId><user>HerdNav<\/user><password><\/password><xmlData>&lt;requestData&gt;&lt;object name=&quot;Animal&quot;/);
  assert.ok(!env.includes("<requestData>"), "inner XML must be element text, not markup");
});

test("parses the real Animal 337 result", () => {
  const [animal] = parseDdmData(fixture("animal-337.result.xml"));
  assert.equal(animal.objectName, "Animal");
  assert.deepEqual(animal.properties.ObjectGuid, { value: "f3d9f5df-f72f-4659-8d25-66a02cf583eb", objectType: null });
  assert.equal(animal.properties.Number.value, "337");
});

test("parses the real TreatmentDrugUsage 197: references by objectType, typed values", () => {
  const objects = parseDdmData(fixture("tdu-197.result.xml"));
  assert.equal(objects.length, 1);
  assert.deepEqual(objects[0].properties.DrugParams, { value: "218", objectType: "DrugParameters" });
  const { record, warnings } = normalizeRecord(typeOf("TreatmentDrugUsage"), objects[0]);
  assert.deepEqual(record, { key: "197", treatment: "40", drug: "7", drug_params: "218", dosage: 20, frequency: 1, treat_cow_days: 1 });
  assert.deepEqual(warnings, []);
});

test("parses the real DrugParameters 218: empty property = null", () => {
  const [params] = parseDdmData(fixture("drugparameters-218.result.xml"));
  assert.equal(params.properties.ApplicationMethod.value, null);
  const { record } = normalizeRecord(typeOf("DrugParameters"), params);
  assert.deepEqual(record, { key: "218", uom: "ml", application_method: null, dump_milk_days: 0, meat_withhold_days: 4 });
});

test("list references and unparseable values", () => {
  const [t] = parseDdmData(
    `<ddmData><object name="Treatment"><property name="Code">40</property><property name="Active">True</property>` +
      `<property name="DrugUsages" objectType="TreatmentDrugUsage">197, 198,199</property></object></ddmData>`,
  );
  const { record } = normalizeRecord(typeOf("Treatment"), t);
  assert.deepEqual(record.drug_usages, ["197", "198", "199"]);
  assert.equal(record.active, true);
  // a value the worker can't type is passed through for the database to reject and count
  const [u] = parseDdmData(`<ddmData><object name="TreatmentDrugUsage"><property name="Key">1</property><property name="Dosage">abc</property></object></ddmData>`);
  assert.equal(normalizeRecord(typeOf("TreatmentDrugUsage"), u).record.dosage, "abc");
  // a reference pointing at an unexpected object type is reported
  const [d] = parseDdmData(`<ddmData><object name="Drug"><property name="Code">7</property><property name="DefaultParameters" objectType="Drug">1</property></object></ddmData>`);
  assert.equal(normalizeRecord(typeOf("Drug"), d).warnings.length, 1);
  assert.deepEqual(parseDdmData(`<ddmData />`), []);
});

test("CreateData result: the real OK response, and a refusal", () => {
  assert.deepEqual(parseWriteResponse(fixture("createdata-event.result.xml")), {
    status: "OK",
    created: [{ type: "DiagnosesAndTreatmentEvent", keyProperty: "ObjectGuid", keyValue: "489751f2-ffc7-4491-a445-482160d62620", id: "0" }],
  });
  assert.throws(() => parseWriteResponse(`<Response status="Error"/>`), (e) => e instanceof GatewayError && e.code === "WRITE_REJECTED");
});

test("SOAP layer: result extraction, Fault, garbage", () => {
  assert.equal(extractSoapResult("GetData", soapResponse("GetData", fixture("animal-337.result.xml"))), fixture("animal-337.result.xml").trim());
  const fault = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring xml:lang="en-US">Invalid user</faultstring></s:Fault></s:Body></s:Envelope>`;
  assert.throws(() => extractSoapResult("GetData", fault), (e) => e.code === "SOAP_FAULT" && /Invalid user/.test(e.message));
  assert.throws(() => extractSoapResult("GetData", "<html>proxy error</html>"), (e) => e.code === "BAD_RESPONSE");
  assert.throws(() => parseDdmData(""), (e) => e.code === "BAD_RESPONSE");
});

test("writes are refused unless the client explicitly allows them", async () => {
  const client = createGatewayClient({ url: "http://127.0.0.1:9/never-called" });
  await assert.rejects(client.createData("<ddmData/>"), (e) => e.code === "WRITES_DISABLED");
  await assert.rejects(client.updateData("<ddmData/>"), (e) => e.code === "WRITES_DISABLED");
});

// --- HTTP behaviour against a local stand-in ---------------------------------
const seen = [];
let mode = "ok";
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  seen.push({ headers: req.headers, body });
  if (mode === "flaky" && seen.length === 1) {
    res.writeHead(503).end("busy");
    return;
  }
  if (mode === "hang") return; // never answers -> client timeout
  const op = req.headers.soapaction?.match(/IGatewayService\/(\w+)"/)?.[1];
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(soapResponse(op, op === "CreateData" ? fixture("createdata-event.result.xml") : fixture("animal-337.result.xml")));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/GatewaySoapService`;
after(() => server.close());

test("HTTP: SOAPAction + content type, credentials only in the body, reads retried", async () => {
  seen.length = 0;
  mode = "flaky";
  const client = createGatewayClient({ url, user: "HerdNav", password: "p&ss", clientId: "c1", readRetries: 2, timeoutMs: 2000 });
  const [animal] = await client.getData("Animal", ["ObjectGuid", "Number"], [{ name: "Number", value: "337" }], { top: 1 });
  assert.equal(animal.properties.Number.value, "337");
  assert.equal(seen.length, 2, "a 503 read is retried");
  assert.equal(seen[1].headers.soapaction, '"http://tempuri.org/IGatewayService/GetData"');
  assert.match(seen[1].headers["content-type"], /^text\/xml; charset=utf-8/);
  assert.match(seen[1].body, /<password>p&amp;ss<\/password>/);
});

test("HTTP: a write that times out is never retried and is flagged outcomeUnknown", async () => {
  seen.length = 0;
  mode = "hang";
  const client = createGatewayClient({ url, user: "HerdNav", password: "", allowWrites: true, readRetries: 2, timeoutMs: 300 });
  await assert.rejects(client.createData("<ddmData/>"), (e) => e.code === "TIMEOUT" && e.outcomeUnknown === true && !/HerdNav/.test(e.message));
  assert.equal(seen.length, 1);
  mode = "ok";
  const ok = await client.createData("<ddmData/>");
  assert.equal(ok.created[0].keyValue, "489751f2-ffc7-4491-a445-482160d62620");
});

// --- completeness: never trust a read that may have been capped -------------
function fakeCatalog(rows, cap) {
  // rows: [{Code, Name, Active}] ; the fake Gateway returns at most `cap` rows per request
  return {
    requests: [],
    async getDataXml(req) {
      this.requests.push(req);
      const eq = req.match(/<equal name="(\w+)">([^<]*)<\/equal>/);
      const hit = rows.filter((r) => !eq || r[eq[1]] === eq[2]).slice(0, cap);
      const objs = hit
        .map((r) => `<object name="Diagnosis">${Object.entries(r).map(([k, v]) => `<property name="${k}">${v}</property>`).join("")}</object>`)
        .join("");
      return `<ddmData>${objs}</ddmData>`;
    },
  };
}
const diagnoses = (n, inactiveEvery = 3) =>
  Array.from({ length: n }, (_, i) => ({ Code: String(i + 1), Name: `D${i + 1}`, Active: i % inactiveEvery === 0 ? "false" : "true" }));

test("catalog read: complete when well under the limit (partition check agrees)", async () => {
  const client = fakeCatalog(diagnoses(12), 1000);
  const res = await readCatalogType(client, typeOf("Diagnosis"), { maxRows: 100 });
  assert.equal(res.complete, true);
  assert.equal(res.records.length, 12);
  assert.match(client.requests[0], /<object name="Diagnosis" top="100">/);
  assert.equal(client.requests.length, 3, "main read + one per Active value");
});

test("catalog read: a Gateway-side cap below `top` is detected (and the extra rows kept)", async () => {
  const client = fakeCatalog(diagnoses(200), 150);
  const res = await readCatalogType(client, typeOf("Diagnosis"), { maxRows: 5000 });
  assert.equal(res.returned, 150);
  assert.equal(res.complete, false);
  assert.equal(res.note, "truncated");
  assert.ok(res.records.length > 150);
});

test("catalog read: hitting `top` itself is incomplete", async () => {
  const res = await readCatalogType(fakeCatalog(diagnoses(10), 1000), typeOf("Diagnosis"), { maxRows: 10 });
  assert.equal(res.complete, false);
});

test("catalog read: exactly the Gateway row cap (1000) is never the whole catalog, even below `top`", async () => {
  // 1500 rows, the Gateway answers at most 1000 per request; many partition values (no cross-check possible)
  const rows = Array.from({ length: 1500 }, (_, i) => ({ Code: String(i + 1), Name: `D${i + 1}`, Active: String(i % 40) }));
  const res = await readCatalogType(fakeCatalog(rows, 1000), typeOf("Diagnosis"), { maxRows: 5000, rowCap: 1000 });
  assert.equal(res.returned, 1000);
  assert.equal(res.partitions, null, "too many values for the partition check");
  assert.equal(res.complete, false);
  assert.equal(res.note, "truncated");
});

test("catalog read: a failed partition re-read makes the type incomplete", async () => {
  let n = 0;
  const inner = fakeCatalog(diagnoses(12), 1000);
  const client = {
    async getDataXml(req) {
      if (++n === 2) throw new Error("Gateway timeout");
      return inner.getDataXml(req);
    },
  };
  const res = await readCatalogType(client, typeOf("Diagnosis"), { maxRows: 5000 });
  assert.equal(res.complete, false);
  assert.equal(res.note, "partition_check_failed");
});

test("catalog read: referenced records beyond a truncated type are fetched by key, missing ones listed", async () => {
  const params = (key) =>
    `<object name="DrugParameters"><property name="Key">${key}</property><property name="UOM">ml</property><property name="ApplicationMethod" /><property name="DumpMilkDays">0</property><property name="MeatWithholdDays">4</property></object>`;
  const requests = [];
  const client = {
    async getDataXml(req) {
      requests.push(req);
      const eq = req.match(/<equal name="Key">([^<]*)<\/equal>/);
      if (eq) return eq[1] === "9001" ? `<ddmData>${params("9001")}</ddmData>` : "<ddmData></ddmData>";
      return "<ddmData></ddmData>";
    },
  };
  const results = {
    DrugParameters: { records: [{ key: "1", uom: "ml" }], keyField: "key", complete: false, note: "truncated" },
    Drug: { records: [{ code: "7", default_parameters: "9001" }, { code: "8", default_parameters: "1" }], keyField: "code", complete: true },
    TreatmentDrugUsage: { records: [{ key: "197", drug_params: "9002", drug: "7" }], keyField: "key", complete: true },
  };
  await fetchMissingRefs(client, results);
  const dp = results.DrugParameters;
  assert.deepEqual(dp.records.map((r) => r.key).sort(), ["1", "9001"]);
  assert.equal(dp.refFetched, 1);
  assert.deepEqual(dp.refMissing, ["9002"]);
  assert.equal(dp.complete, false, "still incomplete: fetching references proves nothing about the rest");
  assert.ok(requests.every((r) => /<equal name="Key">/.test(r) && /top="2"/.test(r)));
});

test("catalog read: a key lookup the Gateway does not filter stops further lookups", async () => {
  const two = `<ddmData><object name="DrugParameters"><property name="Key">5</property></object><object name="DrugParameters"><property name="Key">6</property></object></ddmData>`;
  const client = { requests: 0, async getDataXml() { this.requests += 1; return two; } };
  const results = {
    DrugParameters: { records: [], keyField: "key", complete: false },
    Drug: { records: [{ code: "7", default_parameters: "9001" }, { code: "8", default_parameters: "9002" }], keyField: "code", complete: true },
  };
  await fetchMissingRefs(client, results);
  assert.equal(client.requests, 1);
  assert.equal(results.DrugParameters.note, "ref_lookup_unreliable");
  assert.deepEqual(results.DrugParameters.records, []);
  assert.deepEqual(results.DrugParameters.refMissing.sort(), ["9001", "9002"]);
});

// --- write paths (pure) ------------------------------------------------------
import { buildWriteXml, compareStep } from "../src/catalog-writer.js";
import { buildEventXml, writeTreatment } from "../src/treatment-gateway.js";
import { fakeDelpro } from "./fake-delpro.js";

test("treatment event XML is exactly the verified CreateData shape", () => {
  const verified = `<ddmData>
  <object name="DiagnosesAndTreatmentEvent">
    <property name="Animal" objectType="Animal">f3d9f5df-f72f-4659-8d25-66a02cf583eb</property>
    <property name="Diagnosis" objectType="Diagnosis">11</property>
    <property name="EventDate">2026-10-29T10:32:00Z</property>
    <property name="EventTime">12:32:00</property>
    <property name="Comment">GVET_SLUBA_TEST_2e8aaf8d</property>
  </object>
</ddmData>`;
  assert.equal(
    buildEventXml({ animal_guid: "f3d9f5df-f72f-4659-8d25-66a02cf583eb", diagnosis_code: "11", event_at: "2026-10-29T10:32:00Z", event_time: "12:32:00", comment: "GVET_SLUBA_TEST_2e8aaf8d" }),
    squash(verified),
  );
});

test("catalog write XML: refs resolved from earlier steps, key property first on update, values escaped", () => {
  const create = {
    id: "main", object: "Drug", operation: "create", key_property: "Code",
    properties: [
      { name: "Name", value: "A & B" },
      { name: "Active", value: false },
      { name: "ActiveSubstance", value: null },
      { name: "DefaultParameters", object_type: "DrugParameters", ref_step: "params" },
    ],
  };
  assert.equal(
    buildWriteXml(create, { params: "218" }),
    `<ddmData><object name="Drug"><property name="Name">A &amp; B</property><property name="Active">false</property><property name="ActiveSubstance" /><property name="DefaultParameters" objectType="DrugParameters">218</property></object></ddmData>`,
  );
  const update = { id: "main", object: "Diagnosis", operation: "update", key_property: "Code", key: "11", properties: [{ name: "Name", value: "Šluba" }] };
  assert.equal(buildWriteXml(update, {}), `<ddmData><object name="Diagnosis"><property name="Code">11</property><property name="Name">Šluba</property></object></ddmData>`);
  assert.throws(() => buildWriteXml(create, {}), /neturi DelPro rakto/);

  const [readBack] = parseDdmData(`<ddmData><object name="Drug"><property name="Name">A &amp; B</property><property name="Active">False</property><property name="ActiveSubstance" /><property name="DefaultParameters" objectType="DrugParameters">218</property></object></ddmData>`);
  assert.deepEqual(compareStep(create, readBack, { params: "218" }), []);
  assert.equal(compareStep(create, readBack, { params: "219" })[0].property, "DefaultParameters");
});

test("Gateway treatment: an event carrying this job's marker on another animal is never adopted, nothing written", async () => {
  const delpro = fakeDelpro();
  const gateway = { animal_guid: "f3d9f5df-f72f-4659-8d25-66a02cf583eb", diagnosis_code: "11", event_at: "2026-10-29T10:32:00Z", event_time: "12:32:00", comment: "GVET:abc Mastitas" };
  delpro.db.DiagnosesAndTreatmentEvent = { x: { ObjectGuid: "x", Animal: "00000000-0000-0000-0000-000000000001", Diagnosis: "11", Comment: "GVET:abc Mastitas" } };
  const model = { verified: true, usage_object: "TestDrugUsage", key_property: "ObjectGuid", properties: { event: "HealthEvent", drug: "Drug", dosage: "Dosage" } };
  const plan = { gateway_event: gateway, treatment: { course_days: null }, diagnosis: {}, medicines: [{ product_name: "A", drug_code: "7", qty: 10 }] };
  await assert.rejects(writeTreatment(delpro, plan, model), /kitam gyvuliui ar diagnozei/);
  assert.equal(delpro.calls.filter(([op]) => op === "CreateData").length, 0);
});

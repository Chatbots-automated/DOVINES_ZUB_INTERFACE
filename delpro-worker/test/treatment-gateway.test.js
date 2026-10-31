// GVET treatment -> DelPro (0044): saving a treatment queues it, the worker's
// normal outbound loop (OUTBOUND_MODE=gateway) claims it, writes the event + its
// medicine records over the real SOAP client to a fake Gateway, reads back, and
// GVET's report decides Sent / Failed / retry. Database = PGlite, every migration.
//
// The medication model below ("TestDrugUsage" + property names) is TEST DATA for
// our own logic — it is not a claim about DelPro 10.9. The real one is written on
// the farm from `npm run treatment-probe` and a manual DelPro check.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createTestDb } from "../../supabase/tests/helpers/db.mjs";
import { fakeDelpro } from "./fake-delpro.js";

const MODEL = {
  verified: true, verified_by: "test", verified_at: "2026-10-31", evidence: "test double",
  usage_object: "TestDrugUsage", key_property: "ObjectGuid",
  properties: { event: "HealthEvent", drug: "Drug", drug_params: "DrugParams", dosage: "Dosage", treat_days: "TreatDays" },
  event_treatment_property: null,
};
const GUID = "aaaaaaaa-0000-4000-8000-000000000512";
const NAMED = { delpro_claim_next_job: ["p_worker_id", "p_channel"], delpro_release_stale_jobs: [] };

let db, server, gw, delpro, idx, tg, cfg, modelFile;
const q = async (sql, params) => (await db.query(sql, params)).rows;
const asUser = async (id, sql) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${id}', false);`);
  try {
    return (await db.query(sql)).rows[0];
  } finally {
    await db.exec("reset role");
  }
};
const ADMIN = "00000000-0000-0000-0000-0000000000aa";
const VET = "00000000-0000-0000-0000-0000000000bb";

function seedDelpro() {
  delpro = fakeDelpro();
  delpro.db.Animal = { [GUID]: { ObjectGuid: GUID, Number: "512" } };
  delpro.db.Diagnosis = { 21: { Code: "21", Name: "Akių ligos" } };
  delpro.db.Drug = { 119: { Code: "119", Name: "Vetrimoxin LA", DefaultParameters: "67211" } };
  delpro.db.DrugParameters = { 67211: { Key: "67211", UOM: "ml", DumpMilkDays: "4", MeatWithholdDays: "15" } };
}

/** A vet saves a gydymas treatment: GVET queues it by itself (auto mode, 0044). Returns its job id. */
async function savedTreatment(qty = 20) {
  const id = (await asUser(VET, `select create_treatment(jsonb_build_object('animal_id', (select id from animals where tag_no = 'LT000044547452'),
    'reg_date', '2026-10-30', 'diagnosis', 'Akių ligos', 'disease_id', '43000000-0000-0000-0000-0000000000d1', 'vet_name', 'Dr. Test',
    'medications', jsonb_build_array(jsonb_build_object('product_id', '43000000-0000-0000-0000-0000000000a1', 'qty', ${qty}, 'unit', 'ml')))) as id`)).id;
  return (await q(`select id from delpro_sync_jobs where treatment_id = $1`, [id]))[0].id;
}

before(async () => {
  db = await createTestDb();
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const fn = req.url.match(/rpc\/([a-z_]+)$/)[1];
    try {
      await db.exec("set role service_role");
      const parsed = body ? JSON.parse(body) : {};
      const r = NAMED[fn]
        ? await db.query(`select ${fn}(${NAMED[fn].map((_, i) => `$${i + 1}`).join(",")}) as r`, NAMED[fn].map((n) => parsed[n] ?? null))
        : await db.query(`select ${fn}($1::jsonb) as r`, [body || "{}"]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.rows[0].r));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: err.message }));
    } finally {
      await db.exec("reset role").catch(() => {});
    }
  });
  await new Promise((r) => server.listen(0, r));
  // the worker's real SOAP client talks to this fake Gateway
  const { escapeXml } = await import("../src/gateway.js");
  gw = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const op = String(req.headers.soapaction).replace(/^"?.*\//, "").replace(/"$/, "");
    const xmlData = body.match(/<xmlData>([\s\S]*)<\/xmlData>/)[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    let result;
    try {
      if (op === "GetData") result = await delpro.getDataXml(xmlData);
      else {
        const r = op === "CreateData" ? await delpro.createData(xmlData) : await delpro.updateData(xmlData);
        result = `<Response status="OK">${r.created.map((c) => `<CreatedObject type="${c.type}" keyProperty="${c.keyProperty}" keyValue="${c.keyValue}" id="0"/>`).join("")}</Response>`;
      }
    } catch {
      // the fake's "timeout after the write landed": a failing server answer, outcome unknown to the worker
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${op}Response xmlns="http://tempuri.org/"><${op}Result>${escapeXml(result)}</${op}Result></${op}Response></s:Body></s:Envelope>`);
  });
  await new Promise((r) => gw.listen(0, r));

  modelFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gvet-model-")), "treatment-model.json");
  Object.assign(process.env, {
    SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SERVICE_ROLE_KEY: "k", WORKER_ID: "pilot-pc",
    DELPRO_SOURCE: "off", OUTBOUND_MODE: "off", CATALOG_SOURCE: "gateway", DELPRO_GATEWAY_USER: "HerdNav",
    DELPRO_GATEWAY_URL: `http://127.0.0.1:${gw.address().port}/GatewaySoapService`, TREATMENT_MODEL_FILE: modelFile,
  });
  cfg = (await import("../src/config.js")).config;
  Object.assign(cfg, { supabaseUrl: process.env.SUPABASE_URL, serviceKey: "k", catalogSource: "gateway", workerId: "pilot-pc" });
  Object.assign(cfg.gateway, { url: process.env.DELPRO_GATEWAY_URL, user: "HerdNav" });
  Object.assign(cfg, { outboundMode: "gateway" });
  idx = await import("../src/index.js");
  tg = await import("../src/treatment-gateway.js");

  await db.exec(`
    insert into auth.users values ('${ADMIN}', 'admin@x'), ('${VET}', 'vet@x');
    insert into users (id, email, role) values ('${ADMIN}', 'admin@x', 'admin'), ('${VET}', 'vet@x', 'vet');
    insert into animals (tag_no, animal_no, delpro_animal_id, delpro_object_guid, source) values
      ('LT000044547452', '512', 'dp-512', '${GUID}', 'delpro'),
      ('LT000044547479', '513', 'dp-513', null, 'delpro');
    insert into diseases (id, name) values ('43000000-0000-0000-0000-0000000000d1', 'Akių ligos');
    insert into products (id, name, category, unit, withdrawal_days_milk, withdrawal_days_meat) values
      ('43000000-0000-0000-0000-0000000000a1', 'Vetrimoxin LA', 'medicines', 'ml', 4, 15),
      ('43000000-0000-0000-0000-0000000000a2', 'Nesusietas vaistas', 'medicines', 'ml', 1, 1);
    insert into batches (product_id, lot, expiry_date, received_qty) values
      ('43000000-0000-0000-0000-0000000000a1', 'B1', '2030-01-01', 1000), ('43000000-0000-0000-0000-0000000000a2', 'B2', '2030-01-01', 1000);
  `);
  await db.exec("set role service_role");
  const run = (await db.query(`select delpro_catalog_begin_run('{"worker_id":"t"}'::jsonb)->>'run_id' as id`)).rows[0].id;
  await db.query(`select delpro_catalog_upload($1::jsonb)`, [JSON.stringify({ run_id: run, object_type: "DrugParameters", records: [{ key: "67211", uom: "ml", dump_milk_days: 4, meat_withhold_days: 15 }] })]);
  await db.query(`select delpro_catalog_upload($1::jsonb)`, [JSON.stringify({ run_id: run, object_type: "Drug", records: [{ code: "119", name: "Vetrimoxin LA", active: true, default_parameters: "67211" }] })]);
  await db.query(`select delpro_catalog_upload($1::jsonb)`, [JSON.stringify({ run_id: run, object_type: "Diagnosis", records: [{ code: "21", name: "Akių ligos", active: true }] })]);
  await db.query(`select delpro_catalog_finish_run($1::jsonb)`, [JSON.stringify({ run_id: run, types: {} })]);
  await db.exec(`select fn_delpro_catalog_create_link('Diagnosis', '21', '43000000-0000-0000-0000-0000000000d1', 'manual', null);
                 select fn_delpro_catalog_create_link('Drug', '119', '43000000-0000-0000-0000-0000000000a1', 'manual', null);`);
  await db.exec("reset role");
});

after(() => {
  server?.close();
  gw?.close();
});

const plan = (job) => q(`select fn_delpro_treatment_plan($1::uuid) as p`, [job]).then((r) => r[0].p);
const codes = (ps) => ps.map((p) => p.code).sort();
const job = (id) => q(`select status, verified, error, attempts, requires_verification, next_attempt_at, actual_result from delpro_sync_jobs where id = $1`, [id]).then((r) => r[0]);
const writes = () => delpro.calls.filter(([op]) => op !== "GetData").length;
const done = (...ids) => db.exec(`update delpro_sync_jobs set status = 'rejected' where id in (${ids.map((i) => `'${i}'`).join(",")})`);

test("saving a treatment queues it at once; settings: auto, no delay, gateway channel", async () => {
  const id = await savedTreatment();
  assert.equal((await job(id)).status, "pending_approval");
  const s = Object.fromEntries((await q(`select setting_key k, setting_value v from system_settings where setting_key in ('delpro_outbound_mode', 'delpro_auto_delay_minutes', 'delpro_write_channel')`)).map((r) => [r.k, r.v]));
  assert.deepEqual(s, { delpro_outbound_mode: "auto", delpro_auto_delay_minutes: "0", delpro_write_channel: "gateway" });
  const p = await plan(id);
  assert.deepEqual(p.problems, []);
  assert.equal(p.animal.delpro_object_guid, GUID);
  assert.deepEqual([p.diagnosis.code, p.medicines[0].drug_code, p.medicines[0].drug_params_key, Number(p.medicines[0].qty)], ["21", "119", "67211", 20]);
  await done(id);
});

test("plan problems: no verified animal GUID, unlinked medicine, GVET vs DelPro withdrawal", async () => {
  const t = (await asUser(VET, `select create_treatment(jsonb_build_object('animal_id', (select id from animals where tag_no = 'LT000044547479'),
    'reg_date', '2026-10-30', 'diagnosis', 'Akių ligos', 'disease_id', '43000000-0000-0000-0000-0000000000d1',
    'medications', jsonb_build_array(jsonb_build_object('product_id', '43000000-0000-0000-0000-0000000000a2', 'qty', 5, 'unit', 'ml')))) as id`)).id;
  const id = (await q(`select id from delpro_sync_jobs where treatment_id = $1`, [t]))[0].id;
  assert.deepEqual(codes((await plan(id)).problems), ["medicine_not_linked", "no_animal_guid"]);
  await db.exec(`update products set withdrawal_days_milk = 3 where id = '43000000-0000-0000-0000-0000000000a1'`);
  const j2 = await savedTreatment();
  assert.ok(codes((await plan(j2)).problems).includes("withdrawal_mismatch"));
  await db.exec(`update products set withdrawal_days_milk = 4 where id = '43000000-0000-0000-0000-0000000000a1'`);
  await done(id, j2);
});

test("worker checks: no verified model, missing dose, missing protocol, frequency never guessed, live mismatches", async () => {
  seedDelpro();
  const id = await savedTreatment();
  const p = await plan(id);
  assert.deepEqual(codes(tg.treatmentProblems(p, null)), ["medication_model"]);
  assert.deepEqual(codes(tg.treatmentProblems(p, { ...MODEL, verified: false })), ["medication_model"]);
  assert.deepEqual(codes(tg.treatmentProblems({ ...p, medicines: [{ ...p.medicines[0], qty: null }] }, MODEL)), ["missing_dose"]);
  assert.deepEqual(codes(tg.treatmentProblems(p, { ...MODEL, event_treatment_property: "Treatment" })), ["no_treatment_protocol"]);
  assert.deepEqual(codes(tg.treatmentProblems(p, { ...MODEL, properties: { ...MODEL.properties, frequency: "Frequency" } })), ["frequency_unknown"]);
  assert.deepEqual(await tg.liveChecks(delpro, p), []);
  delpro.db.Animal[GUID].Number = "999";
  delpro.db.DrugParameters[67211].DumpMilkDays = "5";
  assert.deepEqual(codes(await tg.liveChecks(delpro, p)), ["animal_number_mismatch", "withdrawal_changed_in_delpro"]);
  await done(id);
});

test("without a verified medicine model the worker claims nothing: jobs wait, nothing written", async () => {
  seedDelpro();
  fs.rmSync(modelFile, { force: true });
  const id = await savedTreatment();
  assert.equal(await idx.runOutbound(), 0);
  assert.equal((await job(id)).status, "pending_approval");
  assert.equal(writes(), 0);
  await done(id);
});

test("worker loop: event + medicine written within one poll, read back, Sent; a re-run never duplicates", async () => {
  seedDelpro();
  fs.writeFileSync(modelFile, JSON.stringify(MODEL));
  const id = await savedTreatment();
  assert.equal(await idx.runOutbound(), 1);
  const j = await job(id);
  assert.deepEqual([j.status, j.verified, j.actual_result.medication.verified], ["success", true, true]);
  const usage = Object.values(delpro.db.TestDrugUsage)[0];
  assert.deepEqual([usage.HealthEvent, usage.Drug, usage.DrugParams, usage.Dosage, usage.TreatDays], [j.actual_result.object_guid, "119", "67211", "20", "1"]);
  assert.equal(writes(), 2);
  assert.equal(await idx.runOutbound(), 0, "a sent treatment is never claimed again");
  // the write itself is idempotent too (marker + usage lookup)
  const again = await tg.writeTreatment(delpro, { ...(await plan(id)), gateway_event: (await q(`select gateway_entry g from delpro_sync_jobs where id = $1`, [id]))[0].g }, MODEL);
  assert.deepEqual([again.found_existing_event, again.medication.usages[0].adopted, writes()], [true, true, 2]);
});

test("a treatment that can't be sent yet waits with its problems listed; the next one still goes out", async () => {
  seedDelpro();
  const bad = (await asUser(VET, `select create_treatment(jsonb_build_object('animal_id', (select id from animals where tag_no = 'LT000044547479'),
    'reg_date', '2026-10-30', 'diagnosis', 'Akių ligos', 'disease_id', '43000000-0000-0000-0000-0000000000d1',
    'medications', jsonb_build_array(jsonb_build_object('product_id', '43000000-0000-0000-0000-0000000000a1', 'qty', 5, 'unit', 'ml')))) as id`)).id;
  const badJob = (await q(`select id from delpro_sync_jobs where treatment_id = $1`, [bad]))[0].id;
  await db.exec(`update delpro_sync_jobs set status = 'pending_approval' where id = '${badJob}'`);
  const good = await savedTreatment(15);
  await idx.runOutbound();
  assert.equal((await job(badJob)).status, "pending_approval", "kept, not lost — it goes once the animal has a DelPro ObjectGuid");
  assert.ok((await q(`select fn_delpro_transfer_problems($1::uuid) p`, [bad]))[0].p.some((p) => p.code === "animal_guid"), "the reason is shown in GVET");
  assert.equal((await job(good)).status, "success");
});

test("timeout after the event landed -> retried with backoff, the retry adopts the event: one event, Sent", async () => {
  seedDelpro();
  const flaky = fakeDelpro({ timeoutAfterCreate: 1 });
  Object.assign(flaky.db, delpro.db);
  delpro = flaky;
  const id = await savedTreatment(12);
  await idx.runOutbound();
  let j = await job(id);
  assert.deepEqual([j.status, j.requires_verification, j.attempts], ["approved", true, 1], "back in the queue, verify first");
  assert.ok(new Date(j.next_attempt_at) > new Date(), "with backoff");
  assert.equal(await idx.runOutbound(), 0, "not before the backoff");
  await db.exec(`update delpro_sync_jobs set next_attempt_at = now() - interval '1 second' where id = '${id}'`);
  await idx.runOutbound();
  j = await job(id);
  assert.deepEqual([j.status, j.actual_result.found_existing_event], ["success", true]);
  const mine = Object.values(flaky.db.DiagnosesAndTreatmentEvent).filter((e) => e.Comment.startsWith(`GVET:${id}`));
  assert.equal(mine.length, 1, "never a second event");
});

test("read-back mismatch, or a diagnosis event without verified medicine, is never Sent", async () => {
  seedDelpro();
  const changing = fakeDelpro({ onCreate: (name, row) => name === "TestDrugUsage" && (row.Dosage = "2") });
  Object.assign(changing.db, delpro.db);
  delpro = changing;
  const id = await savedTreatment(9);
  await idx.runOutbound();
  const j = await job(id);
  assert.equal(j.status, "verification_failed");
  assert.deepEqual(j.actual_result.medication.usages[0].diffs.map((d) => d.property), ["Dosage"]);
});

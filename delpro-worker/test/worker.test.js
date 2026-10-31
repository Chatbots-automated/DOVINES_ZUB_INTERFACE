// Worker <-> GVET contract test: the real worker modules talk HTTP to a tiny
// PostgREST stand-in backed by PGlite running every migration. Proves the
// RPC names, argument passing (unnamed jsonb body vs. named p_worker_id)
// and payload shapes line up end to end, without a Supabase project or a
// DelPro SQL Server (DELPRO_SOURCE=json).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "../../supabase/tests/helpers/db.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let db;
let server;

// Functions whose single parameter is named (PostgREST binds body keys to
// argument names); everything else takes the raw body as unnamed jsonb.
const NAMED_ARGS = { delpro_claim_next_job: ["p_worker_id", "p_channel"], delpro_release_stale_jobs: [] };

before(async () => {
  db = await createTestDb();
  server = http.createServer(async (req, res) => {
    const m = req.url.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      assert.ok(m, `unexpected path ${req.url}`);
      assert.equal(req.headers.authorization, "Bearer test-service-key");
      const fn = m[1];
      const parsed = body ? JSON.parse(body) : {};
      await db.exec("set role service_role");
      const named = NAMED_ARGS[fn];
      const result = named
        ? await db.query(`select ${fn}(${named.map((_, i) => `$${i + 1}`).join(",")}) as r`, named.map((n) => parsed[n]))
        : await db.query(`select ${fn}($1::jsonb) as r`, [JSON.stringify(parsed)]);
      await db.exec("reset role");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.rows[0]?.r ?? null));
    } catch (err) {
      await db.exec("reset role").catch(() => {});
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: err.message }));
    }
  });
  await new Promise((r) => server.listen(0, r));
  Object.assign(process.env, {
    SUPABASE_URL: `http://127.0.0.1:${server.address().port}`,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    DELPRO_SOURCE: "json",
    DELPRO_JSON_FILE: path.join(here, "fixtures/herd.json"),
    OUTBOUND_MODE: "dry-run",
    WORKER_ID: "test-pc",
  });
});

after(() => server?.close());

test("inbound: herd snapshot lands in animals + groups", async () => {
  const { runInbound } = await import("../src/index.js");
  const result = await runInbound();
  assert.equal(result.inserted, 3);
  assert.equal(result.groups_received, 2);

  const { rows } = await db.query("select animal_no, group_name, source from animals order by animal_no");
  assert.deepEqual(
    rows.map((r) => [r.animal_no, r.group_name, r.source]),
    [
      ["512", "Melžiamos 1", "delpro"],
      ["513", "Melžiamos 1", "delpro"],
      ["514", "Užtrūkusios", "delpro"],
    ],
  );

  // DairyPlan-style fields travel through normalizeAnimal -> upsert_animals_from_delpro
  const f = (await db.query("select * from animals where animal_no = '512'")).rows[0];
  assert.equal(f.reproduction_status, "Veršinga");
  assert.equal(f.days_in_milk, 250);
  assert.equal(Number(f.milk_yield_kg), 31.4);
  assert.equal(f.is_pregnant, true);
  assert.equal(f.last_bulls, "Atlas, Zeus");
  assert.deepEqual(f.missing_teats, ["FL", "HR"]);
  const due = (await db.query("select expected_calving_date::text as d from animals where animal_no = '512'")).rows[0].d;
  assert.equal(due, "2026-12-10");
  const bare = (await db.query("select days_in_milk, is_pregnant, missing_teats from animals where animal_no = '513'")).rows[0];
  assert.deepEqual(bare, { days_in_milk: null, is_pregnant: null, missing_teats: null });
});

test("heartbeat + claim/report round trip through the HTTP contract", async () => {
  const { gvet } = await import("../src/gvet.js");
  const { treatmentParams } = await import("../src/delpro.js");

  await gvet.heartbeat({ worker_id: "test-pc", version: "0.1.0" });
  const { rows: hb } = await db.query("select setting_value from system_settings where setting_key = 'delpro_worker_info'");
  assert.equal(JSON.parse(hb[0].setting_value).worker_id, "test-pc");

  // A vet-created, admin-approved treatment — the UI-script channel with approval (0044 defaults are auto + gateway).
  await db.exec(`
    update system_settings set setting_value = 'ui_script' where setting_key = 'delpro_write_channel';
    update system_settings set setting_value = 'approval' where setting_key = 'delpro_outbound_mode';
    insert into auth.users values ('00000000-0000-0000-0000-0000000000aa', 'admin@x');
    insert into users (id, email, role) values ('00000000-0000-0000-0000-0000000000aa', 'admin@x', 'admin');
    insert into products (id, name, unit, withdrawal_days_milk, withdrawal_days_meat)
      values ('22222222-0000-0000-0000-000000000001', 'Penicilinas', 'ml', 4, 10);
    insert into batches (product_id, received_qty, expiry_date) values ('22222222-0000-0000-0000-000000000001', 100, '2030-01-01');
    insert into diseases (id, name) values ('22222222-0000-0000-0000-0000000000d1', 'Viduriavimas');
    -- approval needs explicit DelPro mappings (nothing is guessed)
    insert into delpro_mappings (kind, local_id, delpro_code, delpro_name) values
      ('disease', '22222222-0000-0000-0000-0000000000d1', '54', 'Viduriavimas'),
      ('product', '22222222-0000-0000-0000-000000000001', null, 'Vitamin C');
    set role authenticated;
    select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000aa', false);
  `);
  await db.query(
    `select create_treatment(jsonb_build_object('animal_id', (select id from animals where animal_no = '512'), 'reg_date', '2026-09-01',
       'diagnosis', 'Mastitas', 'disease_id', '22222222-0000-0000-0000-0000000000d1', 'medications', jsonb_build_array(jsonb_build_object('product_id', '22222222-0000-0000-0000-000000000001', 'qty', 10, 'unit', 'ml'))))`,
  );
  // the treatment screen's approval path; a repeat click must not change anything
  const approval = (await db.query("select delpro_approve_treatment((select treatment_id from delpro_sync_jobs)) as r")).rows[0].r;
  assert.equal(approval.outcome, "approved");
  const again = (await db.query("select delpro_approve_treatment((select treatment_id from delpro_sync_jobs)) as r")).rows[0].r;
  assert.equal(again.outcome, "already_approved");
  await db.exec("reset role");
  assert.equal((await db.query("select count(*)::int as n from delpro_sync_jobs")).rows[0].n, 1);

  const job = await gvet.claimNextJob();
  assert.equal(job.animal.animal_no, "512");
  assert.equal(job.delpro.milk_withdrawal_days, 5);

  // the parameter set delpro.ps1 understands arrives complete in the claimed payload
  assert.equal(job.payload_version, 2);
  assert.deepEqual(job.delpro.ui_entry, {
    treatment_id: job.treatment_id,
    animal_number: "512",
    diagnosis_name: "Viduriavimas",
    diagnosis_code: "54",
    medicine_name: "Vitamin C",
    dose: 10,
    dose_unit: "ml",
    course_days: 1,
  });

  const params = treatmentParams(job);
  assert.equal(params.sync_id, job.sync_id);
  assert.equal(params.treatment_text, "Penicilinas 10 ml");

  const report = await gvet.reportJobResult({
    sync_id: job.sync_id,
    worker_id: "test-pc",
    success: true,
    actual_result: { animal_no: "512", event_date: "2026-09-01", milk_withdrawal_days: 5, meat_withdrawal_days: 11 },
  });
  assert.equal(report.status, "success");
  assert.equal(await gvet.claimNextJob(), null);
  await db.exec(`update system_settings set setting_value = 'gateway' where setting_key = 'delpro_write_channel';
                 update system_settings set setting_value = 'auto' where setting_key = 'delpro_outbound_mode';`);
});

test("empty DelPro snapshot is never sent (would deactivate the herd)", async () => {
  const fs = await import("node:fs");
  const empty = path.join(here, "fixtures/empty.tmp.json");
  fs.writeFileSync(empty, JSON.stringify({ animals: [] }));
  const { config } = await import("../src/config.js");
  const prev = config.jsonFile;
  config.jsonFile = empty;
  try {
    const { runInbound } = await import("../src/index.js");
    assert.equal(await runInbound(), null);
    const { rows } = await db.query("select count(*)::int as n from animals where active");
    assert.equal(rows[0].n, 3);
  } finally {
    config.jsonFile = prev;
    fs.unlinkSync(empty);
  }
});

test("catalog dry run: the real pipeline is previewed and rolled back — GVET unchanged", async () => {
  const fs = await import("node:fs");
  const { runCatalogDryRun } = await import("../src/index.js");
  const { config } = await import("../src/config.js");
  const { escapeXml } = await import("../src/gateway.js");
  const fx = (name) => fs.readFileSync(path.join(here, "fixtures/gateway", name), "utf8");
  const results = {
    DrugParameters: fx("drugparameters-218.result.xml"),
    TreatmentDrugUsage: fx("tdu-197.result.xml"),
    Animal: fx("animal-337.result.xml"),
    Drug: `<ddmData><object name="Drug"><property name="Code">7</property><property name="Name">Penicilinas</property><property name="Active">true</property><property name="MedicineName" /><property name="ActiveSubstance" /><property name="DefaultParameters" objectType="DrugParameters">218</property></object></ddmData>`,
    Treatment: `<ddmData><object name="Treatment"><property name="Code">40</property><property name="Name">Mastito gydymas</property><property name="Active">true</property><property name="TreatmentType" /><property name="DrugUsages" objectType="TreatmentDrugUsage">197</property></object></ddmData>`,
    Diagnosis: `<ddmData><object name="Diagnosis"><property name="Code">11</property><property name="Name">Viduriavimas</property><property name="Active">true</property><property name="RecommendedTreatment" objectType="Treatment">40</property></object></ddmData>`,
  };
  // a fake Gateway over real HTTP, so the worker's own SOAP client is used; it records every operation
  const ops = [];
  const gw = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const op = String(req.headers.soapaction).replace(/^"?.*\//, "").replace(/"$/, "");
    ops.push(op);
    const xmlData = body.match(/<xmlData>([\s\S]*)<\/xmlData>/)[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const result = results[xmlData.match(/<object name="(\w+)"/)[1]];
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${op}Response xmlns="http://tempuri.org/"><${op}Result>${escapeXml(result)}</${op}Result></${op}Response></s:Body></s:Envelope>`);
  });
  await new Promise((r) => gw.listen(0, r));
  const saved = { ...config.gateway, catalogSource: config.catalogSource };
  Object.assign(config.gateway, { url: `http://127.0.0.1:${gw.address().port}/GatewaySoapService`, user: "HerdNav", password: "" });
  config.catalogSource = "gateway";
  await db.exec(`insert into animals (tag_no, animal_no, active) values ('LT000000000999', '337', true)`);

  // every table the real run touches, fingerprinted independently of the function under test
  const TABLES = ["delpro_catalog_runs", "delpro_catalog_items", "delpro_catalog_issues", "delpro_catalog_links", "delpro_catalog_jobs",
    "animals", "diseases", "products", "treatment_templates", "system_settings", "user_audit_logs"];
  const state = async () => {
    const out = {};
    for (const t of TABLES) out[t] = (await db.query(`select count(*)::int as n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from ${t} x`)).rows[0];
    return out;
  };
  const before = await state();

  let preview;
  let file;
  try {
    ({ preview, file } = await runCatalogDryRun());
  } finally {
    gw.close();
    Object.assign(config.gateway, saved);
    config.catalogSource = saved.catalogSource;
  }
  assert.deepEqual([...new Set(ops)], ["GetData"], "only GetData reaches DelPro");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).preview.rolled_back, true);
  fs.rmSync(file);
  assert.equal(preview.dry_run, true);
  assert.equal(preview.rolled_back, true);
  assert.equal(preview.run.status, "completed");
  assert.equal(preview.uploads.Drug.inserted, 1);
  assert.equal(preview.run.stats.TreatmentDrugUsage.complete, true);
  assert.equal(preview.animals.matched, 1);
  assert.equal(preview.new_issues.suggested_match.count, 2);
  assert.equal(preview.gvet_changes.animals.updated, 1);
  assert.equal(preview.gvet_changes.diseases, undefined, "a first sync only suggests; no GVET disease changes");

  assert.deepEqual(await state(), before, "nothing persisted");
  await db.exec(`delete from animals where tag_no = 'LT000000000999'`);
});

test("catalog: Gateway snapshot -> GVET mirror + reconciliation through the HTTP contract", async () => {
  const fs = await import("node:fs");
  const { runCatalogSync } = await import("../src/catalog.js");
  const fx = (name) => fs.readFileSync(path.join(here, "fixtures/gateway", name), "utf8");
  // DrugParameters 218, TreatmentDrugUsage 197 and Animal 337 are the verbatim Gateway results;
  // Drug / Treatment / Diagnosis are test rows in the same ddmData format.
  const results = {
    DrugParameters: fx("drugparameters-218.result.xml"),
    TreatmentDrugUsage: fx("tdu-197.result.xml"),
    Animal: fx("animal-337.result.xml"),
    Drug: `<ddmData><object name="Drug"><property name="Code">7</property><property name="Name">Penicilinas</property><property name="Active">true</property><property name="MedicineName" /><property name="ActiveSubstance" /><property name="DefaultParameters" objectType="DrugParameters">218</property></object></ddmData>`,
    Treatment: `<ddmData><object name="Treatment"><property name="Code">40</property><property name="Name">Mastito gydymas</property><property name="Active">true</property><property name="TreatmentType" /><property name="DrugUsages" objectType="TreatmentDrugUsage">197</property></object></ddmData>`,
    Diagnosis: `<ddmData><object name="Diagnosis"><property name="Code">11</property><property name="Name">Viduriavimas</property><property name="Active">true</property><property name="RecommendedTreatment" objectType="Treatment">40</property></object></ddmData>`,
  };
  const requests = [];
  const client = {
    async getDataXml(req) {
      requests.push(req);
      return results[req.match(/<object name="(\w+)"/)[1]];
    },
  };
  await db.exec(`insert into animals (tag_no, animal_no, active) values ('LT000000000337', '337', true)`);

  const result = await runCatalogSync(client);
  assert.equal(result.status, "completed");
  assert.equal(result.stats.TreatmentDrugUsage.complete, true);
  assert.equal(result.stats.Animal.matched, 1);
  // dependency order: parameters first, diagnoses last
  const order = [...new Set(requests.map((r) => r.match(/<object name="(\w+)"/)[1]))];
  assert.deepEqual(order, ["DrugParameters", "Drug", "TreatmentDrugUsage", "Treatment", "Diagnosis", "Animal"]);

  const { rows: items } = await db.query("select object_type, delpro_key, fields from delpro_catalog_items order by object_type");
  assert.equal(items.length, 5);
  assert.deepEqual(items.find((i) => i.object_type === "DrugParameters").fields, {
    uom: "ml", application_method: null, dump_milk_days: 0, meat_withhold_days: 4,
  });
  // exact-name matches are suggestions only — no link without an admin
  const { rows: issues } = await db.query("select issue_type, object_type from delpro_catalog_issues where status = 'open' order by object_type");
  assert.deepEqual(issues.map((i) => [i.issue_type, i.object_type]), [["suggested_match", "Diagnosis"], ["suggested_match", "Drug"]]);
  assert.equal((await db.query("select count(*)::int as n from delpro_catalog_links")).rows[0].n, 0);

  const tpl = (await db.query("select drug_usages from vw_delpro_catalog_treatments where code = '40'")).rows[0];
  assert.equal(tpl.drug_usages[0].drug_name, "Penicilinas");
  assert.equal(tpl.drug_usages[0].dosage, 20);
  const guid = (await db.query("select delpro_object_guid from animals where animal_no = '337'")).rows[0].delpro_object_guid;
  assert.equal(guid, "f3d9f5df-f72f-4659-8d25-66a02cf583eb");

  // an unchanged second snapshot changes nothing
  const again = await runCatalogSync(client);
  assert.equal(again.stats.Drug.unchanged, 1);
  assert.equal(again.reconcile.opened, 0);
});

test("catalog writes: gate, test job, validated create, unknown outcome to review + admin adopt, read-back mismatch", async () => {
  const { config } = await import("../src/config.js");
  const { runCatalogWrites } = await import("../src/catalog-writer.js");
  const { fakeDelpro } = await import("./fake-delpro.js");
  const asAdmin = async (sql) => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000aa', false);`);
    try {
      return (await db.query(sql)).rows[0];
    } finally {
      await db.exec("reset role");
    }
  };
  const job = async (where) => (await db.query(`select * from delpro_catalog_jobs where ${where} order by created_at desc limit 1`)).rows[0];

  config.catalogWriteEnabled = true;
  try {
    const delpro = fakeDelpro();
    await asAdmin(`select delpro_catalog_create_test_job('Diagnosis.create')`);
    // GVET's switch is still off -> nothing handed out
    assert.equal(await runCatalogWrites(delpro), 0);
    await asAdmin(`select delpro_catalog_set_write_enabled(true)`);
    assert.equal(await runCatalogWrites(delpro), 1);
    const test = await job("is_test");
    assert.equal(test.status, "success");
    const [created] = Object.values(delpro.db.Diagnosis);
    assert.match(created.Name, /^GVET TEST /);
    assert.equal(created.Active, "false");
    await asAdmin(`select delpro_catalog_mark_validated('${test.id}')`);

    // a real create, whose first CreateData times out after DelPro stored it
    await db.exec(`insert into diseases (id, name) values ('22222222-0000-0000-0000-0000000000d9', 'WT Ketozė')`);
    await asAdmin(`select delpro_catalog_enqueue_create('Diagnosis', '22222222-0000-0000-0000-0000000000d9')`);
    const flaky = fakeDelpro({ timeoutAfterCreate: 1 });
    await runCatalogWrites(flaky);
    let j = await job("disease_id = '22222222-0000-0000-0000-0000000000d9'");
    assert.equal(j.status, "queued");
    assert.ok(j.progress.main.started_at && !j.progress.main.key, "the step is known to have started");
    await db.exec(`update delpro_catalog_jobs set next_attempt_at = now() - interval '1 second' where id = '${j.id}'`);
    await runCatalogWrites(flaky);
    // unknown outcome: never re-sent and never adopted by name — an admin decides
    j = await job("disease_id = '22222222-0000-0000-0000-0000000000d9'");
    assert.equal(j.status, "needs_review");
    assert.equal(Object.values(flaky.db.Diagnosis).length, 1, "the uncertain write is not repeated");
    const candidates = j.error_details.details.candidates;
    assert.deepEqual(candidates.map((c) => c.name), ["WT Ketozė"], "same-name records are only listed");
    assert.equal(j.progress.main.key, undefined, "nothing adopted automatically");
    await assert.rejects(asAdmin(`select delpro_catalog_job_action('${j.id}', 'retry')`), /Nežinomas ankstesnio įrašymo rezultatas/);
    // the admin checked DelPro: the candidate is GVET's record -> read back and compared, then linked
    await asAdmin(`select delpro_catalog_job_action('${j.id}', 'adopt', 'main', '${candidates[0].key}')`);
    await runCatalogWrites(flaky);
    j = await job("disease_id = '22222222-0000-0000-0000-0000000000d9'");
    assert.equal(j.status, "success");
    assert.equal(j.progress.main.key, candidates[0].key);
    assert.equal(Object.values(flaky.db.Diagnosis).length, 1, "adopting does not write");
    const link = (await db.query(`select delpro_key, origin from delpro_catalog_links where disease_id = '22222222-0000-0000-0000-0000000000d9' and retired_at is null`)).rows[0];
    assert.deepEqual(link, { delpro_key: j.progress.main.key, origin: "created" });

    // DelPro stores something else than was sent -> verification_failed, never success
    await db.exec(`insert into diseases (id, name) values ('22222222-0000-0000-0000-0000000000da', 'WT Ilgas pavadinimas')`);
    await asAdmin(`select delpro_catalog_enqueue_create('Diagnosis', '22222222-0000-0000-0000-0000000000da')`);
    await runCatalogWrites(fakeDelpro({ onCreate: (_n, row) => (row.Name = row.Name.slice(0, 5)) }));
    j = await job("disease_id = '22222222-0000-0000-0000-0000000000da'");
    assert.equal(j.status, "verification_failed");
    assert.match(j.error, /laukta „WT Ilgas pavadinimas“/);
  } finally {
    config.catalogWriteEnabled = false;
    await db.exec(`update system_settings set setting_value = 'false' where setting_key = 'delpro_catalog_write_enabled'`);
  }
});

test("pilot medicine: schema check, single-job release, one write over SOAP, read-back, mapping, no duplicate on re-run", async () => {
  const { config } = await import("../src/config.js");
  const { runCatalogWriteCheck, runCatalogWriteOne } = await import("../src/index.js");
  const { fakeDelpro } = await import("./fake-delpro.js");
  const { escapeXml } = await import("../src/gateway.js");
  const asAdmin = async (sql) => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000aa', false);`);
    try {
      return (await db.query(sql)).rows[0];
    } finally {
      await db.exec("reset role");
    }
  };

  // DelPro as the farm has it: existing drugs + parameters in the shapes GetData returns
  const delpro = fakeDelpro();
  delpro.db.DrugParameters = { 218: { Key: "218", UOM: "ml", ApplicationMethod: "", DumpMilkDays: "0", MeatWithholdDays: "4" } };
  delpro.db.Drug = { 7: { Code: "7", Name: "Penicilinas", Active: "true", MedicineName: "", ActiveSubstance: "", DefaultParameters: "218" } };
  // the fake behind the worker's real SOAP client
  const gw = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const op = String(req.headers.soapaction).replace(/^"?.*\//, "").replace(/"$/, "");
    const xmlData = body.match(/<xmlData>([\s\S]*)<\/xmlData>/)[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    let result;
    if (op === "GetData") result = await delpro.getDataXml(xmlData);
    else {
      const r = op === "CreateData" ? await delpro.createData(xmlData) : await delpro.updateData(xmlData);
      result = `<Response status="OK">${r.created.map((c) => `<CreatedObject type="${c.type}" keyProperty="${c.keyProperty}" keyValue="${c.keyValue}" id="0"/>`).join("")}</Response>`;
    }
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><${op}Response xmlns="http://tempuri.org/"><${op}Result>${escapeXml(result)}</${op}Result></${op}Response></s:Body></s:Envelope>`);
  });
  await new Promise((r) => gw.listen(0, r));
  const saved = { ...config.gateway, catalogSource: config.catalogSource, write: config.catalogWriteEnabled };
  Object.assign(config.gateway, { url: `http://127.0.0.1:${gw.address().port}/GatewaySoapService`, user: "HerdNav", password: "" });
  config.catalogSource = "gateway";
  const writes = () => delpro.calls.filter(([op]) => op !== "GetData").length;

  try {
    const jobId = (await asAdmin(`select delpro_catalog_create_pilot_drug()->>'job_id' as id`)).id;

    // 1. read-only check: exact XML + schema evidence from DelPro, nothing written
    const { check } = await runCatalogWriteCheck(jobId);
    assert.equal(check.ok, true, check.problems.join("; "));
    const main = check.steps.find((s) => s.id === "main");
    assert.match(main.xml, /^<ddmData><object name="Drug"><property name="Name">GVET TEST vaistas [^<]+<\/property><property name="Active">false<\/property><property name="DefaultParameters" objectType="DrugParameters">\{step:params\}<\/property><\/object><\/ddmData>$/);
    assert.equal(check.steps.find((s) => s.id === "params").xml,
      `<ddmData><object name="DrugParameters"><property name="UOM">ml</property><property name="DumpMilkDays">0</property><property name="MeatWithholdDays">0</property></object></ddmData>`);
    assert.equal(writes(), 0);

    // 2. not enabled on the PC / not released in GVET -> refused before any write
    config.catalogWriteEnabled = false;
    await assert.rejects(runCatalogWriteOne(jobId), /CATALOG_WRITE_ENABLED=true/);
    config.catalogWriteEnabled = true;
    await assert.rejects(runCatalogWriteOne(jobId), /GVET neleido/);
    assert.equal(writes(), 0);

    // 3. released for this job only -> written, read back, mapped; the gate closes itself
    await asAdmin(`select delpro_catalog_release_single_job('${jobId}')`);
    const { job } = await runCatalogWriteOne(jobId);
    assert.equal(job.status, "success");
    assert.deepEqual(delpro.calls.filter(([op]) => op !== "GetData").map(([op, xml]) => [op, xml.match(/<object name="(\w+)"/)[1]]),
      [["CreateData", "DrugParameters"], ["CreateData", "Drug"]]);
    const created = Object.values(delpro.db.Drug).find((d) => d.Name.startsWith("GVET TEST vaistas"));
    assert.equal(created.Active, "false");
    assert.equal(delpro.db.DrugParameters[created.DefaultParameters].UOM, "ml");
    const link = (await db.query(`select l.delpro_key, l.origin from delpro_catalog_links l join delpro_catalog_jobs j on j.product_id = l.product_id
      where j.id = '${jobId}' and l.retired_at is null`)).rows[0];
    assert.deepEqual(link, { delpro_key: created.Code, origin: "created" });
    const gate = (await db.query(`select setting_key, setting_value from system_settings where setting_key in ('delpro_catalog_write_enabled', 'delpro_catalog_write_only_job') order by 1`)).rows;
    assert.deepEqual(gate.map((g) => g.setting_value), ["false", ""]);

    // 4. re-running cannot create a duplicate
    const again = await runCatalogWriteOne(jobId);
    assert.equal(again.job.status, "success");
    assert.equal(again.result, null);
    assert.equal(writes(), 2);
    assert.equal(Object.values(delpro.db.Drug).filter((d) => d.Name === created.Name).length, 1);
  } finally {
    gw.close();
    Object.assign(config.gateway, saved);
    config.catalogSource = saved.catalogSource;
    config.catalogWriteEnabled = saved.write;
  }
});

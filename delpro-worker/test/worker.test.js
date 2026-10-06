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
const NAMED_ARGS = { delpro_claim_next_job: ["p_worker_id"], delpro_release_stale_jobs: [] };

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

  // A vet-created, admin-approved treatment.
  await db.exec(`
    insert into auth.users values ('00000000-0000-0000-0000-0000000000aa', 'admin@x');
    insert into users (id, email, role) values ('00000000-0000-0000-0000-0000000000aa', 'admin@x', 'admin');
    insert into products (id, name, unit, withdrawal_days_milk, withdrawal_days_meat)
      values ('22222222-0000-0000-0000-000000000001', 'Penicilinas', 'ml', 4, 10);
    insert into batches (product_id, received_qty, expiry_date) values ('22222222-0000-0000-0000-000000000001', 100, '2030-01-01');
    set role authenticated;
    select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000aa', false);
  `);
  await db.query(
    `select create_treatment(jsonb_build_object('animal_id', (select id from animals where animal_no = '512'), 'reg_date', '2026-09-01',
       'diagnosis', 'Mastitas', 'medications', jsonb_build_array(jsonb_build_object('product_id', '22222222-0000-0000-0000-000000000001', 'qty', 10, 'unit', 'ml'))))`,
  );
  await db.query("select delpro_approve_jobs(array(select id from delpro_sync_jobs))");
  await db.exec("reset role");

  const job = await gvet.claimNextJob();
  assert.equal(job.animal.animal_no, "512");
  assert.equal(job.delpro.milk_withdrawal_days, 5);

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

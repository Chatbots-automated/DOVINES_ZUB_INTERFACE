// CMS atskyrimai (0048): GVET batch -> admin approval -> gated claim -> Gateway (fake) -> read-back -> report.
// Database = PGlite with every migration behind a PostgREST-shaped shim. The fake Gateway is a TEST DOUBLE
// for our own logic; it proves nothing about how DelPro 10.9 accepts an AnimalActionSetting — that is what
// the supervised single-animal write on the farm establishes. No test talks to farm equipment.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTestDb } from "../../supabase/tests/helpers/db.mjs";
import { fakeDelpro } from "./fake-delpro.js";

const ADMIN = "00000000-0000-0000-0000-0000000000aa";
const VET = "00000000-0000-0000-0000-0000000000bb";
// the verified farm example (animal 337, AnimalMilkSetting 8246, SortCow 11981)
const GUID = "f3d9f5df-f72f-4659-8d25-66a02cf583eb";
const GUID2 = "f3d9f5df-f72f-4659-8d25-66a02cf58300";
const GUID3 = "f3d9f5df-f72f-4659-8d25-66a02cf58301";

let db, server, cms, cfg, idx;
const q = async (sql, params) => (await db.query(sql, params)).rows;
const asUser = async (id, sql) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${id}', false);`);
  try {
    return (await db.query(sql)).rows[0];
  } finally {
    await db.exec("reset role");
  }
};

function delproWith({ existingSortCow = false, milk = true } = {}) {
  const d = fakeDelpro();
  d.db.Animal = {
    [GUID]: { ObjectGuid: GUID, Number: "337", OfficialRegNumber: "LT000007300337" },
    [GUID2]: { ObjectGuid: GUID2, Number: "338", OfficialRegNumber: "LT000007300338" },
    [GUID3]: { ObjectGuid: GUID3, Number: "339", OfficialRegNumber: "LT000007300339" },
  };
  d.db.AnimalMilkSetting = milk ? { 8246: { Key: "8246", Animal: GUID }, 8247: { Key: "8247", Animal: GUID2 } } : {};
  d.db.AnimalActionSetting = {
    11980: { Key: "11980", AnimalMilkSetting: "8246", ActionType: "DumpMilk", Active: "false" },
    ...(existingSortCow
      ? { 11981: { Key: "11981", AnimalMilkSetting: "8246", ActionType: "SortCow", Active: "true", StartDate: "2026-09-22T09:01:00Z", IsValidForSession1: "true", IsValidForSession2: "true" } }
      : {}),
  };
  d.db.SortArea = { 1: { Key: "1", SortAreaNumber: "1", SortAreaName: "Rūšiavimo patalpa 1" } };
  return d;
}

/** A vet saves + submits a batch, an admin approves it; returns job ids by ORN. */
async function approvedBatch(items) {
  const b = await asUser(VET, `select cms_save_batch('${JSON.stringify({ submit: true, items }).replace(/'/g, "''")}'::jsonb) as r`);
  const ids = (await q(`select id from cms_separation_jobs where batch_id = $1`, [b.r.batch_id])).map((r) => r.id);
  await asUser(ADMIN, `select cms_approve_jobs(array['${ids.join("','")}']::uuid[], true)`);
  const rows = await q(`select j.id, a.tag_no from cms_separation_jobs j join animals a on a.id = j.animal_id where j.batch_id = $1`, [b.r.batch_id]);
  return Object.fromEntries(rows.map((r) => [r.tag_no, r.id]));
}
const animalId = async (tag) => (await q(`select id from animals where tag_no = $1`, [tag]))[0].id;
const item = async (tag, extra = {}) => ({ animal_id: await animalId(tag), mode: "period", start_local: "2099-11-03T08:00", end_local: "2099-11-05T08:00", sessions: [1, 2], ...extra });
const job = async (id) => (await q(`select * from cms_separation_jobs where id = $1`, [id]))[0];
const release = (id) => asUser(ADMIN, `select cms_release_single_job('${id}')`);

before(async () => {
  db = await createTestDb();
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const fn = req.url.match(/rpc\/([a-z_]+)$/)[1];
    try {
      await db.exec("set role service_role");
      const r = await db.query(`select ${fn}($1::jsonb) as r`, [body || "{}"]);
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
  Object.assign(process.env, {
    SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SERVICE_ROLE_KEY: "k", WORKER_ID: "cms-pc",
    DELPRO_SOURCE: "off", OUTBOUND_MODE: "off", CATALOG_SOURCE: "gateway", DELPRO_GATEWAY_USER: "HerdNav", CMS_OUTBOUND_MODE: "off",
  });
  cfg = (await import("../src/config.js")).config;
  Object.assign(cfg, { supabaseUrl: process.env.SUPABASE_URL, serviceKey: "k", catalogSource: "gateway", workerId: "cms-pc", cmsOutboundMode: "off" });
  cfg.gateway.animalOrnProperty = "OfficialRegNumber";
  cms = await import("../src/cms-separation.js");
  idx = await import("../src/index.js");
  await db.exec(`
    insert into auth.users values ('${ADMIN}', 'admin@x'), ('${VET}', 'vet@x');
    insert into users (id, email, role) values ('${ADMIN}', 'admin@x', 'admin'), ('${VET}', 'vet@x', 'vet');
    insert into animals (tag_no, animal_no, delpro_object_guid, source) values
      ('LT000007300337', '337', '${GUID}', 'delpro'), ('LT000007300338', null, '${GUID2}', 'vic'),
      ('LT000007300339', '339', '${GUID3}', 'delpro'), ('LT000007300340', '340', null, 'delpro');
    -- 0049: GVET sending on + destination checked; the 0048 gates (single job / verified mode) are what these tests cover
    update system_settings set setting_value = 'true' where setting_key = 'cms_outbound_enabled';
    update system_settings set setting_value = '{"note":"test"}' where setting_key = 'cms_destination_verified';
  `);
});

after(async () => {
  server?.close();
  await db?.close();
});

const SNAP = { animal_guid: GUID, orn: "LT000007300337", mode: "period", start_at: "2099-11-03T06:00:00Z", end_at: "2099-11-05T06:00:00Z", sessions: [2, 1] };

test("dry-run XML: proposed AnimalActionSetting, every session explicit, no SortArea / Sort Once property", () => {
  const xml = cms.buildActionSettingXml(SNAP, "8246");
  assert.equal(
    xml,
    `<ddmData><object name="AnimalActionSetting"><property name="AnimalMilkSetting" objectType="AnimalMilkSetting">8246</property>` +
      `<property name="ActionType">SortCow</property><property name="Active">true</property>` +
      `<property name="StartDate">2099-11-03T06:00:00Z</property><property name="EndDate">2099-11-05T06:00:00Z</property>` +
      `<property name="IsValidForSession1">true</property><property name="IsValidForSession2">true</property>` +
      Array.from({ length: 8 }, (_, i) => `<property name="IsValidForSession${i + 3}">false</property>`).join("") +
      `</object></ddmData>`,
  );
  assert.doesNotMatch(xml, /SortArea|SortOnce/);
  assert.doesNotMatch(cms.buildActionSettingXml({ ...SNAP, mode: "ongoing", end_at: null }, "8246"), /EndDate/);
});

test("snapshot validation: missing dates, invalid sessions, Sort Once and a chosen SortArea are refused", () => {
  const now = new Date("2026-11-02T00:00:00Z");
  assert.deepEqual(cms.snapshotProblems(SNAP, now), []);
  assert.match(cms.snapshotProblems({ ...SNAP, end_at: null }, now).join(), /pabaigos/);
  assert.match(cms.snapshotProblems({ ...SNAP, start_at: null }, now).join(), /pradžios/);
  assert.match(cms.snapshotProblems({ ...SNAP, sessions: [] }, now).join(), /sesija/);
  assert.match(cms.snapshotProblems({ ...SNAP, sessions: [0, 11] }, now).join(), /Netinkamos/);
  assert.match(cms.snapshotProblems({ ...SNAP, sessions: [1, 1] }, now).join(), /Netinkamos/);
  assert.match(cms.snapshotProblems({ ...SNAP, mode: "once" }, now).join(), /nesiunčiamas/);
  assert.match(cms.snapshotProblems({ ...SNAP, sort_area_key: "1" }, now).join(), /nepatikrintas/);
  assert.match(cms.snapshotProblems({ ...SNAP, animal_guid: null }, now).join(), /ObjectGuid/);
});

test("existing SortCow detection uses the verified farm example; inactive / ended ones don't count", () => {
  const d = delproWith({ existingSortCow: true });
  const rows = Object.values(d.db.AnimalActionSetting).map((r) => ({ properties: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { value: v }])) }));
  const active = cms.activeSortCows(rows, new Date("2026-11-02T00:00:00Z"));
  assert.deepEqual(active.map((a) => [a.key, a.sessions]), [["11981", [1, 2]]]);
  rows.push({ properties: { Key: { value: "1" }, ActionType: { value: "SortCow" }, Active: { value: "true" }, EndDate: { value: "2026-10-01T00:00:00Z" } } });
  assert.equal(cms.activeSortCows(rows, new Date("2026-11-02T00:00:00Z")).length, 1);
});

test("milk-setting lookup: exactly one, else nothing is written", async () => {
  const d = delproWith();
  assert.equal(await cms.findMilkSetting(d, GUID), "8246");
  await assert.rejects(cms.findMilkSetting(d, GUID3), /AnimalMilkSetting/);
  d.db.AnimalMilkSetting[9000] = { Key: "9000", Animal: GUID };
  await assert.rejects(cms.findMilkSetting(d, GUID), /2 AnimalMilkSetting/);
});

test("worker with CMS_OUTBOUND_MODE=off claims nothing; approved jobs wait", async () => {
  const ids = await approvedBatch([await item("LT000007300337")]);
  assert.equal(await idx.runCms(), 0);
  assert.equal((await job(ids.LT000007300337)).status, "approved");
  await asUser(ADMIN, `select cms_cancel_jobs(array['${ids.LT000007300337}']::uuid[])`);
});

test("supervised single write: created, read back, every property compared -> success; second claim impossible", async () => {
  const d = delproWith();
  const ids = await approvedBatch([await item("LT000007300337"), await item("LT000007300338", { mode: "ongoing", end_local: "", sessions: [3], is_override: true })]);
  await release(ids.LT000007300337);
  assert.equal(await cms.runCmsOutbound(d, { jobId: ids.LT000007300337 }), 1);
  const j = await job(ids.LT000007300337);
  assert.equal(j.status, "success", j.last_error);
  assert.equal(j.milk_setting_key, "8246");
  const created = d.db.AnimalActionSetting[j.action_key];
  assert.equal(created.ActionType, "SortCow");
  assert.equal(created.StartDate, "2099-11-03T06:00:00Z");
  assert.equal(created.IsValidForSession3, "false");
  assert.equal(j.readback.verified, true);
  // nothing is sent twice (0052: the other approved job would now go routinely — cancel it to check that alone)
  assert.equal(await cms.runCmsOutbound(d, { jobId: ids.LT000007300337 }), 0);
  await asUser(ADMIN, `select cms_cancel_jobs(array['${ids.LT000007300338}']::uuid[])`);
  assert.equal(await cms.runCmsOutbound(d), 0);
  assert.equal(d.calls.filter(([op]) => op === "CreateData").length, 1);
});

test("existing active SortCow in DelPro: never overwritten or duplicated, job fails visibly", async () => {
  const d = delproWith({ existingSortCow: true });
  const ids = await approvedBatch([await item("LT000007300337")]);
  await release(ids.LT000007300337);
  await cms.runCmsOutbound(d, { jobId: ids.LT000007300337 });
  const j = await job(ids.LT000007300337);
  assert.equal(j.status, "error");
  assert.match(j.last_error, /11981/);
  assert.equal(d.calls.filter(([op]) => op !== "GetData").length, 0);
});

test("read-back mismatch is never success", async () => {
  const d = delproWith();
  d.createData = ((orig) => async (xml) => {
    const r = await orig(xml);
    d.db.AnimalActionSetting[r.created[0].keyValue].IsValidForSession2 = "false";
    return r;
  })(d.createData.bind(d));
  const ids = await approvedBatch([await item("LT000007300337")]);
  await release(ids.LT000007300337);
  await cms.runCmsOutbound(d, { jobId: ids.LT000007300337 });
  const j = await job(ids.LT000007300337);
  assert.equal(j.status, "needs_review");
  assert.deepEqual(j.readback.diffs.map((x) => x.property), ["IsValidForSession2"]);
  await asUser(ADMIN, `select cms_cancel_jobs(array['${ids.LT000007300337}']::uuid[])`);
});

test("timeout after CreateData: outcome unknown -> review, never re-sent; admin adopts the key -> verified", async () => {
  const d = fakeDelpro({ timeoutAfterCreate: 1 });
  Object.assign(d.db, delproWith().db);
  const ids = await approvedBatch([await item("LT000007300337")]);
  await release(ids.LT000007300337);
  await cms.runCmsOutbound(d, { jobId: ids.LT000007300337 });
  let j = await job(ids.LT000007300337);
  assert.equal(j.status, "needs_review");
  assert.ok(j.write_started_at);
  // a blind retry is refused
  await assert.rejects(asUser(ADMIN, `select cms_job_action('${j.id}', 'retry')`), /klaidos būsenos/);
  const key = Object.values(d.db.AnimalActionSetting).find((r) => r.ActionType === "SortCow").Key;
  await asUser(ADMIN, `select cms_job_action('${j.id}', 'adopt', '${key}')`);
  await release(j.id);
  await cms.runCmsOutbound(d, { jobId: j.id });
  j = await job(j.id);
  assert.equal(j.status, "success");
  assert.equal(j.action_key, key);
  assert.equal(d.calls.filter(([op]) => op === "CreateData").length, 1);
});

test("partial batch: verified mode routinely sends the good job, the one without a milk setting fails alone", async () => {
  // 'period' is verified after the successful supervised write above (+ admin's physical confirmation)
  await asUser(ADMIN, `select cms_set_mode_verified('period', true, true)`);
  const d = delproWith();
  delete d.db.AnimalMilkSetting[8246];
  d.db.AnimalMilkSetting[8248] = { Key: "8248", Animal: GUID2 };
  delete d.db.AnimalMilkSetting[8247];
  const ids = await approvedBatch([await item("LT000007300338"), await item("LT000007300339")]);
  assert.equal(await cms.runCmsOutbound(d), 2);
  assert.equal((await job(ids.LT000007300338)).status, "success");
  const bad = await job(ids.LT000007300339);
  assert.equal(bad.status, "error");
  assert.match(bad.last_error, /AnimalMilkSetting/);
  assert.equal(bad.write_started_at, null);
});

test("unmapped animal can't be submitted; a vet can't approve", async () => {
  await assert.rejects(asUser(VET, `select cms_save_batch('${JSON.stringify({ submit: true, items: [await item("LT000007300340")] })}'::jsonb)`), /klaidų/);
  const b = await asUser(VET, `select cms_save_batch('${JSON.stringify({ submit: true, items: [await item("LT000007300337", { start_local: "2099-12-01T08:00", end_local: "2099-12-02T08:00" })] })}'::jsonb) as r`);
  const [{ id }] = await q(`select id from cms_separation_jobs where batch_id = $1`, [b.r.batch_id]);
  await assert.rejects(asUser(VET, `select cms_approve_jobs(array['${id}']::uuid[], true)`), /administratorius/);
});

test("emergency stop in GVET: a released, approved job is not handed out; treatments are not involved", async () => {
  const d = delproWith();
  const ids = await approvedBatch([await item("LT000007300339", { start_local: "2099-12-10T08:00", end_local: "2099-12-11T08:00" })]);
  await release(ids.LT000007300339);
  await asUser(VET, `select cms_set_outbound_enabled(false)`);
  assert.equal(await cms.runCmsOutbound(d, { jobId: ids.LT000007300339 }), 0);
  assert.equal(d.calls.filter(([op]) => op === "CreateData").length, 0);
  assert.equal((await job(ids.LT000007300339)).status, "approved");
  await asUser(ADMIN, `select cms_set_outbound_enabled(true, true)`);
  await asUser(ADMIN, `select cms_cancel_jobs(array['${ids.LT000007300339}']::uuid[])`);
});

// The farm (DelPro 10.9, 2026-11): 3478 AnimalMilkSetting keys; [Key, Animal] above ~1000 rows -> NullReferenceException.
const NULLREF_BULK = ({ name, props, where, top }) => name === "AnimalMilkSetting" && props.includes("Animal") && !where.Key && !where.Animal && top > 1000;
const guidOf = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
function farm({ milk = 3476, failGetData = null, hideFromBulk = null } = {}) {
  const d = fakeDelpro({ failGetData, hideFromBulk });
  Object.assign(d.db, delproWith({ existingSortCow: true }).db);
  for (let i = 0; i < milk; i += 1) {
    d.db.AnimalMilkSetting[30000 + i] = { Key: String(30000 + i), Animal: guidOf(i) };
    d.db.AnimalActionSetting[60000 + i] = { Key: String(60000 + i), AnimalMilkSetting: String(30000 + i), ActionType: "SortCow", Active: "true", StartDate: "2024-01-01T00:00:00Z", EndDate: "2024-01-02T00:00:00Z", IsValidForSession1: "true" };
    d.db.AnimalActionSetting[90000 + i] = { Key: String(90000 + i), AnimalMilkSetting: String(30000 + i), ActionType: "DumpMilk", Active: "false" };
  }
  return d;
}
const reads = (d, re) => d.calls.filter(([op, req]) => op === "GetData" && re.test(req)).length;
const LIVE = { maxRows: 20000, rowCap: 0, bulkTop: 1000, concurrency: 3, attempts: 2, backoffMs: 1 };

test("live read: 3478 keys, [Key, Animal] above 1000 rows breaks (NullReferenceException), the rest resolved by Key, complete", async () => {
  const d = farm({ failGetData: NULLREF_BULK });
  // the request that broke on the farm really does break in this double
  await assert.rejects(d.getDataXml('<object name="AnimalMilkSetting" top="2000"><property name="Key"/><property name="Animal"/></object>').then((x) => import("../src/gateway.js").then((g) => g.parseDdmData(x))), /NullReferenceException/);
  d.calls.length = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const client = { ...d, async getDataXml(req) {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    try { return await d.getDataXml(req); } finally { inFlight -= 1; }
  } };
  const s = await cms.readLiveState(client, LIVE);
  assert.equal(s.complete, true, s.errors.join(" | "));
  assert.equal(s.stats.milk_setting_keys, 3478);
  assert.equal(s.stats.milk_settings_resolved, 3478);
  assert.equal(s.stats.milk_settings_from_bulk, 1000);
  assert.equal(s.stats.milk_settings_read_by_key, 2478);
  assert.equal(s.stats.sortcow_actions, 3477);
  assert.equal(s.stats.other_action_types_dropped, 0);
  assert.equal(s.stats.gateway_read_errors, 0);
  assert.ok(s.actions.every((a) => a.action_type === "SortCow" && a.animal_guid && a.animal_ref === "resolved"));
  assert.equal(s.actions.find((a) => a.key === "60123").animal_guid, guidOf(123), "Key -> Animal kept exactly");
  assert.ok(maxInFlight <= 3, `bounded concurrency (${maxInFlight})`);
  const bigBulk = d.calls.filter(([op, req]) => op === "GetData" && /name="AnimalMilkSetting"/.test(req) && /name="Animal"/.test(req) && !/<where>/.test(req) && Number(req.match(/top="(\d+)"/)?.[1]) > 1000);
  assert.equal(bigBulk.length, 0, "never asks [Key, Animal] above 1000 rows");
  assert.ok(reads(d, /<equal name="ActionType">SortCow<\/equal>/) >= 1, "SortCow read uses the ActionType filter");
  assert.equal(d.calls.filter(([op]) => op !== "GetData").length, 0, "read-only");
});

test("live read: if even the small bulk read fails, every key is read alone and the scan still completes", async () => {
  const d = farm({ milk: 1500, failGetData: ({ name, props, where }) => name === "AnimalMilkSetting" && props.includes("Animal") && !where.Key });
  const s = await cms.readLiveState(d, LIVE);
  assert.equal(s.complete, true, s.errors.join(" | "));
  assert.equal(s.stats.milk_bulk_failed, 1);
  assert.match(s.warnings.join(), /NullReferenceException/);
  assert.equal(s.stats.milk_settings_read_by_key, 1502);
  assert.equal(s.stats.milk_settings_resolved, 1502);
});

test("live read: one record that breaks even alone is retried, reported with its key, and makes the scan incomplete", async () => {
  const d = farm({ milk: 1200, failGetData: (r) => NULLREF_BULK(r) || (r.name === "AnimalMilkSetting" && r.where.Key === "31100") });
  const s = await cms.readLiveState(d, LIVE);
  assert.equal(s.complete, false);
  assert.equal(reads(d, /<equal name="Key">31100<\/equal>/), 2, "read retried a limited number of times");
  assert.deepEqual(s.unresolved.map((u) => [u.key, u.status, u.used_by_sortcow]), [["31100", "error", true]]);
  assert.match(s.unresolved[0].error, /NullReferenceException/);
  assert.deepEqual(s.actions_unresolved.map((a) => a.key), ["61100"]);
  assert.equal(s.actions.length, 1200, "every other row resolved");
  assert.equal(s.stats.gateway_read_errors, 1);
});

test("live read: an invalid animal reference is classified, not a failure; unused failing keys are reported only", async () => {
  const d = farm({ milk: 1200 });
  d.db.AnimalMilkSetting[31150].Animal = "not-a-guid";
  d.db.AnimalMilkSetting[31151].Animal = "";
  const ok = await cms.readLiveState(d, LIVE);
  assert.equal(ok.complete, true, ok.errors.join(" | "));
  assert.equal(ok.stats.milk_settings_invalid_animal, 1);
  assert.equal(ok.stats.milk_settings_without_animal, 1);
  assert.equal(ok.actions.find((a) => a.key === "61150").animal_ref, "invalid");
  assert.equal(ok.actions.find((a) => a.key === "61150").animal_guid, null);

  // several unresolved: two used by SortCow, one not -> incomplete, all three listed
  delete d.db.AnimalActionSetting[61199];
  const bad = ["31197", "31198", "31199"];
  const d2 = farm({ milk: 1200, failGetData: (r) => r.name === "AnimalMilkSetting" && bad.includes(r.where.Key) });
  Object.assign(d2.db, d.db);
  const s = await cms.readLiveState(d2, LIVE);
  assert.equal(s.complete, false);
  assert.equal(s.stats.milk_settings_unresolved, 3);
  assert.equal(s.stats.milk_settings_unresolved_used_by_sortcow, 2);
  assert.deepEqual(s.unresolved.filter((u) => !u.used_by_sortcow).map((u) => u.key), ["31199"]);
  // only a key no SortCow uses fails -> still complete, reported
  const d3 = farm({ milk: 1200, failGetData: (r) => r.name === "AnimalMilkSetting" && r.where.Key === "31199" });
  Object.assign(d3.db, d.db);
  const s3 = await cms.readLiveState(d3, LIVE);
  assert.equal(s3.complete, true, s3.errors.join(" | "));
  assert.deepEqual(s3.unresolved.map((u) => [u.key, u.used_by_sortcow]), [["31199", false]]);
});

test("live read: incomplete when the key list hits top, or when a SortCow uses a key the list did not have", async () => {
  const d = farm({ milk: 1200 });
  assert.equal((await cms.readLiveState(d, { ...LIVE, maxRows: 1202 })).complete, false);
  const h = farm({ milk: 1200, hideFromBulk: (name, r, props) => name === "AnimalMilkSetting" && props.length === 1 && r.Key === "31190" });
  const s = await cms.readLiveState(h, { ...LIVE, bulkTop: 0 });
  assert.equal(s.complete, false);
  assert.equal(s.stats.milk_settings_found_outside_key_list, 1);
  assert.equal(s.actions.find((a) => a.key === "61190").animal_guid, guidOf(1190));
  // a reference DelPro really doesn't have: classified, the scan stays complete
  delete d.db.AnimalMilkSetting[30001];
  const absent = await cms.readLiveState(d, LIVE);
  assert.equal(absent.complete, true, absent.errors.join(" | "));
  assert.equal(absent.actions.find((a) => a.key === "60001").animal_ref, "absent");
});

test("live read: SortCow read reaching top (5000) or failing -> read per milk setting, SortCow only, every type checked", async () => {
  const d = farm({ milk: 3476 });
  for (let i = 0; i < 1600; i += 1) {
    d.db.AnimalActionSetting[120000 + i] = { Key: String(120000 + i), AnimalMilkSetting: String(30000 + i), ActionType: "SortCow", Active: "false", StartDate: "2023-01-01T00:00:00Z", EndDate: "2023-01-02T00:00:00Z" };
  }
  const total = 3477 + 1600;
  const s = await cms.readLiveState(d, { ...LIVE, maxRows: 5000 });
  assert.equal(s.stats.sortcow_read_per_milk_setting, 1);
  assert.match(s.warnings.join(), /5000/);
  assert.equal(s.stats.sortcow_actions, total);
  assert.equal(s.stats.other_action_types_dropped, 3477, "DumpMilk rows from the per-setting reads dropped");
  assert.ok(s.actions.every((a) => a.action_type === "SortCow"));
  assert.equal(s.complete, true, s.errors.join(" | "));

  const f = farm({ milk: 300, failGetData: (r) => r.name === "AnimalActionSetting" && r.where.ActionType === "SortCow" });
  const sf = await cms.readLiveState(f, LIVE);
  assert.equal(sf.stats.sortcow_read_per_milk_setting, 1);
  assert.equal(sf.stats.sortcow_actions, 301);
  assert.equal(sf.complete, true, sf.errors.join(" | "));
  // a per-setting read failing too -> incomplete
  const g = farm({ milk: 300, failGetData: (r) => r.name === "AnimalActionSetting" && (r.where.ActionType === "SortCow" || r.where.AnimalMilkSetting === "30007") });
  const sg = await cms.readLiveState(g, LIVE);
  assert.equal(sg.complete, false);
  assert.equal(sg.stats.sortcow_read_failures, 1);
});

test("live read in GVET: an unreadable milk setting never erases the animal GVET has, nothing is removed", async () => {
  const upload = async (state) => {
    await db.exec("set role service_role");
    try {
      return (await db.query(`select cms_live_upload($1::jsonb) as r`, [JSON.stringify(state)])).rows[0].r;
    } finally {
      await db.exec("reset role");
    }
  };
  const good = await cms.readLiveState(farm({ milk: 20 }), LIVE);
  assert.equal((await upload(good)).complete, true);
  const before = (await q(`select animal_id, animal_guid from cms_live_action_settings where action_key = '11981'`))[0];
  assert.ok(before.animal_id);
  const broken = farm({ milk: 20, failGetData: (r) => r.name === "AnimalMilkSetting" && r.props.includes("Animal") && (!r.where.Key || r.where.Key === "8246") });
  broken.db.AnimalActionSetting[11981].IsValidForSession3 = "true";
  const state = await cms.readLiveState(broken, LIVE);
  assert.equal(state.complete, false);
  const res = await upload(state);
  assert.equal(res.complete, false);
  assert.equal(res.removed, 0);
  assert.equal(res.unmatched_reasons.milk_setting_unresolved, 1);
  const after = (await q(`select animal_id, animal_guid, sessions, removed_at from cms_live_action_settings where action_key = '11981'`))[0];
  assert.equal(after.animal_id, before.animal_id);
  assert.equal(after.animal_guid, before.animal_guid);
  assert.deepEqual(after.sessions, [1, 2, 3], "its DelPro state is still refreshed");
  assert.equal(after.removed_at, null);
  assert.equal((await q(`select count(*)::int as n from cms_live_action_settings where removed_at is not null and action_key like '600%'`))[0].n, 0);
  // the GVET jobs and their statuses are untouched by any live read
  assert.equal((await q(`select count(*)::int as n from cms_separation_jobs where status = 'success' and action_key is null`))[0].n, 0);
});

test("live state: DelPro SortCow settings + sort areas reach GVET, mapped to the animal by GUID", async () => {
  const d = delproWith({ existingSortCow: true });
  const state = await cms.readLiveState(d);
  assert.equal(state.complete, true);
  assert.deepEqual(state.actions.map((a) => [a.key, a.animal_guid, a.sessions]), [["11981", GUID, [1, 2]]]);
  assert.deepEqual(state.sort_areas, [{ key: "1", number: "1", name: "Rūšiavimo patalpa 1" }]);
  await db.exec("set role service_role");
  await db.query(`select cms_live_upload($1::jsonb)`, [JSON.stringify(state)]);
  await db.exec("reset role");
  const [row] = await q(`select l.action_key, a.tag_no from cms_live_action_settings l join animals a on a.id = l.animal_id where l.action_key = '11981'`);
  assert.equal(row.tag_no, "LT000007300337");
});

test("milk diagnose (read-only): finds the record that breaks the bulk read, or says it is a bulk-size problem", async () => {
  const poison = farm({ milk: 1500, failGetData: ({ name, props, rows }) => name === "AnimalMilkSetting" && props.includes("Animal") && rows.some((r) => r.Key === "31000") });
  const r = await cms.diagnoseMilkSettings(poison, { from: 1000, to: 2000 });
  assert.equal(r.first_failing_top, 1003);
  assert.equal(r.candidate_key, "31000");
  assert.equal(r.order_matches_key_list, true);
  assert.match(r.conclusion, /konkretaus įrašo problema/);
  assert.equal(poison.calls.filter(([op]) => op !== "GetData").length, 0);

  const size = farm({ milk: 1500, failGetData: ({ name, props, where, top }) => name === "AnimalMilkSetting" && props.includes("Animal") && !where.Key && top > 1400 });
  size.db.Animal[guidOf(1398)] = { ObjectGuid: guidOf(1398), Number: "9398" };
  const s = await cms.diagnoseMilkSettings(size, { from: 1000, to: 2000 });
  assert.equal(s.candidate_key, "31398");
  assert.equal(s.first_failing_top, 1401);
  assert.match(s.conclusion, /dydžio problema/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 0051: targeted CMS — each job / refresh reads only its own animal; the full-herd scan never gates anything.
// ---------------------------------------------------------------------------------------------------------------------
const T = Array.from({ length: 8 }, (_, i) => ({
  guid: `a0000000-0000-4000-8000-0000000005${String(i).padStart(2, "0")}`,
  orn: `LT0000073005${String(i).padStart(2, "0")}`,
  no: `5${String(i).padStart(2, "0")}`,
  milk: String(8500 + i),
}));
let t51 = false;
async function setup51() {
  if (t51) return;
  t51 = true;
  await db.exec(`insert into animals (tag_no, animal_no, delpro_object_guid, source) values
    ${T.map((a) => `('${a.orn}', '${a.no}', '${a.guid}', 'delpro')`).join(", ")}`);
}
/** ONE DelPro for every 0051 test (records written by one test are there for the next, as on the farm). */
let D51 = null;
function targeted({ failGetData = null } = {}) {
  if (!D51) {
    D51 = fakeDelpro();
    Object.assign(D51.db, delproWith({ existingSortCow: true }).db);
    for (const a of T) {
      D51.db.Animal[a.guid] = { ObjectGuid: a.guid, Number: a.no, OfficialRegNumber: a.orn };
      D51.db.AnimalMilkSetting[a.milk] = { Key: a.milk, Animal: a.guid };
    }
  }
  D51.setFailGetData(failGetData);
  D51.calls.length = 0;
  return D51;
}
const creates = (d) => d.calls.filter(([op]) => op === "CreateData").length;
const svc = async (sql, params) => {
  await db.exec("set role service_role");
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
};
const summary = (props) => cms.actionSummary({ properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { value: v }])) });

test("0051 effective status: dates, sessions and Active decide; unreadable values are 'unknown' and conflict", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  const st = (p) => cms.actionStatus(summary({ Key: "1", ActionType: "SortCow", ...p }), now);
  assert.equal(st({ Active: "true", StartDate: "2026-11-01T00:00:00Z", IsValidForSession1: "true" }), "effective");
  assert.equal(st({ Active: "true", StartDate: "2026-11-05T00:00:00Z", IsValidForSession2: "true" }), "scheduled");
  assert.equal(st({ Active: "true", StartDate: "2026-11-01T00:00:00Z", EndDate: "2026-11-02T00:00:00Z", IsValidForSession1: "true" }), "ended");
  assert.equal(st({ Active: "false", StartDate: "2026-11-01T00:00:00Z", IsValidForSession1: "true" }), "inactive");
  assert.equal(st({ Active: "true", StartDate: "2026-11-01T00:00:00Z" }), "no_sessions");
  assert.equal(st({ StartDate: "2026-11-01T00:00:00Z", IsValidForSession1: "true" }), "unknown", "Active missing");
  assert.equal(st({ Active: "yes", IsValidForSession1: "true" }), "unknown", "Active not a boolean");
  assert.equal(st({ Active: "true", EndDate: "rytoj", IsValidForSession1: "true" }), "unknown", "unreadable date");
  // what blocks a new write: anything that is or may become active, or can't be read
  for (const s of ["effective", "scheduled", "no_sessions", "unknown"]) assert.ok(cms.CONFLICTING.has(s), s);
  for (const s of ["ended", "inactive"]) assert.ok(!cms.CONFLICTING.has(s), s);
});

test("0051 milk setting by Animal GUID: one GetData with the Animal filter and top 10; a full page = ambiguous", async () => {
  await setup51();
  const d = targeted();
  assert.equal(await cms.findMilkSetting(d, T[0].guid), T[0].milk);
  const [, req] = d.calls.at(-1);
  assert.match(req, new RegExp(`<equal name="Animal">${T[0].guid}</equal>`));
  assert.match(req, /top="10"/);
  assert.equal(await cms.findMilkSetting(d, T[1].guid, { optional: true }), T[1].milk);
  assert.equal(await cms.findMilkSetting(d, GUID3, { optional: true }), null, "read-only: no milk setting = no separations");
  const many = fakeDelpro();
  many.db.AnimalMilkSetting = {};
  for (let i = 0; i < 10; i += 1) many.db.AnimalMilkSetting[9100 + i] = { Key: String(9100 + i), Animal: T[2].guid };
  await assert.rejects(cms.findMilkSetting(many, T[2].guid), (e) => e.code === "milk_setting_ambiguous");
});

test("0051 actions read: SortCow filtered from the animal's own milk setting; truncated or keyless answers fail closed", async () => {
  const d = fakeDelpro();
  d.db.AnimalActionSetting = {};
  for (let i = 0; i < 20; i += 1) d.db.AnimalActionSetting[70000 + i] = { Key: String(70000 + i), AnimalMilkSetting: "1", ActionType: "DumpMilk", Active: "false" };
  await assert.rejects(cms.readActions(d, "1"), (e) => e.code === "actions_truncated");
  d.db.AnimalActionSetting = { 70100: { AnimalMilkSetting: "2", ActionType: "SortCow", Active: "true" } };
  await assert.rejects(cms.readActions(d, "2"), (e) => e.code === "actions_unreadable");
});

test("0051 identity: GUID + ORN, or GUID + Number when DelPro has no ORN; never an ORN against a Number", async () => {
  const d = fakeDelpro();
  d.db.Animal = { [T[0].guid]: { ObjectGuid: T[0].guid, Number: T[0].no, OfficialRegNumber: T[0].orn } };
  const s = { animal_guid: T[0].guid, orn: T[0].orn, animal_no: T[0].no };
  assert.deepEqual(await cms.verifyAnimal(d, s), { number: T[0].no, orn: T[0].orn });
  await assert.rejects(cms.verifyAnimal(d, { ...s, orn: T[1].orn }), (e) => e.code === "animal_orn_mismatch");
  delete d.db.Animal[T[0].guid].OfficialRegNumber;
  assert.equal((await cms.verifyAnimal(d, s)).number, T[0].no);
  await assert.rejects(cms.verifyAnimal(d, { ...s, animal_no: "999" }), (e) => e.code === "animal_number_mismatch");
  // GVET's ORN must not be compared with DelPro's short Number
  await assert.rejects(cms.verifyAnimal(d, { ...s, animal_no: null }), (e) => e.code === "animal_identity_unverified");
  await assert.rejects(cms.verifyAnimal(d, { ...s, animal_guid: "a0000000-0000-4000-8000-0000000009ff" }), (e) => e.code === "animal_not_found");
});

test("0051 multi-cow: approved jobs sent independently, bounded concurrency, the full-scan failure blocks nothing", async () => {
  await setup51();
  // the historical full scan is broken / incomplete — exactly the farm's situation
  const broken = farm({ milk: 1200, failGetData: (r) => NULLREF_BULK(r) || (r.name === "AnimalMilkSetting" && r.where.Key === "31100") });
  const scan = await cms.readLiveState(broken, LIVE);
  assert.equal(scan.complete, false);
  assert.equal((await svc(`select cms_live_upload($1::jsonb) as r`, [JSON.stringify(scan)]))[0].r.complete, false);

  // the same DelPro breaks every bulk read, but each cow's own reads work
  const d = targeted({ failGetData: (r) => NULLREF_BULK(r) || (r.name === "AnimalMilkSetting" && !r.where.Animal && r.props.includes("Animal")) });
  let inFlight = 0;
  let maxInFlight = 0;
  const client = { ...d, async getDataXml(x) {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    try { return await d.getDataXml(x); } finally { inFlight -= 1; }
  }, createData: (x) => d.createData(x) };
  const ids = await approvedBatch([await item(T[0].orn), await item(T[1].orn, { sessions: [3] }), await item(T[2].orn)]);
  assert.equal(await cms.runCmsOutbound(client, { concurrency: 2, max: 10 }), 3);
  for (const orn of [T[0].orn, T[1].orn, T[2].orn]) {
    const j = await job(ids[orn]);
    assert.equal(j.status, "success", `${orn}: ${j.last_error}`);
    assert.equal(j.readback.verified, true);
    assert.ok(d.db.AnimalActionSetting[j.action_key], "real DelPro key recorded");
  }
  assert.equal(creates(d), 3);
  assert.ok(maxInFlight <= 2, `bounded concurrency (${maxInFlight})`);
  // no global herd read before or during sending
  assert.equal(d.calls.filter(([op, x]) => op === "GetData" && !/<where>/.test(x)).length, 0, "every read is filtered to one animal");
  // nothing is sent twice
  assert.equal(await cms.runCmsOutbound(client), 0);
  assert.equal(creates(d), 3);
});

test("0051 per-cow failures: missing animal, ambiguous milk setting, unreadable or active existing action — only that cow stops", async () => {
  const d = targeted();
  // T[4]: an existing SortCow whose Active can't be read -> unknown -> never written next to it
  d.db.AnimalActionSetting[71000] = { Key: "71000", AnimalMilkSetting: T[4].milk, ActionType: "SortCow", StartDate: "2026-01-01T00:00:00Z", IsValidForSession1: "true" };
  delete d.db.Animal[T[3].guid]; // T[3]: gone from DelPro
  d.db.AnimalMilkSetting[8999] = { Key: "8999", Animal: T[5].guid }; // T[5]: two milk settings
  const ids = await approvedBatch([await item(T[3].orn), await item(T[4].orn), await item(T[5].orn)]);
  assert.equal(await cms.runCmsOutbound(d), 3);
  const [missing, unknown, ambiguous] = await Promise.all([job(ids[T[3].orn]), job(ids[T[4].orn]), job(ids[T[5].orn])]);
  assert.equal(missing.status, "error");
  assert.equal(missing.error_details.code, "animal_not_found");
  assert.equal(unknown.status, "error");
  assert.match(unknown.last_error, /71000 unknown/);
  assert.equal(ambiguous.status, "error");
  assert.equal(ambiguous.error_details.code, "milk_setting_ambiguous");
  assert.equal(creates(d), 0, "nothing written for any of them");
  for (const j of [missing, unknown, ambiguous]) assert.equal(j.write_started_at, null);
});

test("0051 targeted refresh: only GVET's CMS animals, per-animal removal, a failed read keeps the old state as stale", async () => {
  const d = targeted();
  const jT0 = (await q(`select action_key from cms_separation_jobs j join animals a on a.id = j.animal_id where a.tag_no = $1 and j.status = 'success'`, [T[0].orn]))[0];
  const targets = await svc(`select cms_live_targets('{"limit":100,"due_minutes":60}'::jsonb) as r`);
  const orns = targets[0].r.map((t) => t.orn);
  assert.ok(orns.includes(T[0].orn) && orns.includes(T[1].orn), "GVET-written animals are refreshed");
  assert.ok(!orns.includes("LT000007300340"), "unlinked animals never");
  const res = await cms.runCmsTargetedRefresh(d, { limit: 100, dueMinutes: 60 });
  assert.equal(res.failed, 0);
  assert.ok(d.calls.every(([op, x]) => op === "GetData" && /<where>/.test(x)), "read-only, filtered reads only");
  let [row] = await q(`select active, sessions, removed_at, animal_id from cms_live_action_settings where action_key = $1`, [jT0.action_key]);
  assert.equal(row.active, true);
  assert.ok(row.animal_id);
  const [chk] = await q(`select c.* from cms_animal_live_checks c join animals a on a.id = c.animal_id where a.tag_no = $1`, [T[0].orn]);
  assert.equal(chk.ok, true);
  assert.equal(chk.milk_setting_key, T[0].milk);
  // nothing is due again right away
  assert.equal((await svc(`select cms_live_targets('{"limit":100,"due_minutes":60}'::jsonb) as r`))[0].r.length, 0);

  // a read of T[0] fails: its record stays as it was, the check says when and why
  const bad = targeted({ failGetData: (r) => r.where.Animal === T[0].guid });
  const one = await cms.runCmsTargetedRefresh(bad, { tags: [T[0].orn] });
  assert.equal(one.failed, 1);
  [row] = await q(`select active, removed_at from cms_live_action_settings where action_key = $1`, [jT0.action_key]);
  assert.equal(row.active, true);
  assert.equal(row.removed_at, null);
  const [chk2] = await q(`select c.* from cms_animal_live_checks c join animals a on a.id = c.animal_id where a.tag_no = $1`, [T[0].orn]);
  assert.equal(chk2.ok, false);
  assert.match(chk2.error, /NullReferenceException/);
});

test("0051 disabled by hand in DelPro: GVET shows it on the next refresh and never re-creates it", async () => {
  const d = targeted();
  const [{ id, action_key: key }] = await q(`select j.id, j.action_key from cms_separation_jobs j join animals a on a.id = j.animal_id where a.tag_no = $1 and j.status = 'success'`, [T[1].orn]);
  d.db.AnimalActionSetting[key] = { Key: key, AnimalMilkSetting: T[1].milk, ActionType: "SortCow", Active: "false", StartDate: "2099-11-03T06:00:00Z", EndDate: "2099-11-05T06:00:00Z", IsValidForSession3: "true" };
  // someone asks for this one cow in GVET
  await asUser(VET, `select cms_request_animal_refresh(array['${await animalId(T[1].orn)}']::uuid[])`);
  const res = await cms.runCmsTargetedRefresh(d, { limit: 10, dueMinutes: 60 });
  assert.equal(res.targets, 1);
  const [v] = await q(`select status, delpro_active from vw_cms_separation_jobs where id = $1`, [id]);
  assert.equal(v.delpro_active, false);
  assert.equal(v.status, "success");
  assert.equal(await cms.runCmsOutbound(d), 0);
  assert.equal(creates(d), 0);
  // record deleted in DelPro: removed for this animal only
  delete d.db.AnimalActionSetting[key];
  await cms.runCmsTargetedRefresh(d, { tags: [T[1].orn] });
  assert.ok((await q(`select removed_at from cms_live_action_settings where action_key = $1`, [key]))[0].removed_at);
  assert.equal((await q(`select count(*)::int as n from cms_live_action_settings where removed_at is not null and action_key = '11981'`))[0].n, 0, "other animals untouched");
});

test("0051 emergency stop: routine multi-cow sending stops at the claim, nothing reaches DelPro", async () => {
  const d = targeted();
  const ids = await approvedBatch([await item(T[6].orn), await item(T[7].orn)]);
  await asUser(VET, `select cms_set_outbound_enabled(false)`);
  assert.equal(await cms.runCmsOutbound(d), 0);
  for (const orn of [T[6].orn, T[7].orn]) assert.equal((await job(ids[orn])).status, "approved");
  assert.equal(creates(d), 0);

  // GVET's mirror is stale (DelPro got a separation for T[7] by hand since): the cow's own pre-write read refuses it
  d.db.AnimalActionSetting[72000] = { Key: "72000", AnimalMilkSetting: T[7].milk, ActionType: "SortCow", Active: "true", StartDate: "2026-01-01T00:00:00Z", IsValidForSession2: "true" };
  await asUser(ADMIN, `select cms_set_outbound_enabled(true, true)`);
  assert.equal(await cms.runCmsOutbound(d), 2);
  assert.equal((await job(ids[T[6].orn])).status, "success");
  const j = await job(ids[T[7].orn]);
  assert.equal(j.status, "error");
  assert.equal(j.error_details.code, "existing_active_sortcow");
  assert.match(j.last_error, /72000 effective/);
  assert.equal(creates(d), 1);
});

test("0051 single instance: a live worker's fresh lock refuses a second; stale or foreign-PID locks are taken over, nothing killed", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gvet-lock-"));
  const file = path.join(dir, "worker.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: 4242 }));
  assert.equal(idx.acquireSingleInstanceLock({ dir, alive: () => true }).ok, false, "fresh lock of a running worker");
  // PID reused by another program / process gone
  const taken = idx.acquireSingleInstanceLock({ dir, alive: () => false });
  assert.equal(taken.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  taken.release();
  // an old 0.3.0 lock (bare PID) not touched for 3 minutes
  fs.writeFileSync(file, "4242");
  const old = new Date(Date.now() - 180_000);
  fs.utimesSync(file, old, old);
  const t2 = idx.acquireSingleInstanceLock({ dir, alive: () => true });
  assert.equal(t2.ok, true);
  t2.release();
  assert.equal(fs.existsSync(file), false);
  // Windows: a PID that exists but isn't node.exe is not a worker
  const win = (image) => idx.isNodeProcess(process.ppid, { platform: "win32", exec: () => `"${image}","${process.ppid}","Console","1","10,000 K"` });
  assert.equal(win("node.exe"), true);
  assert.equal(win("chrome.exe"), false);
  assert.equal(idx.isNodeProcess(99999999, { platform: "win32", exec: () => "" }), false, "no such process");
});

// DelPro -> GVET inseminations (0053). PGlite with every migration behind a PostgREST-shaped shim; the Gateway is the in-memory
// fake (GetData with <equal> filters). The objects / properties / the InseminationEvent.ObjectGuid = AnimalEvent.ObjectGuid
// relationship are the ones verified read-only on the farm; the fake proves our logic, not DelPro's behaviour.
// Nothing here can write to DelPro: the import gets a client with getDataXml only, and every call is checked to be GetData.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTestDb } from "../../supabase/tests/helpers/db.mjs";
import { fakeDelpro } from "./fake-delpro.js";

const ADMIN = "00000000-0000-0000-0000-0000000000aa";
const VET = "00000000-0000-0000-0000-0000000000bb";
// the farm example
const COW = "0345269a-aea9-4467-b8d8-9249f9eccce7";
const EV = "46379d22-d258-468d-b8e8-cdca825860d9";
const HEAT = "70e77011-56ab-4b40-b0ab-d73819ebd3b0";
const COW2 = "0345269a-aea9-4467-b8d8-9249f9ecc002";
const COW3 = "0345269a-aea9-4467-b8d8-9249f9ecc003";
const COW4 = "0345269a-aea9-4467-b8d8-9249f9ecc004";
const g = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db, server, ins, cfg, idx;
const q = async (sql, params) => (await db.query(sql, params)).rows;
const asUser = async (id, sql) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${id}', false);`);
  try {
    return (await db.query(sql)).rows[0];
  } finally {
    await db.exec("reset role");
  }
};
const recs = (tag) => q(`select r.* from insemination_records r join animals a on a.id = r.animal_id where a.tag_no = $1 order by delpro_event_at nulls first`, [tag]);
const scan = async (tag) => (await q(`select s.* from delpro_insemination_scans s join animals a on a.id = s.animal_id where a.tag_no = $1`, [tag]))[0];
const readOnly = (d) => ({ getDataXml: (x) => d.getDataXml(x) });
const onlyGetData = (d) => assert.ok(d.calls.every(([op]) => op === "GetData"), "only GetData may reach DelPro");
const aeReads = (d) => d.calls.filter(([op, x]) => op === "GetData" && /object name="AnimalEvent"/.test(x)).length;

function farm() {
  const d = fakeDelpro();
  d.db.InseminationEvent = {
    [EV]: { ObjectGuid: EV, Animal: COW, Semen: "4", Bull: "", Breeder: "", Comment: "Automatiškai generuoja sistema", EventTime: "",
      InseminationNumber: "1", InseminationMethod: "2", HeatEvent: HEAT },
  };
  d.db.AnimalEvent = { [EV]: { ObjectGuid: EV, Animal: COW, EventDate: "2014-06-08T21:00:00.020Z" } };
  // the heat event is a different object with its own GUID — must never be taken as the insemination
  d.db.HeatEvent = { [HEAT]: { ObjectGuid: HEAT, Animal: COW } };
  return d;
}
function addEvent(d, guid, animal, date, extra = {}) {
  d.db.InseminationEvent[guid] = { ObjectGuid: guid, Animal: animal, Semen: "7", InseminationNumber: "2", InseminationMethod: "2", ...extra };
  if (date !== undefined) d.db.AnimalEvent[guid] = { ObjectGuid: guid, Animal: animal, EventDate: date };
}

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
    SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SERVICE_ROLE_KEY: "k", WORKER_ID: "ins-pc",
    DELPRO_SOURCE: "off", OUTBOUND_MODE: "gateway", CMS_OUTBOUND_MODE: "gateway", DELPRO_GATEWAY_USER: "HerdNav",
  });
  cfg = (await import("../src/config.js")).config;
  Object.assign(cfg, { supabaseUrl: process.env.SUPABASE_URL, serviceKey: "k", workerId: "ins-pc", inseminationBackfillMonths: 0 });
  ins = await import("../src/inseminations.js");
  idx = await import("../src/index.js");
  await db.exec(`
    insert into auth.users values ('${ADMIN}', 'admin@x'), ('${VET}', 'vet@x');
    insert into users (id, email, role) values ('${ADMIN}', 'admin@x', 'admin'), ('${VET}', 'vet@x', 'vet');
    insert into animals (tag_no, animal_no, delpro_object_guid, source) values
      ('LT000009526299', '6299', '${COW}', 'delpro'), ('LT000009526300', '6300', '${COW2}', 'delpro'),
      ('LT000009526301', '6301', '${COW3}', 'delpro'), ('LT000009526302', '6302', '${COW4}', 'delpro'),
      ('LT000009526399', '6399', null, 'vic');
  `);
});

after(async () => {
  server?.close();
  await db?.close();
});

test("dates: UTC instant -> Europe/Vilnius date, never the first 10 characters; zone-less / invalid dates refused", () => {
  assert.equal(ins.vilniusDate("2014-06-08T21:00:00.020Z"), "2014-06-09");
  assert.equal(ins.vilniusDate("2026-01-15T21:59:00Z"), "2026-01-15"); // winter +2
  assert.equal(ins.vilniusDate("2026-01-15T22:00:00Z"), "2026-01-16");
  assert.equal(ins.vilniusDate("2026-07-15T20:59:00Z"), "2026-07-15"); // summer +3
  assert.equal(ins.vilniusDate("2026-07-15T21:00:00Z"), "2026-07-16");
  assert.equal(ins.normalizeEventDate("2014-06-08T21:00:00.020Z"), "2014-06-08T21:00:00.020Z");
  assert.equal(ins.normalizeEventDate("2014-06-09T00:00:00+03:00"), "2014-06-08T21:00:00.000Z");
  for (const bad of [null, "", "2014-06-08", "2014-06-08T21:00:00", "nonsense", "2014-13-45T99:00:00Z", "1900-01-01T00:00:00Z"]) {
    assert.equal(ins.normalizeEventDate(bad), null, String(bad));
  }
});

test("the verified farm example: InseminationEvent + AnimalEvent (same ObjectGuid) -> one GVET insemination on 2014-06-09", async () => {
  const d = farm();
  const res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526299"] });
  assert.equal(res.inserted, 1);
  const [r] = await recs("LT000009526299");
  assert.equal(r.source, "delpro");
  assert.equal(r.delpro_event_guid, EV);
  assert.equal(r.delpro_heat_event_guid, HEAT); // separate relationship, kept as a reference only
  assert.equal(new Date(r.delpro_event_at).toISOString(), "2014-06-08T21:00:00.020Z");
  assert.equal(new Date(r.insemination_date).toISOString().slice(0, 10), "2014-06-09");
  assert.equal(r.delpro_semen_key, "4");
  assert.equal(r.delpro_insemination_number, 1);
  assert.equal(r.delpro_method_code, "2");
  assert.equal(r.delpro_comment, "Automatiškai generuoja sistema");
  assert.equal(r.notes, "Automatiškai generuoja sistema");
  // missing Bull / Breeder / EventTime stay null — nothing invented
  assert.equal(r.delpro_bull, null);
  assert.equal(r.bull_name, null);
  assert.equal(r.delpro_breeder, null);
  assert.equal(r.inseminator_name, null);
  assert.equal(r.delpro_event_time, null);
  assert.equal(r.karves_id, "LT000009526299");
  assert.ok(r.delpro_synced_at);
  const s = await scan("LT000009526299");
  assert.equal(s.ok, true);
  assert.equal(s.complete, true);
  // the AnimalEvent lookup is by the insemination GUID, never the heat event's
  assert.ok(d.calls.some(([, x]) => /object name="AnimalEvent" top="2".*<equal name="ObjectGuid">46379d22/.test(x)));
  assert.ok(!d.calls.some(([, x]) => /object name="AnimalEvent".*70e77011/.test(x)));
  onlyGetData(d);
});

test("re-reading: same GUID never imported twice; a changed source record updates the same row; old unchanged dates not re-read", async () => {
  const d = farm();
  let res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526299"] });
  assert.equal(res.inserted, 0);
  assert.equal(res.unchanged, 1);
  assert.equal(aeReads(d), 0, "a 2014 event GVET already has (outside the overlap window) needs no AnimalEvent read");
  d.db.InseminationEvent[EV].Comment = "pataisyta DelPro";
  d.db.InseminationEvent[EV].Bull = "BULIUS 1";
  res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526299"] });
  assert.equal(res.updated, 1);
  assert.equal(aeReads(d), 1, "a changed event re-reads its date");
  const rows = await recs("LT000009526299");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delpro_comment, "pataisyta DelPro");
  assert.equal(rows[0].notes, "pataisyta DelPro");
  assert.equal(rows[0].bull_name, "BULIUS 1");
  // corrected date in DelPro (picked up with --recheck-dates or inside the overlap window): same row, new day
  d.db.AnimalEvent[EV].EventDate = "2014-06-09T21:30:00Z";
  res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526299"], recheckDates: true });
  assert.equal(res.updated, 1);
  const [r] = await recs("LT000009526299");
  assert.equal(new Date(r.insemination_date).toISOString().slice(0, 10), "2014-06-10");
  // the database itself refuses a second row for the GUID
  await assert.rejects(q(`do $$ begin perform set_config('gvet.delpro_import', 'on', true);
    insert into insemination_records (animal_id, insemination_date, source, delpro_event_guid, delpro_event_at)
    values ('${r.animal_id}', '2014-06-10', 'delpro', '${EV}', now()); end $$`), /duplicate key|unique/);
  onlyGetData(d);
});

test("GVET-side edits are kept: a bull typed in GVET is not overwritten; pregnancy stays editable; DelPro fields and delete are refused", async () => {
  const [r] = await recs("LT000009526299");
  await asUser(VET, `update insemination_records set bull_name = 'Rankinis', pregnancy_confirmed = true where id = '${r.id}'`);
  const d = farm();
  d.db.AnimalEvent[EV].EventDate = "2014-06-09T21:30:00Z";
  d.db.InseminationEvent[EV].Comment = "pataisyta DelPro";
  d.db.InseminationEvent[EV].Bull = "BULIUS 2";
  await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526299"] });
  const [after] = await recs("LT000009526299");
  assert.equal(after.delpro_bull, "BULIUS 2");
  assert.equal(after.bull_name, "Rankinis");
  assert.equal(after.pregnancy_confirmed, true);
  await assert.rejects(asUser(VET, `update insemination_records set delpro_event_at = now() where id = '${r.id}'`), /DelPro laukų/);
  await assert.rejects(asUser(VET, `update insemination_records set insemination_date = '2020-01-01' where id = '${r.id}'`), /DelPro laukų/);
  await assert.rejects(asUser(VET, `delete from insemination_records where id = '${r.id}'`), /ištrinti negalima/);
  await assert.rejects(
    asUser(VET, `insert into insemination_records (animal_id, source, delpro_event_guid, delpro_event_at) values ('${r.animal_id}', 'delpro', '${g(999)}', now())`),
    /tik sinchronizacija/,
  );
});

test("several inseminations on one day are separate events; missing semen / bull / breeder stay null", async () => {
  const d = farm();
  addEvent(d, g(1), COW2, "2026-03-01T06:00:00Z", { Semen: "", Bull: "", Breeder: "" });
  addEvent(d, g(2), COW2, "2026-03-01T15:00:00Z", { Semen: "9", Breeder: "Jonas" });
  const res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526300"] });
  assert.equal(res.inserted, 2);
  const rows = await recs("LT000009526300");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => new Date(r.insemination_date).toISOString().slice(0, 10)), ["2026-03-01", "2026-03-01"]);
  assert.equal(rows[0].delpro_semen_key, null);
  assert.equal(rows[0].delpro_breeder, null);
  assert.equal(rows[1].delpro_semen_key, "9");
  assert.equal(rows[1].inseminator_name, "Jonas");
  onlyGetData(d);
});

test("invalid events are never imported: missing / ambiguous AnimalEvent, bad EventDate, animal mismatch in either object", async () => {
  const d = farm();
  addEvent(d, g(10), COW3, undefined); // no AnimalEvent
  addEvent(d, g(11), COW3, "not-a-date");
  addEvent(d, g(12), COW3, "2026-03-02T06:00:00"); // no zone: not guessed
  addEvent(d, g(13), COW3, "2026-03-02T06:00:00Z");
  d.db.AnimalEvent[g(13)].Animal = COW2; // AnimalEvent says another animal
  addEvent(d, g(14), COW3, "2026-03-03T06:00:00Z");
  d.db.AnimalEvent["dup"] = { ObjectGuid: g(14), Animal: COW3, EventDate: "2026-03-04T06:00:00Z" }; // two base events
  addEvent(d, g(15), COW3, "2026-03-05T06:00:00Z", { HeatEvent: "nesąmonė" });
  addEvent(d, g(16), COW3, "2026-03-06T06:00:00Z"); // the only good one
  const res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526301"] });
  assert.equal(res.inserted, 1);
  assert.equal(res.invalid, 6);
  assert.equal(res.incomplete, 1);
  const rows = await recs("LT000009526301");
  assert.deepEqual(rows.map((r) => r.delpro_event_guid), [g(16)]);
  const s = await scan("LT000009526301");
  assert.equal(s.ok, true);
  assert.equal(s.complete, false, "an animal with invalid events is shown as a problem and retried");
  const errs = Object.fromEntries(s.invalid.map((i) => [i.guid, i.error]));
  assert.equal(errs[g(10)], "animal_event_missing");
  assert.match(errs[g(11)], /event_date_invalid/);
  assert.match(errs[g(12)], /event_date_invalid/);
  assert.equal(errs[g(13)], "animal_event_animal_mismatch");
  assert.equal(errs[g(14)], "animal_event_ambiguous");
  assert.equal(errs[g(15)], "heat_event_invalid");
  // an InseminationEvent naming a different animal than the one asked for (if the Gateway ignored the filter)
  const row = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
  assert.deepEqual(ins.eventFromRow(row({ ObjectGuid: g(16), Animal: COW4 }), COW3).problems, ["event_animal_mismatch"]);
  assert.deepEqual(ins.eventFromRow(row({ ObjectGuid: g(16), Animal: COW3.toUpperCase() }), COW3).problems, []);
  assert.deepEqual(ins.eventFromRow(row({ ObjectGuid: HEAT, Animal: COW3, HeatEvent: HEAT }), COW3).problems, ["heat_event_is_insemination"]);
  assert.deepEqual(ins.eventFromRow(row({ ObjectGuid: "", Animal: COW3 }), COW3).problems, ["event_guid_missing"]);
  assert.deepEqual(ins.eventFromRow(row({ ObjectGuid: g(17), Animal: COW3, InseminationNumber: "x" }), COW3).problems, ["insemination_number_invalid"]);
  onlyGetData(d);
});

test("failed Gateway read: nothing imported or removed, the animal is retried later; resumes when DelPro answers again", async () => {
  const d = farm();
  addEvent(d, g(1), COW2, "2026-03-01T06:00:00Z", { Semen: "", Bull: "", Breeder: "" });
  addEvent(d, g(2), COW2, "2026-03-01T15:00:00Z", { Semen: "9", Breeder: "Jonas" });
  d.setFailGetData(({ name }) => name === "InseminationEvent");
  const res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526300"] });
  assert.equal(res.failed, 1);
  assert.equal((await recs("LT000009526300")).length, 2, "earlier imports stay");
  assert.ok((await recs("LT000009526300")).every((r) => r.delpro_missing_at === null));
  let s = await scan("LT000009526300");
  assert.equal(s.ok, false);
  assert.match(s.error, /NullReference|GetData/);
  // not due yet (retry window), then due
  await db.exec(`update delpro_insemination_scans set checked_at = now() - interval '1 hour', complete_at = now() - interval '1 minute'`);
  const targets = await q(`select delpro_insemination_targets('{"limit":100,"due_minutes":360,"retry_minutes":30}'::jsonb) as t`);
  const picked = targets[0].t.map((t) => t.orn);
  assert.ok(picked.includes("LT000009526300"), "failed read is retried");
  assert.ok(!picked.includes("LT000009526299"), "a complete, recent read is not due");
  d.setFailGetData(null);
  await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526300"] });
  s = await scan("LT000009526300");
  assert.equal(s.ok, true);
  assert.equal(s.complete, true);
});

test("truncated InseminationEvent answer: re-read with the max top; still full -> incomplete, imports what it got, flags nothing missing", async () => {
  const d = farm();
  for (let i = 30; i < 34; i += 1) addEvent(d, g(i), COW4, `2026-04-0${i - 29}T06:00:00Z`);
  const save = { top: cfg.inseminationEventTop, max: cfg.inseminationEventMaxTop };
  Object.assign(cfg, { inseminationEventTop: 2, inseminationEventMaxTop: 3 });
  try {
    const res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526302"] });
    assert.equal(res.incomplete, 1);
    assert.equal(res.inserted, 3);
    assert.equal(res.missing, 0);
    const s = await scan("LT000009526302");
    assert.equal(s.complete, false);
    assert.match(s.error, /top=3/);
    assert.equal(s.complete_at, null, "progress is not advanced by an incomplete read");
    assert.equal(d.calls.filter(([, x]) => /object name="InseminationEvent"/.test(x)).length, 2);
  } finally {
    Object.assign(cfg, { inseminationEventTop: save.top, inseminationEventMaxTop: save.max });
  }
  // complete read afterwards: all 4, and an event later deleted in DelPro is flagged — never deleted in GVET
  await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526302"] });
  assert.equal((await recs("LT000009526302")).length, 4);
  delete d.db.InseminationEvent[g(33)];
  const res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526302"] });
  assert.equal(res.missing, 1);
  const rows = await recs("LT000009526302");
  assert.equal(rows.length, 4);
  assert.ok(rows.find((r) => r.delpro_event_guid === g(33)).delpro_missing_at);
});

test("initial backfill window: older events are not imported, remembered, and their date is not re-read every round", async () => {
  await db.exec(`insert into animals (tag_no, animal_no, delpro_object_guid, source) values ('LT000009526303', '6303', '${g(500)}', 'delpro')`);
  const d = farm();
  const now = () => new Date("2026-11-03T10:00:00Z");
  addEvent(d, g(40), g(500), "2023-01-10T06:00:00Z"); // > 24 months
  addEvent(d, g(41), g(500), "2025-12-10T06:00:00Z");
  cfg.inseminationBackfillMonths = 24;
  try {
    let res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526303"], now });
    assert.equal(res.inserted, 1);
    assert.equal(res.skipped, 1);
    assert.deepEqual((await recs("LT000009526303")).map((r) => r.delpro_event_guid), [g(41)]);
    assert.equal((await scan("LT000009526303")).skipped[0].guid, g(40));
    const before = aeReads(d);
    res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526303"], now });
    assert.equal(aeReads(d), before, "neither the skipped nor the imported old event needs another AnimalEvent read");
    assert.equal(res.inserted, 0);
    // a complete read with a skipped event does not flag it as missing
    assert.equal((await recs("LT000009526303")).every((r) => !r.delpro_missing_at), true);
  } finally {
    cfg.inseminationBackfillMonths = 0;
  }
});

test("incremental automatic rounds: never-read animals first, then only requests / due ones; sync-all pages every linked animal", async () => {
  await db.exec(`insert into animals (tag_no, animal_no, delpro_object_guid, source) values ('LT000009526304', '6304', '${g(501)}', 'delpro')`);
  const d = farm();
  addEvent(d, g(50), g(501), "2026-10-30T06:00:00Z");
  cfg.inseminationSource = "gateway";
  try {
    let res = await idx.runInseminations(readOnly(d));
    assert.ok(res.results.some((r) => r.orn === "LT000009526304"), "a never-read animal is picked automatically");
    assert.ok(!res.results.some((r) => r.orn === "LT000009526399"), "an animal without a DelPro ObjectGuid is never read");
    assert.equal((await recs("LT000009526304")).length, 1);
    // nothing due now
    res = await idx.runInseminations(readOnly(d));
    assert.equal(res.targets, 0);
    // a new event in DelPro + "Atnaujinti iš DelPro" for that cow -> picked next round
    addEvent(d, g(51), g(501), "2026-11-02T06:00:00Z");
    const req = await asUser(VET, `select delpro_insemination_request('{"tags":["lt 0000 0952 6304"]}'::jsonb) as r`);
    assert.equal(req.r.requested, 1);
    assert.equal((await q(`select delpro_insemination_status() as s`).catch(() => [{ s: null }]))[0].s?.pending_requests ?? 1, 1);
    res = await idx.runInseminations(readOnly(d));
    assert.deepEqual(res.results.map((r) => r.orn), ["LT000009526304"]);
    assert.equal(res.inserted, 1);
    assert.equal((await scan("LT000009526304")).requested_at, null, "request cleared by the read");
    // recent known events are inside the overlap window: their date is re-read (late corrections)
    const before = aeReads(d);
    await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526304"] });
    assert.equal(aeReads(d) - before, 2);
    // the round is recorded for GVET + heartbeat
    const round = JSON.parse((await q(`select setting_value from system_settings where setting_key = 'delpro_insemination_last_round'`))[0].setting_value);
    assert.equal(round.mode, "tags");
    // sync-all: every linked active animal, paged
    res = await ins.runInseminationSync(readOnly(d), { all: true, limit: 2 });
    assert.equal(res.targets, 6);
    assert.equal(res.failed, 0);
  } finally {
    cfg.inseminationSource = "off";
  }
  // INSEMINATION_SOURCE=off: the automatic tick does nothing
  assert.equal(await idx.runInseminations(readOnly(d)), null);
  onlyGetData(d);
});

test("a manual GVET insemination on the same Vilnius day is flagged as a possible duplicate, never merged or deleted", async () => {
  await db.exec(`insert into animals (tag_no, animal_no, delpro_object_guid, source) values ('LT000009526305', '6305', '${g(502)}', 'delpro')`);
  const animal = (await q(`select id from animals where tag_no = 'LT000009526305'`))[0].id;
  const manual = (await asUser(VET, `select create_insemination('{"animal_id":"${animal}","insemination_date":"2026-06-10","bull_name":"Rankinis"}'::jsonb) as id`)).id;
  const d = farm();
  addEvent(d, g(60), g(502), "2026-06-09T22:30:00Z"); // = 2026-06-10 01:30 in Vilnius
  const res = await ins.runInseminationSync(readOnly(d), { tags: ["LT000009526305"] });
  assert.equal(res.flagged_duplicates, 1);
  const rows = await recs("LT000009526305");
  assert.equal(rows.length, 2);
  const imported = rows.find((r) => r.source === "delpro");
  assert.equal(imported.delpro_possible_duplicate_of, manual);
  assert.equal(rows.find((r) => r.source === "gvet").bull_name, "Rankinis");
  await asUser(VET, `select delpro_insemination_dismiss_duplicate('${imported.id}')`);
  assert.equal((await recs("LT000009526305")).find((r) => r.source === "delpro").delpro_possible_duplicate_of, null);
  // manual inseminations keep working, including delete
  await asUser(VET, `delete from insemination_records where id = '${manual}'`);
});

test("preview writes nothing to GVET; commands handle zero records and unknown tags with exit codes", async () => {
  const d = farm();
  addEvent(d, g(70), COW4, "2026-10-01T06:00:00Z");
  const count = async () => (await q(`select (select count(*) from insemination_records)::int as r, (select count(*) from delpro_insemination_scans)::int as s,
    (select max(checked_at) from delpro_insemination_scans) as m`))[0];
  const before = await count();
  const res = await idx.runInseminationCommand(["node", "x", "--insemination-preview", "--tag", "LT000009526302"], readOnly(d));
  assert.deepEqual(await count(), before);
  assert.equal(res.exitCode, 0);
  assert.equal(res.results[0].events.find((e) => e.guid === g(70)).state, "new");
  assert.equal(res.results[0].events.find((e) => e.guid === g(70)).date_lt, "2026-10-01");
  // a linked cow with no inseminations at all: fine, exit 0
  await db.exec(`insert into animals (tag_no, animal_no, delpro_object_guid, source) values ('LT000009526306', '6306', '${g(503)}', 'delpro')`);
  const zero = await idx.runInseminationCommand(["node", "x", "--insemination-sync-one", "--tag", "LT000009526306"], readOnly(d));
  assert.equal(zero.exitCode, 0);
  assert.equal(zero.results[0].events.length, 0);
  assert.equal((await scan("LT000009526306")).complete, true);
  // unknown / unlinked tag -> exit 2
  assert.equal((await idx.runInseminationCommand(["node", "x", "--insemination-sync-one", "--tag", "LT000009526399"], readOnly(d))).exitCode, 2);
  await assert.rejects(idx.runInseminationCommand(["node", "x", "--insemination-sync-one"], readOnly(d)), /Nurodykite/);
  onlyGetData(d);
});

test("staff only: a viewer can't request reads; worker RPCs are service_role only; treatments and CMS settings untouched", async () => {
  await assert.rejects(asUser(VET, `select delpro_insemination_targets('{}'::jsonb)`), /permission denied/);
  await assert.rejects(asUser(VET, `select delpro_insemination_upload('{"worker_id":"x"}'::jsonb)`), /permission denied/);
  const s = (await asUser(VET, `select delpro_insemination_status() as s`)).s;
  assert.ok(s.imported >= 1);
  assert.equal(cfg.inseminationSource, "off", "INSEMINATION_SOURCE defaults to off");
  const settings = await q(`select setting_key, setting_value from system_settings where setting_key in ('delpro_write_channel', 'cms_outbound_enabled')`);
  assert.ok(settings.length >= 1);
  // a GUID upload for an animal whose ObjectGuid doesn't match is skipped
  const bad = (await q(`select delpro_insemination_upload(jsonb_build_object('worker_id', 'x', 'results', jsonb_build_array(jsonb_build_object(
    'animal_id', (select id from animals where tag_no = 'LT000009526299'), 'animal_guid', '${g(9999)}', 'ok', true, 'complete', true, 'events', '[]'::jsonb)))) as r`))[0].r;
  assert.equal(bad.mismatched, 1);
  assert.equal((await recs("LT000009526299")).every((r) => !r.delpro_missing_at), true);
});

test("0054 semen names: existing imports enriched in place with the verified SemenName; cached by Key; a failed lookup keeps the name", async () => {
  const tag = "LT000009526299";
  const d = farm();
  // the two farm events (verified catalog: 2111 = Heavenly / Karvėms, 2104 = Mcclain Sex / Telyčioms)
  addEvent(d, g(80), COW, "2026-11-02T07:15:00Z", { Semen: "2111", InseminationNumber: "3" });
  addEvent(d, g(81), COW, "2025-11-13T08:00:00Z", { Semen: "2104", InseminationNumber: "2" });
  addEvent(d, g(82), COW, "2026-11-02T16:00:00Z", { Semen: "2111", InseminationNumber: "4" });
  d.db.Semen = { 2111: { Key: "2111", SemenName: "Heavenly", Comment: "Karvėms" }, 2104: { Key: "2104", SemenName: "Mcclain Sex", Comment: "Telyčioms" } };
  // imported first without names (as 0.5.0 did on the farm)
  const saved = cfg.inseminationSemenProperties;
  cfg.inseminationSemenProperties = [];
  try {
    await ins.runInseminationSync(readOnly(d), { tags: [tag] });
  } finally {
    cfg.inseminationSemenProperties = saved;
  }
  const before = await recs(tag);
  const byGuid = (rows, gd) => rows.find((r) => r.delpro_event_guid === gd);
  assert.equal(byGuid(before, g(80)).delpro_semen_label, null);
  assert.equal(byGuid(before, g(80)).bull_name, null);
  const countBefore = before.length;
  await asUser(VET, `update insemination_records set pregnancy_confirmed = false, pazymejimo_nr = '2600010001' where delpro_event_guid = '${g(81)}'`);

  // 0.5.1 default properties: SemenName,Comment
  assert.deepEqual(cfg.inseminationSemenProperties, ["SemenName", "Comment"]);
  ins.clearSemenCache();
  const res = await ins.runInseminationSync(readOnly(d), { tags: [tag] });
  assert.equal(res.ok, 1, "ok counts the cows read successfully");
  assert.equal(res.inserted, 0);
  assert.ok(res.updated >= 3);
  const rows = await recs(tag);
  assert.equal(rows.length, countBefore, "no record duplicated");
  const a = byGuid(rows, g(80));
  const b = byGuid(rows, g(81));
  assert.equal(a.delpro_semen_label, "Heavenly");
  assert.equal(a.delpro_semen_comment, "Karvėms");
  assert.equal(a.bull_name, "Heavenly");
  assert.equal(a.delpro_semen_key, "2111");
  assert.equal(a.reproduktoriaus_id, null, "Semen.Key / SemenName are never the bull's KK number");
  assert.equal(new Date(a.insemination_date).toISOString().slice(0, 10), "2026-11-02");
  assert.equal(b.delpro_semen_label, "Mcclain Sex");
  assert.equal(b.delpro_semen_comment, "Telyčioms");
  assert.equal(new Date(b.insemination_date).toISOString().slice(0, 10), "2025-11-13");
  assert.equal(b.pregnancy_confirmed, false, "pregnancy kept");
  assert.equal(b.pazymejimo_nr, "2600010001", "certificate field kept");
  assert.equal(byGuid(rows, g(82)).delpro_semen_label, "Heavenly");
  // a bull typed in GVET earlier (2014 event) is not replaced by a catalog name
  assert.equal(byGuid(rows, EV).bull_name, "Rankinis");
  // one Semen read per key, not per insemination (2111 is used twice)
  const semenReads = (key) => d.calls.filter(([, x]) => /object name="Semen"/.test(x) && x.includes(`>${key}<`)).length;
  assert.equal(semenReads("2111"), 1);
  assert.equal(semenReads("2104"), 1);
  // the cache also spans rounds
  await ins.runInseminationSync(readOnly(d), { tags: [tag] });
  assert.equal(semenReads("2111"), 1);

  // a Semen lookup that fails keeps the stored name (same key)
  ins.clearSemenCache();
  d.setFailGetData(({ name }) => name === "Semen");
  await ins.runInseminationSync(readOnly(d), { tags: [tag] });
  d.setFailGetData(null);
  assert.equal(byGuid(await recs(tag), g(80)).delpro_semen_label, "Heavenly");
  // a GVET edit of the bull is kept on later reads; DelPro's semen fields stay import-only
  await asUser(VET, `update insemination_records set bull_name = 'Heavenly (rankinis)' where delpro_event_guid = '${g(80)}'`);
  d.db.Semen[2111].SemenName = "Heavenly ET";
  ins.clearSemenCache();
  await ins.runInseminationSync(readOnly(d), { tags: [tag] });
  const c = byGuid(await recs(tag), g(80));
  assert.equal(c.delpro_semen_label, "Heavenly ET");
  assert.equal(c.bull_name, "Heavenly (rankinis)");
  await assert.rejects(asUser(VET, `update insemination_records set delpro_semen_comment = 'x' where delpro_event_guid = '${g(80)}'`), /DelPro laukų/);
  // round summary carries the run's totals (not one chunk's)
  const round = JSON.parse((await q(`select setting_value from system_settings where setting_key = 'delpro_insemination_last_round'`))[0].setting_value);
  assert.equal(round.counts.ok, 1);
  assert.equal(round.counts.targets, 1);
  onlyGetData(d);
});

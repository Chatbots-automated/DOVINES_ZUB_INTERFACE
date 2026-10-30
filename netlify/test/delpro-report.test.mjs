// DelPro daily Excel report ingestion (0042 + netlify/functions/delpro-report-upload).
//   Part 1: the XLSX parser on its own.
//   Part 2: the upload endpoint end to end — real HTTP Request objects, the real
//           ingest RPC on PGlite (every migration), reached through a
//           PostgREST-shaped shim exactly like the Netlify function reaches Supabase.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { createTestDb } from "../../supabase/tests/helpers/db.mjs";
import { buildXlsx, serial } from "./xlsx-writer.mjs";
import { ReportError, extractReport, formatKind, parseReport, readWorkbook, reportTimeFromFilename, typeText } from "../lib/delpro-report.mjs";
import { handleUpload } from "../functions/delpro-report-upload.mjs";

const HEADERS = [
  "Oficialus reg. Nr. (ORN)",
  "Paskutiniojo sveikatos įvykio data",
  "Gyvulio tipas",
  "Gimimo data",
  "Naujausia diagnozė",
  "Naujausi vaistai ir jų dozės",
  "Pieno išpylimo laikotarpio pabaigos data",
  "Mėsos sulaikymo pabaigos data",
  "Naujausias komentaras",
];

// The three example rows from the farm's report + the "21" total row.
const day30 = (over = {}) => [
  ["LT000044547452", { date: serial(2026, 10, 30) }, "Telyčia", { date: serial(2026, 5, 20) }, "Akių ligos", "Vetrimoxin LA 3 d 1X20ml",
    { datetime: serial(2026, 11, 3, 7, 0) }, { datetime: serial(2026, 11, 14, 7, 0) }, over.comment452 ?? null],
  ["LT000044547479", { date: serial(2026, 10, 30) }, "Telyčia", { date: serial(2026, 6, 10) }, "Kvėpavimo ligos", over.med479 ?? "Flordofen 300mg/ml 1 d 1X10ml",
    null, { datetime: serial(2026, 11, 28, 7, 0) }, null],
  ["LT000008329655", "2026-10-30", "Karvė", "2020-03-08", "Nagų sužeidimai", null, null, null, "Žaizda kairėje užpakalinėje"],
  [21],
];

const report = (rows, { headers = HEADERS, title = true, sheets } = {}) =>
  buildXlsx({ sheets: sheets ?? [{ name: "Ataskaita", rows: [...(title ? [["DelPro ataskaita: Gvet"], []] : []), headers, ...rows] }] });

// --- Part 1: parser ---------------------------------------------------------------

test("parser: example report — header found below a title, footer total skipped, cells typed, ORN kept as text", () => {
  const r = extractReport(readWorkbook(report(day30())));
  assert.equal(r.sheets.length, 1);
  assert.equal(r.sheets[0].header_row, 3);
  assert.equal(r.footer_rows, 1, "the '21' total row is not an animal");
  assert.deepEqual(r.columns.map((c) => c.header), HEADERS);
  assert.equal(r.rows.length, 3);
  const first = Object.fromEntries(r.rows[0].cells.map((c) => [r.columns[c.c].header, c]));
  assert.deepEqual([first["Oficialus reg. Nr. (ORN)"].t, first["Oficialus reg. Nr. (ORN)"].v], ["text", "LT000044547452"]);
  assert.deepEqual([first["Gimimo data"].t, first["Gimimo data"].v], ["date", "2026-05-20"]);
  assert.deepEqual([first["Pieno išpylimo laikotarpio pabaigos data"].t, first["Pieno išpylimo laikotarpio pabaigos data"].v], ["timestamp_local", "2026-11-03 07:00:00"]);
  assert.equal(first["Naujausi vaistai ir jų dozės"].v, "Vetrimoxin LA 3 d 1X20ml", "medicine text is kept verbatim");
  assert.equal(first["Naujausias komentaras"].t, "empty", "an empty cell of a present column is listed as empty");
  const third = Object.fromEntries(r.rows[2].cells.map((c) => [r.columns[c.c].header, c]));
  assert.deepEqual([third["Gimimo data"].t, third["Gimimo data"].v, third["Gimimo data"].raw], ["date", "2020-03-08", "2020-03-08"], "text dates too");
  assert.equal(third["Naujausias komentaras"].v, "Žaizda kairėje užpakalinėje", "Lithuanian characters intact");
});

test("parser: several sheets, shifted header, reordered + unknown columns, inline strings, numbers, 1904 dates", () => {
  const buf = buildXlsx({
    date1904: true,
    sheets: [
      { name: "Info", rows: [["Sugeneruota DelPro"], ["Ūkis", "Dovinės"]] },
      {
        name: "Duomenys",
        rows: [[], [], [], [], ["Pieno kiekis, kg", "Naujausia diagnozė", "Oficialus reg. Nr. (ORN)", "Gimimo data"],
          [24.5, { inline: "Mastitas" }, { inline: "LT000000000001" }, { date: serial(2020, 1, 1) - 1462 }]],
      },
    ],
  });
  const r = extractReport(readWorkbook(buf));
  assert.deepEqual(r.sheets.map((s) => [s.name, s.header_row, s.rows]), [["Duomenys", 5, 1]]);
  const cells = Object.fromEntries(r.rows[0].cells.map((c) => [r.columns[c.c].header, c]));
  assert.deepEqual([cells["Pieno kiekis, kg"].t, cells["Pieno kiekis, kg"].v], ["number", 24.5]);
  assert.equal(cells["Oficialus reg. Nr. (ORN)"].v, "LT000000000001");
  assert.equal(cells["Gimimo data"].v, "2020-01-01", "1904 date system honoured");
});

test("parser: text date formats, explicit offsets, number formats, file-name time", () => {
  assert.deepEqual(typeText("2026-11-03 07:00"), { t: "timestamp_local", v: "2026-11-03 07:00:00", raw: "2026-11-03 07:00" });
  assert.deepEqual(typeText("30.10.2026"), { t: "date", v: "2026-10-30", raw: "30.10.2026" });
  assert.deepEqual(typeText("2026.10.30"), { t: "date", v: "2026-10-30", raw: "2026.10.30" });
  assert.equal(typeText("2026-11-03T07:00:00Z").t, "timestamp");
  assert.equal(typeText("2026-02-30").t, "text", "impossible dates stay text");
  assert.equal(typeText("   ").t, "empty");
  assert.equal(formatKind(14, null), "date");
  assert.equal(formatKind(164, "yyyy\\-mm\\-dd\\ hh:mm"), "datetime");
  assert.equal(formatKind(165, "0.00"), null);
  assert.equal(formatKind(166, '[$-427]yyyy" m. "mmmm d" d."'), "date");
  assert.equal(reportTimeFromFilename("Gvet_20261030 121001.xlsx"), "2026-10-30 12:10:01");
  assert.equal(reportTimeFromFilename("Gvet_20261029 121000.xlsx"), "2026-10-29 12:10:00");
  assert.equal(reportTimeFromFilename("ataskaita.xlsx"), null);
});

test("parser: not an XLSX / no ORN column -> a typed error, never a partial result", () => {
  assert.throws(() => readWorkbook(Buffer.from("definitely not a spreadsheet, just text bytes")), (e) => e instanceof ReportError && e.code === "invalid_xlsx");
  const noOrn = buildXlsx({ sheets: [{ name: "A", rows: [["Gyvulio tipas", "Gimimo data"], ["Karvė", "2020-01-01"]] }] });
  assert.throws(() => parseReport(noOrn, { filename: "x.xlsx" }), (e) => e.code === "no_orn_column");
});

// --- Part 2: endpoint + database ---------------------------------------------------

let db;
let server;
let env;
let token;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

before(async () => {
  db = await createTestDb();
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const fn = req.url.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1];
    try {
      assert.equal(req.headers.authorization, "Bearer test-service-key");
      await db.exec("set role service_role");
      const r = await db.query(`select ${fn}($1::jsonb) as r`, [body || "{}"]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.rows[0].r));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: err.code ?? "P0001", message: err.message }));
    } finally {
      await db.exec("reset role").catch(() => {});
    }
  });
  await new Promise((r) => server.listen(0, r));
  env = { url: `http://127.0.0.1:${server.address().port}`, key: "test-service-key" };

  await db.exec(`
    insert into auth.users values ('00000000-0000-0000-0000-0000000000aa', 'admin@x'), ('00000000-0000-0000-0000-0000000000bb', 'vet@x');
    insert into users (id, email, role) values ('00000000-0000-0000-0000-0000000000aa', 'admin@x', 'admin'), ('00000000-0000-0000-0000-0000000000bb', 'vet@x', 'vet');
    -- GVET herd before any report: a DelPro cow (Number 337), a heifer with a different birth date,
    -- and an animal whose DelPro short Number equals the digits of a report ORN (must NOT match)
    insert into animals (tag_no, animal_no, sex, birth_date, source, delpro_animal_id) values
      ('LT000008329655', '337', 'Karvė', '2020-03-08', 'delpro', 'dp-337'),
      ('LT000044547479', '512', null, '2025-01-01', 'delpro', 'dp-512'),
      ('LT000099999999', '44547452', 'Karvė', '2019-01-01', 'delpro', 'dp-900');
  `);
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000aa', false);`);
  token = (await db.query(`select delpro_report_create_token('DAU-DOV-KDV-002')->>'token' as t`)).rows[0].t;
  await db.exec("reset role");
});

after(() => server?.close());

function upload(buf, { filename = "Gvet_20261030 121001.xlsx", auth = `Bearer ${token}`, hash = sha(buf), type = "daily-health",
  contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } = {}) {
  const headers = { "Content-Type": contentType, "X-GVET-Report-Filename": filename, "X-GVET-Report-SHA256": hash, "X-GVET-Report-Type": type };
  if (auth) headers.Authorization = auth;
  return handleUpload(new Request("https://gvet.example/.netlify/functions/delpro-report-upload", { method: "POST", headers, body: buf }), env)
    .then(async (res) => ({ status: res.status, body: await res.json() }));
}
const q = async (sql, params) => (await db.query(sql, params)).rows;
const state = async (orn) => (await q(`select s.* from delpro_report_animal_state s join animals a on a.id = s.animal_id where a.tag_no = $1`, [orn]))[0];
const clinicalCounts = () => q(`select (select count(*) from treatments)::int t, (select count(*) from usage_items)::int u,
  (select count(*) from delpro_sync_jobs)::int j, (select count(*) from delpro_catalog_jobs)::int c, (select count(*) from course_doses)::int d`);

test("endpoint: auth, headers, hash and file checks — nothing imported on any refusal", async () => {
  const buf = report(day30());
  assert.equal((await upload(buf, { auth: null })).status, 401);
  assert.equal((await upload(buf, { auth: "Bearer gvr_wrongwrongwrongwrongwrongwrong" })).status, 401);
  // a token of ANOTHER farm (overlapping ORNs there must never land here)
  const other = "gvr_otherfarmtoken000000000000000000000000";
  await db.exec(`insert into delpro_report_upload_tokens (farm_id, label, token_hash, token_hint) values (gen_random_uuid(), 'kitas ūkis', '${sha(other)}', 'xxxx')`);
  assert.deepEqual(await upload(buf, { auth: `Bearer ${other}` }).then((r) => [r.status, r.body.error]), [403, "forbidden"]);
  assert.equal((await upload(buf, { contentType: "text/csv" })).status, 415);
  assert.equal((await upload(buf, { filename: "../../etc/passwd" })).status, 400);
  assert.equal((await upload(buf, { type: "weekly-milk" })).status, 400);
  assert.deepEqual(await upload(buf, { hash: sha(Buffer.from("other")) }).then((r) => [r.status, r.body.error]), [400, "sha256_mismatch"]);
  const garbage = Buffer.from("PK\u0003\u0004 this is not really a zip");
  assert.deepEqual(await upload(garbage).then((r) => [r.status, r.body.status, r.body.error]), [422, "error", "invalid_xlsx"]);
  assert.equal((await q("select count(*)::int n from delpro_report_imports"))[0].n, 0);
  assert.ok((await q("select stage from delpro_report_failures")).some((f) => f.stage === "parse"), "failures after authentication are logged for the admin screen");
});

test("endpoint: daily report -> exact response, matched by ORN (never by DelPro Number), provisional animal, conflict review", async () => {
  const before = await clinicalCounts();
  const r = await upload(report(day30()));
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body), ["status", "import_id", "rows_received", "matched", "created", "updated", "conflicts"]);
  assert.deepEqual({ ...r.body, import_id: undefined }, { status: "processed", import_id: undefined, rows_received: 3, matched: 2, created: 1, updated: 2, conflicts: 1 });

  const created = (await q(`select tag_no, source, sex, birth_date::text b, active from animals where tag_no = 'LT000044547452'`))[0];
  assert.deepEqual(created, { tag_no: "LT000044547452", source: "delpro_report", sex: "Telyčia", b: "2026-05-20", active: true });
  assert.equal((await q(`select count(*)::int n from animals where animal_no = '44547452'`))[0].n, 1, "the DelPro Number 44547452 animal is untouched and unmatched");

  // the heifer: GVET birth date kept, conflict reviewed, the empty sex filled from the report
  const heifer = (await q(`select birth_date::text b, sex from animals where tag_no = 'LT000044547479'`))[0];
  assert.deepEqual(heifer, { b: "2025-01-01", sex: "Telyčia" });
  const review = (await q(`select kind, details from delpro_report_reviews where orn = 'LT000044547479'`))[0];
  assert.deepEqual([review.kind, review.details], ["birth_date_conflict", { gvet: "2025-01-01", report: "2026-06-10" }]);
  // the cow: GVET's category stays
  assert.equal((await q(`select sex from animals where tag_no = 'LT000008329655'`))[0].sex, "Karvė");

  const s = await state("LT000044547452");
  assert.equal(s.fields.latest_diagnosis.value, "Akių ligos");
  assert.equal(s.fields.latest_medicines.value, "Vetrimoxin LA 3 d 1X20ml");
  assert.equal(s.fields.milk_withdrawal_until.local, "2026-11-03 07:00:00");
  assert.equal(new Date(s.fields.milk_withdrawal_until.value).toISOString(), "2026-11-03T05:00:00.000Z", "07:00 Vilnius (EET, UTC+2)");
  assert.equal(s.fields.latest_comment.type, "empty");
  assert.equal(new Date(s.latest_report_at).toISOString(), "2026-10-30T10:10:01.000Z", "12:10:01 Vilnius from the file name");

  const imp = (await q(`select filename, rows_received, footer_rows, columns from delpro_report_imports where id = $1`, [r.body.import_id]))[0];
  assert.equal(imp.footer_rows, 1);
  assert.deepEqual(imp.columns.map((c) => c.key), ["orn", "health_event_date", "animal_type", "birth_date", "latest_diagnosis", "latest_medicines",
    "milk_withdrawal_until", "meat_withdrawal_until", "latest_comment"]);
  assert.deepEqual(await clinicalCounts(), before, "observational: no treatments, stock use, DelPro or catalog jobs");
});

test("endpoint: the same file again -> duplicate, nothing new", async () => {
  const buf = report(day30());
  const first = (await q(`select id from delpro_report_imports where filename = 'Gvet_20261030 121001.xlsx'`))[0].id;
  const counts = await q(`select (select count(*) from delpro_report_rows)::int r, (select count(*) from animals)::int a`);
  const r = await upload(buf);
  assert.deepEqual([r.status, r.body], [200, { status: "duplicate", import_id: first }]);
  assert.deepEqual(await q(`select (select count(*) from delpro_report_rows)::int r, (select count(*) from animals)::int a`), counts);
});

test("endpoint: an older report arriving late goes to history only", async () => {
  const older = report([["LT000044547452", "2026-10-29", "Telyčia", "2026-05-20", "Senesnė diagnozė", "Senas vaistas", null, null, "senas"]]);
  const r = await upload(older, { filename: "Gvet_20261029 121000.xlsx" });
  assert.equal(r.status, 201);
  assert.equal(r.body.updated, 0);
  const s = await state("LT000044547452");
  assert.equal(s.fields.latest_diagnosis.value, "Akių ligos", "the newer value stays current");
  assert.equal(s.fields.latest_comment.type, "empty", "newer explicit empty is not overwritten by the older comment");
  const history = await q(`select r.outcome, r.fields->'latest_diagnosis'->>'value' d from delpro_report_rows r where r.orn = 'LT000044547452' order by r.report_at`);
  assert.deepEqual(history, [{ outcome: "stale", d: "Senesnė diagnozė" }, { outcome: "created", d: "Akių ligos" }]);
});

test("endpoint: next day's report with renamed, reordered, new and missing columns; empty cell clears; absent animal untouched", async () => {
  // "Paskutinio" instead of "Paskutiniojo", columns reordered, comment column gone, a new milk column
  const headers = ["Pieno kiekis, kg", "Naujausia diagnozė", "Oficialus reg. Nr. (ORN)", "Paskutinio sveikatos įvykio data", "Gyvulio tipas", "Gimimo data",
    "Naujausi vaistai ir jų dozės", "Pieno išpylimo laikotarpio pabaigos data", "Mėsos sulaikymo pabaigos data"];
  const rows = [[18.2, "Akių ligos", "LT000044547452", "2026-10-31", "Telyčia", "2026-05-20", "Vetrimoxin LA 3 d 1X20ml", null, "2026-11-14 07:00"]];
  const r = await upload(report(rows, { headers }), { filename: "Gvet_20261031 121003.xlsx" });
  assert.equal(r.status, 201);

  const s = await state("LT000044547452");
  assert.deepEqual([s.fields.milk_withdrawal_until.type, s.fields.milk_withdrawal_until.value], ["empty", null], "explicit empty clears the deadline");
  assert.equal(s.fields.health_event_date.value, "2026-10-31", "renamed header mapped by alias");
  assert.equal(s.fields.x_pieno_kiekis_kg.value, 18.2, "a new column is stored without a migration");
  assert.equal(new Date(s.latest_report_at).toISOString(), "2026-10-31T10:10:03.000Z");
  assert.ok(new Date(s.fields.latest_comment.report_at) < new Date(s.latest_report_at), "a missing column's value stays, marked historical by its older report time");

  const field = (await q(`select key, label, data_type, known, visible from delpro_report_fields where key = 'x_pieno_kiekis_kg'`))[0];
  assert.deepEqual(field, { key: "x_pieno_kiekis_kg", label: "Pieno kiekis, kg", data_type: "number", known: false, visible: true });
  assert.ok((await q(`select headers_seen from delpro_report_fields where key = 'health_event_date'`))[0].headers_seen.includes("Paskutinio sveikatos įvykio data"));

  const cow = await state("LT000008329655");
  assert.equal(new Date(cow.latest_report_at).toISOString(), "2026-10-30T10:10:01.000Z", "absent from the new report: kept as it was");
  assert.equal((await q(`select active from animals where tag_no = 'LT000008329655'`))[0].active, true, "a partial report never deactivates");
});

test("endpoint: same file name regenerated with different content -> a new version that supersedes", async () => {
  const headers = ["Oficialus reg. Nr. (ORN)", "Naujausi vaistai ir jų dozės"];
  const r = await upload(report([["LT000044547452", "Pataisytas vaistas 1X5ml"]], { headers }), { filename: "Gvet_20261031 121003.xlsx" });
  assert.equal(r.status, 201);
  const imp = (await q(`select supersedes_import_id is not null s from delpro_report_imports where id = $1`, [r.body.import_id]))[0];
  assert.equal(imp.s, true);
  assert.equal((await state("LT000044547452")).fields.latest_medicines.value, "Pataisytas vaistas 1X5ml");
});

test("endpoint: duplicate ORN rows, invalid ORN, ambiguous GVET animals -> reviews, never guessed", async () => {
  await db.exec(`insert into animals (tag_no, source) values ('LT 0000 1111 2222', 'manual'), ('lt000011112222', 'manual')`);
  const rows = [
    ["LT000077777777", "2026-11-01", "Karvė", null, "Mastitas", "A", null, null, null],
    ["LT000077777777", "2026-11-01", "Karvė", null, "Mastitas", "A", null, null, null], // identical copy
    ["LT000088888888", "2026-11-01", "Karvė", null, "Mastitas", "A", null, null, null],
    ["LT000088888888", "2026-11-01", "Karvė", null, "Endometritas", "B", null, null, null], // conflicting copy
    ["12345", "2026-11-01", "Karvė", null, "Mastitas", "A", null, null, null], // not an ORN
    ["LT000011112222", "2026-11-01", "Karvė", null, "Mastitas", "A", null, null, null], // two GVET animals
  ];
  const r = await upload(report(rows), { filename: "Gvet_20261101 121000.xlsx" });
  assert.equal(r.status, 201);
  assert.equal(r.body.created, 1, "only the identical-copy animal is created");
  assert.equal(r.body.conflicts, 3);
  assert.deepEqual((await q(`select kind from delpro_report_reviews where import_id = $1 order by kind`, [r.body.import_id])).map((x) => x.kind),
    ["ambiguous_animal", "duplicate_orn_row", "invalid_orn"]);
  assert.equal((await q(`select count(*)::int n from animals where tag_no = 'LT000088888888'`))[0].n, 0, "conflicting copies are not applied");
  assert.deepEqual((await q(`select outcome from delpro_report_rows where orn = 'LT000077777777' order by row_number`)).map((x) => x.outcome), ["created", "duplicate"]);
});

test("database: only the service role ingests; only admins manage tokens; signed-in users read", async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000bb', false);`);
  try {
    await assert.rejects(db.query(`select delpro_report_ingest('{}'::jsonb)`), /permission denied/);
    await assert.rejects(db.query(`select delpro_report_create_token('x')`), /administratorius/);
    await assert.rejects(db.query(`insert into delpro_report_fields (key, label) values ('x', 'x')`), /permission denied|row-level security/);
    assert.ok((await db.query(`select count(*)::int n from delpro_report_animal_state`)).rows[0].n > 0, "vets see report data");
    assert.equal((await db.query(`select count(*)::int n from delpro_report_upload_tokens`)).rows[0].n, 0, "tokens are admin-only");
  } finally {
    await db.exec("reset role");
  }
  assert.equal((await q(`select count(*)::int n from delpro_report_upload_tokens where token_hash = $1`, [sha(token)]))[0].n, 1, "only the hash is stored");
  assert.equal((await q(`select count(*)::int n from delpro_report_upload_tokens where token_hash like 'gvr_%'`))[0].n, 0);
});

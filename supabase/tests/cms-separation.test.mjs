// CMS atskyrimai draft editor logic (src/lib/cms/separation.ts): common settings, overrides, copying, validation.
//
//   npm run test:cms
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const text = fs.readFileSync(path.join(root, "src/lib/cms/separation.ts"), "utf8");
const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const row = (id, extra = {}) => ({
  animal_id: id, tag_no: `LT${id}`, animal_no: null, animal_name: null, group_name: null, delpro_object_guid: `g-${id}`,
  live_action_key: null, open_job_status: null, settings: m.emptySettings(), source: "common", existing_decision: null, ...extra,
});
const ids = (n) => Array.from({ length: n }, (_, i) => `a${i + 1}`);
const T1 = { mode: "period", start_local: "2026-11-03T08:00", end_local: "2026-11-05T08:00", sessions: [1, 2], sort_area_key: "", note: "" };
const T2 = { ...T1, start_local: "2026-11-04T06:00", sessions: [3] };

test("nothing is pre-selected: no dates, no sessions", () => {
  const s = m.emptySettings();
  assert.deepEqual(s.sessions, []);
  assert.equal(s.start_local, "");
  assert.ok(m.settingsProblems(s).length >= 3);
});

test("20 animals: apply to all, then 5 marked get other settings, then one animal is edited — all kept", () => {
  let rows = ids(20).map((id) => row(id));
  rows = m.applyTemplate(rows, ids(20), T1);
  assert.ok(rows.every((r) => m.sameSettings(r.settings, T1) && r.source === "common"));
  const five = ids(5);
  rows = m.applyTemplate(rows, five, T2);
  assert.equal(rows.filter((r) => m.sameSettings(r.settings, T2)).length, 5);
  assert.equal(rows.filter((r) => m.sameSettings(r.settings, T1)).length, 15);
  rows = m.updateRow(rows, "a3", { start_local: "2026-11-04T07:30", sessions: [3, 4] });
  const a3 = rows.find((r) => r.animal_id === "a3");
  assert.equal(a3.source, "override");
  assert.deepEqual(a3.settings.sessions, [3, 4]);
  // applying T1 to all again would replace exactly one individual configuration — the caller must confirm it
  assert.equal(m.overridesAffected(rows, ids(20), T1), 1);
  assert.equal(m.overridesAffected(rows, ids(20).filter((x) => x !== "a3"), T1), 0);
});

test("copy from one animal to the marked subset (not to the others, not to itself)", () => {
  let rows = m.applyTemplate(ids(6).map((id) => row(id)), ids(6), T1);
  rows = m.updateRow(rows, "a1", { sessions: [5] });
  rows = m.copySettings(rows, "a1", ["a1", "a2", "a4"]);
  assert.deepEqual(rows.filter((r) => r.settings.sessions.join() === "5").map((r) => r.animal_id), ["a1", "a2", "a4"]);
  assert.equal(rows.find((r) => r.animal_id === "a2").source, "override");
  assert.equal(rows.find((r) => r.animal_id === "a3").source, "common");
  // the copy is independent
  rows = m.updateRow(rows, "a2", { sessions: [6] });
  assert.deepEqual(rows.find((r) => r.animal_id === "a4").settings.sessions, [5]);
});

test("copy settings to all", () => {
  let rows = ids(4).map((id) => row(id));
  rows = m.updateRow(rows, "a2", T2);
  rows = m.copySettings(rows, "a2", ids(4));
  assert.ok(rows.every((r) => m.sameSettings(r.settings, T2)));
});

test("validation: missing dates, end before start, invalid sessions, once, destination, ongoing with end", () => {
  assert.deepEqual(m.settingsProblems(T1, "2026-11-01T00:00"), []);
  assert.match(m.settingsProblems({ ...T1, end_local: "" }).join(), /pabaiga/);
  assert.match(m.settingsProblems({ ...T1, start_local: "" }).join(), /pradžia/);
  assert.match(m.settingsProblems({ ...T1, end_local: "2026-11-03T07:00" }).join(), /vėliau/);
  assert.match(m.settingsProblems({ ...T1, sessions: [11] }).join(), /1–10/);
  assert.match(m.settingsProblems({ ...T1, sessions: [] }).join(), /sesija/);
  assert.match(m.settingsProblems({ ...T1, mode: "once" }).join(), /Vienkartinis/);
  assert.match(m.settingsProblems({ ...T1, sort_area_key: "1" }).join(), /rūšiavimo vietos/);
  assert.match(m.settingsProblems({ ...T1, mode: "ongoing" }).join(), /neturi pabaigos/);
  assert.match(m.settingsProblems(T1, "2026-11-06T00:00").join(), /praėjo/);
});

test("row problems: missing DelPro mapping, open job, existing SortCow needs a decision; skip excludes it", () => {
  assert.match(m.rowProblems(row("x", { delpro_object_guid: null, settings: T1 })).join(), /ObjectGuid/);
  assert.match(m.rowProblems(row("x", { open_job_status: "approved", settings: T1 })).join(), /neužbaigtas/);
  assert.match(m.rowProblems(row("x", { live_action_key: "11981", settings: T1 })).join(), /aktyvų/);
  assert.deepEqual(m.rowProblems(row("x", { live_action_key: "11981", existing_decision: "skip", settings: m.emptySettings() })), []);
});

test("schedule text, duration helper and items", () => {
  assert.equal(m.describeSchedule(T1), "2026-11-03 08:00 → 2026-11-05 08:00; sesijos 1, 2");
  assert.equal(m.describeSchedule({ ...T1, mode: "ongoing", end_local: "" }), "Nuo 2026-11-03 08:00 be pabaigos; sesijos 1, 2");
  assert.equal(m.addDaysLocal("2026-03-28T08:00", 2), "2026-03-30T08:00"); // across the DST change: wall clock kept
  assert.equal(m.addDaysLocal("2026-12-31T23:30", 1), "2027-01-01T23:30");
  const [it] = m.toItems([row("a1", { settings: { ...T1, mode: "ongoing" }, source: "override" })]);
  assert.equal(it.end_local, "");
  assert.equal(it.is_override, true);
  assert.equal(m.vilniusNowLocal(new Date("2026-07-01T10:00:00Z")), "2026-07-01T13:00");
  assert.equal(m.vilniusNowLocal(new Date("2026-12-01T10:00:00Z")), "2026-12-01T12:00");
});

const actText = fs.readFileSync(path.join(root, "src/lib/cms/activation.ts"), "utf8");
const act = await import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(actText, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64"));

test("activation: 'fully active' only when every operational check passes; the historical full scan is not one (0051)", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const good = {
    verified_modes: ["period"], worker_cms_mode: "gateway",
    worker_seen_at: "2026-11-03 11:59:00+00", outbound_enabled: true, destination_verified: { note: "Patalpa 1", by_name: "Admin" },
    worker: { has_cms: true, started_by: "task", gateway_ok_at: "2026-11-03T11:55:00Z", version: "0.4.0" },
  };
  const checks = act.activationChecks(good, now);
  assert.equal(act.fullyActive(checks), true);
  assert.deepEqual(checks.map((c) => c.id), ["worker", "gateway", "gvet", "local", "gvet_switch", "mode", "destination"]);
  // a broken / incomplete / never-run full DelPro scan changes nothing
  for (const live of [null, { finished_at: "2026-11-01T00:00:00Z", complete: false }]) {
    assert.equal(act.fullyActive(act.activationChecks({ ...good, live_last_refresh: live }, now)), true);
  }
  for (const [k, v] of [["outbound_enabled", false], ["destination_verified", null], ["worker_cms_mode", "off"], ["verified_modes", []],
    ["worker_seen_at", "2026-11-03 10:00:00+00"]]) {
    assert.equal(act.fullyActive(act.activationChecks({ ...good, [k]: v }, now)), false, k);
  }
  assert.equal(act.fullyActive(act.activationChecks({ ...good, worker: { ...good.worker, started_by: "manual" } }, now)), false);
  assert.equal(act.fullyActive(act.activationChecks({ ...good, worker: { ...good.worker, has_cms: false } }, now)), false);
  assert.equal(act.fullyActive(act.activationChecks({ ...good, worker: { ...good.worker, gateway_ok_at: "2026-11-03T10:00:00Z" } }, now)), false, "gateway");
  assert.equal(act.fullyActive(act.activationChecks(null, now)), false);
  assert.match(act.PER_JOB_CHECK_NOTE, /kiekvieną/);
});

const liveText = fs.readFileSync(path.join(root, "src/lib/cms/live-status.ts"), "utf8");
const live = await import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(liveText, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64"));

test("live status (0051): same rule as the worker — Active, dates and sessions; unreadable = unknown", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const a = (x) => live.cmsActionStatus({ active: true, start_at: "2026-11-01T00:00:00Z", end_at: null, sessions: [1], ...x }, now);
  assert.equal(a({}), "effective");
  assert.equal(a({ start_at: "2026-11-04T00:00:00Z" }), "scheduled");
  assert.equal(a({ end_at: "2026-11-02T00:00:00Z" }), "ended");
  assert.equal(a({ active: false }), "inactive");
  assert.equal(a({ sessions: [] }), "no_sessions");
  assert.equal(a({ active: null }), "unknown");
  assert.equal(a({ end_at: "rytoj" }), "unknown");
  // the worker's rule (delpro-worker/src/cms-separation.js actionStatus) must give the same answers
  const worker = fs.readFileSync(path.join(root, "delpro-worker/src/cms-separation.js"), "utf8");
  for (const s of ["effective", "scheduled", "no_sessions", "ended", "inactive", "unknown"]) assert.match(worker, new RegExp(`return "${s}"`));
});

test("live freshness (0051): pending request, never read, failed read, stale vs fresh", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  assert.equal(live.cmsFreshness(null, now), "never");
  assert.equal(live.cmsFreshness({ checked_at: "2026-11-03T11:30:00Z", ok: true, requested_at: null }, now), "fresh");
  assert.equal(live.cmsFreshness({ checked_at: "2026-11-03T08:00:00Z", ok: true, requested_at: null }, now), "stale");
  assert.equal(live.cmsFreshness({ checked_at: "2026-11-03T11:30:00Z", ok: false, requested_at: null }, now), "failed");
  assert.equal(live.cmsFreshness({ checked_at: "2026-11-03T11:30:00Z", ok: true, requested_at: "2026-11-03T11:45:00Z" }, now), "pending");
});

// Guards for the DelPro treatment-confirmation UI that need no browser:
//   * the status vocabulary keeps "approved/queued" distinct from "completed"
//   * the service-role key / admin client can never reach client code
//   * nothing in the UI claims a transfer is finished before the worker verified it
//
//   npm run test:guards
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = path.join(root, "src");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}
const files = walk(src).map((p) => ({ p: path.relative(root, p), text: fs.readFileSync(p, "utf8") }));

async function loadStatusModule() {
  const text = fs.readFileSync(path.join(src, "lib/delpro-status.ts"), "utf8");
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

test("status labels: queued is never shown as transferred", async () => {
  const m = await loadStatusModule();
  assert.equal(m.delproStatusLabel(null), "Laukia siuntimo");
  assert.equal(m.delproStatusLabel("pending_approval"), "Laukia siuntimo");
  assert.equal(m.delproStatusLabel("approved"), "Laukia perdavimo");
  assert.equal(m.delproStatusLabel("processing"), "Perduodama į DelPro");
  assert.equal(m.delproStatusLabel("success"), "Perduota į DelPro");
  assert.equal(m.delproStatusLabel("error"), "Perdavimo klaida");
  assert.equal(m.delproStatusLabel("verification_failed"), "Nepavyko patvirtinti įrašo");
  const labels = Object.values(m.DELPRO_STATUS_LABEL);
  assert.equal(new Set(labels).size, labels.length, "every status has its own label");
  // only a verified success may look successful
  for (const [status, tone] of Object.entries(m.DELPRO_STATUS_TONE)) {
    if (status !== "success") assert.notEqual(tone, "success", `${status} must not use the success tone`);
  }
  assert.deepEqual([...m.DELPRO_CONFIRMABLE], [null, "pending_approval"]);
});

test("service-role key never reaches client code", () => {
  for (const f of files) {
    const isClient = /^\s*["']use client["']/m.test(f.text.split("\n").slice(0, 3).join("\n"));
    if (isClient) {
      assert.ok(!/supabase\/admin|SERVICE_ROLE|createAdminClient/.test(f.text), `${f.p}: client component touches the admin client`);
    }
    assert.ok(!/NEXT_PUBLIC_[A-Z_]*SERVICE/.test(f.text), `${f.p}: service key exposed through NEXT_PUBLIC_`);
  }
  const admin = files.find((f) => f.p === "src/lib/supabase/admin.ts");
  assert.ok(admin && /import "server-only"/.test(admin.text), "admin client must stay server-only");
  // the DelPro actions use the user's own session, not the service role
  const actions = files.find((f) => f.p === "src/lib/actions/delpro.ts");
  assert.ok(actions && !/createAdminClient|SERVICE_ROLE/.test(actions.text), "DelPro actions must run as the logged-in user");
});

test("confirmation sends only the treatment id and never claims completion", () => {
  const actions = files.find((f) => f.p === "src/lib/actions/delpro.ts").text;
  const confirm = actions.slice(actions.indexOf("export async function confirmDelproTransfer"), actions.indexOf("export async function rejectDelproJob"));
  assert.match(confirm, /delpro_approve_treatment/);
  assert.ok(!/payload/i.test(confirm), "confirm action must not accept or forward a payload from the client");
  for (const f of files) {
    assert.ok(!/sėkmingai įrašyt\w* į DelPro/i.test(f.text), `${f.p}: claims a successful DelPro write`);
  }
  const migration = fs.readFileSync(path.join(root, "supabase/migrations/0033_delpro_treatment_confirmation.sql"), "utf8");
  assert.ok(migration.includes("Įrašas laukia perdavimo į DelPro"));
  assert.ok(!/sėkmingai įrašyt/i.test(migration));
});

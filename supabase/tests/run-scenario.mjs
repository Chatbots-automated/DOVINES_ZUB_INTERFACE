// End-to-end database scenario: DelPro herd sync, FEFO stock, treatments +
// courses + karencija, DelPro approve/claim/report, group vaccination,
// biocides, nurašymo aktas lifecycle, RLS. Rows tagged with a `step` column
// are printed; any SQL error (including a failed negative assertion) fails
// the run with exit code 1.
//
//   npm run test:db
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb, splitStatements } from "./helpers/db.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const db = await createTestDb();
console.log("migrations: OK");

for (const stmt of splitStatements(fs.readFileSync(path.join(here, "scenario.sql"), "utf8"))) {
  try {
    const results = await db.exec(stmt);
    for (const r of results) {
      if (r.fields.some((f) => f.name === "step")) for (const row of r.rows) console.log(JSON.stringify(row));
    }
  } catch (err) {
    console.error("FAIL:", err.message, "\n  in:", stmt.trim().slice(0, 400));
    process.exit(1);
  }
}
console.log("scenario: OK");

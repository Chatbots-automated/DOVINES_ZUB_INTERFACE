# DelPro worker (Dovinės ŽŪB)

Small Node.js process that runs on the farm PC next to DelPro (Priedas Nr. 1 §3-§4):

- **DelPro → GVET PRO**: every `INBOUND_INTERVAL_MIN` reads the herd + groups from DelPro's SQL Server (read-only) and
  posts a full snapshot to `upsert_animals_from_delpro`.
- **GVET PRO → DelPro**: every `OUTBOUND_INTERVAL_SEC` claims approved treatments (`delpro_claim_next_job`), writes each
  into DelPro, reads it back and reports (`delpro_report_job_result`). A read-back that doesn't match what was approved
  is reported as *verification_failed*.
- Heartbeat on every tick → the admin screen shows "Veikia / Neatsako".

Only outbound HTTPS to Supabase — no ports opened on the farm PC.

## Install (farm PC)

1. Install Node.js 20 LTS or newer.
2. Copy this folder to e.g. `C:\gvet\delpro-worker`, then `npm install --omit=dev`.
3. `copy .env.example .env` and fill it in (service-role key from the Supabase dashboard; SQL Server login).
   Create **two** SQL logins in DelPro's SQL Server: one with `db_datareader` only (inbound + discovery), and — only once
   the write path is agreed — one allowed to write the treatment table(s).
4. Discovery: `npm run discover` lists candidate tables/columns; `npm run discover -- <Table>` shows sample rows.
   Fill in `queries/animals.sql` and `queries/groups.sql` (column aliases are documented in each file) and remove the
   `TODO(discovery)` line.
5. Test once: `npm run once` (with `OUTBOUND_MODE=dry-run`) — animals should appear in GVET PRO → Gyvūnai.
6. Run permanently as a Windows service, e.g. with NSSM:
   ```
   nssm install GVET-DelPro "C:\Program Files\nodejs\node.exe" "C:\gvet\delpro-worker\src\index.js"
   nssm set GVET-DelPro AppDirectory C:\gvet\delpro-worker
   nssm set GVET-DelPro AppStdout C:\gvet\delpro-worker\logs\worker.log
   nssm set GVET-DelPro AppStderr C:\gvet\delpro-worker\logs\worker.log
   nssm start GVET-DelPro
   ```

## Treatment write-back

Preferred order (see ../AGENTS.md): DelPro's own import function → UI automation → direct SQL. The shipped
`sql` mode runs `queries/insert-treatment.sql` + `queries/readback-treatment.sql`; it stays disabled while those files
are placeholders, and must only be enabled with the farm's written agreement. Until then keep `OUTBOUND_MODE=dry-run`.

## Tests

From the repo root: `npm run test:worker` — runs the worker against a PostgREST stand-in over PGlite with every
migration applied (`DELPRO_SOURCE=json`, fixture in `test/fixtures/herd.json`).

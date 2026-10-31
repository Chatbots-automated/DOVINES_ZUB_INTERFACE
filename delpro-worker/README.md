# DelPro worker (Dovinės ŽŪB)

Small Node.js process that runs on the farm PC next to DelPro (Priedas Nr. 1 §3-§4):

- **DelPro → GVET PRO**: every `INBOUND_INTERVAL_MIN` reads the herd + groups from DelPro's SQL Server (read-only) and
  posts a full snapshot to `upsert_animals_from_delpro`.
- **GVET PRO → DelPro**: every `OUTBOUND_INTERVAL_SEC` claims approved treatments (`delpro_claim_next_job`), writes each
  into DelPro, reads it back and reports (`delpro_report_job_result`). A read-back that doesn't match what was approved
  is reported as *verification_failed*.
- **DelPro catalog → GVET PRO** (`CATALOG_SOURCE=gateway`): every `CATALOG_INTERVAL_MIN`, or within a minute of an admin
  pressing *Sinchronizuoti dabar*, reads Drug, DrugParameters, Diagnosis, Treatment, TreatmentDrugUsage and Animal ObjectGuids
  through the local **Gateway SOAP service** (`GetData` only) and uploads them in batches (`delpro_catalog_*`). Nothing is
  written to DelPro.
- Heartbeat on every tick → the admin screen shows "Veikia / Neatsako".

Only outbound HTTPS to Supabase — no ports opened on the farm PC.

## Install (farm PC)

1. Install Node.js 22 or newer (24 LTS recommended; `package.json` `engines` is `>=22` — a patched dependency needs it).
   Step-by-step Windows install + read-only first run: [`DEPLOY-WINDOWS.md`](DEPLOY-WINDOWS.md).
2. Copy this folder to e.g. `C:\gvet\delpro-worker`, then `npm ci --omit=dev` (exact versions from `package-lock.json`).
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

## Catalog sync (DelPro Gateway)

Configure in `.env`: `CATALOG_SOURCE=gateway` (with `DELPRO_SOURCE=off` the worker runs catalog-only, no SQL login needed), `DELPRO_GATEWAY_USER` (the farm uses `HerdNav`), `DELPRO_GATEWAY_PASSWORD`
(empty on this farm — leave the value empty), optionally `DELPRO_GATEWAY_URL` / `DELPRO_GATEWAY_CLIENT_ID`. Credentials are only
ever put into the SOAP body; they are not logged or written to disk.

1. `npm run gateway-discover` — saves the WSDL (+ imported schemas), and for every catalog type the request document, the raw
   SOAP response and the decoded result (5 rows; `SAMPLE_TOP=200 npm run gateway-discover -- Diagnosis` for more) to
   `discovery/` (git-ignored). Check them once; copy a raw `*.soap-response.xml` into `test/fixtures/gateway/` so the parser
   tests also cover the real outer envelope.
2. `npm run catalog:dry-run` — the same reads, then **one** call to `delpro_catalog_preview` (0038), which runs the real GVET
   pipeline (upload, animal ids, removals, reconcile) and rolls it back, returning what would change. Nothing is written to GVET
   or DelPro (no heartbeat either); the report is saved to `dry-run/` (git-ignored).
3. `npm run catalog` — one catalog sync, then look at Veterinarija → DelPro → Katalogo sinchronizacija.
4. Leave it to the service (`npm start`) afterwards.

Completeness: each type is read with `top=CATALOG_MAX_ROWS` (default 5000). A read returning `CATALOG_GATEWAY_ROW_CAP` rows
(default 1000 — the farm's Gateway returned exactly 1000 DrugParameters) or more, one that a re-read per value of a field DelPro
itself returned (Active / UOM / Frequency, `<equal>` filter) shows to be capped, or one whose re-read failed, is sent as
**incomplete** — GVET then removes nothing for that type. The Gateway has no verified paging, so a type over the cap stays
incomplete; records the other types reference (a drug's DefaultParameters, a usage's DrugParams…) are then read one by one by key,
so links and templates are not left pointing at missing records. Missing ones are listed (`refMissing`). The earlier PowerShell
test returned exactly 150 diagnoses at its own limit; don't assume that is the whole catalog.

### Importing DelPro into GVET (0039)

Veterinarija → DelPro → *Importas iš DelPro į GVET* shows the database's plan (`delpro_catalog_import_preview`) for every unlinked
DelPro diagnosis / drug: **link** an existing GVET record (a farm mapping in `delpro_mappings` by DelPro code or name override, or a
unique exact name match on both sides — GVET values are never overwritten, differences show as *Skiriasi*), **create** a GVET
disease / medicine (DelPro unit + withdrawal days, then a clinical review), **review** (several candidates, candidate already
linked, two DelPro records → one GVET record — never applied), **blocked** (parameters not received, unknown unit, no withdrawal
days). The admin ticks rows; `delpro_catalog_import_apply` re-plans and applies a row only if its decision and fingerprint are
unchanged; already linked rows are skipped, so repeating it is safe. Each link keeps its provenance in `import_snapshot`.

### Writing the catalog (GVET → DelPro)

`src/catalog-writer.js` executes `delpro_catalog_jobs` — step plans built by GVET (DrugParameters → Drug; Treatment →
parameters + TreatmentDrugUsage per line → check that DelPro lists the usages). Each step: report *start* → CreateData /
UpdateData → read the record back by key → compare every written property → report *done*. Nothing is deleted.

It only runs when **all** of these hold:
1. `CATALOG_SOURCE=gateway` and `CATALOG_WRITE_ENABLED=true` in `.env` (the only place a write-enabled Gateway client is made),
2. *Rašymas į DelPro katalogą* is switched on in GVET (Veterinarija → DelPro → Katalogo sinchronizacija → Rašymas į DelPro),
3. the job is a **test job**, or its operation (e.g. `Drug.create`) has been marked *patikrinta* — which GVET only allows
   after that operation's test job (an inactive `GVET TEST …` record) was written and read back correctly.

First real write: the **pilot medicine** (0039) — one inactive GVET medicine whose Drug.create job is released alone
(`delpro_catalog_release_single_job`) and executed with `npm run catalog:write-one -- <job>` after `npm run catalog:write-check -- <job>`
(read-only schema check against the live Gateway). Steps in [`DEPLOY-WINDOWS.md`](DEPLOY-WINDOWS.md) §9.

Validation order on the farm: Diagnosis.create → Diagnosis.update → Drug.create → Drug.update → Treatment.create (uses the
test drug) → Treatment.update. Check each test record in DelPro itself before marking it. Things the test jobs settle:
UpdateData identifying the record by its key property, the boolean format (`true`/`false`), whether `Code` must be supplied
on create, `TreatmentType` values, and that DelPro fills `Treatment.DrugUsages` from new usages.

Outcome unknown (a create was sent but never confirmed — timeout, crash): the step is **never re-sent and never adopted by
name** — a same-named diagnosis or medicine in DelPro may have been entered by hand. The job goes to *Reikia patikrinti ranka*;
same-name DelPro records are listed only as candidates. An admin checks DelPro and either **assigns** the record (*Priskirti
įrašą* — the worker then reads it back and compares every written property, a mismatch is *DelPro įrašas nesutampa*) or confirms
it does not exist (*Įrašo nėra — siųsti iš naujo*). *Kartoti* is refused while such a step is undecided. A read-back that differs
from what was sent is *DelPro įrašas nesutampa* — never "success".

## Treatments through the Gateway (0044)

Saving a treatment in GVET queues it; with `OUTBOUND_MODE=gateway` the worker polls every `OUTBOUND_INTERVAL_SEC` (5 s) and
`src/treatment-gateway.js` writes one `DiagnosesAndTreatmentEvent` (looked up by its `GVET:<job>` marker first, so retries never
duplicate) plus one medicine record per GVET medicine line, then reads everything back. The medicine object and its property names
come from a farm-verified `treatment-model.json` (`npm run treatment-probe`, `src/treatment-model.js`); the dose fields are fixed:
`Dosage` (dose), `DrugParams`, `Frequency` (GVET `frequency_per_day`) and `TreatCowDays` (GVET `course_days`) — both entered by the vet,
a missing one is a validation error, never 1. Without the model nothing is claimed — a diagnosis event with medicine names in its Comment is not a treatment, and GVET reports a job as sent only when the
medicine records are verified.

## Treatment write-back

Preferred order (see ../AGENTS.md): DelPro's own import function → UI automation → direct SQL. The shipped
`sql` mode runs `queries/insert-treatment.sql` + `queries/readback-treatment.sql`; it stays disabled while those files
are placeholders, and must only be enabled with the farm's written agreement. Until then keep `OUTBOUND_MODE=dry-run`.

## Tests

From the repo root: `npm run test:worker` — runs the worker against a PostgREST stand-in over PGlite with every
migration applied (`DELPRO_SOURCE=json`, fixture in `test/fixtures/herd.json`), plus the Gateway client/parser against the
verbatim Gateway documents in `test/fixtures/gateway/` (`test/gateway.test.js`).

## Approved-job payload (contract for the PowerShell executor)

`delpro_claim_next_job` returns the **frozen** `approved_payload` (payload v2; the database builds it, the browser never supplies
it). Only `delpro.ui_entry` is meant for `C:\GVET\delpro.ps1`:

| `delpro.ui_entry` | PowerShell parameter | Notes |
|---|---|---|
| `animal_number` | `-AnimalNumber` | DelPro animal number (`animals.animal_no`) |
| `diagnosis_name` | `-DiagnosisName` | the GVET disease name (same as in DelPro); an optional mapping may override it |
| `diagnosis_code` | `-DiagnosisCode` | **usually null** (names are matched, no code kept). The script must work without it, or take the code from an optional mapping |
| `medicine_name` | `-MedicineName` | the GVET product name (same as in DelPro); an optional mapping may override it. Exactly one medicine per job |
| `dose` | `-Dose` | day-1 quantity; course days are guaranteed to use the same dose |
| `course_days` | `-CourseDays` | `1` when the treatment has no course |
| `treatment_id` (and `sync_id`) | `-TreatmentId` | |

Everything else in the payload (`event_date`, karencija, route, vet, `dose_unit`) is informational — the script does not enter it.

Executor rules (not built yet): validate every value (type, length, no control characters) and pass them as an **argument array**
to the process — never concatenate them into a command string. Report the outcome only after reading the saved record back from
DelPro (`delpro_report_job_result`); a click on Save is not evidence. GUI automation needs the interactive logged-in Windows
session, so run it as a separate process from the polling service (e.g. a scheduled task "at log on" / a tray app) rather than
from a Windows service in session 0.

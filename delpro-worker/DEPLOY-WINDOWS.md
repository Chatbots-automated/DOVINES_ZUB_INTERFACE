# Deploying the DelPro worker on a Windows DelPro PC (read-only)

For a DelPro PC with Windows PowerShell 5.1 and the DelPro Gateway on `http://127.0.0.1:28080/GatewaySoapService`.
Everything here is **read-only towards DelPro**: the worker reads the Gateway (`GetData`) and uploads to GVET. Catalog
writes (`CATALOG_WRITE_ENABLED=false`) and treatment writes (`OUTBOUND_MODE=off`) stay off. Nothing in this guide is run
remotely; a person runs each step on the PC.

What the worker does in this profile:

| | Reads | Writes |
|---|---|---|
| `npm run gateway-discover` | Gateway WSDL + 5 rows per catalog type (`GetData`) | local `discovery\` folder only (no Supabase, no credentials) |
| `npm run catalog:dry-run` | Gateway `GetData` (same as below) | **nothing**: one call to `delpro_catalog_preview`, which runs the sync in GVET and rolls it back; report in local `dry-run\` |
| `npm run catalog` / service | Gateway `GetData` (Drug, DrugParameters, Diagnosis, Treatment, TreatmentDrugUsage, Animal) | GVET: `delpro_catalog_*` mirror + issues, `animals.delpro_object_guid`, heartbeat. GVET diseases/products are **not** changed in inbound mode `review` (only a linked disease without a recommended template adopts DelPro's) |

## 0. Requirements

- **Node.js ≥ 22** (`package.json` → `"engines": { "node": ">=22" }`). Install the current **24 LTS** (22 also works).
  Node 20 is end-of-life and a patched dependency (`@azure/identity` 4.14.1, via mssql) requires 22.
- Outbound HTTPS to `<project-ref>.supabase.co` and, for `npm ci`, to `registry.npmjs.org`.
- The GVET Supabase project of **this farm** already has migrations up to **0038** (section 5). The Gateway discovery
  (section 4) does not need it; the catalog dry run and scan (section 6) do.

> GVET is single-farm: one Supabase project per farm. Never point this PC's worker at another farm's project — herd
> snapshots would deactivate the other farm's animals and DelPro catalog keys would collide.

PowerShell note: use **`npm.cmd`**, not `npm`. On PowerShell 5.1, `npm` may resolve to `npm.ps1`, which the default execution
policy blocks ("running scripts is disabled on this system"). `npm.cmd` needs no policy change.

## 1. Install Node.js (PowerShell as Administrator)

```powershell
node -v          # if this prints v22.x or v24.x, skip to section 2
```

Download the **Windows Installer (.msi), x64, LTS** from https://nodejs.org/en/download and, optionally, check it against
the `SHASUMS256.txt` published next to it:

```powershell
Get-FileHash "$env:USERPROFILE\Downloads\node-v24.<x>.<y>-x64.msi" -Algorithm SHA256
msiexec /i "$env:USERPROFILE\Downloads\node-v24.<x>.<y>-x64.msi" /qn
```

(Or, where winget exists: `winget install --id OpenJS.NodeJS.LTS -e --source winget`.)
Close PowerShell, open a new one (new PATH), then:

```powershell
node -v          # v24.x (or v22.x)
npm.cmd -v
```

## 2. Copy the worker and install dependencies

The package is built on the developer machine from the committed tree, so it can't contain `.env`, `node_modules`, logs
or discovery output:

```bash
# developer machine, repo root
git archive --format=zip --output="../delpro-worker-$(git rev-parse --short HEAD).zip" \
  HEAD:delpro-worker package.json package-lock.json .env.example README.md DEPLOY-WINDOWS.md src queries
```

Files the PC needs (and nothing else):

```
C:\gvet\delpro-worker\
  package.json  package-lock.json  .env.example  README.md  DEPLOY-WINDOWS.md
  src\        (index.js, config.js, gvet.js, gateway.js, catalog.js, catalog-writer.js, treatment-gateway.js,
               discover-gateway.js, discover.js, delpro.js, log.js)
  queries\    (animals.sql, groups.sql, insert-treatment.sql, readback-treatment.sql — placeholders, unused with DELPRO_SOURCE=off)
```

`test\` is not needed. Copy the zip to the PC the usual way (RDP clipboard, USB), then in PowerShell:

```powershell
New-Item -ItemType Directory -Force C:\gvet | Out-Null
Unblock-File "$env:USERPROFILE\Downloads\delpro-worker-<sha>.zip"
Expand-Archive -Path "$env:USERPROFILE\Downloads\delpro-worker-<sha>.zip" -DestinationPath C:\gvet\delpro-worker
Set-Location C:\gvet\delpro-worker
npm.cmd ci --omit=dev
```

`npm ci` installs exactly the versions in `package-lock.json` (must end with `found 0 vulnerabilities`).

## 3. Configure `.env`

```powershell
Set-Location C:\gvet\delpro-worker
Copy-Item .env.example .env
notepad .env
```

Fill in only:

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` of **this farm's** GVET project |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` (paste on the PC only) |
| `WORKER_ID` | `DAU-DOV-KDV-002` |
| `DELPRO_GATEWAY_USER` | the local Gateway account (e.g. `HerdNav`) |
| `DELPRO_GATEWAY_PASSWORD` | its password, or leave empty if it has none |

Leave the read-only defaults as they are: `DELPRO_SOURCE=off`, `OUTBOUND_MODE=off`, `CATALOG_SOURCE=gateway`,
`CATALOG_WRITE_ENABLED=false`, `DELPRO_GATEWAY_URL=http://127.0.0.1:28080/GatewaySoapService`. No quotes, no trailing spaces.

Restrict the file to administrators, SYSTEM (the service account in section 6) and you:

```powershell
icacls .env /inheritance:r /grant:r "Administrators:F" "SYSTEM:R" "${env:USERDOMAIN}\${env:USERNAME}:M"
```

Connectivity checks:

```powershell
(Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:28080/GatewaySoapService?wsdl").StatusCode    # 200
node -e "fetch(process.argv[1]).then(r=>console.log('Supabase HTTP',r.status)).catch(e=>console.error(e.message))" https://<project-ref>.supabase.co/rest/v1/
```

The Supabase check prints `Supabase HTTP 401`, which is fine: it proves the host is reachable. A network error means it isn't.

## 4. Read-only Gateway discovery

```powershell
Set-Location C:\gvet\delpro-worker
npm.cmd run gateway-discover
```

This saves the WSDL and its schemas, plus for each of Drug, DrugParameters, Diagnosis, Treatment, TreatmentDrugUsage and Animal
the request document, the raw SOAP response and the decoded rows, into `C:\gvet\delpro-worker\discovery\`. It sends `GetData` only.
The Gateway client refuses CreateData/UpdateData unless explicitly built for writing, which only the catalog writer does, and only
with `CATALOG_WRITE_ENABLED=true`. The request files hold only `xmlData`, never the user or password. More rows of one type:

```powershell
$env:SAMPLE_TOP = "200"; npm.cmd run gateway-discover -- Diagnosis; Remove-Item Env:SAMPLE_TOP
```

Check: every type printed `<Type>: N eil.` (not `KLAIDA`), and the `*.soap-response.xml` files have the `GetDataResult` the parser
expects. The `discovery\` folder holds farm catalog data, not credentials. It is git-ignored, so don't commit it.

## 5. Apply migrations to this farm's GVET project (developer machine, after a backup)

0038 (catalog dry run) needs 0037, which needs 0033, 0034 and 0036. Apply from a **clean checkout of the commit**, not a working tree with
other uncommitted migrations.

1. **Identify the project.** The project ref is the subdomain of the `NEXT_PUBLIC_SUPABASE_URL` set on this farm's Netlify
   site (Site configuration → Environment variables). It must be the same value as `SUPABASE_URL` in the PC's `.env`.

   ```bash
   git worktree add ../gvet-deploy <commit-sha> && cd ../gvet-deploy
   npx supabase login
   npx supabase projects list                 # find the ref + name of THIS farm's project
   npx supabase link --project-ref <project-ref>
   cat supabase/.temp/project-ref             # must print that ref
   ```

2. **Back up.** Check Supabase Dashboard → Database → Backups: there should be a recent daily backup, or PITR if enabled.
   Then take your own dump. Copy the connection string from Dashboard → Connect → *Session pooler*. `pg_dump` must be the
   same major version as the server, or newer.

   ```bash
   psql "postgresql://postgres.<project-ref>:<db-password>@<pooler-host>:5432/postgres" -c "show server_version"
   pg_dump "postgresql://postgres.<project-ref>:<db-password>@<pooler-host>:5432/postgres" \
     --format=custom --no-owner --file="gvet-<project-ref>-pre-0038-$(date +%Y%m%d-%H%M).dump"
   pg_restore --list "gvet-<project-ref>-pre-0038-"*.dump | head      # readable = usable
   ```

3. **See what is pending, then apply.**

   ```bash
   npx supabase migration list --linked       # Local vs Remote; 0033/0034/0036/0037/0038 should be the only local-only rows
   npx supabase db push --linked --dry-run    # lists exactly what would run
   npx supabase db push --linked
   ```

   If the dry run lists anything other than the expected migrations, stop. If a migration numbered lower than the last applied
   one is applied later (e.g. 0035), `db push` will need `--include-all`.

4. **Verify** (Dashboard → SQL Editor). Writing must be off:

   ```sql
   select version from supabase_migrations.schema_migrations order by version desc limit 5;
   select setting_key, setting_value from system_settings
   where setting_key in ('delpro_catalog_write_enabled', 'delpro_catalog_validated_operations',
                         'delpro_catalog_outbound_mode', 'delpro_catalog_inbound_mode', 'delpro_write_channel')
   order by 1;
   -- expected: write_enabled = false, validated_operations = '' , outbound_mode = manual,
   --           inbound_mode = review, write_channel = ui_script
   select count(*) as catalog_jobs from delpro_catalog_jobs;   -- 0
   select count(*) as catalog_runs from delpro_catalog_runs;   -- 0 (no catalog sync has written yet)
   select has_function_privilege('service_role', 'delpro_catalog_preview(jsonb)', 'execute') as preview_ok,  -- true
          has_function_privilege('authenticated', 'delpro_catalog_preview(jsonb)', 'execute') as app_can_call;  -- false
   ```

   Deploy the GVET app build from the same commit, so the admin screen matches the database. If a worker call returns
   PGRST202 right after the push, run `notify pgrst, 'reload schema';`.

## 6. Catalog: dry run first, then the first real scan

### 6a. Dry run (changes nothing in GVET or DelPro)

On the PC, after section 5:

```powershell
Set-Location C:\gvet\delpro-worker
npm.cmd run catalog:dry-run
```

This runs `node src/index.js --catalog --dry-run`:

- **DelPro**: `GetData` only, through a client object that has no write method at all. Per type: one read with
  `top=CATALOG_MAX_ROWS`, one re-read per value of Active / UOM / Frequency (completeness check), and, for a type that may be
  truncated (DrugParameters), one `<equal Key>` read per record that a Drug or TreatmentDrugUsage references but the capped read
  didn't return. Then Animal `ObjectGuid` + `Number`.
- **GVET**: exactly one HTTPS call, `POST https://<project-ref>.supabase.co/rest/v1/rpc/delpro_catalog_preview` (service role).
  In the database it runs the real begin_run → upload → ingest_animal_ids → finish_run (removals + reconcile) and rolls all of
  it back before answering. No heartbeat, no other RPC, no outbound or catalog-write queue.
- **PC**: writes the full report to `C:\gvet\delpro-worker\dry-run\catalog-<time>.json` (farm catalog data, no credentials,
  git-ignored).

It exits non-zero if anything fails. Check the log:

- `SAUSAS PALEIDIMAS — GVET ir DelPro nepakeisti` must be there.
- Per type: received / new / changed / invalid, `pilnas=taip|NE`, removals. **DrugParameters will show `pilnas=NE`** while the
  Gateway answers at most 1000 rows (`CATALOG_GATEWAY_ROW_CAP`): GVET then removes nothing for it. `+N pagal nuorodas` counts the
  referenced parameter records fetched by key; `nuorodų DelPro nerasta` > 0 means a drug/usage points to a record DelPro didn't
  return; look at `read.types.DrugParameters.refMissing` in the report.
- `Nauji klausimai suggested_match / ambiguous_match: N`: what the admin screen would show.
- `GVET <table>: +a ~b -c`: rows the real run would change outside the mirror. On a first run expect only `animals` (ObjectGuid),
  `system_settings` (last seen) and nothing in `diseases`, `products`, `treatment_templates`, `delpro_catalog_jobs`, `delpro_sync_jobs`.
- SQL afterwards: `select count(*) from delpro_catalog_runs;` is still 0.

### 6b. First real scan (after the dry-run report is reviewed and agreed)

```powershell
npm.cmd run catalog
```

This runs `node src/index.js --catalog`: the same reads, the upload to GVET, then a heartbeat, and exits. It does not run the
herd sync, the treatment queue or the catalog write queue. Check:

- The log ends with `DelPro katalogas → GVET: completed {…}`. A `WARN … gali būti ne viskas, pašalinimai nevykdomi` line
  means that type hit a read limit. GVET then treats it as incomplete and removes nothing for it.
- GVET → Veterinarija → DelPro → *Katalogo sinchronizacija* shows the DelPro records, suggestions and differences, and the
  worker as active with `CATALOG_WRITE_ENABLED=false`.
- SQL: `select count(*) from delpro_catalog_jobs;` is still 0, and `select setting_value from system_settings where setting_key = 'delpro_catalog_write_enabled';` is `false`.

Suggestions are **not** links: an admin confirms each one. Withdrawal days, units and template lines are never applied
automatically.

## 7. Run continuously (after sections 4–6 look right)

Use a built-in Task Scheduler task as SYSTEM, started at boot and restarted on failure. Its output is appended to
`logs\worker.log`. Run in PowerShell as Administrator:

```powershell
$dir  = 'C:\gvet\delpro-worker'
$node = (Get-Command node.exe).Source
New-Item -ItemType Directory -Force "$dir\logs" | Out-Null
$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$node`" src\index.js >> logs\worker.log 2>&1`"" -WorkingDirectory $dir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
               -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Limited
Register-ScheduledTask -TaskName 'GVET-DelPro-Worker' -Action $action -Trigger $trigger -Settings $settings -Principal $principal
Start-ScheduledTask -TaskName 'GVET-DelPro-Worker'
```

Check and operate:

```powershell
Get-ScheduledTask -TaskName 'GVET-DelPro-Worker' | Get-ScheduledTaskInfo      # LastTaskResult 267009 = running
Get-Content C:\gvet\delpro-worker\logs\worker.log -Tail 30 -Wait               # Ctrl+C to stop watching
Stop-ScheduledTask  -TaskName 'GVET-DelPro-Worker'
Start-ScheduledTask -TaskName 'GVET-DelPro-Worker'
Unregister-ScheduledTask -TaskName 'GVET-DelPro-Worker' -Confirm:$false        # remove
```

The first log line must read `šaltinis=off, outbound=off, katalogas=gateway, katalogo rašymas=išjungtas`. In this profile the
service sends a heartbeat every `OUTBOUND_INTERVAL_SEC`, reads the catalog every `CATALOG_INTERVAL_MIN` (360) and whenever an
admin presses *Sinchronizuoti dabar*, and writes nothing to DelPro. `logs\worker.log` is not rotated; archive it when it gets
large. (`README.md` also shows the NSSM alternative.)

Updating the worker later: `Stop-ScheduledTask`, replace `src\`, `queries\`, `package.json` and `package-lock.json` from a new
`git archive`, run `npm.cmd ci --omit=dev`, then `Start-ScheduledTask`. `.env` stays as it is.

## 8. Update an installed worker (keeps `.env`)

```powershell
Get-ScheduledTask -TaskName 'GVET-DelPro-Worker' -ErrorAction SilentlyContinue | Stop-ScheduledTask
$zip = "$env:USERPROFILE\Downloads\delpro-worker-<version>.zip"
$tmp = "$env:TEMP\delpro-worker-new"
Unblock-File $zip
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -Path $zip -DestinationPath $tmp
Set-Location C:\gvet\delpro-worker
Copy-Item .env ".env.backup-$(Get-Date -Format yyyyMMdd-HHmm)"
Remove-Item .\src -Recurse -Force
Copy-Item "$tmp\src" .\src -Recurse
Copy-Item "$tmp\queries\*" .\queries -Force
Copy-Item "$tmp\package.json", "$tmp\package-lock.json", "$tmp\.env.example", "$tmp\README.md", "$tmp\DEPLOY-WINDOWS.md" . -Force
npm.cmd ci --omit=dev
Get-ScheduledTask -TaskName 'GVET-DelPro-Worker' -ErrorAction SilentlyContinue | Start-ScheduledTask
```

`.env` is never in the package and is not touched; the copy is only a safety net (delete it once the worker runs).

## 9. First GVET → DelPro medicine (pilot, 0039)

Writes exactly one inactive medicine `GVET TEST vaistas …` (a DrugParameters record + a Drug record) to DelPro. Everything else stays off.

1. GVET → Veterinarija → DelPro → *Rašymas į DelPro* → **Sukurti bandomąjį vaistą**. The panel shows the job id.
2. On the PC, read-only check (GetData only; prints the exact `ddmData` per step and checks property names, objectType, boolean format,
   UOM value and that the name doesn't exist yet in DelPro):

   ```powershell
   Set-Location C:\gvet\delpro-worker
   npm.cmd run catalog:write-check -- <job-id>
   ```

   It must end with `Patikra: OK — DelPro schema atitinka.`
3. GVET → **Leisti įrašyti tik šią užduotį** (sets `delpro_catalog_write_enabled=true` and `delpro_catalog_write_only_job=<job-id>`;
   GVET then hands out that job only, and only to a worker that names it).
4. On the PC, one write. `CATALOG_WRITE_ENABLED` is set for this one process only; `.env` and the scheduled service keep `false`:

   ```powershell
   $env:CATALOG_WRITE_ENABLED = 'true'; npm.cmd run catalog:write-one -- <job-id>; Remove-Item Env:CATALOG_WRITE_ENABLED
   ```

   It re-runs the check, then CreateData DrugParameters → read back by Key → compare; CreateData Drug (DefaultParameters = the new
   key) → read back by Code → compare; GVET saves the link. Expected last line: `Rezultatas: success, DelPro <Code>, susieta (…)`.
   GVET switches writing off again by itself as soon as the job is no longer queued (success, failure, review, cancel).
5. Check the record in DelPro itself (inactive, ml, 0/0 days). Then, if it is right, *Pažymėti „Vaistas: sukūrimas“ patikrinta*.
6. Running step 4 again prints `Užduotis jau success (DelPro …) — nieko nesiunčiama.` and writes nothing.

If the write's outcome is unknown (timeout after sending), the job goes to *Reikia patikrinti ranka*; it is never re-sent and never
adopted by name (assign the DelPro record or confirm it is absent, as for any catalog job).

## 10. Treatments GVET → DelPro (0044)

Saving a gydymas treatment in GVET queues it (auto mode, no delay). The service polls every `OUTBOUND_INTERVAL_SEC` (5 s) and
writes the event + its medicine records, reads them back, and GVET shows **Perduota į DelPro** only when both are verified.
Transient failures are retried with backoff; every attempt looks for the event's `GVET:<job>` marker first (no duplicates).

It writes only when BOTH hold:
1. `OUTBOUND_MODE=gateway` in `.env` (keep `off` until step 2 is done), and
2. a farm-verified `treatment-model.json` — the per-animal medicine object of this DelPro, found with the read-only probe:
   ```powershell
   Set-Location C:\gvet\delpro-worker
   npm.cmd run treatment-probe -- <ObjectGuid of an event entered by hand in DelPro WITH a medicine>
   ```
   Send `discovery\treatment-probe.json`; the model is written from it (format in `src/treatment-model.js`). Each medicine record gets
   `Dosage`, `DrugParams`, `Frequency` and `TreatCowDays` from the vet's entry in GVET.
Without the model the worker claims nothing: treatments wait in GVET as *Laukia siuntimo*, none is lost.

## 11. CMS atskyrimai (0048)

GVET prepares per-animal CMS sorting instructions (DelPro `AnimalActionSetting`, `ActionType=SortCow`), an admin approves them,
and this worker writes them. **Only the reads are verified on this farm.** Whether DelPro accepts a CreateData of
`AnimalActionSetting`, with which properties, and where the cow physically goes, is what the supervised single-animal test below
establishes. Until then keep `CMS_OUTBOUND_MODE=off` — preparing and approving in GVET works regardless.

1. Install the new package with section 8 (keeps `.env`). Then add the CMS lines to `.env` once, without touching anything else
   (`OUTBOUND_MODE` for treatments is separate and stays as it is):

   ```powershell
   Set-Location C:\gvet\delpro-worker
   Copy-Item .env ".env.backup-$(Get-Date -Format yyyyMMdd-HHmm)"
   $add = @('CMS_OUTBOUND_MODE=off', 'CMS_POLL_INTERVAL_SEC=5', 'CMS_DEFAULT_SORT_AREA_KEY=1', 'CMS_LIVE_INTERVAL_MIN=60',
            'DELPRO_GATEWAY_ANIMAL_ORN_PROPERTY=OfficialRegNumber')
   if ((Get-Content .env -Raw) -notmatch "`n$") { Add-Content -Path .env -Value '' }   # last line must end with a newline
   foreach ($line in $add) {
     $name = $line.Split('=')[0]
     if (-not (Select-String -Path .env -Pattern "^$name=" -Quiet)) { Add-Content -Path .env -Value $line }
   }
   Get-ScheduledTask -TaskName 'GVET-DelPro-Worker' | Stop-ScheduledTask
   Get-ScheduledTask -TaskName 'GVET-DelPro-Worker' | Start-ScheduledTask
   Get-Content .\logs\worker.log -Tail 5
   ```

   The start line must end with `CMS=off`. `CMS_DEFAULT_SORT_AREA_KEY` is only reported to GVET — it is **not** sent and is not
   proven to route the cow.
2. Read-only checks (write nothing):

   ```powershell
   npm.cmd run cms:inspect     # GetMetadata + sample rows of AnimalActionSetting / SortArea -> discovery\cms-*
   npm.cmd run cms:live        # DelPro SortCow settings + sort areas -> GVET "Aktyvūs atskyrimai"
   ```

   Send the `discovery\cms-*` files to the developer: the metadata may show which properties are writable.
3. In GVET → CMS atskyrimai: prepare ONE cow **without** an active separation, a short *Nurodytam laikotarpiui* window starting in
   the next hours, the sessions you want. Submit; an admin approves it (*Patvirtinti*).
4. Dry run of that job (reads only, prints the exact CreateData document, saves `dry-run\cms-<job>.json`):

   ```powershell
   npm.cmd run cms:dry-run -- <job-id>
   ```

5. GVET (admin) → *Leisti siųsti tik šią* on that job. Then ONE supervised write; `CMS_OUTBOUND_MODE` is set for this process
   only, `.env` and the scheduled task keep `off`:

   ```powershell
   $env:CMS_OUTBOUND_MODE = 'gateway'; npm.cmd run cms:write-one -- <job-id>; Remove-Item Env:CMS_OUTBOUND_MODE
   ```

   It re-checks the animal (GUID + ORN), finds its single AnimalMilkSetting, refuses if DelPro already has an active SortCow,
   writes, reads the record back and compares every property. Expected: `Rezultatas: success`. A mismatch or an unknown outcome
   ends in *Reikia peržiūros* — check DelPro and use *Įrašo DelPro nėra* or *Priskirti DelPro įrašą*; it is never re-sent blindly.
6. Check the setting in DelPro itself AND that the cow is physically sorted at the start time. Only then, in GVET, *Leisti* the mode
   (*Nurodytam laikotarpiui*). *Neterminuotas* needs its own supervised test the same way. *Vienkartinis (Sort Once)* is not supported.
7. Routine sending: set `CMS_OUTBOUND_MODE=gateway` in `.env` and restart the task. To stop at any time: set it back to `off` and
   restart, or *Sustabdyti* the mode in GVET (approved jobs then wait).

## 12. Production: automatic worker + CMS activation (0049)

All commands in **PowerShell started with "Run as Administrator"** while logged in as the farm account (the task runs as the
account that installs it, at its logon). The script never deletes a task it did not create, never starts a second worker, never
prints secrets and never changes `OUTBOUND_MODE` (treatments).

**Upgrade to this package** (keeps `.env`, `treatment-model.json`, `logs\`; backs the old code up to `C:\GVET\backup\…`; adds only
missing CMS keys to `.env`, all with `CMS_OUTBOUND_MODE=off`; re-registers the task as "at logon of this account"):

```powershell
$zip = "$env:USERPROFILE\Downloads\delpro-worker-0049.zip"
Unblock-File $zip
$tmp = "$env:TEMP\gvet-worker-0049"; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip $tmp
powershell -ExecutionPolicy Bypass -File "$tmp\delpro-worker\scripts\gvet-worker.ps1" -Action upgrade -Source "$tmp\delpro-worker" -Dir C:\GVET\delpro-worker -StopRunning
```

`-StopRunning` is needed this once: the worker running now is the pre-0048 version (its heartbeat has no CMS fields), started by the
earlier task, and does not mark itself. If no task of ours exists yet, finish with `-Action install`:

```powershell
powershell -ExecutionPolicy Bypass -File C:\GVET\delpro-worker\scripts\gvet-worker.ps1 -Action install -StopRunning
```

If install stops with *"A task named GVET-DelPro-Worker exists that this script did not create"* or *"Task name already taken but not
readable"*: that is the cause of the earlier *Cannot create a file when that file already exists* (a task with that name, created
elevated / as SYSTEM, invisible to a non-elevated `Get-ScheduledTask`). Open Task Scheduler as Administrator, look at it, and
delete or rename it yourself if it is the old GVET task; then run install again.

**Operate / diagnose:**

```powershell
$w = 'C:\GVET\delpro-worker\scripts\gvet-worker.ps1'
powershell -ExecutionPolicy Bypass -File $w -Action status     # task, processes (duplicates flagged), .env modes, GVET + Gateway reachability, CMS live result, log tail
powershell -ExecutionPolicy Bypass -File $w -Action logs -Follow
powershell -ExecutionPolicy Bypass -File $w -Action restart
powershell -ExecutionPolicy Bypass -File $w -Action cms-off    # emergency: CMS_OUTBOUND_MODE=off + restart; treatments keep running
```

Starts automatically when this account logs on to Windows. Starting **without** anyone logged on needs a task running as a service
account (e.g. SYSTEM, "Run whether user is logged on or not") — not set up by this script; test it separately before relying on it.
A second copy started by hand exits by itself (`logs\worker.lock`).

**Verify the complete CMS read** (read-only; writes nothing anywhere; exit code 0 only when the scan is complete).
*Since 0051 this is an optional diagnostic only — not an activation condition and not needed for sending; see §14.*

```powershell
Set-Location C:\GVET\delpro-worker
npm.cmd run cms:live; "exit code: $LASTEXITCODE"
```

Expected: `"complete":true`, `received` = number of SortCow records, `matched` = those tied to an active GVET animal, and
`unmatched_reasons` explaining the rest (`animal_not_in_gvet` = DelPro milk settings of animals GVET doesn't have — culled/sold
animals DelPro keeps; `milk_setting_without_animal`; `animal_inactive_in_gvet`). An incomplete scan exits 2 and removes nothing in GVET.

**Activation** (*superseded by §14 since 0051 — no complete CMS read needed*) (GVET → CMS atskyrimai → *Laukia perdavimo / istorija* → *Aktyvavimas*). "Visiškai aktyvu" appears only when all hold:
CMS worker installed · GVET API · Gateway · complete CMS read (< 26 h) · automatic worker (task) running · `CMS_OUTBOUND_MODE=gateway` ·
(Superseded by 0052 — see §14: approval alone sends.) GVET CMS sending switched on · a mode verified (*Nurodytam laikotarpiui* after job 443b4846… — admin presses *Leisti*) · physical
destination confirmed by the farm operator (*Patvirtinti fizinę vietą*, with a note where the test cow went).
Turn on `CMS_OUTBOUND_MODE=gateway` in `.env` only after the destination check; then `-Action restart`.

**Emergency stop**: GVET *Avarinis stabdymas* (any staff member) or `-Action cms-off` on the PC. Either stops NEW CMS writes only.
Neither — nor stopping the whole worker — cancels separations already created in DelPro: disable those in DelPro itself.

## 13. CMS live read fix (0050, worker 0.3.0)

DelPro 10.9 on this farm answers `GetData AnimalMilkSetting [Key, Animal]` with `System.NullReferenceException` above ~1000 rows
(worker 0.2.0 then failed with *Gateway rezultatas nėra ddmData*). 0.3.0 reads the keys alone (`[Key]`), maps at most 1000 in one
read and every other key by `Key` (3 at a time, each read tried twice), reads SortCow with the `ActionType` filter and falls back to
one read per milk setting if that read fails or reaches `top`. Writes are unchanged.

1. Developer: apply `supabase/migrations/0050_cms_live_unresolved.sql` (after a backup) **before** the worker upgrade. Nothing else
   changes in the database; an unreadable milk setting then keeps the animal GVET already has for that SortCow row.
2. Farm PC, PowerShell as Administrator (keeps `.env`, `treatment-model.json`, `logs\` and the existing task — it is only stopped
   and started again):

```powershell
$zip = "$env:USERPROFILE\Downloads\delpro-worker-0050.zip"
Unblock-File $zip
$tmp = "$env:TEMP\gvet-worker-0050"; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip $tmp
powershell -ExecutionPolicy Bypass -File "$tmp\delpro-worker\scripts\gvet-worker.ps1" -Action upgrade -Source "$tmp\delpro-worker" -Dir C:\GVET\delpro-worker
```

   If it says *A worker is still running*, add `-StopRunning`. If it says *No task yet*, run `-Action install` (§12).
3. Verify (read-only; takes a minute or two — ~2500 single reads):

```powershell
Set-Location C:\GVET\delpro-worker
npm.cmd run cms:live; "exit code: $LASTEXITCODE"
```

   The first log line `DelPro CMS skaitymas: {...}` has `milk_setting_keys` (≈3478), `milk_settings_resolved`,
   `milk_settings_unresolved`, `sortcow_actions`, `gateway_read_errors`; then `"complete":true`, `matched`, `unmatched_reasons`, exit 0.
   Exit 2 = incomplete: each unreadable key is logged as `WARN AnimalMilkSetting <key>: error — …`; GVET keeps the earlier state.
4. Optional, read-only — which record (if any) breaks the big read:

```powershell
npm.cmd run cms:milk-diagnose
```

   Bisects the failing `top` between 1000 and 2000, reads the record at that position (and neighbours) by Key and its Animal, and
   saves `discovery\cms-milk-diagnose-*.json` with a one-line conclusion (record-specific vs bulk size).

## 14. Targeted CMS + reliable automatic start (0051, worker 0.4.0)

What changes: no full DelPro scan any more (not in the loop, not an activation check). Each approved job re-reads only its own cow
right before writing (identity, its one milk setting, its existing SortCow records); "Aktyvūs atskyrimai" is fed by the same per-cow
read for GVET's CMS cows only, hourly or on *Atnaujinti iš DelPro*. The task now runs a hidden supervisor that restarts the worker
after any exit (the 0.3.0 task ended with `3221225786` = `0xC000013A`: its visible console was closed / got Ctrl+C, and Task
Scheduler does not restart a program that exits). Treatments, catalog, reports, `.env` and the CreateData of SortCow are unchanged.

1. Developer: apply `supabase/migrations/0051_cms_targeted_refresh.sql` (after a backup) **before** the worker upgrade.
2. Farm PC, PowerShell **as Administrator**, logged in as the farm account. Run the script **from the new package** (the installed
   0.3.0 script would keep the old task action):

```powershell
$zip = "$env:USERPROFILE\Downloads\delpro-worker-0051.zip"
Unblock-File $zip
$tmp = "$env:TEMP\gvet-worker-0051"; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip $tmp
powershell -ExecutionPolicy Bypass -File "$tmp\delpro-worker\scripts\gvet-worker.ps1" -Action upgrade -Source "$tmp\delpro-worker" -Dir C:\GVET\delpro-worker
```

   It backs up the code, keeps `.env` / `treatment-model.json` / `logs\`, adds only missing keys (`CMS_BATCH_LIMIT=10`,
   `CMS_CONCURRENCY=2`, `CMS_REFRESH_BATCH=50`, `CMS_REFRESH_POLL_SEC=30`), **reuses the existing `GVET-DelPro-Worker` task** (same
   trigger and user; only its action becomes the hidden supervisor) and starts it. If it says *A worker is still running*, add
   `-StopRunning`; if *Could not update the task action*, run `-Action install` (re-registers our task only).

3. **Automatic start verification**:

```powershell
powershell -ExecutionPolicy Bypass -File C:\GVET\delpro-worker\scripts\gvet-worker.ps1 -Action status
```

   Expect `[OK] Startup: task starts at Windows logon`, `[OK] Startup: task runs the supervisor`, `[OK] Supervisor running`,
   one `[OK] Process PID …, by task`, `[OK] lock: PID … (this worker)`, `[OK] GVET last heartbeat … (< 300 s ago)`, and Gateway
   reachable. To prove the restart: `Stop-Process -Id <node PID>`; within ~20 s `-Action status` shows a new PID and
   `logs\supervisor.log` has `worker exited with code … - restarting`. After a Windows sign-out / sign-in the same status must be green.

4. **Targeted live status check** (read-only towards DelPro; prints each cow's SortCow records with status, uploads to GVET):

```powershell
Set-Location C:\GVET\delpro-worker
npm.cmd run cms:refresh -- --tag LT000007300337      # one cow (repeat --tag for more)
npm.cmd run cms:refresh                              # GVET's whole CMS set now
```

   Each line: `LT… (DelPro Nr. …, AnimalMilkSetting …): <key> effective|scheduled|inactive|ended … s[1,2]` or `NENUSKAITYTA — <reason>`.
   Exit 2 if any cow could not be read. The test record you disabled by hand must show `inactive`.

5. **CMS activation** (0052: GVET → CMS atskyrimai → *Aktyvavimas*, 5 checks: worker running by the task · Gateway · GVET API ·
   `CMS_OUTBOUND_MODE=gateway` · GVET switch on). No mode verification, no destination note: once these are green, an admin's
   **Patvirtinti** on a job sends it. On the PC, once:

```powershell
powershell -ExecutionPolicy Bypass -File C:\GVET\delpro-worker\scripts\gvet-worker.ps1 -Action cms-on   # type GATEWAY
```

   Migration 0052 switches GVET's CMS sending on; if someone pressed *Avarinis stabdymas*, an admin presses *Įjungti CMS siuntimą*.
   Sort Once and a chosen sort area stay blocked (approval refuses them); the worker still re-checks every cow in DelPro before writing.

6. **Emergency stop** (stops NEW CMS writes only; treatments keep running; separations already in DelPro are NOT cancelled —
   disable those in DelPro): GVET *Avarinis stabdymas* (any staff member, immediate — the worker gets no more jobs), and/or on the PC:

```powershell
powershell -ExecutionPolicy Bypass -File C:\GVET\delpro-worker\scripts\gvet-worker.ps1 -Action cms-off
```

Optional, diagnostic only: `npm.cmd run cms:live` (whole DelPro, slow, may be incomplete — blocks nothing).

## Not enabled by this guide

- **Catalog writes** need the farm's agreement, then `CATALOG_WRITE_ENABLED=true`, the GVET switch, and a validated test record
  per operation (`README.md` → *Writing the catalog*).
- **Treatments** (`OUTBOUND_MODE`): the Gateway channel writes only a `DiagnosesAndTreatmentEvent`, with the medicines as
  text in its Comment. DelPro drug usages (`HealthEventDrugUsage`) are not synchronized and not validated. This is not
  medicine treatment synchronization.
- **Herd sync** (`DELPRO_SOURCE=mssql`) needs this PC's DelPro SQL queries discovered (`npm.cmd run discover`) and a read-only
  SQL login.

# Deploying the DelPro worker on a Windows DelPro PC (read-only)

For a DelPro PC with Windows PowerShell 5.1 and the DelPro Gateway on `http://127.0.0.1:28080/GatewaySoapService`.
Everything here is **read-only towards DelPro**: the worker reads the Gateway (`GetData`) and uploads to GVET. Catalog
writes (`CATALOG_WRITE_ENABLED=false`) and treatment writes (`OUTBOUND_MODE=off`) stay off. Nothing in this guide is run
remotely; a person runs each step on the PC.

What the worker does in this profile:

| | Reads | Writes |
|---|---|---|
| `npm run gateway-discover` | Gateway WSDL + 5 rows per catalog type (`GetData`) | local `discovery\` folder only (no Supabase, no credentials) |
| `npm run catalog` / service | Gateway `GetData` (Drug, DrugParameters, Diagnosis, Treatment, TreatmentDrugUsage, Animal) | GVET: `delpro_catalog_*` mirror + issues, `animals.delpro_object_guid`, heartbeat. GVET diseases/products are **not** changed (inbound mode `review`) |

## 0. Requirements

- **Node.js ≥ 22** (`package.json` → `"engines": { "node": ">=22" }`). Install the current **24 LTS** (22 also works).
  Node 20 is end-of-life and a patched dependency (`@azure/identity` 4.14.1, via mssql) requires 22.
- Outbound HTTPS to `<project-ref>.supabase.co` and, for `npm ci`, to `registry.npmjs.org`.
- The GVET Supabase project of **this farm** already has migrations up to **0037** (section 5). The Gateway discovery
  (section 3) does not need it; the catalog scan (section 4) does.

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

0037 needs 0033, 0034 and 0036 to be applied before it. Apply from a **clean checkout of the commit**, not a working tree with
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
     --format=custom --no-owner --file="gvet-<project-ref>-pre-0037-$(date +%Y%m%d-%H%M).dump"
   pg_restore --list "gvet-<project-ref>-pre-0037-"*.dump | head      # readable = usable
   ```

3. **See what is pending, then apply.**

   ```bash
   npx supabase migration list --linked       # Local vs Remote; 0033/0034/0036/0037 should be the only local-only rows
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
   ```

   Deploy the GVET app build from the same commit, so the admin screen matches the database. If a worker call returns
   PGRST202 right after the push, run `notify pgrst, 'reload schema';`.

## 6. Read-only catalog scan

On the PC, after section 5:

```powershell
Set-Location C:\gvet\delpro-worker
npm.cmd run catalog
```

This runs `node src/index.js --catalog`: one catalog read via `GetData`, an upload to GVET, then a heartbeat, and exits. It
does not run the herd sync, the treatment queue or the catalog write queue. Check:

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

## Not enabled by this guide

- **Catalog writes** need the farm's agreement, then `CATALOG_WRITE_ENABLED=true`, the GVET switch, and a validated test record
  per operation (`README.md` → *Writing the catalog*).
- **Treatments** (`OUTBOUND_MODE`): the Gateway channel writes only a `DiagnosesAndTreatmentEvent`, with the medicines as
  text in its Comment. DelPro drug usages (`HealthEventDrugUsage`) are not synchronized and not validated. This is not
  medicine treatment synchronization.
- **Herd sync** (`DELPRO_SOURCE=mssql`) needs this PC's DelPro SQL queries discovered (`npm.cmd run discover`) and a read-only
  SQL login.

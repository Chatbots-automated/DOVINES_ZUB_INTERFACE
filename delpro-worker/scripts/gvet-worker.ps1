<#
  GVET DelPro worker - install / repair / status / upgrade on the farm PC (Windows PowerShell 5.1+).

    powershell -ExecutionPolicy Bypass -File C:\GVET\delpro-worker\scripts\gvet-worker.ps1 -Action status
    ... -Action install  [-StopRunning]          (as Administrator; idempotent - safe to run again)
    ... -Action stop | start | restart | logs [-Follow]
    ... -Action upgrade -Source <extracted package>\delpro-worker   (or -Zip <package.zip>)
    ... -Action cms-off                            (emergency: CMS_OUTBOUND_MODE=off + restart; treatments untouched)
    ... -Action cms-on                             (CMS_OUTBOUND_MODE=gateway + restart; asks to type GATEWAY)
    ... -Action run                                (what the scheduled task runs: the supervisor loop, hidden window)

  Rules: never deletes or replaces a scheduled task it did not create, never starts a second worker, never prints secrets,
  never changes OUTBOUND_MODE (treatments). .env, treatment-model.json and logs are preserved by upgrade.

  Why "Cannot create a file when that file already exists" while Get-ScheduledTask found nothing: a task with that name existed
  (created elevated / as SYSTEM by the first install) but was not visible to a non-elevated PowerShell, and Register-ScheduledTask
  without -Force refuses to overwrite it. This script requires Administrator for install/upgrade so it can see every task, and only
  replaces the task when it is recognisably ours.

  Why the worker stopped with task result 3221225786 (0xC000013A, STATUS_CONTROL_C_EXIT) and stayed down (0.3.0): the task ran
  cmd.exe -> node in a VISIBLE console of the logged-on user; closing that window (or a Ctrl+C / logoff signal) ended it, and Task
  Scheduler's "restart on failure" only retries a task that fails to START, never a program that exits. Since 0.4.0 the task runs
  this script with -Action run in a hidden window: a supervisor loop that restarts node after any exit (backoff 10 s .. 5 min),
  waits while another worker holds logs\worker.lock (exit code 3), and logs every start/exit to logs\supervisor.log.
#>
[CmdletBinding()]
param(
  [ValidateSet('status', 'install', 'start', 'stop', 'restart', 'logs', 'upgrade', 'cms-off', 'cms-on', 'run')]
  [string]$Action = 'status',
  [string]$Dir = 'C:\GVET\delpro-worker',
  [string]$Zip,
  [string]$Source,
  [string]$User,
  [switch]$StopRunning,
  [switch]$Follow,
  [int]$Tail = 40
)

$ErrorActionPreference = 'Stop'
$TaskName = 'GVET-DelPro-Worker'
$Marker = 'GVET-DelPro-Worker (managed by scripts\gvet-worker.ps1)'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Say([string]$m) { Write-Host $m }
function Ok([string]$m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Bad([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Stop-Script([string]$m) { Write-Host "STOPPED: $m" -ForegroundColor Red; exit 1 }

function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Read-DotEnv([string]$path) {
  $h = @{}
  if (-not (Test-Path $path)) { return $h }
  foreach ($line in [IO.File]::ReadAllLines($path)) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') { $h[$Matches[1]] = $Matches[2] }
  }
  return $h
}

# Sets KEY=VALUE in .env (replaces that one line, or appends). Every other line is kept byte for byte.
function Set-DotEnvValue([string]$path, [string]$key, [string]$value, [switch]$OnlyIfMissing) {
  $text = [IO.File]::ReadAllText($path)
  $pattern = "(?m)^\s*$([regex]::Escape($key))\s*=.*$"
  if ([regex]::IsMatch($text, $pattern)) {
    if ($OnlyIfMissing) { return $false }
    $text = [regex]::Replace($text, $pattern, "$key=$value")
  } else {
    if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $text += "`r`n" }
    $text += "$key=$value`r`n"
  }
  [IO.File]::WriteAllText($path, $text, $Utf8)
  return $true
}

function Get-OurTasks {
  # every task with this name, in any folder (needs Administrator to see tasks created by other accounts / SYSTEM)
  return @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq $TaskName })
}

function Test-IsOurTask($task) {
  if ($task.Description -like "*managed by scripts\gvet-worker.ps1*") { return $true }
  $a = Get-TaskActionText $task
  # the earlier hand-made task from DEPLOY-WINDOWS.md section 7: node src\index.js in a delpro-worker folder
  return (($a -match 'delpro-worker' -and $a -match 'index\.js') -or ($a -match 'gvet-worker\.ps1' -and $a -match '-Action run'))
}

function Get-TaskActionText($task) {
  return ($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' '
}

# 0.4.0: the task runs the supervisor (this script, -Action run) in a hidden window
function New-WorkerTaskAction {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $Dir 'scripts\gvet-worker.ps1'
  $arg = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Action run -Dir `"$Dir`""
  return New-ScheduledTaskAction -Execute $ps -Argument $arg -WorkingDirectory $Dir
}

function New-WorkerTaskSettings {
  # restart-on-failure only covers a failed launch; the supervisor loop restarts node itself
  return New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
}

function Get-SupervisorProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessId -ne $PID -and $_.CommandLine -match 'gvet-worker\.ps1' -and $_.CommandLine -match '-Action\s+run'
    })
}

function Get-HiddenTaskHint {
  # Windows PowerShell 5.1 turns redirected native stderr into a terminating error under 'Stop'
  $ErrorActionPreference = 'Continue'
  $out = & schtasks.exe /Query /TN $TaskName 2>&1
  if ($LASTEXITCODE -eq 0) { return 'schtasks sees the task but Get-ScheduledTask does not' }
  if ("$out" -match 'denied|draud|negalima') { return 'a task with this name exists but this account may not read it (run as Administrator)' }
  if (Test-Path (Join-Path $env:windir "System32\Tasks\$TaskName")) { return "file $env:windir\System32\Tasks\$TaskName exists" }
  return $null
}

function Get-WorkerProcesses {
  # continuous workers only (one-shot commands like cms:live / catalog are not counted)
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -match 'src[\\/]index\.js' -and $_.CommandLine -notmatch '--(once|catalog|cms-|write-|dry-run)'
    })
}

function Get-WorkerServices {
  return @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.PathName -match 'delpro-worker' -or $_.Name -match 'GVET' })
}

function Get-LockInfo {
  $f = Join-Path $Dir 'logs\worker.lock'
  if (-not (Test-Path $f)) { return $null }
  $pidText = ([IO.File]::ReadAllText($f)).Trim()
  $age = [int]((Get-Date) - (Get-Item $f).LastWriteTime).TotalSeconds
  return [pscustomobject]@{ Pid = [int]$pidText; AgeSec = $age }
}

function Stop-Worker {
  foreach ($t in @(Get-OurTasks)) {
    if (Test-IsOurTask $t) {
      if ($t.State -eq 'Running') { Say "Stopping task $($t.TaskPath)$($t.TaskName)"; Stop-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath }
    }
  }
  # the supervisor first (it would restart node), then node
  foreach ($s in @(Get-SupervisorProcesses)) {
    Say "Stopping supervisor PID $($s.ProcessId)"
    Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 3
  # the task runs cmd.exe -> node.exe; stopping the task may leave node running, so stop our node too
  $lock = Get-LockInfo
  foreach ($p in @(Get-WorkerProcesses)) {
    $ours = ($lock -and $p.ProcessId -eq $lock.Pid) -or ($p.CommandLine -match '--service')
    if ($ours -or $StopRunning) {
      Say "Stopping worker process PID $($p.ProcessId)"
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    } else {
      Warn "Worker process PID $($p.ProcessId) was not started by the task ($($p.CommandLine)). Close its window, or re-run with -StopRunning."
    }
  }
  Start-Sleep -Seconds 1
}

function Start-Worker {
  $running = @(Get-WorkerProcesses)
  if ($running.Count -gt 0) { Warn "A worker is already running (PID $($running[0].ProcessId)) - not starting another."; return }
  $sup = @(Get-SupervisorProcesses)
  if ($sup.Count -gt 0) { Warn "The supervisor is already running (PID $($sup[0].ProcessId)); it starts the worker itself."; return }
  $t = @(Get-OurTasks) | Where-Object { Test-IsOurTask $_ } | Select-Object -First 1
  if (-not $t) { Stop-Script "Task $TaskName not found. Run -Action install (as Administrator)." }
  Start-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath
  Say 'Started. Waiting 10 s for the first log lines...'
  Start-Sleep -Seconds 10
}

function Test-Url([string]$name, [string]$url, [hashtable]$headers) {
  try {
    $r = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec 15
    Ok "$name reachable (HTTP $($r.StatusCode))"
    return $true
  } catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code) { Bad "$name answered HTTP $code" } else { Bad "$name not reachable: $($_.Exception.Message)" }
    return $false
  }
}

function Show-Status {
  Say "== GVET DelPro worker: $Dir"
  if (-not (Test-Admin)) { Warn 'Not running as Administrator - tasks created by other accounts may be invisible.' }
  if (Test-Path (Join-Path $Dir 'src\index.js')) {
    $ver = (Get-Content (Join-Path $Dir 'package.json') -Raw | ConvertFrom-Json).version
    $cms = Test-Path (Join-Path $Dir 'src\cms-separation.js')
    Ok "Installed: version $ver, CMS module: $cms"
  } else { Bad "No worker in $Dir" }

  $envFile = Join-Path $Dir '.env'
  $e = Read-DotEnv $envFile
  if ($e.Count -eq 0) { Bad '.env missing or empty' } else {
    Ok (".env: OUTBOUND_MODE={0}  CMS_OUTBOUND_MODE={1}  CATALOG_SOURCE={2}  DELPRO_SOURCE={3}" -f $e['OUTBOUND_MODE'], $e['CMS_OUTBOUND_MODE'], $e['CATALOG_SOURCE'], $e['DELPRO_SOURCE'])
    if (-not $e['SUPABASE_URL'] -or -not $e['SUPABASE_SERVICE_ROLE_KEY']) { Bad '.env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing' }
  }
  if (Test-Path (Join-Path $Dir 'treatment-model.json')) { Ok 'treatment-model.json present' } else { Warn 'treatment-model.json missing (treatments are not sent without it)' }

  $tasks = @(Get-OurTasks)
  if ($tasks.Count -eq 0) {
    $hint = Get-HiddenTaskHint
    if ($hint) { Warn "Task not visible: $hint" } else { Warn "No scheduled task $TaskName" }
  }
  foreach ($t in $tasks) {
    $i = Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath
    $trig = ($t.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace 'MSFT_Task', '' }) -join ','
    $line = "Task $($t.TaskPath)$($t.TaskName): $($t.State), user $($t.Principal.UserId), trigger $trig, last run $($i.LastRunTime) result $($i.LastTaskResult)"
    if (Test-IsOurTask $t) { Ok $line } else { Warn "$line  (NOT created by this script - left untouched)"; continue }
    if ($trig -match 'LogonTrigger') { Ok 'Startup: task starts at Windows logon' } else { Bad 'Startup: task has no logon trigger - run -Action install' }
    if ((Get-TaskActionText $t) -match 'gvet-worker\.ps1' -and (Get-TaskActionText $t) -match '-Action run') { Ok 'Startup: task runs the supervisor (restarts the worker after any exit)' }
    else { Warn 'Startup: task runs node directly (0.3.0 style, not restarted after an exit) - run -Action upgrade or -Action install' }
    if ($i.LastTaskResult -eq 3221225786) { Warn 'Last result 0xC000013A: the worker console was closed / got Ctrl+C (fixed by the hidden supervisor)' }
  }
  $sups = @(Get-SupervisorProcesses)
  if ($sups.Count -gt 0) { Ok "Supervisor running (PID $($sups[0].ProcessId))" } elseif ($tasks.Count -gt 0) { Warn 'Supervisor not running' }
  if ($sups.Count -gt 1) { Bad "$($sups.Count) supervisors running" }
  foreach ($s in @(Get-WorkerServices)) { Warn "Windows service $($s.Name) [$($s.State)] $($s.PathName)" }

  $procs = @(Get-WorkerProcesses)
  if ($procs.Count -eq 0) { Warn 'No worker process running' }
  if ($procs.Count -gt 1) { Bad "$($procs.Count) worker processes running - duplicates!" }
  foreach ($p in $procs) {
    $by = 'manual'
    if ($p.CommandLine -match '--service') { $by = 'task' }
    Ok "Process PID $($p.ProcessId), started $($p.CreationDate), by $by"
  }
  $lock = Get-LockInfo
  if ($lock) {
    $lockAlive = @($procs | Where-Object { $_.ProcessId -eq $lock.Pid }).Count -gt 0
    if ($lockAlive) { Ok "lock: PID $($lock.Pid) (this worker), refreshed $($lock.AgeSec) s ago" }
    elseif ($lock.AgeSec -gt 120) { Say "  lock: PID $($lock.Pid), $($lock.AgeSec) s old - stale, the next start takes it over" }
    else { Warn "lock: PID $($lock.Pid) is not a running worker; it becomes stale in $(120 - $lock.AgeSec) s (or at once if that PID is not node.exe)" }
  }
  $sl = Join-Path $Dir 'logs\supervisor.log'
  if (Test-Path $sl) { Say "== last lines of $sl"; Get-Content $sl -Tail 5 }

  if ($e['SUPABASE_URL'] -and $e['SUPABASE_SERVICE_ROLE_KEY']) {
    $h = @{ apikey = $e['SUPABASE_SERVICE_ROLE_KEY']; Authorization = "Bearer $($e['SUPABASE_SERVICE_ROLE_KEY'])" }
    $base = $e['SUPABASE_URL'].TrimEnd('/')
    if (Test-Url 'GVET API' "$base/rest/v1/system_settings?select=setting_key&limit=1" $h) {
      try {
        $rows = Invoke-RestMethod -Uri "$base/rest/v1/system_settings?setting_key=in.(delpro_worker_last_seen_at,cms_live_last_refresh,cms_targeted_last_refresh,cms_outbound_enabled)&select=setting_key,setting_value" -Headers $h -TimeoutSec 15
        foreach ($r in $rows) {
          if ($r.setting_key -eq 'delpro_worker_last_seen_at' -and $r.setting_value) {
            $age = [int]((Get-Date).ToUniversalTime() - ([datetime]::Parse($r.setting_value)).ToUniversalTime()).TotalSeconds
            if ($age -lt 300) { Ok "GVET last heartbeat: $($r.setting_value) ($age s ago)" } else { Bad "GVET last heartbeat: $($r.setting_value) ($age s ago - worker not reporting)" }
          }
          if ($r.setting_key -eq 'cms_outbound_enabled') { Say "  GVET CMS sending switch: $($r.setting_value)" }
          if ($r.setting_key -eq 'cms_targeted_last_refresh' -and $r.setting_value) {
            $l = $r.setting_value | ConvertFrom-Json
            $msg = "CMS state read (targeted) $($l.finished_at): animals ok=$($l.ok) failed=$($l.failed)"
            if ($l.failed -gt 0) { Warn $msg } else { Ok $msg }
          }
          if ($r.setting_key -eq 'cms_live_last_refresh' -and $r.setting_value) {
            $l = $r.setting_value | ConvertFrom-Json
            Say "  (optional diagnostic) full DelPro scan $($l.finished_at): complete=$($l.complete) - not needed for sending"
          }
        }
      } catch { Warn "Could not read GVET status: $($_.Exception.Message)" }
    }
  }
  $gw = $e['DELPRO_GATEWAY_URL']
  if (-not $gw) { $gw = 'http://127.0.0.1:28080/GatewaySoapService' }
  [void](Test-Url 'DelPro Gateway (WSDL)' "$($gw)?wsdl" @{})

  $log = Join-Path $Dir 'logs\worker.log'
  if (Test-Path $log) { Say "== last lines of $log"; Get-Content $log -Tail 15 }
}

function Assert-Admin([string]$what) {
  if (-not (Test-Admin)) { Stop-Script "$what needs PowerShell started with 'Run as Administrator'." }
}

function Install-Worker {
  Assert-Admin 'install'
  if (-not (Test-Path (Join-Path $Dir 'src\index.js'))) { Stop-Script "No worker in $Dir" }
  if (-not (Test-Path (Join-Path $Dir '.env'))) { Stop-Script "$Dir\.env missing (copy .env.example and fill it in)" }
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) { Stop-Script 'node.exe not found in PATH (install Node.js 22+)' }
  $nodeMajor = [int]((& $node --version).TrimStart('v').Split('.')[0])
  if ($nodeMajor -lt 22) { Stop-Script "Node.js $nodeMajor found, 22+ needed" }
  if (-not (Test-Path (Join-Path $Dir 'node_modules\fast-xml-parser'))) {
    Say 'Installing dependencies (npm ci --omit=dev)...'
    Push-Location $Dir; try { & npm.cmd ci --omit=dev; if ($LASTEXITCODE -ne 0) { Stop-Script 'npm ci failed' } } finally { Pop-Location }
  }

  $svc = @(Get-WorkerServices | Where-Object { $_.State -eq 'Running' })
  if ($svc.Count -gt 0) { Stop-Script "Windows service $($svc[0].Name) runs a worker - stop/disable it first (nssm stop / sc config start=disabled). Nothing changed." }

  $tasks = @(Get-OurTasks)
  $foreign = @($tasks | Where-Object { -not (Test-IsOurTask $_) })
  if ($foreign.Count -gt 0) { Stop-Script "A task named $TaskName exists that this script did not create ($($foreign[0].TaskPath)). It is left untouched - rename/remove it yourself in Task Scheduler." }
  if ($tasks.Count -eq 0) {
    $hint = Get-HiddenTaskHint
    if ($hint) { Stop-Script "Task name already taken but not readable: $hint. Open Task Scheduler as Administrator and check it." }
  }

  Stop-Worker
  $left = @(Get-WorkerProcesses)
  if ($left.Count -gt 0) { Stop-Script "A worker is still running (PID $($left[0].ProcessId)). Close it or re-run with -StopRunning. Nothing registered." }

  if (-not $User) { $User = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
  New-Item -ItemType Directory -Force (Join-Path $Dir 'logs') | Out-Null
  $action = New-WorkerTaskAction
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
  $settings = New-WorkerTaskSettings
  # -Force only replaces OUR task (checked above); a foreign one stopped the script already
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "$Marker; dir=$Dir" -Force | Out-Null
  Ok "Task $TaskName registered: at logon of $User, hidden supervisor in $Dir (node loads $Dir\.env itself)"
  Start-Worker
  Show-Status
}

function Upgrade-Worker {
  Assert-Admin 'upgrade'
  if ($Zip) {
    $tmp = Join-Path $env:TEMP ("gvet-worker-" + (Get-Date -Format yyyyMMddHHmmss))
    Unblock-File $Zip
    Expand-Archive -Path $Zip -DestinationPath $tmp
    $Source = Join-Path $tmp 'delpro-worker'
  }
  if (-not $Source -or -not (Test-Path (Join-Path $Source 'src\index.js'))) { Stop-Script 'Give -Zip <package.zip> or -Source <extracted>\delpro-worker' }
  if ((Resolve-Path $Source).Path -eq (Resolve-Path $Dir).Path) { Stop-Script '-Source must be the extracted NEW package, not the installed folder' }
  if (-not (Test-Path (Join-Path $Dir '.env'))) { Stop-Script "$Dir\.env missing - is this the right folder?" }

  $hadTask = @(Get-OurTasks | Where-Object { Test-IsOurTask $_ }).Count -gt 0
  Stop-Worker
  if (@(Get-WorkerProcesses).Count -gt 0) { Stop-Script 'A worker is still running - close it or re-run with -StopRunning. Nothing changed.' }

  $backup = Join-Path (Split-Path $Dir -Parent) ("backup\delpro-worker-" + (Get-Date -Format yyyyMMdd-HHmmss))
  New-Item -ItemType Directory -Force $backup | Out-Null
  foreach ($item in 'src', 'queries', 'scripts', 'package.json', 'package-lock.json', '.env', 'treatment-model.json') {
    $p = Join-Path $Dir $item
    if (Test-Path $p) { Copy-Item $p (Join-Path $backup $item) -Recurse -Force }
  }
  Ok "Backup: $backup"

  # code only; .env, treatment-model.json, logs, discovery, dry-run, node_modules stay
  Remove-Item (Join-Path $Dir 'src') -Recurse -Force
  Copy-Item (Join-Path $Source 'src') (Join-Path $Dir 'src') -Recurse
  New-Item -ItemType Directory -Force (Join-Path $Dir 'queries'), (Join-Path $Dir 'scripts') | Out-Null
  Copy-Item (Join-Path $Source 'queries\*') (Join-Path $Dir 'queries') -Force
  Copy-Item (Join-Path $Source 'scripts\*') (Join-Path $Dir 'scripts') -Force
  foreach ($f in 'package.json', 'package-lock.json', '.env.example', 'README.md', 'DEPLOY-WINDOWS.md') {
    if (Test-Path (Join-Path $Source $f)) { Copy-Item (Join-Path $Source $f) (Join-Path $Dir $f) -Force }
  }
  $envFile = Join-Path $Dir '.env'
  $defaults = [ordered]@{
    CMS_OUTBOUND_MODE = 'off'; CMS_POLL_INTERVAL_SEC = '5'; CMS_DEFAULT_SORT_AREA_KEY = '1'; CMS_LIVE_INTERVAL_MIN = '60'
    CMS_LIVE_MAX_ROWS = '20000'; DELPRO_GATEWAY_ANIMAL_ORN_PROPERTY = 'OfficialRegNumber'
    CMS_LIVE_MILK_BULK_TOP = '1000'; CMS_LIVE_CONCURRENCY = '3'; CMS_LIVE_READ_ATTEMPTS = '2'
    CMS_BATCH_LIMIT = '10'; CMS_CONCURRENCY = '2'; CMS_REFRESH_BATCH = '50'; CMS_REFRESH_POLL_SEC = '30'
  }
  foreach ($k in $defaults.Keys) { if (Set-DotEnvValue $envFile $k $defaults[$k] -OnlyIfMissing) { Say "  .env: added $k=$($defaults[$k])" } }

  Push-Location $Dir
  try {
    & npm.cmd ci --omit=dev; if ($LASTEXITCODE -ne 0) { Stop-Script "npm ci failed - restore from $backup" }
    & node.exe --check src\index.js; if ($LASTEXITCODE -ne 0) { Stop-Script "src\index.js does not parse - restore from $backup" }
  } finally { Pop-Location }
  Ok 'Code updated (.env values unchanged, treatment-model.json and logs kept)'
  if ($hadTask) {
    # the existing task is reused: only its action (-> hidden supervisor) and settings change; trigger, user and name stay
    $t = @(Get-OurTasks) | Where-Object { Test-IsOurTask $_ } | Select-Object -First 1
    try {
      Set-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Action (New-WorkerTaskAction) -Settings (New-WorkerTaskSettings) | Out-Null
      Ok "Task $($t.TaskPath)$($t.TaskName) now runs the supervisor (same trigger and user)"
    } catch {
      Warn "Could not update the task action ($($_.Exception.Message)) - run -Action install to re-register it."
    }
    Start-Worker; Show-Status
  } else { Warn 'No task yet - run -Action install' }
}

function Set-CmsOff {
  $envFile = Join-Path $Dir '.env'
  if (-not (Test-Path $envFile)) { Stop-Script "$envFile missing" }
  [void](Set-DotEnvValue $envFile 'CMS_OUTBOUND_MODE' 'off')
  Ok 'CMS_OUTBOUND_MODE=off (OUTBOUND_MODE for treatments not changed)'
  Warn 'Separations already created in DelPro are NOT cancelled - disable them in DelPro.'
  if (@(Get-WorkerProcesses).Count -gt 0) { Stop-Worker; Start-Worker }
}

function Set-CmsOn {
  $envFile = Join-Path $Dir '.env'
  if (-not (Test-Path $envFile)) { Stop-Script "$envFile missing" }
  Say 'This lets the worker WRITE approved CMS separations (SortCow) to DelPro. GVET still decides which jobs: its CMS switch,'
  Say 'admin approval, verified mode and the physical destination confirmation. Treatments (OUTBOUND_MODE) are not changed.'
  $answer = Read-Host 'Type GATEWAY to enable'
  if ($answer -cne 'GATEWAY') { Stop-Script 'Not confirmed - nothing changed.' }
  [void](Set-DotEnvValue $envFile 'CMS_OUTBOUND_MODE' 'gateway')
  Ok 'CMS_OUTBOUND_MODE=gateway'
  Stop-Worker; Start-Worker; Show-Status
}

function Write-Sup([string]$m) {
  try { Add-Content -Path (Join-Path $Dir 'logs\supervisor.log') -Value "$((Get-Date).ToString('s')) $m" -Encoding UTF8 } catch { }
}

function Invoke-Rotate([string]$path) {
  try {
    if ((Test-Path $path) -and (Get-Item $path).Length -gt 20MB) { Move-Item $path "$path.1" -Force }
  } catch { }
}

# The scheduled task's action (hidden window): keeps ONE worker running. node's own lock decides who runs (exit code 3 = another
# worker holds it -> wait); any other exit -> restart with backoff. Never kills anything.
function Invoke-Supervisor {
  Set-Location $Dir
  New-Item -ItemType Directory -Force (Join-Path $Dir 'logs') | Out-Null
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Sup 'node.exe not found in PATH - waiting 5 min'; Start-Sleep -Seconds 300; exit 1 }
  $others = @(Get-SupervisorProcesses)
  if ($others.Count -gt 0) { Write-Sup "another supervisor runs (PID $($others[0].ProcessId)) - exiting"; exit 0 }
  Write-Sup "supervisor started (PID $PID, $node)"
  $delay = 10
  while ($true) {
    Invoke-Rotate (Join-Path $Dir 'logs\worker.log')
    $started = Get-Date
    $ErrorActionPreference = 'Continue'
    & (Join-Path $Dir 'scripts\run-worker.cmd') $node
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $ran = [int]((Get-Date) - $started).TotalSeconds
    if ($code -eq 3) {
      Write-Sup 'another worker holds logs\worker.lock - checking again in 60 s'
      Start-Sleep -Seconds 60
      continue
    }
    if ($ran -gt 600) { $delay = 10 } else { $delay = [Math]::Min($delay * 2, 300) }
    Write-Sup "worker exited with code $code after $ran s - restarting in $delay s"
    Start-Sleep -Seconds $delay
  }
}

switch ($Action) {
  'status' { Show-Status }
  'install' { Install-Worker }
  'stop' { Stop-Worker; Show-Status }
  'start' { Start-Worker; Show-Status }
  'restart' { Stop-Worker; Start-Worker; Show-Status }
  'logs' {
    $log = Join-Path $Dir 'logs\worker.log'
    if ($Follow) { Get-Content $log -Tail $Tail -Wait } else { Get-Content $log -Tail $Tail }
  }
  'upgrade' { Upgrade-Worker }
  'cms-off' { Set-CmsOff }
  'cms-on' { Set-CmsOn }
  'run' { Invoke-Supervisor }
}

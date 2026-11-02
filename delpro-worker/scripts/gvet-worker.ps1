<#
  GVET DelPro worker - install / repair / status / upgrade on the farm PC (Windows PowerShell 5.1+).

    powershell -ExecutionPolicy Bypass -File C:\GVET\delpro-worker\scripts\gvet-worker.ps1 -Action status
    ... -Action install  [-StopRunning]          (as Administrator; idempotent - safe to run again)
    ... -Action stop | start | restart | logs [-Follow]
    ... -Action upgrade -Source <extracted package>\delpro-worker   (or -Zip <package.zip>)
    ... -Action cms-off                            (emergency: CMS_OUTBOUND_MODE=off + restart; treatments untouched)

  Rules: never deletes or replaces a scheduled task it did not create, never starts a second worker, never prints secrets,
  never changes OUTBOUND_MODE (treatments). .env, treatment-model.json and logs are preserved by upgrade.

  Why "Cannot create a file when that file already exists" while Get-ScheduledTask found nothing: a task with that name existed
  (created elevated / as SYSTEM by the first install) but was not visible to a non-elevated PowerShell, and Register-ScheduledTask
  without -Force refuses to overwrite it. This script requires Administrator for install/upgrade so it can see every task, and only
  replaces the task when it is recognisably ours.
#>
[CmdletBinding()]
param(
  [ValidateSet('status', 'install', 'start', 'stop', 'restart', 'logs', 'upgrade', 'cms-off')]
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
  $a = ($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' '
  # the earlier hand-made task from DEPLOY-WINDOWS.md section 7: node src\index.js in a delpro-worker folder
  return ($a -match 'delpro-worker' -and $a -match 'index\.js')
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
    if (Test-IsOurTask $t) { Ok $line } else { Warn "$line  (NOT created by this script - left untouched)" }
  }
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
  if ($lock) { Say "  lock: PID $($lock.Pid), refreshed $($lock.AgeSec) s ago" }

  if ($e['SUPABASE_URL'] -and $e['SUPABASE_SERVICE_ROLE_KEY']) {
    $h = @{ apikey = $e['SUPABASE_SERVICE_ROLE_KEY']; Authorization = "Bearer $($e['SUPABASE_SERVICE_ROLE_KEY'])" }
    $base = $e['SUPABASE_URL'].TrimEnd('/')
    if (Test-Url 'GVET API' "$base/rest/v1/system_settings?select=setting_key&limit=1" $h) {
      try {
        $rows = Invoke-RestMethod -Uri "$base/rest/v1/system_settings?setting_key=in.(delpro_worker_last_seen_at,cms_live_last_refresh,cms_outbound_enabled)&select=setting_key,setting_value" -Headers $h -TimeoutSec 15
        foreach ($r in $rows) {
          if ($r.setting_key -eq 'delpro_worker_last_seen_at') { Say "  GVET last heartbeat: $($r.setting_value)" }
          if ($r.setting_key -eq 'cms_outbound_enabled') { Say "  GVET CMS sending switch: $($r.setting_value)" }
          if ($r.setting_key -eq 'cms_live_last_refresh' -and $r.setting_value) {
            $l = $r.setting_value | ConvertFrom-Json
            $msg = "CMS live read $($l.finished_at): complete=$($l.complete), SortCow=$($l.received), matched=$($l.matched), unmatched=$($l.unmatched_animals)"
            if ($l.complete) { Ok $msg } else { Warn $msg }
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
  $arg = "/d /s /c `"`"$node`" src\index.js --service >> logs\worker.log 2>&1`""
  $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument $arg -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  # -Force only replaces OUR task (checked above); a foreign one stopped the script already
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "$Marker; dir=$Dir" -Force | Out-Null
  Ok "Task $TaskName registered: at logon of $User, working directory $Dir (node loads $Dir\.env itself)"
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
  }
  foreach ($k in $defaults.Keys) { if (Set-DotEnvValue $envFile $k $defaults[$k] -OnlyIfMissing) { Say "  .env: added $k=$($defaults[$k])" } }

  Push-Location $Dir
  try {
    & npm.cmd ci --omit=dev; if ($LASTEXITCODE -ne 0) { Stop-Script "npm ci failed - restore from $backup" }
    & node.exe --check src\index.js; if ($LASTEXITCODE -ne 0) { Stop-Script "src\index.js does not parse - restore from $backup" }
  } finally { Pop-Location }
  Ok 'Code updated (.env values unchanged, treatment-model.json and logs kept)'
  if ($hadTask) { Install-Worker } else { Warn 'No task yet - run -Action install' }
}

function Set-CmsOff {
  $envFile = Join-Path $Dir '.env'
  if (-not (Test-Path $envFile)) { Stop-Script "$envFile missing" }
  [void](Set-DotEnvValue $envFile 'CMS_OUTBOUND_MODE' 'off')
  Ok 'CMS_OUTBOUND_MODE=off (OUTBOUND_MODE for treatments not changed)'
  Warn 'Separations already created in DelPro are NOT cancelled - disable them in DelPro.'
  if (@(Get-WorkerProcesses).Count -gt 0) { Stop-Worker; Start-Worker }
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
}

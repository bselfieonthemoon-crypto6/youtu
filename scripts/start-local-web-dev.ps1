<#
  Local web development server for http://localhost:3020.

  The previous local flow served a STATIC EXPORT (`apps/web/out`) through a
  Python file server, so every frontend edit needed a full `next build` plus a
  copy of `.next-local-replica` into `out/` before anything changed. That is why
  frontend work felt slow.

  This launcher runs `next dev` instead: hot reload, no build and no copy step.
  `LOOMIC_NEXT_SERVER_MODE=true` disables `output: "export"` in next.config.ts,
  which is required for the dev server. The application is fully client-rendered
  (no route handlers, no middleware), so dev and export behave the same at
  runtime.

  Use the static-export path only when you actually need a production bundle:
      scripts/build-local-production-web.ps1   (then serve the export yourself)
#>
param(
  [int]$Port = 3020,
  [Nullable[int]]$HeapLimitMB
)
$ErrorActionPreference = 'Stop'
$taskMemoryHelper = Join-Path $PSScriptRoot 'local-node-memory.ps1'
. $taskMemoryHelper
# Must run before any Start-Process: see the helper for why.
Remove-DuplicateProxyEnvironment
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskWeb = Join-Path $taskRoot 'apps/web'
$taskLogs = Join-Path $taskRoot 'artifacts/local-replica-20260907'
$taskEnvFile = Join-Path $taskLogs 'app.env'
if (-not (Test-Path -LiteralPath $taskEnvFile)) { throw 'Local replica configuration is missing.' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $Port is occupied; this script never stops existing work. Stop the current web server first."
}
$taskPriorEnv = @{}
foreach ($taskName in @('NODE_ENV', 'LOOMIC_NEXT_SERVER_MODE', 'LOOMIC_NEXT_DIST_DIR')) {
  $taskPriorEnv[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process')
}
try {
  $taskHeapMB = Set-LocalNodeHeapLimit -ServiceName 'web_dev' -DefaultHeapLimitMB 2048 -ExplicitHeapLimitMB $HeapLimitMB
  $env:NODE_ENV = 'development'
  # Turns the static export off, which the dev server requires.
  $env:LOOMIC_NEXT_SERVER_MODE = 'true'
  # Dev artefacts stay out of the export directory used for release builds.
  $env:LOOMIC_NEXT_DIST_DIR = '.next'
  $taskProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList @(
    "--env-file=$taskEnvFile",
    "--max-old-space-size=$taskHeapMB",
    'node_modules/next/dist/bin/next', 'dev', '-p', "$Port", '-H', 'localhost'
  ) -WorkingDirectory $taskWeb -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $taskLogs 'web-dev.stdout.log') `
    -RedirectStandardError (Join-Path $taskLogs 'web-dev.stderr.log')

  $taskReady = $false
  $taskDeadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $taskDeadline) {
    $taskProcess.Refresh()
    if ($taskProcess.HasExited) { throw 'Web dev server exited during startup; inspect artifacts/local-replica-20260907/web-dev.stderr.log.' }
    try {
      $taskProbe = Invoke-WebRequest -Uri "http://localhost:$Port/login" -TimeoutSec 2 -UseBasicParsing
      if ($taskProbe.StatusCode -eq 200) { $taskReady = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  if (-not $taskReady) { throw 'Web dev server started but is not answering yet; check the web-dev logs.' }
  Write-Output "Local web DEV server started: PID $($taskProcess.Id), http://localhost:$Port. Hot reload is on; no build or copy step. Node heap: ${taskHeapMB}MB."
} finally {
  foreach ($taskName in $taskPriorEnv.Keys) {
    [Environment]::SetEnvironmentVariable($taskName, $taskPriorEnv[$taskName], 'Process')
  }
}

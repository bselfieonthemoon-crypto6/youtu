param([ValidatePattern('^\.next-production(?:-[a-zA-Z0-9-]+)?$')][string]$DistDir = '.next-production', [Nullable[int]]$HeapLimitMB)
$ErrorActionPreference = 'Stop'
$taskMemoryHelper = Join-Path $PSScriptRoot 'local-node-memory.ps1'
. $taskMemoryHelper
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskWeb = Join-Path $taskRoot 'apps/web'
$taskLogs = Join-Path $taskRoot 'artifacts/local-replica-20260907'
if (-not (Test-Path -LiteralPath (Join-Path $taskWeb "$DistDir/BUILD_ID"))) { throw 'Build the production web application first.' }
if (Get-NetTCPConnection -LocalPort 3020 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3020 is occupied; no existing process was stopped.' }
$taskOldNodeEnv = $env:NODE_ENV
$taskOldDist = $env:LOOMIC_NEXT_DIST_DIR
$taskOldMode = $env:LOOMIC_NEXT_SERVER_MODE
$taskOldNodeOptions = $env:NODE_OPTIONS
try {
  $taskConfiguredHeapMB = Set-LocalNodeHeapLimit -ServiceName 'web' -DefaultHeapLimitMB 1024 -ExplicitHeapLimitMB $HeapLimitMB
  $env:NODE_ENV = 'production'
  $env:LOOMIC_NEXT_DIST_DIR = $DistDir
  $env:LOOMIC_NEXT_SERVER_MODE = 'true'
  $taskProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList @(
    '--env-file=../../artifacts/local-replica-20260907/app.env',
    "--max-old-space-size=$taskConfiguredHeapMB",
    'node_modules/next/dist/bin/next', 'start', '-p', '3020', '-H', 'localhost'
  ) -WorkingDirectory $taskWeb -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $taskLogs 'production-web.stdout.log') `
    -RedirectStandardError (Join-Path $taskLogs 'production-web.stderr.log')
  Write-Output "Local production web started: PID $($taskProcess.Id), http://localhost:3020. Node heap configured: ${taskConfiguredHeapMB}MB."
} finally {
  $env:NODE_ENV = $taskOldNodeEnv
  $env:LOOMIC_NEXT_DIST_DIR = $taskOldDist
  $env:LOOMIC_NEXT_SERVER_MODE = $taskOldMode
  $env:NODE_OPTIONS = $taskOldNodeOptions
}

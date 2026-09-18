param([Nullable[int]]$HeapLimitMB)
$ErrorActionPreference = 'Stop'
$taskMemoryHelper = Join-Path $PSScriptRoot 'local-node-memory.ps1'
. $taskMemoryHelper
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskServer = Join-Path $taskRoot 'apps/server'
$taskLogs = Join-Path $taskRoot 'artifacts/local-replica-20260907'
if (-not (Test-Path -LiteralPath (Join-Path $taskLogs 'app.env'))) { throw 'Local replica configuration is missing.' }
$taskWorkers = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -like '*--env-file=../../artifacts/local-replica-20260907/app.env*' -and $_.CommandLine -match '\bsrc/worker\.ts(?:\s|$)'
}
if ($taskWorkers) { throw 'Local replica worker already exists; inspect active jobs before stopping an exact process.' }
$taskPriorNodeOptions = $env:NODE_OPTIONS
$taskConfiguredHeapMB = Set-LocalNodeHeapLimit -ServiceName 'worker' -DefaultHeapLimitMB 1536 -ExplicitHeapLimitMB $HeapLimitMB
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
try {
  $taskProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList @(
    '--env-file=../../artifacts/local-replica-20260907/app.env', "--max-old-space-size=$taskConfiguredHeapMB", '--import', 'tsx', 'src/worker.ts'
  ) -WorkingDirectory $taskServer -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $taskLogs "boundary-worker-$taskStamp.stdout.log") `
    -RedirectStandardError (Join-Path $taskLogs "boundary-worker-$taskStamp.stderr.log")
  Write-Output "Local replica worker started: PID $($taskProcess.Id). Logs: boundary-worker-$taskStamp. Node heap configured: ${taskConfiguredHeapMB}MB."
} finally {
  $env:NODE_OPTIONS = $taskPriorNodeOptions
}

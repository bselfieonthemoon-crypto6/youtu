param(
  [ValidateSet('mastra')][string]$AgentRuntime = 'mastra',
  [ValidateSet('legacy', 'observational')][string]$MemoryMode = 'legacy',
  [Nullable[int]]$HeapLimitMB
)
$ErrorActionPreference = 'Stop'
$taskMemoryHelper = Join-Path $PSScriptRoot 'local-node-memory.ps1'
. $taskMemoryHelper
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskServer = Join-Path $taskRoot 'apps/server'
$taskLogs = Join-Path $taskRoot 'artifacts/local-replica-20260907'
if (-not (Test-Path -LiteralPath (Join-Path $taskLogs 'app.env'))) { throw 'Local replica configuration is missing.' }
if (Get-NetTCPConnection -LocalPort 3002 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3002 is occupied; this script never stops existing work.' }
$taskPriorRuntime = $env:LOOMIC_AGENT_RUNTIME
$taskPriorMemoryMode = $env:LOOMIC_MASTRA_MEMORY_MODE
$taskPriorMemoryDatabase = $env:LOOMIC_MASTRA_MEMORY_DATABASE_URL
$taskPriorNodeOptions = $env:NODE_OPTIONS
try {
  $taskConfiguredHeapMB = Set-LocalNodeHeapLimit -ServiceName 'api' -DefaultHeapLimitMB 1024 -ExplicitHeapLimitMB $HeapLimitMB
  $env:LOOMIC_AGENT_RUNTIME = $AgentRuntime
  $env:LOOMIC_MASTRA_MEMORY_MODE = $MemoryMode
  if ($MemoryMode -eq 'observational') {
    if ($AgentRuntime -ne 'mastra') { throw 'Observational memory requires the Mastra runtime.' }
    # This launcher is explicitly local-only. Never infer a cloud connection
    # from .env.local or print credentials into terminal output.
    $taskDbContainer = @(docker inspect supabase_db_thtdhcvjppuvlvahfmga | ConvertFrom-Json)[0]
    if (-not $taskDbContainer.State.Running) { throw 'Local replica database is not running.' }
    $taskDbPort = $taskDbContainer.NetworkSettings.Ports.'5432/tcp' | Select-Object -First 1
    if ($taskDbPort.HostPort -ne '54322') { throw 'Unexpected local replica database port.' }
    $taskPasswordEntry = $taskDbContainer.Config.Env | Where-Object { $_.StartsWith('POSTGRES_PASSWORD=') } | Select-Object -First 1
    if (-not $taskPasswordEntry) { throw 'Local database credentials are unavailable.' }
    $taskDbPassword = [Uri]::EscapeDataString(($taskPasswordEntry -split '=',2)[1])
    $env:LOOMIC_MASTRA_MEMORY_DATABASE_URL = "postgresql://supabase_admin:${taskDbPassword}@127.0.0.1:54322/loomic_replica_light_20260907"
  }
  $taskProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList @(
    '--env-file=../../artifacts/local-replica-20260907/app.env', "--max-old-space-size=$taskConfiguredHeapMB", '--import', 'tsx', 'src/server.ts'
  ) -WorkingDirectory $taskServer -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $taskLogs 'conversation-api.stdout.log') `
    -RedirectStandardError (Join-Path $taskLogs 'conversation-api.stderr.log')
  $taskReady = $false
  $taskReadinessDeadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $taskReadinessDeadline) {
    $taskProcess.Refresh()
    if ($taskProcess.HasExited) { throw 'Local API exited during startup; inspect the local API logs.' }
    try {
      $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:3002/api/health' -TimeoutSec 1
      if ($taskHealth.ok -and $taskHealth.service -eq 'loomic-server') { $taskReady = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 250
  }
  if (-not $taskReady) { throw 'Local API started but is not ready yet; do not begin browser acceptance until health is ready.' }
  Write-Output "Local conversation API started: PID $($taskProcess.Id). Agent runtime: $AgentRuntime. Memory: $MemoryMode. Node heap configured: ${taskConfiguredHeapMB}MB."
} finally {
  $env:LOOMIC_AGENT_RUNTIME = $taskPriorRuntime
  $env:LOOMIC_MASTRA_MEMORY_MODE = $taskPriorMemoryMode
  $env:LOOMIC_MASTRA_MEMORY_DATABASE_URL = $taskPriorMemoryDatabase
  $env:NODE_OPTIONS = $taskPriorNodeOptions
}

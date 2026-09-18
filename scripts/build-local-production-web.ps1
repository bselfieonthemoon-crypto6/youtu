param([ValidatePattern('^\.next-production(?:-[a-zA-Z0-9-]+)?$')][string]$DistDir = '.next-production', [Nullable[int]]$HeapLimitMB)
$ErrorActionPreference = 'Stop'
$taskMemoryHelper = Join-Path $PSScriptRoot 'local-node-memory.ps1'
. $taskMemoryHelper
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOldNodeEnv = $env:NODE_ENV
$taskOldDist = $env:LOOMIC_NEXT_DIST_DIR
$taskOldMode = $env:LOOMIC_NEXT_SERVER_MODE
$taskOldNodeOptions = $env:NODE_OPTIONS
$taskOldBuildSerial = $env:LOOMIC_LOCAL_BUILD_SERIAL
Push-Location (Join-Path $taskRoot 'apps/web')
try {
  $taskConfiguredHeapMB = Set-LocalNodeHeapLimit -ServiceName 'production_build' -DefaultHeapLimitMB 2048 -ExplicitHeapLimitMB $HeapLimitMB
  $env:NODE_ENV = 'production'
  $env:LOOMIC_NEXT_DIST_DIR = $DistDir
  $env:LOOMIC_NEXT_SERVER_MODE = 'true'
  $env:LOOMIC_LOCAL_BUILD_SERIAL = 'true'
  & node --env-file=../../artifacts/local-replica-20260907/app.env "--max-old-space-size=$taskConfiguredHeapMB" node_modules/next/dist/bin/next build
  if ($LASTEXITCODE -ne 0) { throw 'Production build failed; do not stop the existing web service.' }
} finally {
  Pop-Location
  $env:NODE_ENV = $taskOldNodeEnv
  $env:LOOMIC_NEXT_DIST_DIR = $taskOldDist
  $env:LOOMIC_NEXT_SERVER_MODE = $taskOldMode
  $env:NODE_OPTIONS = $taskOldNodeOptions
  $env:LOOMIC_LOCAL_BUILD_SERIAL = $taskOldBuildSerial
}

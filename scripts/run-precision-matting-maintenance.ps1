$ErrorActionPreference = 'Stop'
$taskRoot = 'E:\Loomic\Loomic'
$taskOutput = Join-Path $taskRoot 'artifacts\matting-quality-20260908'
$taskWorkers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*local-replica-20260907/app.env*src/worker.ts*' })
if ($taskWorkers.Count -ne 1) { throw 'Expected exactly one local replica worker; inspect before pausing.' }
$taskWorkerId = $taskWorkers[0].ProcessId
$taskBusy = & docker exec supabase_db_thtdhcvjppuvlvahfmga psql -U supabase_admin -d loomic_replica_light_20260907 -Atc "select count(*) from background_jobs where status in ('queued','running');"
if ($LASTEXITCODE -ne 0 -or "$taskBusy".Trim() -ne '0') { throw 'Background jobs are active; maintenance not started.' }
$taskChildren = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $taskWorkerId -and $_.Name -eq 'python.exe' -and $_.CommandLine -like '*feynobg_worker.py*' })
$taskPaused = $false
$taskBench = $null
try {
    Stop-Process -Id $taskWorkerId -ErrorAction Stop
    $taskPaused = $true
    foreach ($taskChild in $taskChildren) { Stop-Process -Id $taskChild.ProcessId -ErrorAction SilentlyContinue }
    Write-Output 'Local job worker paused; web and API remain running.'
    $taskStartedAt = Get-Date
    $taskBench = Start-Process -FilePath (Get-Command python).Source -ArgumentList '-u','scripts/benchmark-precision-matting.py' -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskOutput 'precision-run.log') -RedirectStandardError (Join-Path $taskOutput 'precision-run.err.log') -PassThru
    $taskDeadline = (Get-Date).AddMinutes(10)
    while (-not $taskBench.HasExited) {
        if ((Get-Date) -gt $taskDeadline) { Stop-Process -Id $taskBench.Id; throw 'Precision trial exceeded 10 minutes.' }
        $taskMemory = Get-CimInstance Win32_OperatingSystem
        if ($taskMemory.FreePhysicalMemory -lt 512000) { Stop-Process -Id $taskBench.Id; throw 'Precision trial stopped to avoid memory pressure.' }
        Start-Sleep -Seconds 2
        $taskBench.Refresh()
    }
    # Do not mistake stale/partial results from an earlier run for success.
    $taskReport = Get-Item -LiteralPath (Join-Path $taskOutput 'precision-report.json')
    $taskSheet = Get-Item -LiteralPath (Join-Path $taskOutput 'precision-comparison.png')
    $taskResults = Get-Content -LiteralPath $taskReport.FullName -Raw | ConvertFrom-Json
    if ($taskReport.LastWriteTime -lt $taskStartedAt -or $taskSheet.LastWriteTime -lt $taskStartedAt -or $taskResults.results.Count -ne 2) { throw 'Precision trial did not produce fresh, complete results. Inspect logs.' }
    Write-Output "Precision process finished with two result files. PID: $($taskBench.Id)."
} finally {
    if ($taskBench -and -not $taskBench.HasExited) { Stop-Process -Id $taskBench.Id -ErrorAction SilentlyContinue }
    if ($taskPaused) {
        $taskRestored = Start-Process -FilePath (Get-Command node).Source -ArgumentList '--env-file=../../artifacts/local-replica-20260907/app.env','--import','tsx','src/worker.ts' -WorkingDirectory (Join-Path $taskRoot 'apps\server') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskOutput 'worker-restored.log') -RedirectStandardError (Join-Path $taskOutput 'worker-restored.err.log') -PassThru
        Write-Output "Local worker restarted. PID: $($taskRestored.Id). Verify worker-restored.log."
    }
}

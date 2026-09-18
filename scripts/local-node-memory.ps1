function Resolve-LocalNodeHeapLimit {
  param(
    [Parameter(Mandatory)][string]$ServiceName,
    [Parameter(Mandatory)][int]$DefaultHeapLimitMB,
    [Nullable[int]]$ExplicitHeapLimitMB
  )

  $taskEnvName = "LOOMIC_$($ServiceName.ToUpperInvariant())_HEAP_MB"
  $taskRawLimit = if ($null -ne $ExplicitHeapLimitMB) {
    [string]$ExplicitHeapLimitMB
  } elseif ([Environment]::GetEnvironmentVariable($taskEnvName)) {
    [Environment]::GetEnvironmentVariable($taskEnvName)
  } elseif ($env:LOOMIC_NODE_HEAP_MB) {
    [string]$env:LOOMIC_NODE_HEAP_MB
  } else {
    [string]$DefaultHeapLimitMB
  }

  $taskParsedLimit = 0
  if (-not [int]::TryParse($taskRawLimit, [ref]$taskParsedLimit) -or $taskParsedLimit -lt 128) {
    throw "Invalid Node heap limit for $ServiceName. Use an integer of at least 128 MB."
  }
  return $taskParsedLimit
}

function Set-LocalNodeHeapLimit {
  param(
    [Parameter(Mandatory)][string]$ServiceName,
    [Parameter(Mandatory)][int]$DefaultHeapLimitMB,
    [Nullable[int]]$ExplicitHeapLimitMB
  )

  $taskHeapLimitMB = Resolve-LocalNodeHeapLimit -ServiceName $ServiceName `
    -DefaultHeapLimitMB $DefaultHeapLimitMB -ExplicitHeapLimitMB $ExplicitHeapLimitMB
  $taskNodeOptions = [string]$env:NODE_OPTIONS
  # Remove every inherited heap flag, including the space-separated form, while
  # retaining all unrelated Node options. The explicit service value wins.
  $taskNodeOptions = [regex]::Replace($taskNodeOptions, '(?<!\S)--max[-_]old[-_]space[-_]size(?:=|\s+)["'']?\d+["'']?', '').Trim()
  $env:NODE_OPTIONS = (($taskNodeOptions, "--max-old-space-size=$taskHeapLimitMB") | Where-Object { $_ }) -join ' '
  return $taskHeapLimitMB
}

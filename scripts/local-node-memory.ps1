# Windows PowerShell 5.1's Start-Process rebuilds the child environment through a
# case-insensitive dictionary. An environment that defines BOTH `NO_PROXY` and
# `no_proxy` (common when proxy tooling writes the lowercase form) therefore makes
# EVERY Start-Process call fail with:
#   "Item has already been added. Key in dictionary: 'NO_PROXY'"
# which silently breaks every launcher in this folder. Collapse the duplicates
# once, here, so anything that dot-sources this module can start a service.
function Remove-DuplicateProxyEnvironment {
  foreach ($taskLowercaseName in @('no_proxy', 'http_proxy', 'https_proxy', 'all_proxy')) {
    $taskValue = [Environment]::GetEnvironmentVariable($taskLowercaseName, 'Process')
    if (-not $taskValue) { continue }
    $taskUppercaseName = $taskLowercaseName.ToUpperInvariant()
    # Keep the value: promote it only when the uppercase spelling is absent, then
    # drop the lowercase duplicate that breaks Start-Process.
    if (-not [Environment]::GetEnvironmentVariable($taskUppercaseName, 'Process')) {
      [Environment]::SetEnvironmentVariable($taskUppercaseName, $taskValue, 'Process')
    }
    [Environment]::SetEnvironmentVariable($taskLowercaseName, $null, 'Process')
  }
}

function Resolve-LocalNodeHeapLimit {  param(
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

# Applied on import so every launcher that dot-sources this module inherits the
# fix without each one having to call it. See Remove-DuplicateProxyEnvironment.
Remove-DuplicateProxyEnvironment

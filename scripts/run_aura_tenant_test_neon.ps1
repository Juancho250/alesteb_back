Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RedactedHost {
  param([Parameter(Mandatory = $true)][string]$HostName)
  $parts = $HostName.Split('.')
  if ($parts.Count -lt 2) { return ($HostName.Substring(0, [Math]::Min(4, $HostName.Length)) + '***') }
  $first = $parts[0]
  $safeFirst = $first.Substring(0, [Math]::Min(4, $first.Length)) + '***'
  return (@($safeFirst) + $parts[1..($parts.Count - 1)]) -join '.'
}

$branchUrl = $env:NEON_AURA_BRANCH_URL
if ([string]::IsNullOrWhiteSpace($branchUrl)) {
  throw 'NEON_AURA_BRANCH_URL is required.'
}
try { $branchUri = [uri]$branchUrl } catch { throw 'NEON_AURA_BRANCH_URL must be a valid PostgreSQL URL.' }

$hostName = $branchUri.Host
$databaseName = $branchUri.AbsolutePath.TrimStart('/')
if ([string]::IsNullOrWhiteSpace($hostName) -or [string]::IsNullOrWhiteSpace($databaseName)) {
  throw 'NEON_AURA_BRANCH_URL must include host and database.'
}
if ($hostName -match '(?i)pooler') { throw 'BLOCKER: pooled Neon URLs are not allowed for this test.' }
if ($hostName -match '(?i)(^|[.-])(prod|production|main)([.-]|$)' -or $databaseName -match '(?i)(prod|production|main)') {
  throw 'BLOCKER: target looks production-like.'
}

$psqlPath = (Get-Command psql -ErrorAction Stop).Source
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sqlPath = Join-Path $repoRoot 'scripts\aura_staging_tenant_test.sql'
if (-not (Test-Path -LiteralPath $sqlPath)) { throw "Missing SQL file: $sqlPath" }
$logsDir = Join-Path $repoRoot 'logs'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$logPath = Join-Path $logsDir "aura_staging_tenant_test_$timestamp.log"

Write-Host 'AURA Neon tenant integrity runner'
Write-Host "Target host: $(Get-RedactedHost -HostName $hostName)"
Write-Host "Target database: $databaseName"
Write-Host 'Mode: read-only transaction; no migrations are executed.'
$confirmation = Read-Host 'Type RUN-AURA-TENANT-TEST to continue'
if ($confirmation -ne 'RUN-AURA-TENANT-TEST') { throw 'Confirmation did not match. Aborting.' }

& $psqlPath $branchUrl -X -v ON_ERROR_STOP=1 -f $sqlPath 2>&1 | Tee-Object -FilePath $logPath
if ($LASTEXITCODE -ne 0) {
  throw "AURA tenant test failed with exit code $LASTEXITCODE. See $logPath"
}

Write-Host "Log: $logPath"
Write-Host 'AURA_STAGING_TENANT_TEST_PASS'

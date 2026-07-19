[CmdletBinding()]
param(
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RedactedHost {
  param([Parameter(Mandatory = $true)][string]$HostName)

  $parts = $HostName.Split('.')
  if ($parts.Count -lt 2) {
    return ($HostName.Substring(0, [Math]::Min(4, $HostName.Length)) + '***')
  }

  $first = $parts[0]
  $safeFirst = $first.Substring(0, [Math]::Min(4, $first.Length)) + '***'
  return (@($safeFirst) + $parts[1..($parts.Count - 1)]) -join '.'
}

function ConvertTo-AuraProcessArgument {
  param([Parameter(Mandatory = $true)][string]$Value)

  if ($Value.IndexOf('"') -ge 0 -or $Value.IndexOf("`r") -ge 0 -or $Value.IndexOf("`n") -ge 0) {
    throw 'Unsafe character found in a psql process argument.'
  }

  return '"{0}"' -f $Value
}

function Protect-AuraProcessOutput {
  param(
    [AllowNull()][string]$Text,
    [AllowEmptyCollection()][string[]]$SensitiveValues = @(),
    [AllowNull()][string]$HostName,
    [AllowNull()][string]$RedactedHost
  )

  if ($null -eq $Text) {
    return ''
  }

  $safeText = [string]$Text
  foreach ($value in $SensitiveValues) {
    if (-not [string]::IsNullOrEmpty($value)) {
      $safeText = [regex]::Replace(
        $safeText,
        [regex]::Escape($value),
        '[REDACTED]',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
      )
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($HostName)) {
    $safeHost = if ([string]::IsNullOrWhiteSpace($RedactedHost)) { '[REDACTED_HOST]' } else { $RedactedHost }
    $safeText = [regex]::Replace(
      $safeText,
      [regex]::Escape($HostName),
      $safeHost,
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
  }

  return $safeText
}

function Test-AuraTenantEvidence {
  param(
    [AllowNull()][string]$StdOut,
    [AllowNull()][string]$StdErr,
    [Parameter(Mandatory = $true)][int]$ExitCode
  )

  $output = if ($null -eq $StdOut) { '' } else { [string]$StdOut }
  $hasResultPass = $output -match '(?im)^\s*PASS\s*\|'
  $hasRollback = $output -match '(?im)^\s*ROLLBACK\s*$'
  $hasCompletionMarker = $output -match '(?im)^\s*AURA_STAGING_TENANT_TEST_PASS\s*$'
  $hasZeroExitCode = $ExitCode -eq 0
  $failures = @()

  if (-not $hasZeroExitCode) {
    $failures += "psql exit code was $ExitCode"
  }
  if (-not $hasResultPass) {
    $failures += 'result PASS evidence is missing'
  }
  if (-not $hasRollback) {
    $failures += 'ROLLBACK evidence is missing'
  }
  if (-not $hasCompletionMarker) {
    $failures += 'AURA_STAGING_TENANT_TEST_PASS evidence is missing'
  }

  return [pscustomobject]@{
    Success = $failures.Count -eq 0
    ExitCode = $ExitCode
    HasZeroExitCode = $hasZeroExitCode
    HasResultPass = $hasResultPass
    HasRollback = $hasRollback
    HasCompletionMarker = $hasCompletionMarker
    Failures = $failures
  }
}

function Invoke-AuraTenantRunnerSelfTest {
  $successStdOut = @'
 result | detail
--------+--------------------------------------
 PASS   | Tenant integrity checks completed
(1 row)

ROLLBACK
AURA_STAGING_TENANT_TEST_PASS
'@
  $success = Test-AuraTenantEvidence `
    -StdOut $successStdOut `
    -StdErr 'NOTICE: prueba: PASS' `
    -ExitCode 0
  if (-not $success.Success) {
    throw "Successful runner self-test failed: $($success.Failures -join '; ')."
  }

  $sqlError = Test-AuraTenantEvidence `
    -StdOut '' `
    -StdErr 'ERROR: simulated SQL failure' `
    -ExitCode 3
  if ($sqlError.Success -or $sqlError.HasZeroExitCode) {
    throw 'Non-zero psql exit code was not detected by the runner self-test.'
  }

  $missingRollback = Test-AuraTenantEvidence `
    -StdOut "PASS | ok`r`nAURA_STAGING_TENANT_TEST_PASS" `
    -StdErr '' `
    -ExitCode 0
  if ($missingRollback.Success -or $missingRollback.HasRollback) {
    throw 'Missing ROLLBACK evidence was not detected by the runner self-test.'
  }

  $missingMarker = Test-AuraTenantEvidence `
    -StdOut "PASS | ok`r`nROLLBACK" `
    -StdErr '' `
    -ExitCode 0
  if ($missingMarker.Success -or $missingMarker.HasCompletionMarker) {
    throw 'Missing completion marker was not detected by the runner self-test.'
  }

  Write-Host 'AURA_TENANT_RUNNER_SELF_TEST_PASS'
}

function Write-AuraPsqlOutput {
  param(
    [AllowNull()][string]$StdOut,
    [AllowNull()][string]$StdErr
  )

  if (-not [string]::IsNullOrWhiteSpace($StdOut)) {
    Write-Host $StdOut.TrimEnd()
  }

  if (-not [string]::IsNullOrWhiteSpace($StdErr)) {
    foreach ($line in @($StdErr -split '\r?\n')) {
      if ([string]::IsNullOrWhiteSpace($line)) {
        continue
      }
      if ($line -match '(?i)\bNOTICE:') {
        Write-Host "[PostgreSQL NOTICE] $line"
      } else {
        Write-Host "[PostgreSQL stderr] $line"
      }
    }
  }
}

function Invoke-AuraPsqlTenantTest {
  param(
    [Parameter(Mandatory = $true)][string]$PsqlPath,
    [Parameter(Mandatory = $true)][string]$ConnectionUrl,
    [Parameter(Mandatory = $true)][string]$SqlPath,
    [Parameter(Mandatory = $true)][string]$StdOutLogPath,
    [Parameter(Mandatory = $true)][string]$StdErrLogPath,
    [AllowEmptyCollection()][string[]]$SensitiveValues,
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][string]$RedactedHost
  )

  $rawSuffix = [guid]::NewGuid().ToString('N')
  $rawStdOutPath = Join-Path ([System.IO.Path]::GetTempPath()) "aura_tenant_stdout_$rawSuffix.tmp"
  $rawStdErrPath = Join-Path ([System.IO.Path]::GetTempPath()) "aura_tenant_stderr_$rawSuffix.tmp"
  $argumentList = @(
    (ConvertTo-AuraProcessArgument -Value $ConnectionUrl)
    '-X'
    '-v'
    'ON_ERROR_STOP=1'
    '-f'
    (ConvertTo-AuraProcessArgument -Value $SqlPath)
  )

  try {
    $process = Start-Process `
      -FilePath $PsqlPath `
      -ArgumentList $argumentList `
      -RedirectStandardOutput $rawStdOutPath `
      -RedirectStandardError $rawStdErrPath `
      -WindowStyle Hidden `
      -Wait `
      -PassThru

    $exitCode = [int]$process.ExitCode
    $rawStdOut = if (Test-Path -LiteralPath $rawStdOutPath) {
      Get-Content -LiteralPath $rawStdOutPath -Raw
    } else {
      ''
    }
    $rawStdErr = if (Test-Path -LiteralPath $rawStdErrPath) {
      Get-Content -LiteralPath $rawStdErrPath -Raw
    } else {
      ''
    }
    $safeStdOut = Protect-AuraProcessOutput `
      -Text $rawStdOut `
      -SensitiveValues $SensitiveValues `
      -HostName $HostName `
      -RedactedHost $RedactedHost
    $safeStdErr = Protect-AuraProcessOutput `
      -Text $rawStdErr `
      -SensitiveValues $SensitiveValues `
      -HostName $HostName `
      -RedactedHost $RedactedHost

    Set-Content -LiteralPath $StdOutLogPath -Value $safeStdOut -Encoding UTF8
    Set-Content -LiteralPath $StdErrLogPath -Value $safeStdErr -Encoding UTF8

    return [pscustomobject]@{
      ExitCode = $exitCode
      StdOut = $safeStdOut
      StdErr = $safeStdErr
    }
  } finally {
    if (Test-Path -LiteralPath $rawStdOutPath) {
      Remove-Item -LiteralPath $rawStdOutPath -Force
    }
    if (Test-Path -LiteralPath $rawStdErrPath) {
      Remove-Item -LiteralPath $rawStdErrPath -Force
    }
  }
}

if ($SelfTest) {
  Invoke-AuraTenantRunnerSelfTest
  return
}

$branchUrl = $env:NEON_AURA_BRANCH_URL
if ([string]::IsNullOrWhiteSpace($branchUrl)) {
  throw 'NEON_AURA_BRANCH_URL is required.'
}

try {
  $branchUri = [uri]$branchUrl
} catch {
  throw 'NEON_AURA_BRANCH_URL must be a valid PostgreSQL URL.'
}
if (-not $branchUri.IsAbsoluteUri -or $branchUri.Scheme -notin @('postgres', 'postgresql')) {
  throw 'NEON_AURA_BRANCH_URL must be a valid PostgreSQL URL.'
}

$hostName = $branchUri.Host
$databaseName = $branchUri.AbsolutePath.TrimStart('/')
if ([string]::IsNullOrWhiteSpace($hostName) -or [string]::IsNullOrWhiteSpace($databaseName)) {
  throw 'NEON_AURA_BRANCH_URL must include host and database.'
}
if ($hostName -match '(?i)pooler') {
  throw 'BLOCKER: pooled Neon URLs are not allowed for this test.'
}
if ($hostName -match '(?i)(^|[.-])(prod|production|main)([.-]|$)' -or $databaseName -match '(?i)(prod|production|main)') {
  throw 'BLOCKER: target looks production-like.'
}

$psqlPath = (Get-Command psql -CommandType Application -ErrorAction Stop).Source
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sqlPath = Join-Path $repoRoot 'scripts\aura_staging_tenant_test.sql'
if (-not (Test-Path -LiteralPath $sqlPath)) {
  throw "Missing SQL file: $sqlPath"
}

$logsDir = Join-Path $repoRoot 'logs'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$stdOutLogPath = Join-Path $logsDir "aura_staging_tenant_test_${timestamp}_stdout.log"
$stdErrLogPath = Join-Path $logsDir "aura_staging_tenant_test_${timestamp}_stderr.log"
$redactedHost = Get-RedactedHost -HostName $hostName

$sensitiveValues = @($branchUrl)
if (-not [string]::IsNullOrWhiteSpace($branchUri.UserInfo)) {
  $sensitiveValues += $branchUri.UserInfo
  $userInfoParts = @($branchUri.UserInfo -split ':', 2)
  foreach ($part in $userInfoParts) {
    if (-not [string]::IsNullOrWhiteSpace($part)) {
      $sensitiveValues += $part
      try {
        $sensitiveValues += [uri]::UnescapeDataString($part)
      } catch {}
    }
  }
}

Write-Host 'AURA Neon tenant integrity runner'
Write-Host "Target host: $redactedHost"
Write-Host "Target database: $databaseName"
Write-Host 'Mode: read-only transaction; no migrations are executed.'
$confirmation = Read-Host 'Type RUN-AURA-TENANT-TEST to continue'
if ($confirmation -ne 'RUN-AURA-TENANT-TEST') {
  throw 'Confirmation did not match. Aborting.'
}

$result = Invoke-AuraPsqlTenantTest `
  -PsqlPath $psqlPath `
  -ConnectionUrl $branchUrl `
  -SqlPath $sqlPath `
  -StdOutLogPath $stdOutLogPath `
  -StdErrLogPath $stdErrLogPath `
  -SensitiveValues $sensitiveValues `
  -HostName $hostName `
  -RedactedHost $redactedHost

Write-AuraPsqlOutput -StdOut $result.StdOut -StdErr $result.StdErr
$evidence = Test-AuraTenantEvidence `
  -StdOut $result.StdOut `
  -StdErr $result.StdErr `
  -ExitCode $result.ExitCode

Write-Host "stdout log: $stdOutLogPath"
Write-Host "stderr log: $stdErrLogPath"

if (-not $evidence.HasZeroExitCode) {
  throw "AURA tenant SQL test failed with psql exit code $($evidence.ExitCode). See the separate logs."
}
if (-not $evidence.Success) {
  throw "AURA tenant test evidence validation failed: $($evidence.Failures -join '; ')."
}

Write-Host 'AURA_STAGING_TENANT_TEST_PASS'

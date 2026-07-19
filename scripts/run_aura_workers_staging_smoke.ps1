[CmdletBinding()]
param(
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:AuraWorkerMarkers = @(
  'AURA_NOTIFICATION_WORKER_SMOKE_PASS',
  'AURA_IMAGE_WORKER_SMOKE_PASS',
  'AURA_FORECAST_WORKER_SMOKE_PASS',
  'AURA_WORKERS_FIXTURES_CLEANED',
  'AURA_WORKERS_STAGING_SMOKE_PASS'
)

function ConvertTo-AuraWorkerConnectionUrl {
  param([Parameter(Mandatory = $true)][string]$InputValue)

  $value = $InputValue.Trim()
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw 'NEON_AURA_BRANCH_URL is required.'
  }

  $psqlMatch = [regex]::Match(
    $value,
    '^(?i:psql(?:\.exe)?)\s+(?<argument>.+?)\s*$'
  )
  if ($psqlMatch.Success) {
    $value = $psqlMatch.Groups['argument'].Value.Trim()
  }

  if ($value.Length -ge 2) {
    $first = $value.Substring(0, 1)
    $last = $value.Substring($value.Length - 1, 1)
    if (($first -eq "'" -and $last -eq "'") -or ($first -eq '"' -and $last -eq '"')) {
      $value = $value.Substring(1, $value.Length - 2).Trim()
    }
  }

  if ([string]::IsNullOrWhiteSpace($value) -or $value -match '\s') {
    throw 'NEON_AURA_BRANCH_URL has an unsupported wrapper or whitespace.'
  }
  return $value
}

function Assert-AuraWorkerStagingTarget {
  param([Parameter(Mandatory = $true)][string]$ConnectionUrl)

  try {
    $uri = [uri]$ConnectionUrl
  } catch {
    throw 'NEON_AURA_BRANCH_URL must be a valid PostgreSQL URL.'
  }
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('postgres', 'postgresql')) {
    throw 'NEON_AURA_BRANCH_URL must be a valid PostgreSQL URL.'
  }

  $hostName = $uri.Host
  $databaseName = $uri.AbsolutePath.TrimStart('/')
  if ([string]::IsNullOrWhiteSpace($hostName) -or [string]::IsNullOrWhiteSpace($databaseName)) {
    throw 'NEON_AURA_BRANCH_URL must include host and database.'
  }
  if ($hostName -notmatch '(?i)(^|\.)neon\.tech$') {
    throw 'BLOCKER: the target is not a valid Neon host.'
  }
  if ($hostName -match '(?i)pooler') {
    throw 'BLOCKER: pooled Neon URLs are not allowed for this smoke.'
  }
  if (
    $hostName -match '(?i)(^|[.-])(prod|production|main)([.-]|$)' -or
    $databaseName -match '(?i)(prod|production|main)'
  ) {
    throw 'BLOCKER: target looks production-like.'
  }
  return $uri
}

function Get-AuraRedactedHost {
  param([Parameter(Mandatory = $true)][string]$HostName)

  $parts = @($HostName.Split('.'))
  if (@($parts).Count -lt 2) {
    return ($HostName.Substring(0, [Math]::Min(4, $HostName.Length)) + '***')
  }
  $first = [string]$parts[0]
  $safeFirst = $first.Substring(0, [Math]::Min(4, $first.Length)) + '***'
  return (@($safeFirst) + @($parts[1..($parts.Count - 1)])) -join '.'
}

function ConvertTo-AuraProcessArgument {
  param([Parameter(Mandatory = $true)][string]$Value)

  if ($Value.IndexOf('"') -ge 0 -or $Value.IndexOf("`r") -ge 0 -or $Value.IndexOf("`n") -ge 0) {
    throw 'Unsafe character found in a process argument.'
  }
  return '"{0}"' -f $Value
}

function Protect-AuraWorkerOutput {
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
  foreach ($value in @($SensitiveValues)) {
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
    $safeHost = if ([string]::IsNullOrWhiteSpace($RedactedHost)) {
      '[REDACTED_HOST]'
    } else {
      $RedactedHost
    }
    $safeText = [regex]::Replace(
      $safeText,
      [regex]::Escape($HostName),
      $safeHost,
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
  }
  return $safeText
}

function Assert-AuraWorkerChildFlags {
  param([Parameter(Mandatory = $true)][hashtable]$Values)

  foreach ($name in @(
    'AURA_STAGING_MODE',
    'AURA_IMAGE_MOCK_PROVIDER_ENABLED',
    'AURA_NOTIFICATION_MOCK_PROVIDER_ENABLED'
  )) {
    if (-not $Values.ContainsKey($name) -or [string]$Values[$name] -ne 'true') {
      throw "$name must be true for the staging smoke."
    }
  }
  foreach ($name in @(
    'AURA_IMAGE_WORKER_ENABLED',
    'AURA_NOTIFICATION_WORKER_ENABLED',
    'AURA_PREDICTIVE_JOBS_ENABLED',
    'AURA_FORECAST_WORKER_ENABLED',
    'LEGACY_CREDIT_REMINDER_WORKER_ENABLED',
    'LEGACY_NOTIFICATION_SCHEDULER_ENABLED',
    'ENABLE_LEGACY_AGENT_CRON',
    'AURA_VOICE_ENABLED'
  )) {
    if (-not $Values.ContainsKey($name) -or [string]$Values[$name] -ne 'false') {
      throw "$name must be false for the one-shot smoke."
    }
  }
}

function Test-AuraWorkerEvidence {
  param(
    [AllowNull()][string]$StdOut,
    [AllowNull()][string]$StdErr,
    [Parameter(Mandatory = $true)][int]$ExitCode
  )

  $output = if ($null -eq $StdOut) { '' } else { [string]$StdOut }
  $errorOutput = if ($null -eq $StdErr) { '' } else { [string]$StdErr }
  $combined = $output + "`n" + $errorOutput
  $missingMarkers = @()
  foreach ($marker in @($script:AuraWorkerMarkers)) {
    if ($output -notmatch "(?im)^\s*$([regex]::Escape($marker))\s*$") {
      $missingMarkers += $marker
    }
  }

  $realProviderPattern = '(?i)(AURA_REAL_PROVIDER_ATTEMPT_BLOCKED|api\.openai\.com|api\.cloudinary\.com|graph\.facebook\.com|api\.brevo\.com)'
  $realProviderAttempt = $combined -match $realProviderPattern
  $failures = @()
  if ($ExitCode -ne 0) {
    $failures += "Node exit code was $ExitCode"
  }
  foreach ($marker in @($missingMarkers)) {
    $failures += "Missing evidence marker: $marker"
  }
  if ($realProviderAttempt) {
    $failures += 'A real-provider attempt was detected.'
  }

  return [pscustomobject]@{
    Success = @($failures).Count -eq 0
    ExitCode = $ExitCode
    HasZeroExitCode = $ExitCode -eq 0
    MissingMarkers = @($missingMarkers)
    HasCleanup = @($missingMarkers) -notcontains 'AURA_WORKERS_FIXTURES_CLEANED'
    RealProviderAttempt = $realProviderAttempt
    Failures = @($failures)
  }
}

function Test-AuraExactCleanupIds {
  param(
    [AllowEmptyCollection()][string[]]$CreatedIds = @(),
    [AllowEmptyCollection()][string[]]$DeletedIds = @()
  )

  $created = @($CreatedIds | Sort-Object -Unique)
  $deleted = @($DeletedIds | Sort-Object -Unique)
  if (@($created).Count -ne @($deleted).Count) {
    return $false
  }
  for ($index = 0; $index -lt @($created).Count; $index++) {
    if ([string]$created[$index] -ne [string]$deleted[$index]) {
      return $false
    }
  }
  return $true
}

function Invoke-AuraWorkersRunnerSelfTest {
  $flags = @{
    AURA_STAGING_MODE = 'true'
    AURA_IMAGE_MOCK_PROVIDER_ENABLED = 'true'
    AURA_NOTIFICATION_MOCK_PROVIDER_ENABLED = 'true'
    AURA_IMAGE_WORKER_ENABLED = 'false'
    AURA_NOTIFICATION_WORKER_ENABLED = 'false'
    AURA_PREDICTIVE_JOBS_ENABLED = 'false'
    AURA_FORECAST_WORKER_ENABLED = 'false'
    LEGACY_CREDIT_REMINDER_WORKER_ENABLED = 'false'
    LEGACY_NOTIFICATION_SCHEDULER_ENABLED = 'false'
    ENABLE_LEGACY_AGENT_CRON = 'false'
    AURA_VOICE_ENABLED = 'false'
  }
  Assert-AuraWorkerChildFlags -Values $flags

  $stagingRejected = $false
  $badFlags = @{} + $flags
  $badFlags['AURA_STAGING_MODE'] = 'false'
  try {
    Assert-AuraWorkerChildFlags -Values $badFlags
  } catch {
    $stagingRejected = $true
  }
  if (-not $stagingRejected) {
    throw 'SelfTest failed to reject disabled staging mode.'
  }

  $mockRejected = $false
  $badMockFlags = @{} + $flags
  $badMockFlags['AURA_IMAGE_MOCK_PROVIDER_ENABLED'] = 'false'
  try {
    Assert-AuraWorkerChildFlags -Values $badMockFlags
  } catch {
    $mockRejected = $true
  }
  if (-not $mockRejected) {
    throw 'SelfTest failed to require both mock providers.'
  }

  $wrapped = ConvertTo-AuraWorkerConnectionUrl -InputValue "psql 'postgresql://user:secret@ep-aura.us-east-2.aws.neon.tech/neondb?sslmode=require'"
  [void](Assert-AuraWorkerStagingTarget -ConnectionUrl $wrapped)
  $poolerRejected = $false
  try {
    [void](Assert-AuraWorkerStagingTarget -ConnectionUrl 'postgresql://user:secret@ep-aura-pooler.us-east-2.aws.neon.tech/neondb')
  } catch {
    $poolerRejected = $true
  }
  if (-not $poolerRejected) {
    throw 'SelfTest failed to reject a Neon pooler host.'
  }

  $successOutput = ($script:AuraWorkerMarkers -join "`r`n")
  $success = Test-AuraWorkerEvidence -StdOut $successOutput -StdErr '' -ExitCode 0
  if (-not $success.Success) {
    throw "Successful evidence SelfTest failed: $($success.Failures -join '; ')."
  }

  $nonZero = Test-AuraWorkerEvidence -StdOut $successOutput -StdErr 'simulated failure' -ExitCode 2
  if ($nonZero.Success -or $nonZero.HasZeroExitCode) {
    throw 'SelfTest failed to reject a non-zero Node exit code.'
  }

  $withoutCleanup = $successOutput -replace 'AURA_WORKERS_FIXTURES_CLEANED', ''
  $missingCleanup = Test-AuraWorkerEvidence -StdOut $withoutCleanup -StdErr '' -ExitCode 0
  if ($missingCleanup.Success -or $missingCleanup.HasCleanup) {
    throw 'SelfTest failed to reject missing cleanup evidence.'
  }

  $withoutImage = $successOutput -replace 'AURA_IMAGE_WORKER_SMOKE_PASS', ''
  $missingMarker = Test-AuraWorkerEvidence -StdOut $withoutImage -StdErr '' -ExitCode 0
  if ($missingMarker.Success) {
    throw 'SelfTest failed to reject a missing worker marker.'
  }

  $providerAttempt = Test-AuraWorkerEvidence `
    -StdOut $successOutput `
    -StdErr 'AURA_REAL_PROVIDER_ATTEMPT_BLOCKED' `
    -ExitCode 0
  if ($providerAttempt.Success -or -not $providerAttempt.RealProviderAttempt) {
    throw 'SelfTest failed to reject a real-provider attempt.'
  }

  if (-not (Test-AuraExactCleanupIds -CreatedIds @('id-a', 'id-b') -DeletedIds @('id-b', 'id-a'))) {
    throw 'SelfTest rejected exact-ID cleanup unexpectedly.'
  }
  if (Test-AuraExactCleanupIds -CreatedIds @('id-a', 'id-b') -DeletedIds @('id-a', 'id-b', 'id-c')) {
    throw 'SelfTest accepted cleanup containing an uncreated ID.'
  }

  Write-Host 'AURA_WORKERS_RUNNER_SELF_TEST_PASS'
}

function Write-AuraWorkerProcessOutput {
  param(
    [AllowNull()][string]$StdOut,
    [AllowNull()][string]$StdErr
  )

  if (-not [string]::IsNullOrWhiteSpace($StdOut)) {
    Write-Host $StdOut.TrimEnd()
  }
  if (-not [string]::IsNullOrWhiteSpace($StdErr)) {
    foreach ($line in @($StdErr -split '\r?\n')) {
      if (-not [string]::IsNullOrWhiteSpace($line)) {
        Write-Host "[Node stderr] $line"
      }
    }
  }
}

function Invoke-AuraWorkersNodeProcess {
  param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][hashtable]$ChildEnvironment,
    [Parameter(Mandatory = $true)][string]$StdOutLogPath,
    [Parameter(Mandatory = $true)][string]$StdErrLogPath,
    [AllowEmptyCollection()][string[]]$SensitiveValues,
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][string]$RedactedHost
  )

  $suffix = [guid]::NewGuid().ToString('N')
  $rawStdOutPath = Join-Path ([System.IO.Path]::GetTempPath()) "aura_workers_stdout_$suffix.tmp"
  $rawStdErrPath = Join-Path ([System.IO.Path]::GetTempPath()) "aura_workers_stderr_$suffix.tmp"
  $previousEnvironment = @{}

  try {
    foreach ($name in @($ChildEnvironment.Keys)) {
      $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
      [Environment]::SetEnvironmentVariable($name, $ChildEnvironment[$name], 'Process')
    }

    $process = Start-Process `
      -FilePath $NodePath `
      -ArgumentList @((ConvertTo-AuraProcessArgument -Value $ScriptPath)) `
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
    $safeStdOut = Protect-AuraWorkerOutput `
      -Text $rawStdOut `
      -SensitiveValues $SensitiveValues `
      -HostName $HostName `
      -RedactedHost $RedactedHost
    $safeStdErr = Protect-AuraWorkerOutput `
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
    foreach ($name in @($previousEnvironment.Keys)) {
      [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $rawStdOutPath) {
      Remove-Item -LiteralPath $rawStdOutPath -Force
    }
    if (Test-Path -LiteralPath $rawStdErrPath) {
      Remove-Item -LiteralPath $rawStdErrPath -Force
    }
  }
}

if ($SelfTest) {
  Invoke-AuraWorkersRunnerSelfTest
  return
}

$rawBranchUrl = $env:NEON_AURA_BRANCH_URL
if ([string]::IsNullOrWhiteSpace($rawBranchUrl)) {
  throw 'NEON_AURA_BRANCH_URL is required.'
}
$branchUrl = ConvertTo-AuraWorkerConnectionUrl -InputValue $rawBranchUrl
$branchUri = Assert-AuraWorkerStagingTarget -ConnectionUrl $branchUrl
$hostName = $branchUri.Host
$databaseName = $branchUri.AbsolutePath.TrimStart('/')
$redactedHost = Get-AuraRedactedHost -HostName $hostName

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeScriptPath = Join-Path $repoRoot 'scripts\aura_workers_staging_smoke.js'
if (-not (Test-Path -LiteralPath $nodeScriptPath)) {
  throw "Missing Node smoke script: $nodeScriptPath"
}
$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source

$logsDir = Join-Path $repoRoot 'logs'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$stdOutLogPath = Join-Path $logsDir "aura_workers_staging_smoke_${timestamp}_stdout.log"
$stdErrLogPath = Join-Path $logsDir "aura_workers_staging_smoke_${timestamp}_stderr.log"

$sensitiveValues = @($rawBranchUrl, $branchUrl)
if (-not [string]::IsNullOrWhiteSpace($branchUri.UserInfo)) {
  $sensitiveValues += $branchUri.UserInfo
  foreach ($part in @($branchUri.UserInfo -split ':', 2)) {
    if (-not [string]::IsNullOrWhiteSpace($part)) {
      $sensitiveValues += $part
      try {
        $sensitiveValues += [uri]::UnescapeDataString($part)
      } catch {}
    }
  }
}

$childEnvironment = @{
  DATABASE_URL = $branchUrl
  NEON_DB_URL = $null
  NEON_AURA_BRANCH_URL = $null
  AURA_STAGING_MODE = 'true'
  AURA_IMAGE_MOCK_PROVIDER_ENABLED = 'true'
  AURA_NOTIFICATION_MOCK_PROVIDER_ENABLED = 'true'
  AURA_IMAGE_WORKER_ENABLED = 'false'
  AURA_NOTIFICATION_WORKER_ENABLED = 'false'
  AURA_PREDICTIVE_JOBS_ENABLED = 'false'
  AURA_FORECAST_WORKER_ENABLED = 'false'
  LEGACY_CREDIT_REMINDER_WORKER_ENABLED = 'false'
  LEGACY_NOTIFICATION_SCHEDULER_ENABLED = 'false'
  ENABLE_LEGACY_AGENT_CRON = 'false'
  AURA_VOICE_ENABLED = 'false'
  OPENAI_API_KEY = $null
  BREVO_API_KEY = $null
  META_WA_PHONE_NUMBER_ID = $null
  META_WA_ACCESS_TOKEN = $null
  TWILIO_ACCOUNT_SID = $null
  TWILIO_AUTH_TOKEN = $null
  TWILIO_WHATSAPP_FROM = $null
  VAPID_PRIVATE_KEY = $null
  CLOUDINARY_API_KEY = $null
  CLOUDINARY_API_SECRET = $null
}
Assert-AuraWorkerChildFlags -Values $childEnvironment

Write-Host 'AURA workers Neon staging smoke runner'
Write-Host "Target host: $redactedHost"
Write-Host "Target database: $databaseName"
Write-Host 'Mode: one-shot, tenant-scoped, mock providers, exact fixture cleanup.'
Write-Host 'No migrations or resident workers will be started.'
$confirmation = Read-Host 'Type RUN-AURA-WORKERS-STAGING-SMOKE to continue'
if ($confirmation -ne 'RUN-AURA-WORKERS-STAGING-SMOKE') {
  throw 'Confirmation did not match. Aborting.'
}

$result = Invoke-AuraWorkersNodeProcess `
  -NodePath $nodePath `
  -ScriptPath $nodeScriptPath `
  -ChildEnvironment $childEnvironment `
  -StdOutLogPath $stdOutLogPath `
  -StdErrLogPath $stdErrLogPath `
  -SensitiveValues $sensitiveValues `
  -HostName $hostName `
  -RedactedHost $redactedHost

Write-AuraWorkerProcessOutput -StdOut $result.StdOut -StdErr $result.StdErr
$evidence = Test-AuraWorkerEvidence `
  -StdOut $result.StdOut `
  -StdErr $result.StdErr `
  -ExitCode $result.ExitCode

Write-Host "stdout log: $stdOutLogPath"
Write-Host "stderr log: $stdErrLogPath"

if (-not $evidence.Success) {
  throw "AURA workers staging smoke failed: $($evidence.Failures -join '; ')."
}

Write-Host 'AURA_WORKERS_STAGING_SMOKE_PASS'

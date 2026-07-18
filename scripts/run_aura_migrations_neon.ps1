Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Get-BranchUri {
  $branchUrl = $env:NEON_AURA_BRANCH_URL
  if ([string]::IsNullOrWhiteSpace($branchUrl)) {
    throw 'NEON_AURA_BRANCH_URL is required.'
  }

  try {
    return [uri]$branchUrl
  } catch {
    throw 'NEON_AURA_BRANCH_URL must be a valid PostgreSQL connection string.'
  }
}

function Get-PsqlPath {
  $cmd = Get-Command psql -ErrorAction Stop
  return $cmd.Source
}

function Invoke-PsqlFile {
  param(
    [Parameter(Mandatory = $true)][string]$PsqlPath,
    [Parameter(Mandatory = $true)][string]$ConnectionString,
    [Parameter(Mandatory = $true)][string]$FilePath
  )

  if (-not (Test-Path -LiteralPath $FilePath)) {
    throw "Missing SQL file: $FilePath"
  }

  & $PsqlPath -X -v ON_ERROR_STOP=1 -d $ConnectionString -f $FilePath
  if ($LASTEXITCODE -ne 0) {
    throw "psql failed for $FilePath with exit code $LASTEXITCODE"
  }
}

$repoRoot = Get-RepoRoot
$branchUri = Get-BranchUri
$psqlPath = Get-PsqlPath
$databaseName = $branchUri.AbsolutePath.TrimStart('/')

Write-Host 'AURA Neon branch migration runner'
Write-Host "Target host: $($branchUri.Host)"
Write-Host "Target database: $databaseName"
Write-Host 'Warning: use this only against a Neon branch or staging database, never production.'

$confirmation = Read-Host 'Type APPLY-AURA-STAGING to continue'
if ($confirmation -ne 'APPLY-AURA-STAGING') {
  throw 'Confirmation did not match. Aborting.'
}

$preflight = Join-Path $repoRoot 'scripts\aura_preflight.sql'
$postflight = Join-Path $repoRoot 'scripts\aura_postflight.sql'
$migrations = @(
  'migrations\aura\001_aura_core_consolidated.sql',
  'migrations\aura\002_page_views_tenant_v2.sql',
  'migrations\aura\003_aura_campaigns_v2.sql',
  'migrations\aura\004_aura_image_jobs.sql',
  'migrations\aura\005_aura_actions_outbox_v2.sql',
  'migrations\aura\006_predictive_features.sql',
  'migrations\aura\007_predictive_forecasting.sql',
  'migrations\aura\008_aura_customer_growth.sql',
  'migrations\aura\009_aura_send_time_optimization.sql',
  'migrations\aura\010_aura_voice_mvp.sql'
)

Write-Host 'Running preflight...'
Invoke-PsqlFile -PsqlPath $psqlPath -ConnectionString $branchUri.AbsoluteUri -FilePath $preflight

foreach ($migration in $migrations) {
  $path = Join-Path $repoRoot $migration
  Write-Host "Applying $migration"
  Invoke-PsqlFile -PsqlPath $psqlPath -ConnectionString $branchUri.AbsoluteUri -FilePath $path
}

Write-Host 'Running postflight...'
Invoke-PsqlFile -PsqlPath $psqlPath -ConnectionString $branchUri.AbsoluteUri -FilePath $postflight

Write-Host 'AURA Neon branch migration run completed successfully.'

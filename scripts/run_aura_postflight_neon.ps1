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

Write-Host 'AURA Neon branch postflight runner'
Write-Host "Target host: $($branchUri.Host)"
Write-Host "Target database: $databaseName"
Write-Host 'Warning: use this only against a Neon branch or staging database, never production.'

$postflight = Join-Path $repoRoot 'scripts\aura_postflight.sql'
Write-Host 'Running postflight...'
Invoke-PsqlFile -PsqlPath $psqlPath -ConnectionString $branchUri.AbsoluteUri -FilePath $postflight

Write-Host 'AURA Neon branch postflight completed successfully.'

[CmdletBinding()]
param(
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AuraItemCount {
  param(
    [AllowNull()]
    [AllowEmptyCollection()]
    [object]$Value
  )

  if ($null -eq $Value) {
    return 0
  }

  return [int](@($Value).Count)
}

function Get-RequiredEnvironmentVariable {
  param([Parameter(Mandatory = $true)][string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "$Name is required."
  }
  return $value
}

function Find-SensitiveKeys {
  param([object]$Value, [string]$Path = '$')
  $found = [System.Collections.Generic.List[string]]::new()
  if ($null -eq $Value) { return $found }

  if ($Value -is [System.Collections.IDictionary]) {
    foreach ($key in $Value.Keys) {
      $name = [string]$key
      $childPath = "$Path.$name"
      if ($name -match '(?i)(password|secret|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|recipient[_-]?(email|phone)|audio[_-]?base64|transcript)') {
        $found.Add($childPath)
      }
      foreach ($child in (Find-SensitiveKeys -Value $Value[$key] -Path $childPath)) { $found.Add($child) }
    }
    return $found
  }

  if ($Value -is [pscustomobject]) {
    foreach ($property in $Value.PSObject.Properties) {
      $name = $property.Name
      $childPath = "$Path.$name"
      if ($name -match '(?i)(password|secret|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|recipient[_-]?(email|phone)|audio[_-]?base64|transcript)') {
        $found.Add($childPath)
      }
      foreach ($child in (Find-SensitiveKeys -Value $property.Value -Path $childPath)) { $found.Add($child) }
    }
    return $found
  }

  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    $index = 0
    foreach ($item in $Value) {
      foreach ($child in (Find-SensitiveKeys -Value $item -Path "$Path[$index]")) { $found.Add($child) }
      $index++
    }
  }
  return $found
}

function Invoke-AuraSmokeRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Path,
    [ValidateSet('GET', 'POST')][string]$Method = 'GET',
    [object]$Body = $null,
    [switch]$RequireMockAnswer,
    [scriptblock]$RequestInvoker = $null
  )

  $uri = [uri]::new($script:BaseUri, $Path)
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $statusCode = 0
  $contentType = $null
  $rawBody = $null
  $requestError = $null
  try {
    $params = @{
      Uri = $uri.AbsoluteUri
      Method = $Method
      Headers = $script:Headers
      TimeoutSec = 30
      UseBasicParsing = $true
    }
    if ($null -ne $Body) {
      $params.ContentType = 'application/json'
      $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
    }
    if ($null -eq $RequestInvoker) {
      $response = Invoke-WebRequest @params
    } else {
      $response = & $RequestInvoker $params
    }
    $statusCode = [int]$response.StatusCode
    $contentType = [string]$response.Headers['Content-Type']
    $rawBody = [string]$response.Content
  } catch {
    $requestError = $_.Exception.Message
    if ($null -ne $_.Exception.Response) {
      $statusCode = [int]$_.Exception.Response.StatusCode
      $contentType = [string]$_.Exception.Response.ContentType
    }
    if ($null -ne $_.ErrorDetails -and $_.ErrorDetails.Message) {
      $rawBody = [string]$_.ErrorDetails.Message
    }
  } finally {
    $watch.Stop()
  }

  $jsonValid = $false
  $parsed = $null
  if (-not [string]::IsNullOrWhiteSpace($rawBody)) {
    try {
      $parsed = $rawBody | ConvertFrom-Json
      $jsonValid = $true
    } catch {}
  }
  $sensitiveKeys = @()
  if ($jsonValid) {
    $sensitiveKeys = @(Find-SensitiveKeys -Value $parsed)
  }
  $sensitiveKeyCount = Get-AuraItemCount -Value $sensitiveKeys
  $mockValid = $true
  if ($RequireMockAnswer) {
    $answer = if ($jsonValid -and $null -ne $parsed.PSObject.Properties['answer']) {
      [string]$parsed.answer
    } else {
      ''
    }
    $mockValid = $answer -like 'Modo mock AURA 2070.*'
  }
  $passed = $statusCode -ge 200 -and $statusCode -lt 300 `
    -and $contentType -match '(?i)application/json' `
    -and $jsonValid `
    -and $sensitiveKeyCount -eq 0 `
    -and $mockValid

  $result = [ordered]@{
    test = $Name
    method = $Method
    path = $Path
    status = $statusCode
    latencyMs = $watch.ElapsedMilliseconds
    contentType = $contentType
    jsonValid = $jsonValid
    sensitiveFields = $sensitiveKeys
    mockValidated = if ($RequireMockAnswer) { $mockValid } else { $null }
    result = if ($passed) { 'PASS' } else { 'FAIL' }
    errorType = if ($requestError) { 'HTTP_REQUEST_FAILED' } else { $null }
  }
  $line = $result | ConvertTo-Json -Depth 8 -Compress
  Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
  Write-Host ("{0,-34} {1,-4} {2,6}ms {3}" -f $Name, $result.result, $result.latencyMs, $statusCode)
  return [pscustomobject]$result
}

function Invoke-AuraSmokeSelfTest {
  $countCases = @(
    [pscustomobject]@{ name = 'null'; value = $null; expected = 0 }
    [pscustomobject]@{ name = 'zero'; value = @(); expected = 0 }
    [pscustomobject]@{ name = 'one'; value = [pscustomobject]@{ status = 'ok' }; expected = 1 }
    [pscustomobject]@{ name = 'many'; value = @('one', 'two', 'three'); expected = 3 }
  )

  foreach ($case in $countCases) {
    $actual = Get-AuraItemCount -Value $case.value
    if ($actual -ne $case.expected) {
      throw "Count self-test '$($case.name)' failed: expected $($case.expected), got $actual."
    }
  }

  $tempLogPath = Join-Path ([System.IO.Path]::GetTempPath()) (
    'aura_staging_smoke_self_test_{0}.log' -f [guid]::NewGuid().ToString('N')
  )
  try {
    $script:BaseUri = [uri]'https://aura-staging.invalid'
    $script:Headers = @{
      Authorization = 'Bearer local-self-test-placeholder'
      Accept = 'application/json'
    }
    $script:LogPath = $tempLogPath
    $healthResponse = {
      param([hashtable]$Parameters)
      return [pscustomobject]@{
        StatusCode = 200
        Headers = @{ 'Content-Type' = 'application/json; charset=utf-8' }
        Content = '{"success":true,"status":"ok"}'
      }
    }

    $healthResult = Invoke-AuraSmokeRequest `
      -Name 'health-single-object' `
      -Path '/api/health' `
      -RequestInvoker $healthResponse

    if ($healthResult.result -ne 'PASS') {
      throw 'Single-object health response self-test did not pass validation.'
    }
    if ((Get-AuraItemCount -Value $healthResult.sensitiveFields) -ne 0) {
      throw 'Single-object health response self-test reported sensitive fields.'
    }
  } finally {
    if (Test-Path -LiteralPath $tempLogPath) {
      Remove-Item -LiteralPath $tempLogPath -Force
    }
  }

  Write-Host 'AURA_STAGING_SMOKE_SELF_TEST_PASS'
}

if ($SelfTest) {
  Invoke-AuraSmokeSelfTest
  return
}

$baseUrl = Get-RequiredEnvironmentVariable -Name 'AURA_STAGING_API_URL'
$token = Get-RequiredEnvironmentVariable -Name 'AURA_STAGING_TOKEN'
try { $BaseUri = [uri]$baseUrl } catch { throw 'AURA_STAGING_API_URL must be a valid URL.' }
if ($BaseUri.Scheme -notin @('https', 'http')) { throw 'AURA_STAGING_API_URL must use HTTP or HTTPS.' }
if ($BaseUri.UserInfo) { throw 'AURA_STAGING_API_URL must not contain credentials.' }
if ($BaseUri.Host -match '(?i)(^|[.-])(prod|production|main)([.-]|$)') {
  throw 'Refusing to run smoke tests against a production-like host.'
}

$Headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logsDir = Join-Path $repoRoot 'logs'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$LogPath = Join-Path $logsDir "aura_staging_smoke_$timestamp.log"
Set-Content -LiteralPath $LogPath -Value (([ordered]@{
  event = 'aura_staging_smoke_started'
  timestamp = (Get-Date).ToUniversalTime().ToString('o')
  host = $BaseUri.Host
  tokenLogged = $false
}) | ConvertTo-Json -Compress) -Encoding UTF8

Write-Host "AURA staging smoke target: $($BaseUri.Scheme)://$($BaseUri.Host)"
$results = @(
  Invoke-AuraSmokeRequest -Name 'health' -Path '/api/health'
  Invoke-AuraSmokeRequest -Name 'conversations' -Path '/api/aura/conversations'
  Invoke-AuraSmokeRequest -Name 'usage' -Path '/api/aura/usage'
  Invoke-AuraSmokeRequest -Name 'campaigns' -Path '/api/aura/campaigns'
  Invoke-AuraSmokeRequest -Name 'actions' -Path '/api/aura/actions'
  Invoke-AuraSmokeRequest -Name 'predictions-demand' -Path '/api/aura/predictions/demand'
  Invoke-AuraSmokeRequest -Name 'customer-segments' -Path '/api/aura/customers/segments'
  Invoke-AuraSmokeRequest -Name 'send-time-recommendation' -Path '/api/aura/campaigns/send-time-recommendation'
  Invoke-AuraSmokeRequest -Name 'chat-mock' -Path '/api/aura/chat' -Method POST -Body @{
    message = 'Smoke test AURA: resume datos disponibles sin ejecutar acciones.'
  } -RequireMockAnswer
)

$failed = @($results | Where-Object { $_.result -ne 'PASS' })
$resultCount = Get-AuraItemCount -Value $results
$failedCount = Get-AuraItemCount -Value $failed
Add-Content -LiteralPath $LogPath -Value (([ordered]@{
  event = 'aura_staging_smoke_completed'
  timestamp = (Get-Date).ToUniversalTime().ToString('o')
  passed = $resultCount - $failedCount
  failed = $failedCount
  result = if ($failedCount -gt 0) { 'FAIL' } else { 'PASS' }
}) | ConvertTo-Json -Compress) -Encoding UTF8

Write-Host "Log: $LogPath"
if ($failedCount -gt 0) {
  throw "$failedCount AURA staging smoke test(s) failed."
}
Write-Host 'AURA_STAGING_SMOKE_PASS'

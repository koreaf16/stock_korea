param(
  [string]$OrchestratorUrl = "http://localhost:5001",
  [switch]$StartLocal
)

$ErrorActionPreference = "Stop"

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    throw $Message
  }
}

function Get-Json {
  param([string]$Url)
  return Invoke-RestMethod -Uri $Url -TimeoutSec 10
}

$proc = $null
if ($StartLocal) {
  $OrchestratorUrl = "http://localhost:5101"
  $proc = Start-Process -FilePath node -ArgumentList "apps/orchestrator/dist/index.js" -PassThru -WindowStyle Hidden -Environment @{
    ORCHESTRATOR_PORT = "5101"
    ZONE2_PROVIDER = "MOCK"
    ZONE3_PROVIDER = "LOCAL_VECTOR"
    ZONE4_PROVIDER = "LOCAL"
    ZONE5_PROVIDER = "RULE"
    ZONE6_PROVIDER = "LOCAL_VECTOR"
  }
  Start-Sleep -Seconds 3
}

try {
  $health = Get-Json "$OrchestratorUrl/health"
  Assert-True ($health.ok -eq $true) "health check failed"

  $snapshot1 = Get-Json "$OrchestratorUrl/api/snapshot"
  Start-Sleep -Seconds 2
  $snapshot2 = Get-Json "$OrchestratorUrl/api/snapshot"

  Assert-True ($snapshot2.lastUpdatedAt -ne $snapshot1.lastUpdatedAt) "snapshot timestamp did not advance"
  Assert-True ([bool]$snapshot2.technical) "snapshot.technical missing"
  Assert-True ([bool]$snapshot2.fundamental) "snapshot.fundamental missing"
  Assert-True ([bool]$snapshot2.pattern) "snapshot.pattern missing"
  Assert-True ([bool]$snapshot2.madness) "snapshot.madness missing"
  Assert-True ([bool]$snapshot2.history) "snapshot.history missing"
  Assert-True ([bool]$snapshot2.decision) "snapshot.decision missing"

  $zone0 = Get-Json "$OrchestratorUrl/api/zone0/buffer"
  $zone1 = Get-Json "$OrchestratorUrl/api/zone1/state"
  $zone2 = Get-Json "$OrchestratorUrl/api/zone2/state"
  $zone3 = Get-Json "$OrchestratorUrl/api/zone3/state"
  $zone4 = Get-Json "$OrchestratorUrl/api/zone4/state"
  $zone5 = Get-Json "$OrchestratorUrl/api/zone5/state"
  $zone6Before = Get-Json "$OrchestratorUrl/api/zone6/state"

  Assert-True ($null -ne $zone0.ticks) "zone0 buffer missing ticks"
  Assert-True ($null -ne $zone1.ma3) "zone1 state missing ma3"
  Assert-True ($null -ne $zone2.provider) "zone2 state missing provider"
  Assert-True ($null -ne $zone3.vectorDim) "zone3 state missing vectorDim"
  Assert-True ($null -ne $zone4.lastStage) "zone4 state missing lastStage"
  Assert-True ($null -ne $zone5.lastDecisionId) "zone5 state missing lastDecisionId"
  Assert-True ($null -ne $zone6Before.recordCount) "zone6 state missing recordCount"

  $targetSymbol = [string]$snapshot2.targetSymbol
  Invoke-RestMethod -Uri "$OrchestratorUrl/api/kill-switch" -Method Post -ContentType "application/json" -Body '{"enabled":true}' | Out-Null
  Invoke-RestMethod -Uri "$OrchestratorUrl/api/manual-order" -Method Post -ContentType "application/json" -Body (@{ symbol = $targetSymbol; side = "BUY"; qty = 3 } | ConvertTo-Json) | Out-Null

  Start-Sleep -Seconds 3
  $zone6After = Get-Json "$OrchestratorUrl/api/zone6/state"
  $snapshot3 = Get-Json "$OrchestratorUrl/api/snapshot"

  Invoke-RestMethod -Uri "$OrchestratorUrl/api/kill-switch" -Method Post -ContentType "application/json" -Body '{"enabled":false}' | Out-Null

  Assert-True (($zone6After.recordCount -as [int]) -gt ($zone6Before.recordCount -as [int])) "zone6 recordCount did not increase"
  Assert-True ($snapshot3.orderLog.Count -gt 0) "order log did not update"

  [pscustomobject]@{
    ok = $true
    healthTickCount = $health.tickCount
    snapshotUpdatedAt = $snapshot3.lastUpdatedAt
    zone2Provider = $zone2.provider
    zone3Source = $zone3.source
    zone4Source = $zone4.source
    zone5Source = $zone5.source
    zone6Source = $zone6After.source
    zone6RecordCountBefore = $zone6Before.recordCount
    zone6RecordCountAfter = $zone6After.recordCount
  } | ConvertTo-Json -Depth 4
} finally {
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
  }
}

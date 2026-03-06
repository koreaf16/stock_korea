param(
  [string]$EnvFile = ".env.local",
  [string]$SqlFile = "db/oracle/init_schema.sql"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Env file not found: $EnvFile"
}
if (-not (Test-Path -LiteralPath $SqlFile)) {
  throw "SQL file not found: $SqlFile"
}

Get-Content -LiteralPath $EnvFile | ForEach-Object {
  if ($_ -match '^(?<key>[A-Z0-9_]+)=(?<value>.*)$') {
    [System.Environment]::SetEnvironmentVariable($matches.key, $matches.value)
  }
}

if (-not $env:ORACLE_CONNECTION_STRING) { throw "ORACLE_CONNECTION_STRING is required" }
if (-not $env:ORACLE_USER) { throw "ORACLE_USER is required" }
if (-not $env:ORACLE_PASSWORD) { throw "ORACLE_PASSWORD is required" }

if ($env:ORACLE_INSTANT_CLIENT_PATH -and (Test-Path -LiteralPath $env:ORACLE_INSTANT_CLIENT_PATH)) {
  $env:PATH = "$env:ORACLE_INSTANT_CLIENT_PATH;$env:PATH"
}

$sqlplusPath = (Get-Command sqlplus -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
if (-not $sqlplusPath) {
  throw "sqlplus executable not found. Check ORACLE_INSTANT_CLIENT_PATH."
}

$fullSqlPath = (Resolve-Path -LiteralPath $SqlFile).Path
$wrapperPath = Join-Path $PWD ".tmp_db_init_wrapper.sql"
$wrapper = @"
whenever sqlerror exit sql.sqlcode;
connect $env:ORACLE_USER/$env:ORACLE_PASSWORD@$env:ORACLE_CONNECTION_STRING
@$fullSqlPath
exit;
"@
Set-Content -LiteralPath $wrapperPath -Value $wrapper -Encoding ascii

try {
  & $sqlplusPath -s /nolog "@$wrapperPath"
  if ($LASTEXITCODE -ne 0) {
    throw "sqlplus failed with exit code $LASTEXITCODE"
  }
} finally {
  Remove-Item -LiteralPath $wrapperPath -ErrorAction SilentlyContinue
}

Write-Output "[db-init] completed successfully"

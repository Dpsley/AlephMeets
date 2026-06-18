param(
  [string]$PostgresBin = "D:\OSPanel\modules\database\PostgreSQL-14-Win10\bin",
  [string]$HostName = "127.0.0.1",
  [int]$Port = 5432,
  [string]$AdminUser = "postgres",
  [string]$AppUser = "aleph_meets",
  [string]$AppPassword = "aleph_meets_dev",
  [string]$Database = "aleph_meets"
)

$ErrorActionPreference = "Stop"
$psql = Join-Path $PostgresBin "psql.exe"
if (-not (Test-Path $psql)) {
  $psql = "psql"
}

$roleExists = & $psql -h $HostName -p $Port -U $AdminUser -d postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname='$AppUser'"
if ($roleExists -ne "1") {
  & $psql -h $HostName -p $Port -U $AdminUser -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE $AppUser LOGIN PASSWORD '$AppPassword'"
}

$dbExists = & $psql -h $HostName -p $Port -U $AdminUser -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$Database'"
if ($dbExists -ne "1") {
  & $psql -h $HostName -p $Port -U $AdminUser -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $Database OWNER $AppUser"
}

$root = Split-Path $PSScriptRoot -Parent
$schemaExists = & $psql -h $HostName -p $Port -U $AppUser -d $Database -Atc "SELECT to_regclass('public.users') IS NOT NULL"
if ($schemaExists -ne "t") {
  & $psql -h $HostName -p $Port -U $AppUser -d $Database -v ON_ERROR_STOP=1 -f (Join-Path $root "database\migrations\001_initial.sql")
}
& $psql -h $HostName -p $Port -U $AppUser -d $Database -v ON_ERROR_STOP=1 -f (Join-Path $root "database\seed.sql")

Write-Host "Database '$Database' is ready."

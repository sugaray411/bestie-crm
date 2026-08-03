<#
  Runs the three-pass migration from SETUP.md §4 in one go.

  Pass 1 (crm_service) applies 0001 and records 0002 as skipped -- crm_service
  has no rights in `public`, which is the point.
  Pass 2 (owner)       applies 0002: the contract views and grants.
  Pass 3 (crm_service) re-runs only to print the isolation report.

  Passwords are prompted for, never stored on disk or in shell history.

  Usage:
    .\scripts\run-migrations.ps1
    .\scripts\run-migrations.ps1 -PoolerRegion us-east-1   # if direct conn fails
#>
param(
  [string]$Ref = 'hmjrvkhzpqxqxpgsolma',
  # Supabase's direct endpoint is IPv6-only on newer projects. If pass 1 dies
  # with ENETUNREACH or a connect timeout, re-run with -PoolerRegion <region>
  # (Settings -> General) to route over the IPv4 transaction pooler instead.
  [string]$PoolerRegion = '',
  # Supabase signs its certs with a private root CA that Node does not trust.
  # Recent pg-connection-string treats sslmode=require as verify-full, so the
  # handshake fails with SELF_SIGNED_CERT_IN_CHAIN. Passing the CA file here
  # gets real verification; without it we fall back to libpq's looser `require`
  # semantics -- encrypted, but the server's identity is NOT checked.
  # Download: Settings -> Database -> SSL Configuration.
  [string]$CaCertPath = '',
  # Skip pass 2 when 0002 has been applied by hand in the Supabase SQL Editor,
  # which is already owner-authenticated -- avoids needing the project DB
  # password, and avoids resetting it and breaking whatever else uses it.
  [switch]$SkipOwnerPass
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Read-Plain([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $bstr   = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try   { [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# A password containing @ / : ? # would otherwise be parsed as URL structure and
# produce a baffling "Invalid URL" or a connection to the wrong host.
function Build-Url([string]$User, [string]$Password) {
  $u = [System.Uri]::EscapeDataString($User)
  $p = [System.Uri]::EscapeDataString($Password)

  if ($CaCertPath) {
    $ssl = "sslmode=verify-full&sslrootcert=$([System.Uri]::EscapeDataString($CaCertPath))"
  } else {
    $ssl = 'uselibpqcompat=true&sslmode=require'
  }

  if ($PoolerRegion) {
    # Pooler expects <role>.<project-ref> as the username; direct does not.
    "postgresql://$u.$Ref`:$p@aws-0-$PoolerRegion.pooler.supabase.com:6543/postgres?$ssl"
  } else {
    "postgresql://$u`:$p@db.$Ref.supabase.co:5432/postgres?$ssl"
  }
}

function Invoke-Pass([string]$Label, [string]$Url) {
  Write-Host ""
  Write-Host "=== $Label ===" -ForegroundColor Cyan
  $env:CRM_DATABASE_URL = $Url

  # Out-Host is load-bearing. A PowerShell function returns everything left on
  # the pipeline, so a bare `& npm run migrate` sends npm's stdout back to the
  # caller alongside the exit code. `(Invoke-Pass ...) -ne 0` then compares an
  # ARRAY, which is always true -- reporting failure on a migration that in fact
  # succeeded, while hiding npm's stdout. Out-Host writes straight to the
  # console and leaves the pipeline clean for the exit code alone.
  & npm run migrate | Out-Host

  return $LASTEXITCODE
}

if (-not (Test-Path (Join-Path $repo 'dist\db\migrate.js'))) {
  Write-Host "dist/ not built -- running npm run build first." -ForegroundColor Yellow
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed; fix that before migrating." }
}

Write-Host "Project ref: $Ref"
if ($PoolerRegion) { Write-Host "Route: transaction pooler ($PoolerRegion), port 6543" }
else               { Write-Host "Route: direct connection, port 5432" }

if ($CaCertPath) {
  if (-not (Test-Path $CaCertPath)) { throw "CA certificate not found: $CaCertPath" }
  Write-Host "TLS:   verify-full against $CaCertPath"
} else {
  Write-Host "TLS:   encrypted, server identity NOT verified (pass -CaCertPath to verify)" -ForegroundColor Yellow
}

$crmPw  = Read-Plain 'Password for role crm_service'
$crmUrl = Build-Url 'crm_service' $crmPw

if (-not $SkipOwnerPass) {
  $ownerPw  = Read-Plain 'Password for role postgres (project DB password)'
  $ownerUrl = Build-Url 'postgres' $ownerPw
}

try {
  # Pass 1 is expected to report 0002 as SKIPPED. That is success, not failure:
  # it proves crm_service cannot create objects in the app's schema.
  if ((Invoke-Pass 'Pass 1/3  as crm_service  (expect 0001 applied, 0002 skipped)' $crmUrl) -ne 0) {
    throw "Pass 1 failed. If the error is ENETUNREACH or a timeout, re-run with -PoolerRegion <your-region>."
  }

  if ($SkipOwnerPass) {
    Write-Host ""
    Write-Host "Pass 2/3 skipped -- 0002 assumed applied via the SQL Editor." -ForegroundColor Yellow
  }
  elseif ((Invoke-Pass 'Pass 2/3  as postgres  (expect 0002 applied)' $ownerUrl) -ne 0) {
    throw "Pass 2 failed (28P01 = wrong password). The project DB password is not the crm_service one. Either supply it, or apply 0002 in the SQL Editor and re-run with -SkipOwnerPass."
  }

  $isolationExit = Invoke-Pass 'Pass 3/3  as crm_service  (isolation report)' $crmUrl
  if ($isolationExit -ne 0) { throw "Pass 3 failed." }

  Write-Host ""
  Write-Host "Read the isolation report above before deploying." -ForegroundColor Yellow
  Write-Host "  'Isolation OK'  -> crm_service is fenced out of public. Good."
  Write-Host "  Anything listing users / interactions as readable -> STOP (SETUP.md line 101)."
  Write-Host "  That would mean the CRM can read conversation content and emails."
}
finally {
  # Do not leave live owner credentials sitting in the session environment.
  Remove-Item Env:\CRM_DATABASE_URL -ErrorAction SilentlyContinue
  $crmPw = $null; $ownerPw = $null; $crmUrl = $null; $ownerUrl = $null
  [GC]::Collect()
}

<#
  Sets CRM_DATABASE_URL on the Fly app from a prompted password.

  Exists because the equivalent one-liner is long enough that pasting it into a
  terminal tends to lose its newlines and collapse into a syntax error. The
  password is prompted for, URL-encoded, and never written to shell history.

  Usage:
    .\scripts\set-db-secret.ps1
    .\scripts\set-db-secret.ps1 -Region us-west-1 -App my-other-app
#>
param(
  [string]$App    = 'bestie-crm',
  [string]$Ref    = 'hmjrvkhzpqxqxpgsolma',
  [string]$Region = 'us-east-1',
  # The transaction pooler rejected `crm_service.<ref>` with "tenant/user not
  # found", so the direct endpoint is the default: it is the one we have
  # actually proven works, and Fly machines have IPv6 egress, so the IPv6-only
  # limitation that breaks it from a home network does not apply there.
  [switch]$UsePooler,
  # libpq-compatible `require` encrypts without verifying the server identity.
  # Only needed if the bundled CA is missing from the image.
  [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'

$secure = Read-Host 'Password for role crm_service' -AsSecureString
$bstr   = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrWhiteSpace($plain)) { throw 'No password entered.' }
if ($plain -match '[<>]') { throw 'Password contains < or > -- that looks like an unsubstituted placeholder.' }

# A password with @ : / ? # % or & would otherwise be parsed as URL structure.
$enc = [System.Uri]::EscapeDataString($plain)

# The CA is baked into the image by the Dockerfile at this path.
$ssl = if ($NoVerify) {
  'uselibpqcompat=true&sslmode=require'
} else {
  'sslmode=verify-full&sslrootcert=' + [System.Uri]::EscapeDataString('/app/certs/prod-ca-2021.crt')
}

# The pooler routes on the username, which must be <role>.<project-ref>.
# The direct endpoint takes a bare role name -- mixing them up gives either
# 28P01 or "tenant/user not found".
if ($UsePooler) {
  $dbHost = "aws-0-$Region.pooler.supabase.com:6543"
  $user   = "crm_service.$Ref"
} else {
  $dbHost = "db.$Ref.supabase.co:5432"
  $user   = 'crm_service'
}

$url = "postgresql://$user`:$enc@$dbHost/postgres?$ssl"

Write-Host "Setting CRM_DATABASE_URL on $App"
Write-Host "  host: $dbHost"
Write-Host "  user: $user"
Write-Host "  ssl:  $ssl"

& fly secrets set -a $App "CRM_DATABASE_URL=$url" | Out-Host
$code = $LASTEXITCODE

$plain = $null; $enc = $null; $url = $null
[GC]::Collect()

if ($code -ne 0) { throw "fly secrets set failed with exit code $code" }
Write-Host "Done." -ForegroundColor Green

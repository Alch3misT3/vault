# Builds Vault and publishes it as a GitHub release, so installed copies update themselves.
# Usage: raise "version" in package.json, then run
#   .\scripts\release.ps1 -Notes "What changed in this version"
param([string]$Notes = '')
# Native tools write progress to stderr; Windows PowerShell 5 would treat that as fatal,
# so failures are detected through exit codes below instead.
$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')
$gh = 'C:\Program Files\GitHub CLI\gh.exe'

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
Write-Host "Releasing Vault $version" -ForegroundColor Cyan

# 1. Run the automated test first; stop if anything fails.
npx electron . --smoke
if ($LASTEXITCODE -ne 0) { throw 'Smoke test failed, nothing was released.' }

# 2. Create the release up front (the installer and portable uploads otherwise race to create it).
& $gh release view $tag -R Alch3misT3/vault > $null 2>&1
if ($LASTEXITCODE -ne 0) {
  if (-not $Notes) { $Notes = "Vault $version" }
  & $gh release create $tag -R Alch3misT3/vault --title "Vault $version" --notes $Notes --target main
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the GitHub release.' }
}

# 3. Build and upload (uses the GitHub CLI sign-in).
Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
node scripts/build-host.js
if ($LASTEXITCODE -ne 0) { throw 'Could not build the browser relay (vault-native-host.exe).' }
$env:GH_TOKEN = (& $gh auth token)
try {
  npx electron-builder --win nsis portable --publish always
  if ($LASTEXITCODE -ne 0) { throw 'Build or upload failed. Run the script again: it reuses the release.' }
} finally {
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
}
Write-Host "Vault $version is published. Installed copies pick it up within a few hours (or via Help > Check for Updates)." -ForegroundColor Green

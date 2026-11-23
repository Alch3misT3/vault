# Builds Vault and publishes it as a GitHub release, so installed copies update themselves.
# Usage: raise "version" in package.json, then run  .\scripts\release.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
Write-Host "Releasing Vault $version" -ForegroundColor Cyan

# 1. Run the automated test first; stop if anything fails.
npx electron . --smoke
if ($LASTEXITCODE -ne 0) { throw 'Smoke test failed, nothing was released.' }

# 2. Build and upload to GitHub Releases (uses the GitHub CLI sign-in).
$env:GH_TOKEN = (& 'C:\Program Files\GitHub CLI\gh.exe' auth token)
try {
  npx electron-builder --win nsis portable --publish always
  if ($LASTEXITCODE -ne 0) { throw 'Build or upload failed.' }
} finally {
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
}
Write-Host "Vault $version is published. Installed copies will pick it up within a few hours (or via Help > Check for Updates)." -ForegroundColor Green

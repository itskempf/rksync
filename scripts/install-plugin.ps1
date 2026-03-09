$ErrorActionPreference = 'Stop'

try {
  if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is not set for the current user session.'
  }

  $pluginRoot = Join-Path $env:LOCALAPPDATA 'Roblox\Plugins'
  $source = Join-Path $PSScriptRoot '..\roblox-plugin\RKsync.lua'
  $destination = Join-Path $pluginRoot 'RKsync.lua'
  $legacyDestination = Join-Path $pluginRoot 'MorgSync.lua'

  if (-not (Test-Path -LiteralPath $source)) {
    throw "Plugin source file was not found: $source"
  }

  New-Item -ItemType Directory -Force -Path $pluginRoot | Out-Null

  if (Test-Path -LiteralPath $legacyDestination) {
    Remove-Item -LiteralPath $legacyDestination -Force
    Write-Host "Removed legacy plugin: $legacyDestination"
  }

  Copy-Item -LiteralPath $source -Destination $destination -Force
  Write-Host "RKsync plugin installed successfully."
  Write-Host "Destination: $destination"
}
catch {
  Write-Error "RKsync plugin install failed. $($_.Exception.Message)"
  exit 1
}

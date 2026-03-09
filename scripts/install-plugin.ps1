if (-not $env:LOCALAPPDATA) {
  Write-Error "LOCALAPPDATA environment variable is not set. Could not determine Roblox Plugins directory."
  exit 1
}

$pluginRoot = Join-Path $env:LOCALAPPDATA 'Roblox\Plugins'
$source = Join-Path $PSScriptRoot '..\roblox-plugin\RKsync.lua'
$destination = Join-Path $pluginRoot 'RKsync.lua'
$legacyDestination = Join-Path $pluginRoot 'MorgSync.lua'

try {
  New-Item -ItemType Directory -Force -Path $pluginRoot | Out-Null

  if (Test-Path $legacyDestination) {
    Remove-Item -Path $legacyDestination -Force
    Write-Host "Removed legacy MorgSync.lua plugin."
  }

  Copy-Item -Path $source -Destination $destination -Force
  Write-Host "Successfully installed RKsync plugin to: $destination"
} catch {
  Write-Error "Failed to install RKsync plugin: $_"
  exit 1
}

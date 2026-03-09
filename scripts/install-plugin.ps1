$pluginRoot = Join-Path $env:LOCALAPPDATA 'Roblox\Plugins'
$source = Join-Path $PSScriptRoot '..\roblox-plugin\RKsync.lua'
$destination = Join-Path $pluginRoot 'RKsync.lua'
$legacyDestination = Join-Path $pluginRoot 'MorgSync.lua'

New-Item -ItemType Directory -Force -Path $pluginRoot | Out-Null
if (Test-Path $legacyDestination) {
  Remove-Item -Path $legacyDestination -Force
}
Copy-Item -Path $source -Destination $destination -Force

if ($?) {
  Write-Host "Installed RKsync plugin to $destination"
} else {
  Write-Error "Failed to install plugin."
}

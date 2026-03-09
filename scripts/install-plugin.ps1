$pluginRoot = 'C:\Users\aaron\AppData\Local\Roblox\Plugins'
$source = Join-Path $PSScriptRoot '..\roblox-plugin\RKsync.lua'
$destination = Join-Path $pluginRoot 'RKsync.lua'
$legacyDestination = Join-Path $pluginRoot 'MorgSync.lua'

New-Item -ItemType Directory -Force -Path $pluginRoot | Out-Null
if (Test-Path $legacyDestination) {
  Remove-Item -Path $legacyDestination -Force
}
Copy-Item -Path $source -Destination $destination -Force

Write-Host "Installed RKsync plugin to $destination"

# Registers the optional Akron native messaging host for the current user.
# Usage: powershell -File install-windows.ps1 -ExtensionId <chrome extension id>
param(
  [Parameter(Mandatory = $true)][string]$ExtensionId
)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostJs = Join-Path $here "host.mjs"
$bat = Join-Path $here "host.bat"
$manifestPath = Join-Path $here "com.autobot.optimusprime.json"
$manifest = @{
  name = "com.autobot.optimusprime"
  description = "Akron Browser Bot tool host"
  path = $bat
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
Set-Content -Path $manifestPath -Value $manifest -Encoding ascii
$reg = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.autobot.optimusprime"
New-Item -Path $reg -Force | Out-Null
Set-ItemProperty -Path $reg -Name "(default)" -Value $manifestPath
Write-Output "Registered $manifestPath"
Write-Output "Host script: $hostJs"

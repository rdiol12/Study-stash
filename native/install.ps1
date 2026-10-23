# Registers the native messaging host with Brave (and Chrome, if present).
#
# No admin rights needed: everything goes under HKCU. Re-run it any time the
# extension ID changes or you move this folder.
#
#   powershell -ExecutionPolicy Bypass -File native\install.ps1

param(
    # Find yours at brave://extensions (Developer mode on) under the card's ID.
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId,
    [string]$HostName    = "com.udemy_bridge.host"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- locate python -----------------------------------------------------------
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $python) { throw "Python not found on PATH. Install Python 3 or edit ud_host.bat by hand." }
Write-Host "python     : $python"

# --- launcher: native messaging needs an executable, and a .bat qualifies ----
# @echo off matters: anything on stdout would corrupt the length-prefixed protocol.
$bat = Join-Path $here "ud_host.bat"
@"
@echo off
"$python" "%~dp0ud_host.py" %*
"@ | Out-File -FilePath $bat -Encoding ascii -Force
Write-Host "launcher   : $bat"

# --- host manifest -----------------------------------------------------------
$manifestPath = Join-Path $here "$HostName.json"
$manifest = [ordered]@{
    name            = $HostName
    description     = "Udemy Downloader Bridge file mover"
    path            = $bat
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
# No BOM: Chromium can silently reject a BOM-prefixed host manifest.
$json = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "manifest   : $manifestPath"

# --- register under every Chromium browser that is installed -----------------
$targets = @(
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
)
foreach ($key in $targets) {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name "(default)" -Value $manifestPath -PropertyType String -Force | Out-Null
    Write-Host "registered : $key"
}

Write-Host ""
Write-Host "Done. Restart Brave, then click 'Test helper' in the extension's Settings page." -ForegroundColor Green
Write-Host "Extension ID used: $ExtensionId" -ForegroundColor Yellow
Write-Host "If that is not your ID (brave://extensions), re-run with -ExtensionId <id>."

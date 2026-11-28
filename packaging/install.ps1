# Installs Zendr for the current Windows user. No admin rights needed.
#
#   Right-click install.ps1 > Run with PowerShell
#   or: powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Puts herdr-core (the background core that keeps your terminals running) in
# %LOCALAPPDATA%\Programs\herdr-core, the app in %LOCALAPPDATA%\Programs\herdr-app,
# Zendr in the Start menu, `zendr` and `hc` on your PATH, and Zendr's mods and
# layout in ~\.config\herdr-app. Running it again updates everything; terminals
# that are running keep running, and an open Zendr keeps going until you reopen it.
#
#   -NoPath   leaves your PATH alone: Zendr still finds its core, but `zendr` and
#             `hc` only run by their full path (%LOCALAPPDATA%\Programs\...).
#   -NoLaunch doesn't open Zendr when done.
param([switch]$NoLaunch, [switch]$NoPath)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$here = $PSScriptRoot

$machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$machine = if ($machine -eq "ARM64") { "arm64" } elseif ($machine -eq "AMD64") { "x64" } else { throw "Zendr runs on x64 and ARM64 Windows, not $machine." }
$package = (Get-Content -LiteralPath (Join-Path $here "arch.txt") -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
if ($package -eq "arm64" -and $machine -eq "x64") { throw "This is the ARM64 build. Download Zendr-...-windows-x64.zip for this PC." }
if ($package -eq "x64" -and $machine -eq "arm64") {
    Write-Warning "This is the x64 build; on this ARM64 PC it runs under emulation. Zendr-...-windows-arm64.zip runs natively."
}

Write-Host ""
Write-Host "  Installing Zendr ($package)" -ForegroundColor Green
Write-Host ""

# 1. The core, with its own installer: it updates a running core in place.
$tmp = Join-Path ([IO.Path]::GetTempPath()) "zendr-install-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    # The core's installer deletes its zip and itself when done: hand it copies.
    Copy-Item (Join-Path $here "core\install.ps1"), (Join-Path $here "core\herdr-core.zip") $tmp
    if ($NoPath) { $env:HC_NO_PATH = "1" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$tmp\install.ps1" "$tmp\herdr-core.zip"
    if ($LASTEXITCODE) { throw "Installing herdr-core failed (exit $LASTEXITCODE)." }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# 2. The app. A running app's folder can be renamed but not deleted: the old one goes
#    now if it can, else on the next install.
$dir = Join-Path $env:LOCALAPPDATA "Programs\herdr-app"
New-Item -ItemType Directory -Force (Split-Path $dir) | Out-Null
Get-ChildItem "$dir.old*" -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $dir) { Rename-Item -LiteralPath $dir -NewName "herdr-app.old-$([guid]::NewGuid().ToString('N'))" }
Copy-Item -Recurse (Join-Path $here "app") $dir
Get-ChildItem "$dir.old*" -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
# `zendr` on the command line is the app's CLI (zendr do / shot / status ...).
Set-Content -LiteralPath (Join-Path $dir "zendr.cmd") -Value "@`"%~dp0herdr-app.exe`" %*" -Encoding ascii
Write-Host "Zendr installed into $dir."

# 3. The Start menu: Zendr replaces Herdr's entry if there was one.
$programs = [Environment]::GetFolderPath("Programs")
Remove-Item -LiteralPath (Join-Path $programs "Herdr.lnk") -Force -ErrorAction SilentlyContinue
$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $programs "Zendr.lnk"))
$link.TargetPath = Join-Path $dir "herdr-app.exe"
$link.WorkingDirectory = $env:USERPROFILE
$link.Description = "Terminals and coding agents that keep running"
$link.Save()

# 4. PATH, keeping %VARIABLES% in it unexpanded and its registry type as it was.
if ($NoPath) {
    Write-Host "Left your PATH alone (-NoPath). The CLI is $dir\zendr.cmd."
} else {
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
try {
    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if (-not ($raw -split ";" | Where-Object { $_.Trim().TrimEnd("\") -ieq $dir.TrimEnd("\") })) {
        $kind = if ($key.GetValueNames() -contains "Path") { $key.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $key.SetValue("Path", $(if ($raw) { "$($raw.TrimEnd(';'));$dir" } else { $dir }), $kind)
        # Setting any user variable tells running programs the environment changed.
        [Environment]::SetEnvironmentVariable("ZENDR_INSTALLING", "1", "User")
        [Environment]::SetEnvironmentVariable("ZENDR_INSTALLING", $null, "User")
    }
} finally { $key.Close() }
}

# 5. Zendr's mods, layout and shortcuts.
& (Join-Path $here "config\install.ps1")

Write-Host ""
$ready = if ($NoPath) { "Zendr is ready. Open it from the Start menu." } else { "Zendr is ready. Open it from the Start menu, or type zendr in a new terminal." }
Write-Host "  $ready" -ForegroundColor Green
Write-Host ""
if (-not $NoLaunch) { Start-Process (Join-Path $dir "herdr-app.exe") -WorkingDirectory $env:USERPROFILE }

# Builds this checkout and installs it for the current Windows user.
function Install-HerdrAppFiles($Binary, $Icon, $Destination) {
    $ErrorActionPreference = "Stop"
    $Destination = [IO.Path]::GetFullPath($Destination)
    $stage = "$Destination.install-$([guid]::NewGuid().ToString('N'))"
    $backup = "$Destination.old-$([guid]::NewGuid().ToString('N'))"
    $installed = $false
    try {
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        Copy-Item -LiteralPath $Binary -Destination "$stage\herdr-app.exe"
        Copy-Item -LiteralPath $Icon -Destination "$stage\herdr-app.svg"
        # Renaming the folder leaves an already running app alive.
        if (Test-Path -LiteralPath $Destination) {
            Rename-Item -LiteralPath $Destination -NewName (Split-Path $backup -Leaf)
        }
        try {
            Rename-Item -LiteralPath $stage -NewName (Split-Path $Destination -Leaf)
        } catch {
            $installError = $_
            if (Test-Path -LiteralPath $backup) {
                try {
                    Rename-Item -LiteralPath $backup -NewName (Split-Path $Destination -Leaf)
                } catch {
                    throw "Installation failed: $installError. Could not restore the previous build at ${backup}: $_"
                }
            }
            throw $installError
        }
        $installed = $true
    } finally {
        if (Test-Path -LiteralPath $stage) {
            Remove-Item -LiteralPath $stage -Recurse -Force
        }
        if ($installed -and (Test-Path -LiteralPath $backup)) {
            try { Remove-Item -LiteralPath $backup -Recurse -Force }
            catch { Write-Warning "Previous build remains at $backup. Remove it after quitting Zendr." }
        }
    }
}

# Dot-sourcing exposes only the file operation for isolated installer tests.
if ($MyInvocation.InvocationName -eq '.') { return }
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "This installer requires Windows." }

Push-Location "$PSScriptRoot\.."
try {
    cargo build --release --locked --target-dir target
    if ($LASTEXITCODE) { throw "Zendr build failed (exit $LASTEXITCODE)." }
    $dir = Join-Path $env:LOCALAPPDATA "Programs\herdr-app"
    Install-HerdrAppFiles "target\release\herdr-app.exe" "assets\icons\herdr-ui-icon-clean.svg" $dir
} finally {
    Pop-Location
}

# Zendr's Start menu entry replaces the one Herdr's installer made.
$programs = [Environment]::GetFolderPath("Programs")
$old = Join-Path $programs "Herdr.lnk"
if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
$menu = Join-Path $programs "Zendr.lnk"
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($menu)
$link.TargetPath = Join-Path $dir "herdr-app.exe"
$link.WorkingDirectory = $env:USERPROFILE
$link.Description = "Terminals and coding agents that keep running"
$link.Save()
# `zendr` on the command line is the app's CLI (herdr-app do/ls/shot/...).
Set-Content -LiteralPath (Join-Path $dir "zendr.cmd") -Value "@`"%~dp0herdr-app.exe`" %*" -Encoding ascii

# Keep literal %VARIABLES% and the existing registry value type in PATH.
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
try {
    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $listed = $raw -split ";" | Where-Object { $_.Trim().TrimEnd("\") -ieq $dir.TrimEnd("\") }
    if (-not $listed) {
        $kind = if ($key.GetValueNames() -contains "Path") { $key.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $key.SetValue("Path", $(if ($raw) { "$($raw.TrimEnd(';'));$dir" } else { $dir }), $kind)
        [Environment]::SetEnvironmentVariable("HERDR_INSTALLING", "1", "User")
        [Environment]::SetEnvironmentVariable("HERDR_INSTALLING", $null, "User")
    }
} finally {
    $key.Close()
}
if (($env:Path -split ";") -notcontains $dir) { $env:Path += ";$dir" }
Write-Host "Installed Zendr. Quit and reopen Zendr to use the new build."

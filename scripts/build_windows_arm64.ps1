# Build, package and optionally install a native Windows ARM64 Herdr.
#
#   .\scripts\build_windows_arm64.ps1            # build + package target\dist\herdr-windows-aarch64.zip
#   .\scripts\build_windows_arm64.ps1 -Install   # ...then install it with distribution\install.ps1
#
# Requires Rust (aarch64-pc-windows-msvc), Visual Studio Build Tools with the
# ARM64 C++ tools, Python, and Zig 0.16.0. The native ARM64 Zig 0.16.0 crashes
# on some Windows 11 builds, so the x86_64 Zig (run under emulation) is the
# default; it cross-compiles libghostty-vt to native ARM64 code either way.
param(
    [switch]$Install,
    [string]$Zig = $env:ZIG
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Invoke-NativeChecked {
    param(
        [string]$Command,
        [string[]]$Arguments
    )

    # Windows PowerShell turns redirected native stderr (cargo progress) into
    # terminating errors under "Stop"; judge native tools by exit code only.
    $ErrorActionPreference = "Continue"
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$triple = "aarch64-pc-windows-msvc"

if ([string]::IsNullOrWhiteSpace($Zig)) {
    $Zig = Join-Path $env:LOCALAPPDATA "Programs\zig\zig-x86_64-windows-0.16.0\zig.exe"
}
if (-not (Test-Path -LiteralPath $Zig -PathType Leaf)) {
    throw "Zig 0.16.0 not found at $Zig. Install it from https://ziglang.org/download/ or pass -Zig."
}
$env:ZIG = $Zig

$python = (Get-Command py -ErrorAction SilentlyContinue)
$python = if ($null -ne $python) { $python.Source } else { (Get-Command python).Source }

Push-Location $root
try {
    Invoke-NativeChecked cargo @("build", "--release", "--locked", "--target", $triple)
    $exe = Join-Path $root "target\$triple\release\herdr.exe"

    $dist = Join-Path $root "target\dist"
    $zip = Join-Path $dist "herdr-windows-aarch64.zip"
    $stage = Join-Path $root "target\$triple\herdr-windows-aarch64"
    $package = Join-Path $root "target\conpty\Microsoft.Windows.Console.ConPTY.nupkg"
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue

    $packager = Join-Path $root "scripts\package_windows_conpty.py"
    Invoke-NativeChecked $python @(
        $packager, "stage", "--architecture", "aarch64",
        "--package", $package, "--herdr-exe", $exe, "--output-dir", $stage
    )
    foreach ($relative in @("conpty\conpty.dll", "conpty\x64\OpenConsole.exe", "conpty\arm64\OpenConsole.exe")) {
        $signature = Get-AuthenticodeSignature (Join-Path $stage $relative)
        $subject = if ($null -eq $signature.SignerCertificate) { "" } else { $signature.SignerCertificate.Subject }
        if ($signature.Status -ne "Valid" -or $subject -notlike "*Microsoft Corporation*") {
            throw "Invalid Microsoft signature for $relative`: $($signature.Status) $subject"
        }
    }
    Invoke-NativeChecked $python @(
        $packager, "archive", "--architecture", "aarch64", "--stage-dir", $stage, "--output", $zip
    )

    $version = ((& $exe --version) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged herdr.exe failed: --version"
    }
    $sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    Write-Host "Built $version -> $zip"
    Write-Host "sha256 $sha256"

    if ($Install) {
        $identity = ($version -split "\s+")[-1]
        Invoke-NativeChecked powershell.exe @(
            "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", (Join-Path $root "distribution\install.ps1"),
            "-Channel", "stable",
            "-LocalPackagePath", $zip,
            "-LocalPackageFormat", "zip",
            "-LocalPackageIdentity", $identity,
            "-LocalPackageSha256", $sha256
        )
    }
} finally {
    Pop-Location
}

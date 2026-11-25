# Builds and installs Zendr (the Herdr desktop app, rebranded) and herdr-core natively for Windows ARM64.
#
#   .\scripts\build-windows-arm64.ps1                 # core (..\herdr-core) + app
#   .\scripts\build-windows-arm64.ps1 -SkipCore       # app only
#   .\scripts\build-windows-arm64.ps1 -CorePath <dir> # core checkout elsewhere
#
# Each project installs through its own installer (scripts\install-local.ps1,
# scripts\install-windows.ps1). Needs Rust, Visual Studio Build Tools with the
# ARM64 tools, the Windows SDK (rc.exe), Zig 0.16.0 and LLVM (clang.exe,
# libclang.dll; ring and bindgen need them on ARM64). The x86_64 Zig is the
# default: the native ARM64 Zig 0.16.0 crashes on some Windows 11 builds, and
# Zig cross-compiles to native ARM64 code either way.
param(
    [string]$CorePath = (Join-Path $PSScriptRoot "..\..\herdr-core"),
    [switch]$SkipCore,
    [string]$Zig = (Join-Path $env:LOCALAPPDATA "Programs\zig\zig-x86_64-windows-0.16.0\zig.exe"),
    [string]$LlvmBin = (Join-Path $env:LOCALAPPDATA "Programs\llvm\clang+llvm-23.1.6-aarch64-pc-windows-msvc\bin")
)
$ErrorActionPreference = "Stop"

foreach ($tool in @($Zig, (Join-Path $LlvmBin "clang.exe"), (Join-Path $LlvmBin "libclang.dll"))) {
    if (-not (Test-Path -LiteralPath $tool)) { throw "Missing $tool (see the header of this script)." }
}
$rc = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\arm64\rc.exe" -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
if (-not $rc) { throw "Missing the Windows SDK's ARM64 rc.exe; install the Windows SDK." }

$env:ZIG = $Zig
$env:RC = $rc.FullName
$env:LIBCLANG_PATH = $LlvmBin
$env:Path = "$LlvmBin;$(Split-Path $Zig);$($rc.DirectoryName);$env:Path"

function Invoke-Installer($Script) {
    # Native stderr (cargo progress) must not stop this script; exit codes decide.
    $ErrorActionPreference = "Continue"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script
    if ($LASTEXITCODE) { throw "$Script failed (exit $LASTEXITCODE)." }
}

if (-not $SkipCore) {
    $core = (Resolve-Path -LiteralPath $CorePath).Path
    Invoke-Installer (Join-Path $core "scripts\install-local.ps1")
}
Invoke-Installer (Join-Path $PSScriptRoot "install-windows.ps1")

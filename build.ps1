# Builds and installs Zendr on Windows ARM64: herdr-core (core\), then the app (app\),
# then its mods and layout (config\). Needs what app\scripts\build-windows-arm64.ps1 lists:
# Rust, Visual Studio Build Tools (ARM64), LLVM/libclang and an x64 Zig.
#   powershell -ExecutionPolicy Bypass -File .\build.ps1             # everything
#   powershell -ExecutionPolicy Bypass -File .\build.ps1 -SkipCore   # app and config only
param([switch]$SkipCore, [switch]$SkipConfig)
$ErrorActionPreference = "Stop"

# The app and core build Ghostty from source.
git -C $PSScriptRoot submodule update --init --depth 1 app/vendor/ghostty core/vendor/ghostty
if ($LASTEXITCODE) { throw "Could not fetch the ghostty submodules (exit $LASTEXITCODE)." }

$app = Join-Path $PSScriptRoot "app\scripts\build-windows-arm64.ps1"
$build = @{ CorePath = (Join-Path $PSScriptRoot "core") }
if ($SkipCore) { $build.SkipCore = $true }
& $app @build
if (-not $SkipConfig) { & (Join-Path $PSScriptRoot "config\install.ps1") }

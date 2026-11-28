# Builds Zendr for Windows x64 or ARM64 and packs it as a zip anyone can install from:
#
#   powershell -ExecutionPolicy Bypass -File .\package.ps1 -Arch x64     # dist\Zendr-<version>-windows-x64.zip
#   powershell -ExecutionPolicy Bypass -File .\package.ps1 -Arch arm64   # dist\Zendr-<version>-windows-arm64.zip
#
# Either kind of machine builds either kind: Rust, Zig and MSVC all cross-compile. It needs
# what build.ps1 needs, plus the Rust target (rustup target add x86_64-pc-windows-msvc or
# aarch64-pc-windows-msvc) and Visual Studio Build Tools' compilers for that architecture.
# The zip holds the app, herdr-core with Microsoft's ConPTY, Zendr's mods and layout, and
# install.ps1 (packaging\install.ps1), which sets everything up for the current user.
# With ZENDR_SIGN_PFX (a .pfx file) and ZENDR_SIGN_PASSWORD set, the app and the core are
# Authenticode-signed before packing (.github/workflows/windows.yml does this from secrets).
param(
    [ValidateSet("x64", "arm64")][string]$Arch = "x64",
    [string]$AppPath = (Join-Path $PSScriptRoot "app"),
    [string]$CorePath = (Join-Path $PSScriptRoot "core"),
    [string]$Zig = (Join-Path $env:LOCALAPPDATA "Programs\zig\zig-x86_64-windows-0.16.0\zig.exe"),
    [string]$LlvmBin = ""
)
$ErrorActionPreference = "Stop"
$triple = if ($Arch -eq "x64") { "x86_64-pc-windows-msvc" } else { "aarch64-pc-windows-msvc" }
$host_ = if (($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE | Where-Object { $_ } | Select-Object -First 1) -eq "ARM64") { "arm64" } else { "x64" }

# Tools: Zig (Ghostty), clang and libclang (ring and bindgen), the SDK's rc.exe (the exe's icon).
if (-not $LlvmBin) {
    $LlvmBin = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Programs\llvm\*\bin\libclang.dll"), "$env:ProgramFiles\LLVM\bin\libclang.dll" -ErrorAction SilentlyContinue |
        Select-Object -First 1 | ForEach-Object { $_.DirectoryName }
}
foreach ($tool in @($Zig, (Join-Path "$LlvmBin" "clang.exe"), (Join-Path "$LlvmBin" "libclang.dll"))) {
    if (-not (Test-Path -LiteralPath $tool)) { throw "Missing $tool (see build.ps1 and app\scripts\build-windows-arm64.ps1)." }
}
$rc = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\$host_\rc.exe" -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
if (-not $rc) { throw "Missing the Windows SDK's rc.exe; install the Windows SDK." }
if (-not ((rustup target list --installed) -contains $triple)) { throw "Run: rustup target add $triple" }
$env:ZIG = $Zig
$env:RC = $rc.FullName
$env:LIBCLANG_PATH = $LlvmBin
$env:Path = "$LlvmBin;$(Split-Path $Zig);$($rc.DirectoryName);$env:Path"
# A source build never updates itself to Herdr's releases (src/update.rs).
Remove-Item Env:HERDR_APP_RELEASE -ErrorAction SilentlyContinue

# This machine's own target builds into target\release, where build.ps1's builds are too.
$native = ((rustc -vV | Select-String '^host: (.+)').Matches[0].Groups[1].Value) -eq $triple
$out = if ($native) { "target\release" } else { "target\$triple\release" }
function Invoke-Cargo($Dir) {
    # Native stderr (cargo progress) must not stop this script; exit codes decide.
    $ErrorActionPreference = "Continue"
    Push-Location $Dir
    try {
        if ($native) { cargo build --release --locked } else { cargo build --release --locked --target $triple }
        if ($LASTEXITCODE) { throw "cargo build in $Dir failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
}

$core = (Resolve-Path -LiteralPath $CorePath).Path
$app = (Resolve-Path -LiteralPath $AppPath).Path
# This repository's app\ and core\ build Ghostty from their submodules.
if ($app.StartsWith($PSScriptRoot) -or $core.StartsWith($PSScriptRoot)) {
    $ErrorActionPreference = "Continue" # git reports progress on stderr
    git -C $PSScriptRoot submodule update --init --depth 1 app/vendor/ghostty core/vendor/ghostty
    if ($LASTEXITCODE) { throw "Could not fetch the ghostty submodules (exit $LASTEXITCODE)." }
    $ErrorActionPreference = "Stop"
}
Write-Host "== herdr-core for $triple"
Invoke-Cargo $core
$coreOut = Join-Path $core $out
& (Join-Path $core "scripts\fetch-conpty.ps1") -Dest $coreOut -Arch $Arch
Write-Host "== Zendr for $triple"
Invoke-Cargo $app
$appOut = Join-Path $app $out

# Authenticode, when a certificate is given (CI passes one from its secrets): both programs
# are signed and timestamped before they're packed, so Windows shows who made them.
if ($env:ZENDR_SIGN_PFX) {
    $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\$host_\signtool.exe" -ErrorAction SilentlyContinue |
        Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
    if (-not $signtool) { throw "Missing the Windows SDK's signtool.exe." }
    $timestamp = if ($env:ZENDR_SIGN_TIMESTAMP) { $env:ZENDR_SIGN_TIMESTAMP } else { "http://timestamp.digicert.com" }
    foreach ($exe in @((Join-Path $appOut "herdr-app.exe"), (Join-Path $coreOut "herdr-core.exe"))) {
        & $signtool.FullName sign /fd SHA256 /td SHA256 /tr $timestamp /f $env:ZENDR_SIGN_PFX /p $env:ZENDR_SIGN_PASSWORD $exe
        if ($LASTEXITCODE) { throw "Signing $exe failed (exit $LASTEXITCODE)." }
    }
}

$version = (Select-String -Path (Join-Path $app "Cargo.toml") -Pattern '^version = "(.+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
$name = "Zendr-$version-windows-$Arch"
$dist = Join-Path $PSScriptRoot "dist"
$stage = Join-Path $dist $name
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force "$stage\app", "$stage\core" | Out-Null

Copy-Item (Join-Path $appOut "herdr-app.exe") "$stage\app\"
Copy-Item (Join-Path $app "assets\icons\herdr-ui-icon-clean.svg") "$stage\app\herdr-app.svg"
Copy-Item (Join-Path $app "LICENSE"), (Join-Path $app "THIRD-PARTY-NOTICES") "$stage\app\"
# The core goes in as its own installer wants it: a zip of herdr-core.exe and conpty\.
& "$env:SystemRoot\System32\tar.exe" -a -cf "$stage\core\herdr-core.zip" -C $coreOut herdr-core.exe conpty
if ($LASTEXITCODE) { throw "Packing herdr-core failed." }
Copy-Item (Join-Path $core "distribution\install.ps1") "$stage\core\install.ps1"
Copy-Item -Recurse (Join-Path $PSScriptRoot "config") "$stage\config"
Copy-Item (Join-Path $PSScriptRoot "packaging\install.ps1"), (Join-Path $PSScriptRoot "LICENSE"), (Join-Path $PSScriptRoot "NOTICE") $stage
Set-Content -LiteralPath "$stage\arch.txt" -Value $Arch -Encoding ascii

$zip = Join-Path $dist "$name.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
& "$env:SystemRoot\System32\tar.exe" -a -cf $zip -C $dist $name
if ($LASTEXITCODE) { throw "Packing $zip failed." }
$stream = [IO.File]::OpenRead($zip)
try { $sha = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) } finally { $stream.Close() }
Set-Content -LiteralPath "$zip.sha256" -Value "$sha  $name.zip" -Encoding ascii
Write-Host "Packed $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)`nsha256 $sha"

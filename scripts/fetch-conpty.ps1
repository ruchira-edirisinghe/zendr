# Puts Microsoft's ConPTY beside herdr-core.exe: <Dest>\conpty\conpty.dll and
# <Dest>\conpty\<x64|arm64>\OpenConsole.exe. Windows' own ConPTY swallows the
# answers hc gives programs (7501, DA), so hc ships this one. Pinned and checked.
# -Arch defaults to the architecture of <Dest>\herdr-core.exe (the machine's if absent):
# conpty.dll must match hc, and it starts the OpenConsole for the machine's own
# architecture from the folder of that name.
param([Parameter(Mandatory)][string]$Dest, [ValidateSet("x64", "arm64", "")][string]$Arch = "")
$ErrorActionPreference = "Stop"
$version = "1.24.260710001"
$url = "https://github.com/microsoft/terminal/releases/download/v1.24.11911.0/Microsoft.Windows.Console.ConPTY.$version.nupkg"
$sha = @{
    nupkg = "9382ad7becb7e4d84e300578d8e4f4df28f43d979d9055d978c42913c47e0e9d"
    "runtimes/win-x64/native/conpty.dll" = "39fba2713e2495117b1591ae8c32a3b904bea7aa66069cf7815e2844c76d75d8"
    "build/native/runtimes/x64/OpenConsole.exe" = "b7fd936c2668b87b9ecf7b3366dc6568afc1c6f981874cba3e955a1c35cf8160"
    "runtimes/win-arm64/native/conpty.dll" = "db3d173640b172bafd42d5b541b638a9aeec1c7d0e40dd636bf02822a32c912c"
    "build/native/runtimes/arm64/OpenConsole.exe" = "ed7622fd0d3bedc9ab9f122f5e58edf0def9e7999224f52dd395ba9f54edbe09"
}
function Check($path, $want) {
    # .NET, not Get-FileHash: that one fails when PowerShell 7 starts 5.1.
    $stream = [IO.File]::OpenRead($path)
    try { $got = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) } finally { $stream.Close() }
    if ($got -ne $want) { throw "$path`: sha256 $got, expected $want" }
}
if (-not $Arch) {
    # Before a build: the machine's own architecture, which cargo builds for.
    $os = [System.Runtime.InteropServices.RuntimeInformation, mscorlib]::OSArchitecture.ToString()
    $Arch = if ($os -eq "Arm64") { "arm64" } else { "x64" }
    $exe = Join-Path $Dest "herdr-core.exe"
    if (Test-Path $exe) {
        # The PE header's machine field: 0xAA64 is ARM64.
        $bytes = [IO.File]::ReadAllBytes($exe)
        $pe = [BitConverter]::ToInt32($bytes, 0x3C)
        $Arch = if ([BitConverter]::ToUInt16($bytes, $pe + 4) -eq 0xAA64) { "arm64" } else { "x64" }
    }
}
$work = Join-Path ([IO.Path]::GetTempPath()) "hc-conpty-$version"
$zip = "$work.zip"
if (-not (Test-Path $zip)) {
    Invoke-WebRequest -UseBasicParsing $url -OutFile "$zip.part"
    Move-Item -Force "$zip.part" $zip
}
Check $zip $sha.nupkg
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
Expand-Archive $zip $work
New-Item -ItemType Directory -Force "$Dest\conpty\$Arch" | Out-Null
foreach ($pair in @(("runtimes/win-$Arch/native/conpty.dll", "conpty\conpty.dll"), ("build/native/runtimes/$Arch/OpenConsole.exe", "conpty\$Arch\OpenConsole.exe"))) {
    Check (Join-Path $work $pair[0]) $sha[$pair[0]]
    Copy-Item -Force (Join-Path $work $pair[0]) (Join-Path $Dest $pair[1])
}
Remove-Item -Recurse -Force $work
"ConPTY $version ($Arch) in $Dest\conpty"

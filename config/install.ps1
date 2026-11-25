# Installs Zendr's mods and its layout into the app's config folder and switches to it.
# Run it after the app is installed (build.ps1), with Zendr open or closed:
#   powershell -ExecutionPolicy Bypass -File .\config\install.ps1
# Mods with the same names are replaced. Your other mods, layouts and keys stay.
$ErrorActionPreference = "Stop"
$config = Join-Path $env:USERPROFILE ".config\herdr-app"
New-Item -ItemType Directory -Force (Join-Path $config "mods"), (Join-Path $config "layouts") | Out-Null

foreach ($mod in Get-ChildItem -Directory (Join-Path $PSScriptRoot "mods")) {
    $to = Join-Path $config "mods\$($mod.Name)"
    if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
    Copy-Item -LiteralPath $mod.FullName -Destination $to -Recurse
    Write-Host "mod     $($mod.Name)"
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "layouts\main-review.json") -Destination (Join-Path $config "layouts\main-review.json") -Force
Write-Host "layout  main-review"

# Adds Zendr's shortcuts to keys.json, keeping every binding already there.
$keysPath = Join-Path $config "keys.json"
$keys = if (Test-Path -LiteralPath $keysPath) { Get-Content -Raw -LiteralPath $keysPath | ConvertFrom-Json } else { [pscustomobject]@{} }
$add = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "keys.json") | ConvertFrom-Json
foreach ($section in $add.PSObject.Properties) {
    if (-not $keys.PSObject.Properties[$section.Name]) { $keys | Add-Member -NotePropertyName $section.Name -NotePropertyValue ([pscustomobject]@{}) }
    foreach ($binding in $section.Value.PSObject.Properties) {
        if (-not $keys.($section.Name).PSObject.Properties[$binding.Name]) {
            $keys.($section.Name) | Add-Member -NotePropertyName $binding.Name -NotePropertyValue $binding.Value
            Write-Host "key     $($binding.Name) -> $($binding.Value)"
        }
    }
}
[IO.File]::WriteAllText($keysPath, ($keys | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))

# Switch an open Zendr to the layout (a closed one picks it from Settings > Look).
$app = Join-Path $env:LOCALAPPDATA "Programs\herdr-app\herdr-app.exe"
if (Test-Path -LiteralPath $app) {
    & $app do layout.switch '{\"name\":\"main-review\"}' 2>$null | Out-Null
}
Write-Host "Done. In Zendr: Settings > Look > main-review, if it didn't switch."

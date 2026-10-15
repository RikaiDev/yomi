param(
    [string]$Output = "build/desktop-release/windows-x64"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root
$Version = node -p "require('./package.json').version"
$Output = [System.IO.Path]::GetFullPath((Join-Path $Root $Output))
$Core = Join-Path $Root "build/desktop-core-windows"
$Stage = Join-Path $Output "stage"
$NodeBinary = if ($env:YOMI_NODE_BINARY) { $env:YOMI_NODE_BINARY } else { (Get-Command node).Source }

npm run desktop:windows:qc
npm run desktop:windows:harness
node scripts/package-desktop-core.mjs --platform windows --output $Core --semantic full --node-binary $NodeBinary
cargo build --manifest-path desktop/Cargo.toml --release --target x86_64-pc-windows-msvc

Remove-Item $Output -Recurse -Force -ErrorAction SilentlyContinue
New-Item $Stage -ItemType Directory -Force | Out-Null
Copy-Item "desktop/target/x86_64-pc-windows-msvc/release/yomi-desktop.exe" (Join-Path $Stage "Yomi.exe")
Copy-Item (Join-Path $Core "YomiCore") (Join-Path $Stage "YomiCore") -Recurse
Copy-Item (Join-Path $Core "runtime") (Join-Path $Stage "runtime") -Recurse
Copy-Item (Join-Path $Core "desktop-bundle.json") $Stage
Copy-Item "LICENSE" $Stage
Copy-Item "NOTICE" $Stage
Copy-Item "desktop/windows-native/README.md" (Join-Path $Stage "README.txt")

function Find-SignTool {
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $kits = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
    return Get-ChildItem $kits -Filter signtool.exe -Recurse |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}

$SignTool = Find-SignTool
$CertificatePath = $null
if ($env:WINDOWS_CERTIFICATE_BASE64) {
    if (-not $SignTool) { throw "signtool.exe was not found" }
    $CertificatePath = Join-Path $env:RUNNER_TEMP "yomi-signing.pfx"
    [IO.File]::WriteAllBytes($CertificatePath, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64))
    & $SignTool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f $CertificatePath /p $env:WINDOWS_CERTIFICATE_PASSWORD (Join-Path $Stage "Yomi.exe")
    & $SignTool verify /pa /v (Join-Path $Stage "Yomi.exe")
} elseif ($env:YOMI_ALLOW_UNSIGNED_PREVIEW -ne "1") {
    throw "WINDOWS_CERTIFICATE_BASE64 and WINDOWS_CERTIFICATE_PASSWORD are required"
}

$Iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
if (-not $Iscc) { throw "Inno Setup iscc.exe was not found" }
& $Iscc "/DAppVersion=$Version" "/DSourceDir=$Stage" "/DOutputDir=$Output" "desktop/windows-native/Yomi.iss"

$Installer = Join-Path $Output "Yomi-Desktop-Windows-x64-$Version-Setup.exe"
if (-not (Test-Path $Installer)) { throw "installer was not produced" }

$TempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$SmokeInstall = Join-Path $TempRoot "yomi-desktop-smoke"
Remove-Item $SmokeInstall -Recurse -Force -ErrorAction SilentlyContinue
$InstallProcess = Start-Process $Installer -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/DIR=$SmokeInstall" -Wait -PassThru
if ($InstallProcess.ExitCode -ne 0) { throw "silent installer smoke failed with $($InstallProcess.ExitCode)" }
$SmokeVersion = & (Join-Path $SmokeInstall "runtime/node.exe") (Join-Path $SmokeInstall "YomiCore/run.mjs") version
if ($SmokeVersion.Trim() -ne $Version) { throw "installed core version smoke failed: $SmokeVersion" }
Remove-Item $SmokeInstall -Recurse -Force

if ($CertificatePath) {
    & $SignTool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f $CertificatePath /p $env:WINDOWS_CERTIFICATE_PASSWORD $Installer
    & $SignTool verify /pa /v $Installer
    Remove-Item $CertificatePath -Force
}

$Hash = (Get-FileHash $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content "$Installer.sha256" "$Hash  $([IO.Path]::GetFileName($Installer))`n" -NoNewline
$SizeMb = [math]::Ceiling((Get-Item $Installer).Length / 1MB)
$maxMb = if ($env:YOMI_WINDOWS_INSTALLER_MAX_MB) { [int]$env:YOMI_WINDOWS_INSTALLER_MAX_MB } else { 120 }
if ($SizeMb -gt $maxMb) {
    throw "installer is $SizeMb MB, above size budget"
}
Write-Host "[desktop:windows-release] $Installer ($SizeMb MB)"

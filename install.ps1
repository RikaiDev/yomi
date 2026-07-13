# Yomi one-click installer for Windows (PowerShell)
# Checks for Node.js >= 22, installs if missing, then launches yomi via npx.

$ErrorActionPreference = "Stop"
$NODE_MIN_MAJOR = 24

# ── helpers ──────────────────────────────────────────────────────────────────

function Write-Info  { Write-Host $args -ForegroundColor Cyan }
function Write-Ok    { Write-Host $args -ForegroundColor Green }
function Write-Warn  { Write-Host $args -ForegroundColor Yellow }
function Write-Die   { Write-Host $args -ForegroundColor Red; exit 1 }

# ── check / install node ─────────────────────────────────────────────────────

function Test-NodeInstalled {
    try {
        $v = & node -v 2>$null
        if ($v -match '^v(\d+)') {
            [int]$Matches[1] -ge $NODE_MIN_MAJOR
        } else { $false }
    } catch { $false }
}

function Install-Node {
    Write-Info "Node.js >= $NODE_MIN_MAJOR not found -- installing..."

    # Try winget first (built into Windows 10/11)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Using winget to install Node.js LTS"
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        if (Test-NodeInstalled) { Write-Ok "Node.js $(node -v) installed"; return }
    }

    # Try chocolatey
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Info "Using chocolatey to install Node.js LTS"
        choco install nodejs-lts -y
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        if (Test-NodeInstalled) { Write-Ok "Node.js $(node -v) installed"; return }
    }

    # Fallback: download MSI directly
    Write-Info "Downloading Node.js v22 LTS installer..."
    $url = "https://nodejs.org/dist/v24.18.0/node-v24.18.0-x64.msi"
    $msi = Join-Path $env:TEMP "node-install.msi"
    Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn" -Wait -NoNewWindow
    Remove-Item $msi -ErrorAction SilentlyContinue

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

    if (Test-NodeInstalled) {
        Write-Ok "Node.js $(node -v) installed"
    } else {
        Write-Die "Node.js installation failed. Please install manually from https://nodejs.org"
    }
}

# ── main ─────────────────────────────────────────────────────────────────────

if (-not (Test-NodeInstalled)) {
    Install-Node
} else {
    Write-Ok "Node.js $(node -v) found"
}

Write-Info "Starting Yomi via npx @rikaidev/yomi ..."
& npx @rikaidev/yomi @args

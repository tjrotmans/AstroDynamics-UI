# Starts the backend (mission-server) and the frontend (vite dev) in their
# own terminal windows. Right-click -> "Run with PowerShell", or from a
# terminal: powershell -ExecutionPolicy Bypass -File scripts/start-servers.ps1
# Safe to re-run: skips whichever server is already listening on its port.

$frontendDir = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path (Split-Path -Parent $frontendDir) "AstroDynamics\MissionPlanner"

function Test-PortInUse($port) {
    $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

if (Test-PortInUse 8000) {
    Write-Host "Backend already running on :8000 - skipping." -ForegroundColor Yellow
} else {
    Write-Host "Starting backend (cargo run --bin mission-server --release)..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$backendDir'; cargo run --bin mission-server --release"
}

if (Test-PortInUse 5173) {
    Write-Host "Frontend already running on :5173 - skipping." -ForegroundColor Yellow
} else {
    Write-Host "Starting frontend (npm run dev)..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$frontendDir'; npm run dev"
}

Write-Host "Done. App: http://localhost:5173" -ForegroundColor Green

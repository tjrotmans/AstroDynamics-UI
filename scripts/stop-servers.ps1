# Stops the backend and frontend dev servers by killing whatever process is
# listening on their ports (8000 / 5173) - no hunting through Task Manager.
# Right-click -> "Run with PowerShell", or:
# powershell -ExecutionPolicy Bypass -File scripts/stop-servers.ps1

foreach ($entry in @(@{ Name = "backend (mission-server)"; Port = 8000 }, @{ Name = "frontend (vite)"; Port = 5173 })) {
    $conns = Get-NetTCPConnection -LocalPort $entry.Port -State Listen -ErrorAction SilentlyContinue
    if ($null -eq $conns) {
        Write-Host "$($entry.Name): nothing listening on :$($entry.Port)." -ForegroundColor Yellow
        continue
    }
    foreach ($processId in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
        try {
            $proc = Get-Process -Id $processId -ErrorAction Stop
            Stop-Process -Id $processId -Force -Confirm:$false -ErrorAction Stop
            Write-Host "$($entry.Name): stopped $($proc.ProcessName) (pid $processId)." -ForegroundColor Green
        } catch {
            Write-Host "$($entry.Name): could not stop pid ${processId}: $_" -ForegroundColor Red
        }
    }
}

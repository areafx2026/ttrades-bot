# Pivot v3.0 - stop the engine started by start.ps1.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = "$root\run\server.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "No PID file found - engine does not appear to be running."
    exit 0
}
$serverPid = Get-Content $pidFile
try {
    Stop-Process -Id $serverPid -Force -ErrorAction Stop
    Write-Host "Stopped Pivot v3.0 (PID $serverPid)."
} catch {
    Write-Host "Process $serverPid not running (already stopped)."
}
Remove-Item $pidFile -ErrorAction SilentlyContinue

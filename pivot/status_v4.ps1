# Pivot v4.0 - show whether the engine is running + a live API check.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = "$root\run\server_v4.pid"

$running = $false
if (Test-Path $pidFile) {
    $serverPid = Get-Content $pidFile
    if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) { $running = $true }
}

if ($running) {
    Write-Host "STATUS: RUNNING (PID $serverPid)"
    Write-Host "Live API check:"
    curl.exe -s --max-time 6 "http://127.0.0.1:8001/api/control/status"
    Write-Host ""
    curl.exe -s --max-time 6 "http://127.0.0.1:8001/api/account"
    Write-Host ""
} else {
    Write-Host "STATUS: STOPPED"
}

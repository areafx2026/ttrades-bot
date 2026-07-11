# Pivot v4.0 - start the engine as a detached background process you own.
# Same codebase as v3, different .env (.env.v4), different port (8001).
# Writes the PID to run\server_v4.pid and logs to logs\server_v4.*.log
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
New-Item -ItemType Directory -Force -Path "$root\logs" | Out-Null
New-Item -ItemType Directory -Force -Path "$root\run"  | Out-Null
$pidFile = "$root\run\server_v4.pid"

if (Test-Path $pidFile) {
    $old = Get-Content $pidFile
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) {
        Write-Host "Already running (PID $old) on http://127.0.0.1:8001"
        exit 0
    }
}

$env:PIVOT_ENV_FILE = "$root\.env.v4"

$p = Start-Process -FilePath "python" `
    -ArgumentList "-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8001" `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput "$root\logs\server_v4.out.log" `
    -RedirectStandardError  "$root\logs\server_v4.err.log"

$p.Id | Out-File -Encoding ascii $pidFile
Write-Host "Started Pivot v4.0 (PID $($p.Id)) -> http://127.0.0.1:8001"
Write-Host "Logs: logs\server_v4.out.log   Stop with: stop_v4.cmd"

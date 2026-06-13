# Pivot v3.0 — start the engine as a detached background process you own.
# Writes the PID to run\server.pid and logs to logs\server.*.log
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
New-Item -ItemType Directory -Force -Path "$root\logs" | Out-Null
New-Item -ItemType Directory -Force -Path "$root\run"  | Out-Null
$pidFile = "$root\run\server.pid"

if (Test-Path $pidFile) {
    $old = Get-Content $pidFile
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) {
        Write-Host "Already running (PID $old) on http://127.0.0.1:8000"
        exit 0
    }
}

$p = Start-Process -FilePath "python" `
    -ArgumentList "-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8000" `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput "$root\logs\server.out.log" `
    -RedirectStandardError  "$root\logs\server.err.log"

$p.Id | Out-File -Encoding ascii $pidFile
Write-Host "Started Pivot v3.0 (PID $($p.Id)) -> http://127.0.0.1:8000"
Write-Host "Logs: logs\server.out.log   Stop with: stop.cmd"

# Launch the trade-close watcher as a detached background process you own.
# Survives this terminal / chat session and has no timeout — it runs until the
# trade closes, then writes the close-path verification to logs\close_verify.log.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
New-Item -ItemType Directory -Force -Path "$root\logs" | Out-Null
New-Item -ItemType Directory -Force -Path "$root\run"  | Out-Null
$pidFile = "$root\run\watcher.pid"

if (Test-Path $pidFile) {
    $old = Get-Content $pidFile
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) {
        Write-Host "Watcher already running (PID $old)"
        exit 0
    }
}

$p = Start-Process -FilePath "python" `
    -ArgumentList "watch_close.py" `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput "$root\logs\close_verify.log" `
    -RedirectStandardError  "$root\logs\close_verify.err.log"

$p.Id | Out-File -Encoding ascii $pidFile
Write-Host "Started close watcher (PID $($p.Id)) -> logs\close_verify.log"
Write-Host "It runs until trade closes. Check result: Get-Content logs\close_verify.log"

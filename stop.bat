@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM ============================================================
REM  MuJian - stop background server (Windows)
REM  Double-click to stop the server started by start.vbs / start.bat
REM  The server now runs with no window, so we kill it by the TCP
REM  port it listens on (robust, no dependency on a window title).
REM ============================================================

set "PORT=8910"
set "PIDF=data\.server.pid"
set "KILLED=0"

REM kill whatever is listening on PORT (handles node + any children)
for /f "tokens=*" %%a in ('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue).OwningProcess"') do (
  if "%%a" neq "" (
    taskkill /pid %%a /f /t >nul 2>nul
    if !errorlevel!==0 set "KILLED=1"
  )
)

REM drop the pid file the launcher may have left behind
if exist "%PIDF%" del /q "%PIDF%" >nul 2>nul

if !KILLED!==1 (
  echo [MuJian] Stopped.
) else (
  echo [MuJian] No running server found on port %PORT%.
)
echo.
pause

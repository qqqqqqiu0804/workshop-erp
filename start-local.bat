@echo off
setlocal
cd /d "%~dp0"

set "LOG=%~dp0start-local.log"
set "SLOG=%~dp0server.log"
set "PORT=3100"
echo [%date% %time%] === Workshop ERP local start (v7) === > "%LOG%"
echo [%date% %time%] cwd=%CD% >> "%LOG%"

set "MGR_DIR="
for /d %%p in ("%USERPROFILE%\.workbuddy\binaries\node\versions\22*") do (
  if not defined MGR_DIR set "MGR_DIR=%%~fp"
)
if defined MGR_DIR (
  set "PATH=%MGR_DIR%;%PATH%"
  echo [OK] Using managed Node 22: %MGR_DIR% >> "%LOG%"
) else (
  echo [WARN] Managed Node 22 not found; using system Node. >> "%LOG%"
)

node -v >> "%LOG%" 2>&1

if exist node_modules goto :havemod
echo [STEP] First run: installing dependencies (1-2 min, keep network on)...
call npm install
if errorlevel 1 echo [WARN] npm install failed; check network, server may not start. >> "%LOG%"
:havemod
echo [OK] node_modules ready. >> "%LOG%"

echo [STEP] Building pages bundle...
call npm run build:pages >> "%LOG%" 2>&1

netsh advfirewall firewall delete rule name="WorkshopERP-%PORT%" >nul 2>&1
netsh advfirewall firewall add rule name="WorkshopERP-%PORT%" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>&1
if errorlevel 1 goto :fwfail
echo [OK] Firewall rule ready (LAN inbound %PORT% only). >> "%LOG%"
goto :fwdone
:fwfail
echo [WARN] Firewall rule add failed (run as Admin once if other PCs cannot connect). >> "%LOG%"
:fwdone

set LAN_IP=127.0.0.1
for /f "tokens=*" %%i in ('node "%~dp0lanip.js"') do set LAN_IP=%%i
echo [OK] LAN IP: %LAN_IP% >> "%LOG%"

echo.
echo ============================================
echo   Workshop ERP - server starting in background
echo.
echo   Workshop PCs / tablets:  http://%LAN_IP%:%PORT%
echo   This machine:            http://127.0.0.1:%PORT%
echo   Server log:              %SLOG%
echo.
echo   Server runs in a SEPARATE window (live log there).
echo   This window can be closed anytime; server keeps running.
echo   To STOP server: taskkill /f /im node.exe
echo ============================================
echo.

start "" cmd /c "cd /d %~dp0 & set PORT=%PORT% & call npm start >> %SLOG% 2>&1"

echo Press any key to close this window (server keeps running in background)...
pause >nul

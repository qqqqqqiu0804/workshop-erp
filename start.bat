@echo off
setlocal enabledelayedexpansion

REM 默认端口 3100（本机 3000 已被 Mineradio.exe 占用）
set PORT=3100

REM 1) 优先用系统 PATH 中的 Node（需 >= 22）
set "NODE_BIN="
where node >nul 2>nul && (
  for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "VER=%%v"
  set "VER=!VER:~1!"
  if defined VER if !VER! GEQ 22 set "NODE_BIN=node"
)

REM 2) 否则回退到 WorkBuddy 管理的 Node 22
if not defined NODE_BIN (
  set "MN=C:\Users\HXT\.workbuddy\binaries\node\versions\22.22.2\node.exe"
  if exist "!MN!" set "NODE_BIN=!MN!"
)

if not defined NODE_BIN (
  echo [错误] 未找到 Node.js 22。请安装 Node 22 LTS：https://nodejs.org
  echo 安装后重开窗口，再双击本脚本。
  pause
  exit /b 1
)

cd /d "%~dp0"
echo 正在启动车间工作台（端口 %PORT%）...
echo 启动完成后，浏览器访问：http://localhost:%PORT%
"%NODE_BIN%" --experimental-sqlite --disable-warning=ExperimentalWarning server.js

@echo off
rem ===========================================================================================================
rem  Turnover setup: checks everything the demo needs and offers to install what's missing.
rem
rem    setup.bat            check, and ask before installing anything
rem    setup.bat /check     check only: install nothing, change nothing (exit code 1 if something is missing)
rem    setup.bat /yes       check, and install what's missing without asking
rem
rem  Needed to run the demo:        Docker Desktop (with WSL 2), Docker Compose 2.20+, about 8 GB of RAM,
rem                                 free ports 8000, 8080, 8090 and 8091.
rem  Needed only for development:   Node.js 24+ and npm (tests and typecheck), Git.
rem ===========================================================================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "MODE=ask"
if /i "%~1"=="/check" set "MODE=check"
if /i "%~1"=="/yes" set "MODE=yes"
if /i "%~1"=="/?" goto :usage
if /i "%~1"=="-h" goto :usage
if /i "%~1"=="--help" goto :usage

set /a MISSING=0
set /a WARNINGS=0
set "INSTALLED_SOMETHING="

echo.
echo  Turnover setup
echo  ================
echo  Folder: %CD%
if "%MODE%"=="check" echo  Mode: check only, nothing will be installed or changed
echo.

rem ---- Windows package manager (used to install missing tools) --------------------------------------------
set "HAVE_WINGET="
where winget >nul 2>&1 && set "HAVE_WINGET=1"

rem ---- WSL 2 (Docker Desktop runs on it) -------------------------------------------------------------------
echo [1/9] WSL 2
wsl --status >nul 2>&1
if errorlevel 1 (
  call :fail "WSL is not installed or not enabled. Docker Desktop needs it."
  echo        Fix: open PowerShell as Administrator, run:  wsl --install   then restart Windows.
) else (
  call :ok "WSL is available"
)

rem ---- Docker CLI ------------------------------------------------------------------------------------------
echo [2/9] Docker
call :find_docker
if not defined DOCKER_OK (
  call :fail "Docker Desktop is not installed"
  call :offer_install "Docker Desktop" "Docker.DockerDesktop"
  call :find_docker
)
if defined DOCKER_OK (
  for /f "tokens=*" %%v in ('docker --version 2^>nul') do call :ok "%%v"
)

rem ---- Docker engine running -------------------------------------------------------------------------------
echo [3/9] Docker engine
if defined DOCKER_OK (
  call :ensure_docker_running
) else (
  call :fail "skipped: Docker is not installed"
)

rem ---- Docker Compose 2.20+ (compose.yaml uses "include") --------------------------------------------------
echo [4/9] Docker Compose
if defined DOCKER_OK (
  set "COMPOSE_VERSION="
  for /f "tokens=*" %%v in ('docker compose version --short 2^>nul') do set "COMPOSE_VERSION=%%v"
  if not defined COMPOSE_VERSION (
    call :fail "docker compose is not available. Update Docker Desktop."
  ) else (
    set "CV=!COMPOSE_VERSION:v=!"
    set /a CMAJ=0
    set /a CMIN=0
    for /f "tokens=1,2 delims=." %%a in ("!CV!") do (
      set /a CMAJ=%%a
      set /a CMIN=%%b
    )
    set "COMPOSE_GOOD="
    if !CMAJ! GTR 2 set "COMPOSE_GOOD=1"
    if !CMAJ! EQU 2 if !CMIN! GEQ 20 set "COMPOSE_GOOD=1"
    if defined COMPOSE_GOOD (
      call :ok "Docker Compose !COMPOSE_VERSION!"
    ) else (
      call :fail "Docker Compose !COMPOSE_VERSION! is too old: 2.20 or newer is needed. Update Docker Desktop."
    )
  )
) else (
  call :fail "skipped: Docker is not installed"
)

rem ---- Memory ----------------------------------------------------------------------------------------------
echo [5/9] Memory
set "RAM_GB="
for /f "tokens=*" %%m in ('powershell -NoProfile -Command "[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)" 2^>nul') do set "RAM_GB=%%m"
if not defined RAM_GB (
  call :warn "could not read the amount of memory"
) else if !RAM_GB! LSS 8 (
  call :warn "!RAM_GB! GB of RAM: Flagsmith, Postgres and the demo want about 8 GB. It may be slow."
) else (
  call :ok "!RAM_GB! GB of RAM"
)

rem ---- Ports -----------------------------------------------------------------------------------------------
echo [6/9] Ports 8000 (Flagsmith), 8080 (shop), 8090 and 8091 (console)
for %%p in (8000 8080 8090 8091) do call :check_port %%p

rem ---- Configuration ---------------------------------------------------------------------------------------
echo [7/9] Configuration
if exist ".env\" (
  call :fail ".env is a folder (Docker creates one when the file is missing). Delete it and run setup.bat again."
) else if exist ".env" (
  call :ok ".env exists"
) else if "%MODE%"=="check" (
  call :warn ".env is missing; turnover.bat creates it from .env.example"
) else (
  copy /y ".env.example" ".env" >nul && call :ok "created .env from .env.example"
)
if not exist "turnover.config.yml" call :fail "turnover.config.yml is missing: is this the Turnover folder?"
if not exist "compose.yaml" call :fail "compose.yaml is missing: is this the Turnover folder?"

rem ---- Node.js 24+ and npm (development only) --------------------------------------------------------------
echo [8/9] Node.js 24+ and npm (only for running tests; the demo runs in Docker)
call :find_node
if not defined NODE_OK (
  call :warn "Node.js is not installed (only needed for development)"
  call :offer_install "Node.js LTS" "OpenJS.NodeJS.LTS"
  call :find_node
)
if defined NODE_OK (
  if !NODE_MAJOR! GEQ 24 (
    call :ok "Node.js !NODE_VERSION!"
    if exist "node_modules\" (
      call :ok "npm packages installed"
    ) else if "%MODE%"=="check" (
      call :warn "npm packages not installed: run  npm ci"
    ) else (
      echo        Installing npm packages ^(npm ci^)...
      call npm ci --no-audit --no-fund >nul 2>&1 && call :ok "npm packages installed" || call :warn "npm ci failed: run it by hand to see why"
    )
  ) else (
    call :warn "Node.js !NODE_VERSION! is too old for development: 24 or newer runs the TypeScript directly"
  )
)

rem ---- Git (development only) ------------------------------------------------------------------------------
echo [9/9] Git (only for development)
where git >nul 2>&1
if errorlevel 1 (
  call :warn "Git is not installed (only needed to clone or commit)"
  call :offer_install "Git" "Git.Git"
) else (
  for /f "tokens=*" %%v in ('git --version') do call :ok "%%v"
)

rem ---- Summary ---------------------------------------------------------------------------------------------
echo.
echo  ------------------------------------------------------------
if !MISSING! GTR 0 (
  echo  !MISSING! problem^(s^) to fix before the demo can run, !WARNINGS! warning^(s^).
  if defined INSTALLED_SOMETHING echo  Something was just installed: open a NEW terminal ^(or restart Windows if asked^) and run setup.bat again.
  echo  ------------------------------------------------------------
  endlocal & exit /b 1
)
echo  Ready. !WARNINGS! warning^(s^).
if defined INSTALLED_SOMETHING echo  Something was just installed: if a command isn't found, open a NEW terminal.
echo  Next: turnover.bat   ^(starts Flagsmith, sets it up and opens judge mode^)
echo  ------------------------------------------------------------
endlocal & exit /b 0


rem ======================================== helpers =========================================================

:usage
echo Usage: setup.bat [/check ^| /yes]
echo   /check  check only, install nothing
echo   /yes    install missing tools without asking (uses winget)
exit /b 0

:ok
echo    [ OK ] %~1
exit /b 0

:warn
echo    [WARN] %~1
set /a WARNINGS+=1
exit /b 0

:fail
echo    [MISS] %~1
set /a MISSING+=1
exit /b 0

rem Docker Desktop can be installed for all users or per user; the per-user CLI isn't always on PATH.
:find_docker
set "DOCKER_OK="
where docker >nul 2>&1 && (set "DOCKER_OK=1" & exit /b 0)
for %%d in ("%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin" "%ProgramFiles%\Docker\Docker\resources\bin") do (
  if exist "%%~d\docker.exe" (
    set "PATH=%PATH%;%%~d"
    set "DOCKER_OK=1"
    echo        found the Docker CLI in %%~d ^(added to PATH for this window^)
    exit /b 0
  )
)
exit /b 0

:ensure_docker_running
docker info >nul 2>&1 && (call :ok "Docker engine is running" & exit /b 0)
if "%MODE%"=="check" (call :fail "Docker Desktop is installed but not running" & exit /b 0)
set "DD_EXE="
if exist "%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe" set "DD_EXE=%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe"
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" set "DD_EXE=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
if not defined DD_EXE (call :fail "Docker engine is not running and Docker Desktop.exe wasn't found: start it by hand" & exit /b 0)
echo        Starting Docker Desktop (this can take a minute)...
start "" "%DD_EXE%"
for /l %%i in (1,1,60) do (
  docker info >nul 2>&1 && (call :ok "Docker engine is running" & exit /b 0)
  timeout /t 3 /nobreak >nul
)
call :fail "Docker Desktop didn't start within 3 minutes: open it and accept any prompts, then run setup.bat again"
exit /b 0

:find_node
set "NODE_OK="
set "NODE_VERSION="
set /a NODE_MAJOR=0
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"
if not defined NODE_VERSION exit /b 0
set "NODE_OK=1"
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION:v=%") do set /a NODE_MAJOR=%%a
exit /b 0

:check_port
set "PORT_USER="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%1 .*LISTENING"') do set "PORT_USER=%%a"
if not defined PORT_USER (call :ok "port %1 is free" & exit /b 0)
set "PORT_NAME="
for /f "tokens=1 delims=," %%n in ('tasklist /fi "PID eq !PORT_USER!" /fo csv /nh 2^>nul') do set "PORT_NAME=%%~n"
echo !PORT_NAME! | findstr /i "docker wsl vpnkit com.docker" >nul
if not errorlevel 1 (call :ok "port %1 is used by Docker (Turnover may already be running)" & exit /b 0)
call :warn "port %1 is used by !PORT_NAME! (PID !PORT_USER!): stop it, or the demo can't start"
exit /b 0

rem :offer_install "<name>" "<winget id>"
:offer_install
if "%MODE%"=="check" exit /b 0
if not defined HAVE_WINGET (
  echo        winget isn't available: install %~1 by hand.
  exit /b 0
)
if "%MODE%"=="yes" goto :do_install
choice /c YN /n /m "       Install %~1 now with winget? [Y/N] "
if errorlevel 2 exit /b 0
:do_install
echo        Installing %~1 ...
winget install --id %~2 -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo        winget couldn't install %~1: install it by hand.
) else (
  set "INSTALLED_SOMETHING=1"
  echo        Installed %~1.
)
exit /b 0

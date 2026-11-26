@echo off
rem ===========================================================================================================
rem  Switchyard: start everything and open judge mode. (Set SWITCHYARD_NO_BROWSER=1 to skip opening the browser.)
rem
rem    switchyard.bat            start Flagsmith, set it up (first run), start Switchyard and the shop, check the setup,
rem                              open judge mode
rem    switchyard.bat demo       the same, then send 1,500 simulated visitors through the proxy
rem    switchyard.bat status     show what's running, check the setup, and the links
rem    switchyard.bat stop       stop every container (Flagsmith's data and the keys are kept)
rem    switchyard.bat reset      wipe Flagsmith's data, the ledger and the keys, then start from scratch
rem    switchyard.bat reset /yes the same without asking (for scripts and tests)
rem
rem  First time on this machine? Run setup.bat first: it checks and installs what's needed.
rem ===========================================================================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=start"
if /i "%ACTION%"=="/?" goto :usage
if /i "%ACTION%"=="-h" goto :usage
if /i "%ACTION%"=="--help" goto :usage
if /i not "%ACTION%"=="start" if /i not "%ACTION%"=="demo" if /i not "%ACTION%"=="status" if /i not "%ACTION%"=="stop" if /i not "%ACTION%"=="reset" (
  echo Unknown option "%ACTION%".
  goto :usage_error
)
set "ASSUME_YES="
if not "%~2"=="" (
  if /i "%ACTION%"=="reset" (
    if /i "%~2"=="/yes" set "ASSUME_YES=1"
    if /i "%~2"=="--yes" set "ASSUME_YES=1"
    if /i "%~2"=="-y" set "ASSUME_YES=1"
  )
  if not defined ASSUME_YES (
    echo Unknown option "%~2" for %ACTION%.
    goto :usage_error
  )
)
if not "%~3"=="" (
  echo Too many options.
  goto :usage_error
)

echo.
echo  Switchyard
echo  ==========

rem ---- Docker must be installed and running -----------------------------------------------------------------
call :find_docker
if not defined DOCKER_OK (
  echo  Docker Desktop isn't installed. Run setup.bat first.
  goto :failed
)
call :ensure_docker_running || goto :failed

if /i "%ACTION%"=="status" goto :status
if /i "%ACTION%"=="stop" goto :stop
if /i "%ACTION%"=="reset" goto :reset

:start
rem ---- Everything else setup.bat checks (Compose version, files, ports) ----------------------------------------
call "%~dp0setup.bat" /check >nul 2>&1
if errorlevel 1 (
  echo  Something the demo needs is missing. Run setup.bat to see what, and to fix it.
  goto :failed
)
if exist ".env\" (
  echo  .env is a folder ^(Docker creates one when the file is missing^). Delete it and run switchyard.bat again.
  goto :failed
)
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo  Created .env from .env.example
)
call :pick_host

echo.
echo  [1/5] Starting Flagsmith ^(the first run downloads its images: a few minutes^)...
docker compose up -d --wait flagsmith
if errorlevel 1 (
  echo  Flagsmith didn't become healthy. Logs:  docker compose logs flagsmith
  goto :failed
)

echo.
echo  [2/5] Setting up Flagsmith ^(admin, keys, event store, flag, metrics, first experiment^)...
echo        Safe to repeat: on an instance that's already set up, it only checks.
docker compose run --rm --build cli init
if errorlevel 1 (
  echo  init failed: see the message above.
  echo  If this Flagsmith already has users, put an Organisation API key in .env as SWITCHYARD_ADMIN_KEY.
  goto :failed
)

echo.
echo  [3/5] Starting Switchyard, the console and the three shop releases...
docker compose up -d --build --wait
if errorlevel 1 (
  echo  Something didn't start. See:  docker compose ps   and   docker compose logs
  goto :failed
)

if /i "%ACTION%"=="demo" (
  echo.
  echo  [3b] Sending 1,500 simulated visitors through the proxy ^(labelled simulation^)...
  docker compose run --rm cli demo --visitors 1500
)

echo.
echo  [4/5] Checking that everything is in place ^(switchyard doctor^)...
call :doctor

echo.
echo  [5/5] Ready.
call :links
if not defined SWITCHYARD_NO_BROWSER echo  Opening judge mode in your browser...
if not defined SWITCHYARD_NO_BROWSER start "" "http://!SY_HOST!:8090/judge"
endlocal & exit /b 0

:status
call :pick_host
echo.
docker compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
echo.
rem The setup check mounts .env: without the file, Docker would create it as a folder.
set "SY_READY="
if exist ".env" if not exist ".env\" set "SY_READY=1"
if defined SY_READY call :doctor
if not defined SY_READY echo  Not set up yet: run switchyard.bat first ^(it creates .env^). Setup check skipped.
call :links
endlocal & exit /b 0

:stop
echo.
echo  Stopping every container. Flagsmith's data, the keys in .env and the ledger are kept.
docker compose --profile tools down
echo  Stopped. Run switchyard.bat to bring it back.
endlocal & exit /b 0

:reset
echo.
echo  This wipes Flagsmith's database (flags, experiments, results), the release ledger and the decision snapshots.
echo  A new admin and new keys are created on the next start. Your .env file stays, and its keys get replaced.
if defined ASSUME_YES goto :reset_wipe
choice /c YN /n /m " Wipe everything and start from scratch? [Y/N] "
if errorlevel 2 (
  echo  Nothing changed.
  endlocal & exit /b 0
)
:reset_wipe
if defined ASSUME_YES echo  /yes: wiping without asking.
docker compose --profile tools down -v
if errorlevel 1 (
  echo  Docker could not remove the containers and volumes: nothing deleted ^(the ledger and snapshots are kept^).
  echo.
  echo  Not reset.
  endlocal & exit /b 1
)
if exist ".switchyard\" rmdir /s /q ".switchyard"
echo  Wiped. Starting from scratch...
goto :start


rem ======================================== helpers =========================================================

:links
set "ADMIN_EMAIL="
for /f "tokens=1,* delims==" %%a in ('findstr /b "FLAGSMITH_ADMIN_EMAIL=" .env 2^>nul') do set "ADMIN_EMAIL=%%b"
echo.
echo  ------------------------------------------------------------
echo   Judge mode   http://!SY_HOST!:8090/judge   ^(the whole story, with buttons^)
echo   Setup check  http://!SY_HOST!:8090/setup   ^(is everything in place?^)
echo   Console      http://!SY_HOST!:8090
echo   Shop         http://!SY_HOST!:8080          ^(through Switchyard^)
echo   Flagsmith    http://!SY_HOST!:8000
if defined ADMIN_EMAIL echo                login !ADMIN_EMAIL!, password in .env ^(FLAGSMITH_ADMIN_PASSWORD^)
echo  ------------------------------------------------------------
echo   Stop:   switchyard.bat stop        Start over:   switchyard.bat reset
echo  ------------------------------------------------------------
echo.
exit /b 0

rem switchyard doctor: expected against actual for Flagsmith, the keys, the flag, metrics, proxy and shops. Non-fatal.
:doctor
docker compose run --rm cli doctor
if errorlevel 1 echo  Some checks above are failing ^(FAIL^). The same list, with Expected and Actual: http://!SY_HOST!:8090/setup
exit /b 0

rem The hostname for links on this machine: 127.0.0.1 (Compose publishes there; "localhost" tries IPv6 first and waits
rem about 2 s for the refusal), or localhost when .env's shop URL uses it, so judge mode and its Shop tab share a
rem hostname and the shop keeps its cookies.
:pick_host
set "SY_HOST=127.0.0.1"
set "SHOP_URL="
for /f "tokens=1,* delims==" %%a in ('findstr /b "SWITCHYARD_PUBLIC_SHOP_URL=" .env 2^>nul') do set "SHOP_URL=%%b"
if not defined SHOP_URL exit /b 0
if /i not "!SHOP_URL:~0,16!"=="http://localhost" exit /b 0
set "SHOP_REST=!SHOP_URL:~16,1!"
if "!SHOP_REST!"=="" set "SY_HOST=localhost"
if "!SHOP_REST!"==":" set "SY_HOST=localhost"
if "!SHOP_REST!"=="/" set "SY_HOST=localhost"
exit /b 0

:find_docker
set "DOCKER_OK="
where docker >nul 2>&1 && (set "DOCKER_OK=1" & exit /b 0)
for %%d in ("%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin" "%ProgramFiles%\Docker\Docker\resources\bin") do (
  if exist "%%~d\docker.exe" (
    set "PATH=%PATH%;%%~d"
    set "DOCKER_OK=1"
    exit /b 0
  )
)
exit /b 0

:ensure_docker_running
docker info >nul 2>&1 && exit /b 0
set "DD_EXE="
if exist "%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe" set "DD_EXE=%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe"
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" set "DD_EXE=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
if not defined DD_EXE (
  echo  Docker isn't running and Docker Desktop wasn't found. Start Docker Desktop, then run switchyard.bat again.
  exit /b 1
)
echo  Starting Docker Desktop (this can take a minute)...
start "" "%DD_EXE%"
for /l %%i in (1,1,60) do (
  docker info >nul 2>&1 && (echo  Docker is running. & exit /b 0)
  timeout /t 3 /nobreak >nul
)
echo  Docker Desktop didn't start within 3 minutes. Open it, accept any prompts, then run switchyard.bat again.
exit /b 1

:usage
echo Usage: switchyard.bat [start ^| demo ^| status ^| stop ^| reset [/yes]]
echo   start   (default) start everything, check the setup and open judge mode
echo   demo    start, then send 1,500 simulated visitors
echo   status  show what's running, check the setup, and the links
echo   stop    stop every container; data and keys are kept
echo   reset   wipe Flagsmith's data, the ledger and the keys, then start fresh (/yes: don't ask)
endlocal & exit /b 0

:usage_error
echo Usage: switchyard.bat [start ^| demo ^| status ^| stop ^| reset [/yes]]
goto :failed

:failed
echo.
echo  Not started.
endlocal & exit /b 1

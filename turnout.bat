@echo off
rem ===========================================================================================================
rem  Turnout: start everything and open judge mode. (Set TURNOUT_NO_BROWSER=1 to skip opening the browser.)
rem
rem    turnout.bat            start Flagsmith, set it up (first run), start Turnout and the shop, check the setup,
rem                              open judge mode
rem    turnout.bat demo       the same, then send 1,500 simulated visitors through the proxy
rem    turnout.bat status     show what's running, check the setup, and the links
rem    turnout.bat stop       stop every container (Flagsmith's data and the keys are kept)
rem    turnout.bat reset      wipe Flagsmith's data, the ledger and the keys, then start from scratch
rem    turnout.bat reset /yes the same without asking (for scripts and tests)
rem    turnout.bat server <hostname>   server mode: write TURNOUT_MODE=server and the hostname into .env,
rem                              generate Flagsmith's secrets, then start behind Caddy with HTTPS on that hostname.
rem                              Every command after that adds -f compose.server.yml (docs\SETUP.md, "Running on a server")
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
if /i not "%ACTION%"=="start" if /i not "%ACTION%"=="demo" if /i not "%ACTION%"=="status" if /i not "%ACTION%"=="stop" if /i not "%ACTION%"=="reset" if /i not "%ACTION%"=="server" if /i not "%ACTION%"=="tryit" (
  echo Unknown option "%ACTION%".
  goto :usage_error
)
set "ASSUME_YES="
set "SERVER_HOST="
if /i "%ACTION%"=="server" set "SERVER_HOST=%~2"
if defined SERVER_HOST if "!SERVER_HOST:~0,1!"=="-" (
  echo Unknown option "%~2" for server: give the hostname, e.g. turnout.bat server turnout.example.com
  goto :usage_error
)
if defined SERVER_HOST if "!SERVER_HOST:~0,1!"=="/" (
  echo Unknown option "%~2" for server: give the hostname, e.g. turnout.bat server turnout.example.com
  goto :usage_error
)
if not "%~2"=="" if not defined SERVER_HOST (
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
echo  Turnout
echo  ==========

rem ---- Docker must be installed and running -----------------------------------------------------------------
call :find_docker
if not defined DOCKER_OK (
  echo  Docker Desktop isn't installed. Run setup.bat first.
  goto :failed
)
call :ensure_docker_running || goto :failed

call :pick_mode
if /i "%ACTION%"=="server" goto :server
if /i "%ACTION%"=="status" goto :status
if /i "%ACTION%"=="stop" goto :stop
if /i "%ACTION%"=="tryit" goto :tryit
if /i "%ACTION%"=="reset" goto :reset

:start
rem ---- Everything else setup.bat checks (Compose version, files, ports) ----------------------------------------
call "%~dp0setup.bat" /check >nul 2>&1
if errorlevel 1 (
  echo  Something the demo needs is missing. Run setup.bat to see what, and to fix it.
  goto :failed
)
if exist ".env\" (
  echo  .env is a folder ^(Docker creates one when the file is missing^). Delete it and run turnout.bat again.
  goto :failed
)
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo  Created .env from .env.example
)
call :pick_host
call :pick_mode
if defined SY_SERVER (
  call :env_get TURNOUT_HOSTNAME
  echo.
  echo  Server mode: !SY_VALUE! ^(compose.yaml + compose.server.yml^)
  rem Placeholder Flagsmith secrets or tokens: refuse before anything public starts. Names only, never values.
  !DC! run --rm --build --no-deps cli server-check
  if errorlevel 1 (
    echo  Fix the settings above in .env ^(turnout.bat server ^<hostname^> writes random Flagsmith secrets^).
    goto :failed
  )
)

echo.
echo  [1/5] Starting Flagsmith ^(the first run downloads its images: a few minutes^)...
!DC! up -d --wait flagsmith
if errorlevel 1 (
  echo  Flagsmith didn't become healthy. Logs:  !DC! logs flagsmith
  goto :failed
)

echo.
echo  [2/5] Setting up Flagsmith ^(admin, keys, event store, flag, metrics, first experiment^)...
echo        Safe to repeat: on an instance that's already set up, it only checks.
!DC! run --rm --build cli init
if errorlevel 1 (
  echo  init failed: see the message above.
  echo  If this Flagsmith already has users, put an Organisation API key in .env as TURNOUT_ADMIN_KEY.
  goto :failed
)

if defined SY_SERVER (
  !DC! run --rm --no-deps cli server-check --after-init
  if errorlevel 1 (
    echo  init left a token empty or a placeholder: see above. Not starting the public side.
    goto :failed
  )
)

echo.
echo  [3/5] Starting Turnout, the console and the three shop releases...
if defined SY_SERVER echo        and Caddy ^(HTTPS; the first certificate can take a minute^)
!DC! up -d --build --wait --remove-orphans
if errorlevel 1 (
  echo  Something didn't start. See:  !DC! ps   and   !DC! logs
  goto :failed
)

if /i "%ACTION%"=="demo" (
  echo.
  echo  [3b] Sending 1,500 simulated visitors through the proxy ^(labelled simulation^)...
  !DC! run --rm cli demo --visitors 1500
)

echo.
echo  [4/5] Checking that everything is in place ^(turnout doctor^)...
call :doctor

echo.
echo  [5/5] Ready.
call :links
rem Never a browser in server mode: a server has no one at its screen.
if defined SY_SERVER endlocal & exit /b 0
if not defined TURNOUT_NO_BROWSER echo  Opening judge mode in your browser...
if not defined TURNOUT_NO_BROWSER start "" "http://!SY_HOST!:8090/judge"
endlocal & exit /b 0

:status
call :pick_host
echo.
!DC! ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
echo.
rem The setup check mounts .env: without the file, Docker would create it as a folder.
set "SY_READY="
if exist ".env" if not exist ".env\" set "SY_READY=1"
if defined SY_READY call :doctor
if not defined SY_READY echo  Not set up yet: run turnout.bat first ^(it creates .env^). Setup check skipped.
call :links
endlocal & exit /b 0

:stop
echo.
echo  Stopping every container. Flagsmith's data, the keys in .env and the ledger are kept.
!DC! --profile tools --profile tryit down
echo  Stopped. Run turnout.bat to bring it back.
endlocal & exit /b 0

:tryit
echo.
echo  Starting Try it with your app. It builds and runs the versions you give it over the Docker socket ^(root on
echo  this machine^), so it is off until you start it. Its proxy is on 127.0.0.1:8085 only.
!DC! --profile tryit up -d --build --wait tryit || goto :failed
echo  Ready: on the console ^(http://127.0.0.1:8090^) press Try it with your app. Stop: turnout.bat stop
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
!DC! --profile tools down -v
if errorlevel 1 (
  echo  Docker could not remove the containers and volumes: nothing deleted ^(the ledger and snapshots are kept^).
  echo.
  echo  Not reset.
  endlocal & exit /b 1
)
if exist ".turnout\" rmdir /s /q ".turnout"
echo  Wiped. Starting from scratch...
goto :start

rem Server mode: hostname and mode into .env, random Flagsmith secrets where there are none, then the usual start.
:server
if exist ".env\" (
  echo  .env is a folder. Delete it and run again.
  goto :failed
)
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo  Created .env from .env.example
)
if not defined SERVER_HOST (
  call :env_get TURNOUT_HOSTNAME
  set "SERVER_HOST=!SY_VALUE!"
)
if not defined SERVER_HOST (
  echo  Give the hostname: turnout.bat server turnout.example.com
  goto :failed
)
call :env_set TURNOUT_MODE server || goto :failed
call :env_set TURNOUT_HOSTNAME "!SERVER_HOST!" || goto :failed
call :env_set TURNOUT_PUBLISH_HOST 127.0.0.1 || goto :failed
call :env_set TURNOUT_PUBLIC_SHOP_URL "https://!SERVER_HOST!" || goto :failed
rem localhost (a trial, CI) gets Caddy's own CA; a real hostname a public certificate.
call :env_get TURNOUT_CADDY_TLS
if /i "!SERVER_HOST!"=="localhost" if not defined SY_VALUE call :env_set TURNOUT_CADDY_TLS "tls internal"
rem Only where empty: Postgres keeps the password it was created with, so an existing one is never replaced.
for %%n in (FLAGSMITH_DJANGO_SECRET_KEY FLAGSMITH_WAREHOUSE_SECRET POSTGRES_PASSWORD) do (
  call :env_get %%n
  if not defined SY_VALUE (
    call :env_set_random %%n || goto :failed
    echo  Wrote a random %%n to .env
  )
)
echo  .env: TURNOUT_MODE=server, TURNOUT_HOSTNAME=!SERVER_HOST!. From now on every command adds compose.server.yml.
goto :start


rem ======================================== helpers =========================================================

rem Mode: TURNOUT_MODE in .env. local (default) is the stack as it always was; server adds compose.server.yml
rem (Caddy, HTTPS, restart policies, random Flagsmith secrets) to every compose command. Same experiment logic.
:pick_mode
set "SY_SERVER="
set "DC=docker compose"
call :env_get TURNOUT_MODE
if /i "!SY_VALUE!"=="server" (
  set "SY_SERVER=1"
  set "DC=docker compose -f compose.yaml -f compose.server.yml"
)
exit /b 0

rem SY_VALUE = NAME's value in .env (empty when missing).
:env_get
set "SY_VALUE="
for /f "tokens=1,* delims==" %%a in ('findstr /b "%~1=" .env 2^>nul') do set "SY_VALUE=%%b"
exit /b 0

rem Set NAME=VALUE in .env (replacing the line or adding it), LF line endings kept. Values are never echoed.
:env_set
set "SY_K=%~1"
set "SY_V=%~2"
powershell -NoProfile -NonInteractive -Command "$p='.env'; $k=$env:SY_K; $v=$env:SY_V; $lines=@([IO.File]::ReadAllText($p) -split \"`r?`n\"); if ($lines[-1] -eq '') { $lines=$lines[0..($lines.Count-2)] }; $found=$false; $out=foreach ($l in $lines) { if ($l.StartsWith($k + '=')) { $found=$true; $k + '=' + $v } else { $l } }; if (-not $found) { $out=@($out) + ($k + '=' + $v) }; [IO.File]::WriteAllText($p, (($out -join \"`n\") + \"`n\"))"
exit /b %errorlevel%

rem NAME=<48 random hex characters> in .env.
:env_set_random
set "SY_V="
for /f %%r in ('powershell -NoProfile -NonInteractive -Command "$b=New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })"') do set "SY_V=%%r"
if not defined SY_V exit /b 1
call :env_set %1 "!SY_V!"
exit /b %errorlevel%

:links
set "ADMIN_EMAIL="
for /f "tokens=1,* delims==" %%a in ('findstr /b "FLAGSMITH_ADMIN_EMAIL=" .env 2^>nul') do set "ADMIN_EMAIL=%%b"
if defined SY_SERVER (
  call :env_get TURNOUT_HOSTNAME
  echo.
  echo  ------------------------------------------------------------
  echo   Server mode on !SY_VALUE!
  echo   Shop         https://!SY_VALUE!/          ^(through Turnout^)
  echo   Judge view   https://!SY_VALUE!/judge     ^(read-only, for anyone^)
  echo   Console, Flagsmith and the full judge mode stay on the server's 127.0.0.1. From your machine:
  echo     ssh -L 8090:127.0.0.1:8090 -L 8000:127.0.0.1:8000 ^<you^>@!SY_VALUE!
  echo     then http://127.0.0.1:8090/judge and http://127.0.0.1:8000
  if defined ADMIN_EMAIL echo   Flagsmith login !ADMIN_EMAIL!, password in .env ^(FLAGSMITH_ADMIN_PASSWORD^)
  echo  ------------------------------------------------------------
  echo   Stop:   turnout.bat stop        Status:   turnout.bat status
  echo  ------------------------------------------------------------
  echo.
  exit /b 0
)
echo.
echo  ------------------------------------------------------------
echo   Judge mode   http://!SY_HOST!:8090/judge   ^(the whole story, with buttons^)
echo   Setup check  http://!SY_HOST!:8090/setup   ^(is everything in place?^)
echo   Console      http://!SY_HOST!:8090
echo   Shop         http://!SY_HOST!:8080          ^(through Turnout^)
echo   Flagsmith    http://!SY_HOST!:8000
if defined ADMIN_EMAIL echo                login !ADMIN_EMAIL!, password in .env ^(FLAGSMITH_ADMIN_PASSWORD^)
echo  ------------------------------------------------------------
echo   Stop:   turnout.bat stop        Start over:   turnout.bat reset
echo  ------------------------------------------------------------
echo.
exit /b 0

rem turnout doctor: expected against actual for Flagsmith, the keys, the flag, metrics, proxy and shops. Non-fatal.
:doctor
if defined SY_SERVER (
  rem Restart policies are Docker's, not visible from inside a container: read them here, hand them to doctor.
  set "IDS="
  for /f %%i in ('!DC! ps -q') do set "IDS=!IDS! %%i"
  set "POLICIES="
  if defined IDS for /f "delims=" %%p in ('docker inspect -f "{{.Name}}={{.HostConfig.RestartPolicy.Name}}" !IDS!') do set "POLICIES=!POLICIES!%%p,"
  !DC! run --rm -e "TURNOUT_RESTART_POLICIES=!POLICIES!" cli doctor
  if errorlevel 1 echo  Some checks above are failing ^(FAIL^).
  exit /b 0
)
!DC! run --rm cli doctor
if errorlevel 1 echo  Some checks above are failing ^(FAIL^). The same list, with Expected and Actual: http://!SY_HOST!:8090/setup
exit /b 0

rem The hostname for links on this machine: 127.0.0.1 (Compose publishes there; "localhost" tries IPv6 first and waits
rem about 2 s for the refusal), or localhost when .env's shop URL uses it, so judge mode and its Shop tab share a
rem hostname and the shop keeps its cookies.
:pick_host
set "SY_HOST=127.0.0.1"
set "SHOP_URL="
for /f "tokens=1,* delims==" %%a in ('findstr /b "TURNOUT_PUBLIC_SHOP_URL=" .env 2^>nul') do set "SHOP_URL=%%b"
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
  echo  Docker isn't running and Docker Desktop wasn't found. Start Docker Desktop, then run turnout.bat again.
  exit /b 1
)
echo  Starting Docker Desktop (this can take a minute)...
start "" "%DD_EXE%"
for /l %%i in (1,1,60) do (
  docker info >nul 2>&1 && (echo  Docker is running. & exit /b 0)
  timeout /t 3 /nobreak >nul
)
echo  Docker Desktop didn't start within 3 minutes. Open it, accept any prompts, then run turnout.bat again.
exit /b 1

:usage
echo Usage: turnout.bat [start ^| demo ^| status ^| stop ^| reset [/yes] ^| server ^<hostname^>]
echo   start   (default) start everything, check the setup and open judge mode
echo   demo    start, then send 1,500 simulated visitors
echo   status  show what's running, check the setup, and the links
echo   stop    stop every container; data and keys are kept
echo   reset   wipe Flagsmith's data, the ledger and the keys, then start fresh (/yes: don't ask)
echo   server  server mode on ^<hostname^>: HTTPS through Caddy, read-only judge view at https://^<hostname^>/judge
echo   tryit   start Try it with your app ^(opt-in: it builds and runs your versions over the Docker socket^)
endlocal & exit /b 0

:usage_error
echo Usage: turnout.bat [start ^| demo ^| status ^| stop ^| reset [/yes] ^| server ^<hostname^>]
goto :failed

:failed
echo.
echo  Not started.
endlocal & exit /b 1

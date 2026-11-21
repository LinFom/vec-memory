@echo off
rem ============================================================
rem  vec-memory data service launcher  (THE one and only copy)
rem
rem  External mode (0.9.3): this service is started FROM THE
rem  vec-memory repo, never from inside a consumer package.
rem  Consumers (QQ-Agent plugin) just point serviceBaseURL at it.
rem
rem    server  : <this folder>\src\server.mjs
rem    lib root: <this folder>\data              (store we own)
rem    source  : configured in <this folder>\data\config.json
rem              as skills.memory-vec.sourceRoot - normally the
rem              QQ-Agent package "data" dir. Index chunks, the
rem              archive and the identity files are READ there;
rem              the settings the panel writes also live there
rem              (the panel writes through the consumer app).
rem
rem  Usage:
rem    this-script.bat                       default data-root + port 8088
rem    this-script.bat D:\some\lib           explicit lib root
rem    this-script.bat D:\lib --port 8089    extra args pass through
rem
rem  Guards - each one asks the RUNNING WORLD, not the intent:
rem    - port already serving? print that instance's /health and STOP.
rem    - lib config.json missing, or no sourceRoot in it? name the
rem      consequence: the panel comes up with EMPTY settings.
rem    - after start, poll /health and echo the dataRoot AND the
rem      sourceRoot the service ACTUALLY came up with.
rem
rem  HISTORY 2026-10-09: dual-layout launcher (repo copy defaulting
rem  8099 / package copy 8088) existed to protect against clicking
rem  the wrong copy; it failed three times anyway. External mode
rem  removes the second copy entirely, so the split is gone and the
rem  only default port is 8088 again.
rem  HISTORY 2026-10-09b: passthrough args are appended ONE BY ONE
rem  (a joined "%~2 %~3 ..." string collapses to spaces and lies);
rem  port is injected first so a caller --port wins; sleep is a
rem  "ping -n 2" poll because "timeout /t" is hijackable on PATH.
rem
rem  Requires: node.exe and curl.exe on PATH. Node.js 20 or newer.
rem  Log: models\vec-memory-service.log   created if missing
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "NODEEXE="
for %%P in (node.exe) do set "NODEEXE=%%~$PATH:P"
if not defined NODEEXE (
  echo [ERROR] node.exe not found in PATH. Install Node.js 20+ first.
  pause
  exit /b 1
)

set "SERVER=%~dp0src\server.mjs"
if exist "%SERVER%" goto serverok
echo [ERROR] server not found: %SERVER%
echo This launcher must live in the vec-memory repo root - it starts
echo the service NEXT TO ITSELF. There is no other copy by design.
pause
exit /b 1
:serverok

set "PORT=8088"

rem -- lib root: %1 if given, else .\data next to this script.
set "DATAROOT=%~dp0data"
if not "%~1"=="" set "DATAROOT=%~1"

rem -- extra args, appended ONE BY ONE (see HISTORY 2026-10-09b).
set "REST="
if not "%~2"=="" set "REST=%~2"
if not "%~3"=="" set "REST=%REST% %~3"
if not "%~4"=="" set "REST=%REST% %~4"
if not "%~5"=="" set "REST=%REST% %~5"
if not "%~6"=="" set "REST=%REST% %~6"
if not "%~7"=="" set "REST=%REST% %~7"
if not "%~8"=="" set "REST=%REST% %~8"
if not "%~9"=="" set "REST=%REST% %~9"

if not exist "%~dp0models" mkdir "%~dp0models"

rem -- runtime fact 0: lib config.json present? sourceRoot configured?
if exist "%DATAROOT%\config.json" goto cfgok
echo [WARN] No config.json in %DATAROOT%
echo        Without it there is no sourceRoot, so the service reads the
echo        SOURCE from the lib root itself - chunks/archive/identity
echo        will be MISSING there and indexing comes up empty. Settings
echo        the panel reads come back EMPTY too.
goto aftercfg
:cfgok
findstr /c:"sourceRoot" "%DATAROOT%\config.json" >nul 2>&1
if errorlevel 1 (
  echo [WARN] %DATAROOT%\config.json has no sourceRoot.
  echo        External mode expects skills.memory-vec.sourceRoot to point
  echo        at the consumer package data dir. Index source, identity and
  echo        panel settings all come from there.
)
:aftercfg

rem -- custom args mean the caller owns the port too: our --port goes in
rem -- first, so a caller --port later in the line wins; health check is
rem -- then skipped and said so.
if not "%REST%"=="" goto customargs

rem -- runtime fact 1: is this port already serving a vec-memory instance?
set "HEALTH="
for /f "delims=" %%H in ('curl -s --max-time 2 http://127.0.0.1:%PORT%/health 2^>nul') do set "HEALTH=%%H"
if not defined HEALTH goto skipprobe
echo [WARN] Port %PORT% is ALREADY serving a vec-memory instance:
echo     !HEALTH!
echo   That line reports the dataRoot the RUNNING instance actually uses.
echo   This script wanted lib root:
echo     %DATAROOT%
echo   If the two dataRoots match, nothing to do - close this window.
echo   If they do NOT match, stop the running instance first, or start
echo   this one on another port.
pause
exit /b 1
:skipprobe

echo Starting vec-memory data service
echo   server : %SERVER%
echo   lib    : %DATAROOT%
echo   port   : %PORT%
start "vec-memory-service" cmd /c ""%NODEEXE%" "%SERVER%" --data-root "%DATAROOT%" --port %PORT% > "%~dp0models\vec-memory-service.log" 2>&1"

rem -- runtime fact 2: poll until OUR instance answers, up to ~10s.
set "HEALTH="
for /l %%I in (1,1,10) do (
  for /f "delims=" %%H in ('curl -s --max-time 3 http://127.0.0.1:%PORT%/health 2^>nul') do set "HEALTH=%%H"
  if defined HEALTH goto healthy
  ping -n 2 127.0.0.1 >nul
)
goto unhealthy

:healthy
echo Started. Running instance reports:
echo   !HEALTH!
echo dataRoot is the lib this service owns; sourceRoot is where the
echo index source, identity and panel settings come from. The settings
echo panel reaches this service at http://127.0.0.1:%PORT% (its
echo serviceBaseURL). If sourceRoot is wrong, fix
echo   %DATAROOT%\config.json
echo and restart this service.
endlocal
exit /b 0

:unhealthy
echo [ERROR] No healthy /health answer on port %PORT% after ~10s. Log:
type "%~dp0models\vec-memory-service.log"
pause
exit /b 1

:customargs
echo Starting vec-memory data service with custom args
echo   server : %SERVER%
echo   lib    : %DATAROOT%
echo   args   : --port %PORT% %REST%
echo Custom args are in play, so the port is whatever the LAST --port says
echo and the health check is skipped. Verify by hand:
echo   curl http://127.0.0.1:%PORT%/health
echo Log: %~dp0models\vec-memory-service.log
start "vec-memory-service" cmd /c ""%NODEEXE%" "%SERVER%" --data-root "%DATAROOT%" --port %PORT% %REST% > "%~dp0models\vec-memory-service.log" 2>&1"
endlocal
exit /b 0

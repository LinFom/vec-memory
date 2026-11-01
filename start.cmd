@echo off
setlocal
cd /d "%~dp0"
set "VEC_MEMORY_DATA_DIR=%~dp0..\vec-memory-data"
if not "%~1"=="" set "VEC_MEMORY_DATA_DIR=%~1"
echo Data: "%VEC_MEMORY_DATA_DIR%"
echo Management page: http://127.0.0.1:8091/standalone.html
echo Keep this window open. Press Ctrl+C to stop.
node tools\standalone-server.mjs serve --root "%VEC_MEMORY_DATA_DIR%"
if errorlevel 1 goto failed
exit /b 0
:failed
echo Startup failed. See the error above. Install dependencies and initialize a new library first.
pause
exit /b 1

@echo off
setlocal
cd /d "%~dp0"
set "VEC_MEMORY_DATA_DIR=%~dp0..\vec-memory-data"
if not "%~1"=="" set "VEC_MEMORY_DATA_DIR=%~1"
echo Initialize a NEW library at "%VEC_MEMORY_DATA_DIR%".
echo An existing initialized library will be refused. Save the adminToken printed below.
node tools\standalone-server.mjs init --root "%VEC_MEMORY_DATA_DIR%"
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo Initialization failed. Keep any existing data. See the error above.
pause
exit /b 1

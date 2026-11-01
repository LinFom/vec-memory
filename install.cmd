@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 goto missing
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
if errorlevel 1 goto missing
call npm ci
if errorlevel 1 goto failed
echo Dependencies installed. Next: init.cmd for a NEW library, then start.cmd.
pause
exit /b 0
:missing
echo Install Node.js 22.5 or newer with npm, then reopen this script.
pause
exit /b 1
:failed
echo Installation failed. Check the network and npm output above.
pause
exit /b 1

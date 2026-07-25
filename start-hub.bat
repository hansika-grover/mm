@echo off
REM ── Start the MetaManager local hub (reads DATABASE_URL from the .env file) ──
cd /d "%~dp0"

if not exist ".env" (
  echo.
  echo   No .env file found.
  echo   Copy .env.example to .env and paste your Render DATABASE_URL into it first.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\pg" (
  echo Installing dependencies ^(first run only, needs internet^)...
  call npm install
)

echo.
echo   Starting MetaManager hub. Leave this window OPEN while you extract from AdsPower.
echo   Point each extension's Hub URL at:  http://127.0.0.1:5051/api/ingest
echo.
node hub/server.js

echo.
echo   Hub stopped. Press any key to close.
pause >nul

@echo off
setlocal
cd /d "%~dp0"

if "%PORT%"=="" set PORT=3334
set DRSO_NO_BROWSER=1
set DRSO_DETACH=1
set DRSO_CLOSE_DRIVE_WINDOWS=1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"

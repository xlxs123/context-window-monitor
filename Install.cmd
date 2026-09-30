@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-local.ps1"
if errorlevel 1 echo Installation failed. See the message above.
pause

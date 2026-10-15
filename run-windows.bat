@echo off
setlocal
cd /d "%~dp0"

set "GODOT="
for %%G in (godot.exe godot Godot.exe Godot) do (
  where %%G >nul 2>&1 && set "GODOT=%%G" && goto :found
)

echo Godot 4.7 was not found on PATH.
echo Install it, then either add godot.exe to PATH or import this project:
echo   %~dp0project.godot
exit /b 1

:found
start "" "%GODOT%" --path "%~dp0."
exit /b 0

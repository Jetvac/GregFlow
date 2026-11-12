@echo off
rem GTNH Planner launcher for Windows: double-click this file.
rem Запуск планировщика в Windows: дважды щёлкните этот файл.
chcp 65001 >nul
cd /d "%~dp0"
title GTNH Planner

set "PY="
where py >nul 2>nul && py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && set "PY=python"
)

if not defined PY goto nopython

%PY% planner.py %*
if errorlevel 1 (
  echo.
  echo The planner stopped with an error ^(see above^). / Планировщик остановился с ошибкой ^(см. выше^).
  pause
)
exit /b

:nopython
echo.
echo  Python 3.9+ is needed to run the planner, and it was not found.
echo  Для работы планировщика нужен Python 3.9+, он не найден.
echo.
where winget >nul 2>nul
if errorlevel 1 goto manual
choice /c YN /m "Install Python 3.12 now with winget? / Установить Python 3.12 через winget"
if errorlevel 2 goto manual
winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements
echo.
echo  Done. Close this window and double-click start.bat again.
echo  Готово. Закройте это окно и снова запустите start.bat.
pause
exit /b

:manual
echo  Download it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"),
echo  then double-click start.bat again.
echo  Скачайте с https://www.python.org/downloads/ (отметьте "Add python.exe to PATH"),
echo  затем снова запустите start.bat.
start "" https://www.python.org/downloads/
pause

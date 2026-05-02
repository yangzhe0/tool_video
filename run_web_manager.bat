@echo off
cd /d "%~dp0web_manager"
python -c "import flask, PIL" >nul 2>nul
if errorlevel 1 (
  echo Installing web manager dependencies...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)
for %%F in (*.py) do set "APP_FILE=%%F"
python "%APP_FILE%"
pause

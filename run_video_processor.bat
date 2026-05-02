@echo off
cd /d "%~dp0video_processor"
for %%F in (*.py) do set "APP_FILE=%%F"
python "%APP_FILE%"

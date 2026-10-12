@echo off
rem Serves the app on http://localhost:8080 (GPS needs localhost or https) and opens it in the browser.
cd /d "%~dp0"
start "" http://localhost:8080
python -m http.server 8080 --bind 127.0.0.1

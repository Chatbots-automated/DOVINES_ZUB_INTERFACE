@echo off
rem GVET DelPro worker - started by scripts\gvet-worker.ps1 -Action run (the supervisor). %1 = full path of node.exe.
rem Output is appended to logs\worker.log; the exit code goes back to the supervisor (3 = another worker holds the lock).
cd /d "%~dp0.."
"%~1" src\index.js --service >> logs\worker.log 2>&1
exit /b %ERRORLEVEL%

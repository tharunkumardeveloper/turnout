@echo off
rem turnout for CMD: runs turnout.ps1 next to this file with the same arguments.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0turnout.ps1" %*

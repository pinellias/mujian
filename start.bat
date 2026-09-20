@echo off
cd /d "%~dp0"
REM Silent launcher: runs the hidden VBScript launcher.
REM For a fully windowless double-click, run start.vbs instead.
wscript //nologo "%~dp0start.vbs"

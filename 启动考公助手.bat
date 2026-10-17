@echo off
rem ===========================================================================
rem  KEEP THIS FILE PURE ASCII - DO NOT ADD CHINESE CHARACTERS.
rem
rem  Why: this .bat used to contain Chinese comments/labels while being saved
rem  as UTF-8. cmd.exe then mis-aligned its line parser (byte offset vs.
rem  multi-byte chars), which silently broke the "if not exist node_modules"
rem  test - so "npm install" ran on EVERY double-click. That was the black
rem  console window and the several seconds of waiting.
rem
rem  This launcher always runs the DEV folder (latest code + latest data).
rem  The OLD packaged copy in .zcode\workspace\default\<app>\ is from
rem  2026-09-22 and would show stale data - not used on purpose.
rem ===========================================================================
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [gongkao] Electron runtime not found, installing dependencies once...
  call npm install --no-audit --no-fund
  if not exist "node_modules\electron\dist\electron.exe" (
    echo [gongkao] Install failed. Run "npm install" manually in this folder.
    pause
    exit /b 1
  )
)

if not exist "renderer\index.html" (
  echo [gongkao] renderer\index.html missing. Wrong folder?
  pause
  exit /b 1
)

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
endlocal

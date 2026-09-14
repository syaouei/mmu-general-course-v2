@echo off
rem ==========================================================================
rem  Double-click this file to create admin\vault.enc, the admin key.
rem
rem  It opens a real console window, so the token and password prompts can
rem  take keyboard input. An editor Run button gives the script no keyboard.
rem
rem  Kept deliberately simple:
rem  - ASCII only with CRLF line endings. cmd.exe re-reads batch files line
rem    by line while running them.
rem  - No chcp. Switching the code page mid-file makes cmd fail to re-open
rem    this file when its path has non-ASCII characters, and it prints
rem    "The system cannot find the path specified." Node already writes
rem    Unicode to a real console correctly without it.
rem  - No goto or labels. Blocks are parsed once, with no re-scan by path.
rem ==========================================================================
setlocal
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    "%ProgramFiles%\nodejs\node.exe" "%~dp0make-vault.mjs"
  ) else (
    echo.
    echo Node.js was not found. Install it from https://nodejs.org and try again.
  )
) else (
  node "%~dp0make-vault.mjs"
)
echo.
pause

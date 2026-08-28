@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先到 https://nodejs.org 安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)
node server.mjs
pause

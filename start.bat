@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :NONODE
if not exist "server.mjs" goto :NOFILE

echo 正在启动剧集文件批量重命名工具，浏览器将自动打开 http://127.0.0.1:3710
echo 若浏览器未自动打开，请手动访问该地址；停止服务请按 Ctrl+C。
echo.
node server.mjs
if errorlevel 1 (
  echo.
  echo [错误] 服务启动失败，请查看上方错误信息（常见原因：端口被占用）。
)
echo.
pause
exit /b 0

:NONODE
echo.
echo [错误] 未检测到 Node.js。
echo 请先到 https://nodejs.org 下载安装 Node.js 18 或更高版本（选择 LTS 版本），
echo 安装完成后重新双击本脚本。
echo.
pause
exit /b 1

:NOFILE
echo.
echo [错误] 未找到 server.mjs 文件。
echo 请确认本脚本与 server.mjs、public 文件夹位于同一目录。
echo.
pause
exit /b 1

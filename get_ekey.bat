@echo off
REM ============================================================
REM  QQ 音乐 ekey 提取器 —— 双击运行
REM
REM  从正在运行的 QQ 音乐客户端读取会话票据, 换 ekey。
REM  不需要重新登录: 客户端已经登录过了, 这里只是把它的票据读出来。
REM
REM  用法:
REM    方式 A: 把 .mgg / .mflac 文件拖到本 bat 上 -> 取 ekey
REM    方式 B: 双击本 bat -> 进入交互模式
REM ============================================================
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] 没找到 Python。
  echo       去 https://www.python.org/downloads/ 装 Python 3,
  echo       安装时务必勾选 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0qq_ekey.py" (
  echo.
  echo   [X] 找不到 qq_ekey.py —— 请把整个包一起解压。
  echo.
  pause
  exit /b 1
)

echo.
echo   需要 QQ 音乐客户端正在运行并且已登录。
echo.
pause

if "%~1"=="" (
  python "%~dp0qq_ekey.py" %*
) else (
  python "%~dp0qq_ekey.py" --files "%~1" %*
)

echo.
echo   --- exit code %errorlevel% ---
pause

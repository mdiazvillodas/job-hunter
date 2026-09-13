@echo off
setlocal
cd /d "%~dp0"

set "JH_NODE=%~dp0runtime-managed\node\node.exe"
if not exist "%JH_NODE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Job Hunter necesita Node 22. Ejecuta primero la preparacion del runtime.
    pause
    exit /b 1
  )
set "JH_NODE=node"
)

powershell -NoProfile -Command "try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/health' -TimeoutSec 1; if($r.status -eq 'ok' -and $r.app -eq 'job-hunter'){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto ready

"%JH_NODE%" "%~dp0scripts\bootstrap.js"
if errorlevel 1 (
  echo No se pudo preparar Job Hunter. Revisa el mensaje anterior.
  pause
  exit /b 1
)

start "Job Hunter" /min "%JH_NODE%" "%~dp0src\ui\server.js"

for /l %%I in (1,1,30) do (
  powershell -NoProfile -Command "try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/health' -TimeoutSec 1; if($r.status -eq 'ok' -and $r.app -eq 'job-hunter'){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto ready
  ping 127.0.0.1 -n 2 >nul
)
echo Job Hunter no pudo iniciar. Revisa la ventana de la aplicacion.
exit /b 1

:ready
start "" "http://127.0.0.1:4173"
exit /b 0

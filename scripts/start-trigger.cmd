@echo off
REM ============================================================================
REM Job Hunter Trigger Service — launcher para Windows Task Scheduler ("At log on").
REM
REM El token NO se guarda en el repositorio. Se lee de la variable de entorno de
REM USUARIO HUNT_TRIGGER_TOKEN. Definila una sola vez (elegí un token fuerte):
REM
REM     setx HUNT_TRIGGER_TOKEN "<token-fuerte>"
REM
REM (Opcional) puerto/host:  setx HUNT_TRIGGER_PORT 8787   /   setx HUNT_TRIGGER_HOST 0.0.0.0
REM ============================================================================

REM Ir al root del proyecto (este script vive en scripts\)
cd /d "%~dp0.."

if "%HUNT_TRIGGER_TOKEN%"=="" (
  echo [start-trigger] ERROR: HUNT_TRIGGER_TOKEN no esta definido en el entorno de usuario.
  echo [start-trigger] Ejecuta una vez:  setx HUNT_TRIGGER_TOKEN "^<token-fuerte^>"
  exit /b 1
)

echo [start-trigger] Iniciando Job Hunter Trigger (puerto %HUNT_TRIGGER_PORT%)...
call npm run trigger

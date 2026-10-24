#!/bin/sh
set -eu
umask 077
mkdir -p /data/home
if [ ! -f /data/.vnc-passwd ]; then
  node -e "process.stdout.write(require('crypto').randomBytes(6).toString('base64'))" > /data/.vnc-password.txt
  x11vnc -storepasswd "$(cat /data/.vnc-password.txt)" /data/.vnc-passwd >/dev/null 2>&1
  chmod 600 /data/.vnc-password.txt /data/.vnc-passwd
fi
# Container restarts preserve /tmp, but the old display process no longer exists.
# Remove only the known display-1 runtime files, never browser/profile data.
if [ -e /tmp/.X1-lock ] || [ -S /tmp/.X11-unix/X1 ]; then
  active_display=$(ps -eo stat,args | awk '$1 !~ /^Z/ && $2 == "Xvfb" && $3 == ":1" {print $0}')
  if [ -n "$active_display" ]; then echo 'Display :1 already active; refusing to replace it.' >&2; exit 1; fi
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
fi
Xvfb :1 -screen 0 1440x900x24 -nolisten tcp >/data/display.log 2>&1 &
display_pid=$!
attempt=0
until [ -S /tmp/.X11-unix/X1 ]; do
  kill -0 "$display_pid" 2>/dev/null || { cat /data/display.log >&2; exit 1; }
  attempt=$((attempt + 1))
  [ "$attempt" -lt 100 ] || exit 1
  sleep 0.1
done
x11vnc -display :1 -localhost -rfbport "$VNC_PORT" -rfbauth /data/.vnc-passwd -forever -shared -quiet >/data/vnc.log 2>&1 &
websockify --web=/usr/share/novnc "${NOVNC_LISTEN_ADDRESS:-127.0.0.1}:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >/data/web-viewer.log 2>&1 &
# Only the UI: no scheduler, Telegram listener or trigger service is started.
exec node /data/src/ui/server.js

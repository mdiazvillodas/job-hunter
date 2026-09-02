'use strict';

// Lock COMPARTIDO del hunt (Milestone 10B). Lo usan tanto `npm run hunt` (manual) como el
// trigger service, para que NUNCA corran dos hunts a la vez sobre ./browser-profile.
//
// Estrategia conservadora de stale-lock:
//   - PID vivo            -> lock valido (busy).
//   - PID inexistente     -> stale, se permite recuperacion.
//   - No se puede determinar (EPERM / lock corrupto) -> NO se asume seguro -> se trata como busy.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LOCK_PATH = path.join(PROJECT_ROOT, 'src', 'data', 'hunt.lock');

// null = no se puede determinar.
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false; // no existe
    if (e.code === 'EPERM') return true; // existe pero sin permiso -> vivo
    return null; // indeterminado
  }
}

function readLockRaw(lockPath) {
  if (!fs.existsSync(lockPath)) return { exists: false, info: null, corrupt: false };
  try {
    return { exists: true, info: JSON.parse(fs.readFileSync(lockPath, 'utf8')), corrupt: false };
  } catch (e) {
    return { exists: true, info: null, corrupt: true };
  }
}

// { busy, stale, info, reason } — busy es conservador (vivo o indeterminado).
function inspectLock(lockPath = DEFAULT_LOCK_PATH) {
  const raw = readLockRaw(lockPath);
  if (!raw.exists) return { busy: false, stale: false, info: null, reason: 'no_lock' };
  if (raw.corrupt) return { busy: true, stale: false, info: null, reason: 'corrupt_lock' };
  const alive = isPidAlive(raw.info && raw.info.pid);
  if (alive === false) return { busy: false, stale: true, info: raw.info, reason: 'stale_pid' };
  if (alive === true) return { busy: true, stale: false, info: raw.info, reason: 'alive_pid' };
  return { busy: true, stale: false, info: raw.info, reason: 'undetermined' };
}

// Adquiere el lock de forma exclusiva. Lanza Error con code 'LOCK_HELD' si esta ocupado.
function acquireLock(lockPath = DEFAULT_LOCK_PATH, _depth = 0) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: os.hostname() });
  try {
    const fd = fs.openSync(lockPath, 'wx'); // creacion exclusiva (atomica)
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
    return { lockPath, pid: process.pid };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const status = inspectLock(lockPath);
    if (status.stale && _depth === 0) {
      try { fs.unlinkSync(lockPath); } catch (err) { /* otro proceso lo tomo; caemos a held */ }
      return acquireLock(lockPath, _depth + 1);
    }
    const held = new Error('hunt_already_running');
    held.code = 'LOCK_HELD';
    held.info = status.info;
    held.reason = status.reason;
    throw held;
  }
}

// Libera el lock SOLO si es nuestro (pid coincide). Idempotente y seguro en finally.
function releaseLock(lockPath = DEFAULT_LOCK_PATH) {
  const raw = readLockRaw(lockPath);
  if (raw.exists && raw.info && raw.info.pid === process.pid) {
    try { fs.unlinkSync(lockPath); return true; } catch (e) { return false; }
  }
  return false;
}

module.exports = {
  acquireLock,
  releaseLock,
  inspectLock,
  isPidAlive,
  DEFAULT_LOCK_PATH,
};

'use strict';

// Lock COMPARTIDO del navegador gestionado de LinkedIn (Milestone 10B). Lo usan el
// hunt (`npm run hunt`, UI y scheduler), la ventana manual, la verificacion de la
// sesion persistida y las herramientas CLI, para que NUNCA haya dos operaciones a
// la vez sobre el perfil persistente.
//
// El lock guarda un DUEÑO (proceso + tipo de operacion + instancia), no solo un PID:
// dos operaciones del mismo proceso se excluyen entre si y solo el dueño exacto
// puede liberar. Ver ./operationOwner.
//
// Estrategia conservadora de stale-lock:
//   - PID vivo            -> lock valido (busy).
//   - PID propio          -> siempre vivo (nunca stale): una operacion viva de este
//                            proceso no puede parecer un lock abandonado.
//   - PID inexistente     -> stale, se permite recuperacion.
//   - No se puede determinar (EPERM / lock corrupto) -> NO se asume seguro -> se trata como busy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DATA_DIR } = require('../runtime');
const { normalizeOwner, isSameOwner, describeOwner } = require('./operationOwner');

const DEFAULT_LOCK_PATH = path.join(DATA_DIR, 'hunt.lock');

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
  // Nuestro propio proceso esta vivo por definicion. Se resuelve antes de consultar
  // al sistema para que una operacion viva de ESTE proceso no pueda ser recuperada
  // como stale por otra operacion del mismo proceso.
  const ownProcess = !!raw.info && raw.info.pid === process.pid;
  const alive = ownProcess ? true : isPidAlive(raw.info && raw.info.pid);
  if (alive === false) return { busy: false, stale: true, info: raw.info, reason: 'stale_pid' };
  if (alive === true) return { busy: true, stale: false, info: raw.info, reason: 'alive_pid' };
  return { busy: true, stale: false, info: raw.info, reason: 'undetermined' };
}

// Diagnostico de propiedad seguro de exponer internamente: sin hostname ni rutas.
function describeLock(lockPath = DEFAULT_LOCK_PATH) {
  const status = inspectLock(lockPath);
  return { busy: status.busy, stale: status.stale, reason: status.reason, owner: describeOwner(status.info) };
}

// Adquiere el lock de forma exclusiva para un dueño. Lanza Error con code
// 'LOCK_HELD' si esta ocupado, incluso si quien lo retiene es otra operacion de
// ESTE MISMO proceso. `options.owner` declara la operacion; sin el se usa el dueño
// UNSPECIFIED del proceso, que nunca puede suplantar a una operacion declarada.
function acquireLock(lockPath = DEFAULT_LOCK_PATH, options = {}, _depth = 0) {
  const owner = normalizeOwner(options.owner);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({
    pid: owner.pid,
    operationType: owner.operationType,
    operationId: owner.operationId,
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
  });
  try {
    const fd = fs.openSync(lockPath, 'wx'); // creacion exclusiva (atomica)
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
    return { lockPath, pid: owner.pid, owner };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const status = inspectLock(lockPath);
    // Solo se recupera un lock cuyo PID esta MUERTO. inspectLock ya garantiza que
    // el PID propio nunca es stale, asi que esto no puede robarle el lock a otra
    // operacion viva de este mismo proceso.
    if (status.stale && _depth === 0) {
      try { fs.unlinkSync(lockPath); } catch (err) { /* otro proceso lo tomo; caemos a held */ }
      return acquireLock(lockPath, options, _depth + 1);
    }
    const held = new Error('hunt_already_running');
    held.code = 'LOCK_HELD';
    held.info = status.info;
    held.reason = status.reason;
    held.owner = describeOwner(status.info);
    throw held;
  }
}

// Libera el lock SOLO si el dueño coincide EXACTAMENTE (proceso + tipo + instancia).
// Otra operacion del mismo proceso, o la misma operacion con otro id, no puede
// liberarlo. No lanza nunca: es seguro en un finally y repetirlo es inocuo
// (la segunda llamada simplemente devuelve false).
function releaseLock(lockPath = DEFAULT_LOCK_PATH, options = {}) {
  const owner = normalizeOwner(options.owner);
  const raw = readLockRaw(lockPath);
  if (!raw.exists || !raw.info || !isSameOwner(raw.info, owner)) return false;
  try { fs.unlinkSync(lockPath); return true; } catch (e) { return false; }
}

module.exports = {
  acquireLock,
  releaseLock,
  inspectLock,
  describeLock,
  isPidAlive,
  DEFAULT_LOCK_PATH,
};

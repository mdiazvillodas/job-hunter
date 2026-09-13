'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { UI_LOCK_PATH } = require('../runtime');

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; return null; }
}

function inspectUiLock(lockPath = UI_LOCK_PATH) {
  if (!fs.existsSync(lockPath)) return { busy: false, stale: false, reason: 'no_lock' };
  let info;
  try { info = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
  catch (_) { return { busy: true, stale: false, reason: 'corrupt_lock' }; }
  const alive = isPidAlive(info.pid);
  if (alive === false) return { busy: false, stale: true, reason: 'stale_pid', info };
  return { busy: true, stale: false, reason: alive === true ? 'alive_pid' : 'undetermined', info };
}

function acquireUiLock(lockPath = UI_LOCK_PATH, retried = false) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: os.hostname() }));
    fs.closeSync(fd);
    return { lockPath };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const status = inspectUiLock(lockPath);
    if (status.stale && !retried) {
      try { fs.unlinkSync(lockPath); } catch (_) {}
      return acquireUiLock(lockPath, true);
    }
    const held = new Error('Job Hunter ya está abierto.');
    held.code = 'UI_LOCK_HELD'; held.statusCode = 409; held.expose = true;
    throw held;
  }
}

function releaseUiLock(lockPath = UI_LOCK_PATH) {
  if (!fs.existsSync(lockPath)) return false;
  try {
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (info.pid !== process.pid) return false;
    fs.unlinkSync(lockPath); return true;
  } catch (_) { return false; }
}

module.exports = { acquireUiLock, releaseUiLock, inspectUiLock, isPidAlive };

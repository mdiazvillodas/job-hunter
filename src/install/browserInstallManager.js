'use strict';

const { spawn } = require('child_process');
const { APP_DIR, PLAYWRIGHT_BROWSERS_DIR } = require('../runtime');

function defaultInstaller(options = {}) {
  const appDir = options.appDir || APP_DIR;
  const browsersDir = options.browsersDir || PLAYWRIGHT_BROWSERS_DIR;
  const resolveCli = options.resolveCli || ((name) => require.resolve(name, { paths: [appDir] }));
  const spawnChild = options.spawnChild || spawn;
  const cli = resolveCli('playwright/cli');
  return spawnChild(options.nodeExecutable || process.execPath, [cli, 'install', 'chromium'], {
    cwd: appDir,
    env: { ...(options.env || process.env), PLAYWRIGHT_BROWSERS_PATH: browsersDir },
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
}

function createBrowserInstallManager(options = {}) {
  const install = options.installer || defaultInstaller;
  const now = options.clock || (() => new Date());
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;
  const timeoutMs = options.timeoutMs === undefined ? 10 * 60 * 1000 : options.timeoutMs;
  let child = null;
  let timer = null;
  let state = { status: 'IDLE', startedAt: null, finishedAt: null, error: null };
  const snapshot = () => ({ ...state, error: state.error && { ...state.error } });
  function cleanup() { if (timer) cancelTimeout(timer); timer = null; child = null; }
  function finish(status, code, message) {
    if (state.status !== 'RUNNING') return;
    state.status = status; state.finishedAt = now().toISOString();
    state.error = code ? { code, message } : null;
    cleanup();
  }
  function observe(result) {
    if (result && typeof result.once === 'function') {
      child = result;
      result.once('error', () => finish('FAILED', 'BROWSER_INSTALL_FAILED', 'No se pudo instalar Chromium.'));
      result.once('exit', (code) => code === 0 ? finish('COMPLETED') : finish('FAILED', 'BROWSER_INSTALL_FAILED', 'No se pudo instalar Chromium.'));
    } else {
      Promise.resolve(result).then(() => finish('COMPLETED')).catch(() => finish('FAILED', 'BROWSER_INSTALL_FAILED', 'No se pudo instalar Chromium.'));
    }
  }
  function start() {
    if (state.status === 'RUNNING') {
      const error = new Error('La instalación de Chromium ya está en curso.');
      error.code = 'BROWSER_INSTALL_RUNNING'; error.statusCode = 409; error.expose = true; throw error;
    }
    state = { status: 'RUNNING', startedAt: now().toISOString(), finishedAt: null, error: null };
    timer = scheduleTimeout(() => {
      const ownedChild = child;
      finish('FAILED', 'BROWSER_INSTALL_TIMEOUT', 'La instalación de Chromium excedió el tiempo permitido.');
      if (ownedChild && typeof ownedChild.kill === 'function') ownedChild.kill();
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try { observe(install()); }
    catch (_) { finish('FAILED', 'BROWSER_INSTALL_FAILED', 'No se pudo instalar Chromium.'); }
    return snapshot();
  }
  function stop() {
    if (state.status !== 'RUNNING') return snapshot();
    const ownedChild = child;
    finish('FAILED', 'BROWSER_INSTALL_STOPPED', 'La instalación de Chromium fue detenida.');
    if (ownedChild && typeof ownedChild.kill === 'function') ownedChild.kill();
    return snapshot();
  }
  return { start, stop, getStatus: snapshot };
}

module.exports = { createBrowserInstallManager, defaultInstaller };

'use strict';

const fs = require('fs');
const path = require('path');
const { APP_DIR, DATA_DIR, RUNTIME_DIR, getManagedNodeExecutable, getPlaywrightBrowsersDir } = require('../runtime');

function parseNodeMajor(version) {
  const match = String(version || '').match(/^v?(\d+)\./);
  return match ? Number(match[1]) : null;
}

function nodeCompatibility(version) {
  const major = parseNodeMajor(version);
  if (major === null) return { state: 'missing', compatible: false };
  return { state: major === 22 ? 'ready' : 'incompatible', compatible: major === 22, version: String(version) };
}

function createRuntimeService(options = {}) {
  const fileSystem = options.fs || fs;
  const appDir = options.appDir || APP_DIR;
  const dataDir = options.dataDir || DATA_DIR;
  const runtimeDir = options.runtimeDir || RUNTIME_DIR;
  const nodeVersion = options.nodeVersion === undefined ? process.version : options.nodeVersion;
  const resolveModule = options.resolveModule || ((name) => require.resolve(name, { paths: [appDir] }));
  const browserExecutable = options.browserExecutable || (() => {
    try { return require('playwright').chromium.executablePath(); } catch (_) { return ''; }
  });

  function browserStatus() {
    try { const executable = browserExecutable(); return executable && fileSystem.existsSync(executable) ? 'ready' : 'missing'; }
    catch (_) { return 'missing'; }
  }

  function dependenciesStatus() {
    const packageFile = path.join(appDir, 'node_modules', 'playwright', 'package.json');
    if (!fileSystem.existsSync(packageFile)) return 'missing';
    try { resolveModule('playwright'); return 'ready'; } catch (_) { return 'invalid'; }
  }

  function getStatus() {
    const node = nodeCompatibility(nodeVersion);
    return {
      node: node.state,
      dependencies: dependenciesStatus(),
      chromium: browserStatus(),
      dataDir: fileSystem.existsSync(dataDir) ? 'ready' : 'missing',
    };
  }

  function bootstrap() {
    if (options.platform && options.platform !== 'win32') throw Object.assign(new Error('Sistema operativo no soportado.'), { code: 'UNSUPPORTED_OS' });
    [dataDir, runtimeDir, getPlaywrightBrowsersDir(runtimeDir), 'config', 'profile', 'browser-profile', 'jobs', 'runs', 'feedback'].map((entry) => path.isAbsolute(entry) ? entry : path.join(dataDir, entry))
      .forEach((dir) => fileSystem.mkdirSync(dir, { recursive: true }));
    const status = getStatus();
    if (status.node !== 'ready') {
      const error = new Error(status.node === 'missing' ? 'No se encontró Node 22 administrado o compatible.' : 'La versión de Node no es compatible; se requiere Node 22.');
      error.code = status.node === 'missing' ? 'NODE_MISSING' : 'NODE_INCOMPATIBLE';
      error.status = status;
      throw error;
    }
    if (status.dependencies !== 'ready') {
      const error = new Error('La instalación de Job Hunter está incompleta. Faltan dependencias de producción válidas.');
      error.code = status.dependencies === 'missing' ? 'DEPENDENCIES_MISSING' : 'DEPENDENCIES_INVALID';
      error.status = status;
      throw error;
    }
    return status;
  }

  return { getStatus, bootstrap, paths: { appDir, dataDir, runtimeDir }, managedNode: getManagedNodeExecutable(runtimeDir), currentNode: process.execPath };
}

module.exports = { createRuntimeService, parseNodeMajor, nodeCompatibility };

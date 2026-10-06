'use strict';

// Google Chrome instalado en Windows. El launcher de InfoJobs puede abrir el
// Chrome de la PC (channel: 'chrome') en lugar del Chromium que prepara el
// instalador; ese Chrome NO lo instala Job Hunter. Este modulo solo lo detecta
// para avisar con un mensaje claro: nunca instala ni descarga nada.

const fs = require('fs');
const path = require('path');

const CHROME_RELATIVE = path.join('Google', 'Chrome', 'Application', 'chrome.exe');

// process.env en Windows no distingue mayusculas; un objeto inyectado (tests) si.
function readEnv(env, names) {
  for (const name of names) {
    if (env[name]) return env[name];
  }
  return null;
}

function chromeCandidates(env = process.env) {
  const roots = [
    readEnv(env, ['ProgramFiles', 'PROGRAMFILES']),
    readEnv(env, ['ProgramFiles(x86)', 'PROGRAMFILES(X86)']),
    readEnv(env, ['LOCALAPPDATA', 'LocalAppData']),
  ].filter(Boolean);
  return roots.map((root) => path.join(root, CHROME_RELATIVE));
}

// Ruta de chrome.exe o null si no esta en ninguna ubicacion estandar.
function findInstalledChrome(options = {}) {
  const env = options.env || process.env;
  const exists = options.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  return chromeCandidates(env).find((p) => exists(p)) || null;
}

// Error de Playwright al pedir channel 'chrome' sin Chrome instalado:
//   "Chromium distribution 'chrome' is not found at C:\...\chrome.exe"
function isChromeNotFoundError(error) {
  const message = error && error.message ? error.message : String(error || '');
  return /distribution 'chrome' is not found/i.test(message);
}

module.exports = { chromeCandidates, findInstalledChrome, isChromeNotFoundError };

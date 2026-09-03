'use strict';

const { BROWSER_PROFILE_DIR } = require('../runtime');
const { acquireLock, releaseLock } = require('../domain/huntLock');

const STATES = Object.freeze({
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  AUTHENTICATED: 'AUTHENTICATED',
  CHECKPOINT_REQUIRED: 'CHECKPOINT_REQUIRED',
  ERROR: 'ERROR',
});

const MESSAGES = Object.freeze({
  NOT_INITIALIZED: 'LinkedIn todavía no fue conectado.',
  LOGIN_REQUIRED: 'Necesitás iniciar sesión en LinkedIn.',
  AUTHENTICATED: 'La sesión de LinkedIn está activa.',
  CHECKPOINT_REQUIRED: 'LinkedIn requiere una verificación manual.',
  ERROR: 'No se pudo verificar la sesión de LinkedIn.',
});

function operationalError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

async function visible(page, selector) {
  return page.locator(selector).first().isVisible({ timeout: 1500 }).catch(() => false);
}

async function detectState(context, page) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return STATES.ERROR;
  const url = String(page.url() || '').toLowerCase();
  if (/\/checkpoint\/|\/challenge\/|\/uas\/login-submit|\/captcha|verification/.test(url)) {
    return STATES.CHECKPOINT_REQUIRED;
  }
  const body = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  if (/captcha|security verification|verificaci[oó]n de seguridad|confirm your identity|confirma tu identidad/i.test(body)) {
    return STATES.CHECKPOINT_REQUIRED;
  }
  if (/\/login|\/signup|authwall/.test(url)) return STATES.LOGIN_REQUIRED;

  const hasAuthenticatedUi = await visible(page, 'a[href*="/feed/"], a[href*="/in/"]');
  if (hasAuthenticatedUi) return STATES.AUTHENTICATED;
  return STATES.LOGIN_REQUIRED;
}

function createLinkedinSessionService(options = {}) {
  const profileDir = options.browserProfileDir || BROWSER_PROFILE_DIR;
  const launch = options.launchBrowser || (async (dir) => {
    const { launchLinkedInBrowser } = require('../linkedin/browser');
    return launchLinkedInBrowser(dir);
  });
  const initialPage = options.getInitialPage || (async (context) => {
    const { getInitialPage } = require('../linkedin/browser');
    return getInitialPage(context);
  });
  const lock = options.acquireLock || acquireLock;
  const unlock = options.releaseLock || releaseLock;
  let context = null;
  let page = null;
  let state = STATES.NOT_INITIALIZED;
  let lockHeld = false;

  function releaseSessionLock() {
    if (lockHeld) unlock();
    lockHeld = false;
  }

  function clearClosedContext() {
    context = null;
    page = null;
    state = STATES.NOT_INITIALIZED;
    releaseSessionLock();
  }

  function publicStatus() {
    return { state, message: MESSAGES[state], windowOpen: !!context };
  }

  async function inspect() {
    if (!context || !page) return publicStatus();
    try {
      state = await detectState(context, page);
      console.log(`[linkedin-session] state=${state}`);
    } catch (_) {
      state = STATES.ERROR;
    }
    return publicStatus();
  }

  async function open() {
    if (context) throw operationalError('SESSION_WINDOW_OPEN', 'La ventana manual de LinkedIn ya está abierta.');
    try {
      lock();
      lockHeld = true;
      context = await launch(profileDir);
      page = await initialPage(context);
      if (context.once) context.once('close', clearClosedContext);
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      return inspect();
    } catch (_) {
      if (context) await context.close().catch(() => {});
      context = null;
      page = null;
      state = STATES.ERROR;
      releaseSessionLock();
      if (_.code === 'LOCK_HELD') throw operationalError('HUNT_ALREADY_RUNNING', 'Ya hay una búsqueda en curso.');
      throw operationalError('LINKEDIN_BROWSER_ERROR', 'No se pudo abrir LinkedIn.', 503);
    }
  }

  async function close() {
    const closing = context;
    clearClosedContext();
    if (closing) await closing.close().catch(() => {});
    return publicStatus();
  }

  return { open, close, getStatus: inspect, isOpen: () => !!context, getBrowserProfileDir: () => profileDir };
}

module.exports = { createLinkedinSessionService, detectState, STATES, operationalError };

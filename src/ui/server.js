'use strict';

// Backend fino de la UI local (Node http, sin dependencias). Adapta HTTP -> jobService.
// UI (browser) -> /api (este server) -> jobService -> repository. La UI nunca toca los JSON.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { createLocalRepository } = require('../data/jobRepository');
const { createJobService } = require('../services/jobService');
const { computeLearnedPreferences } = require('../ai/learnedPreferences');
const { computeCalibrationSignal } = require('../domain/calibration');
const { FEEDBACK_REASONS } = require('../domain/feedbackConfig');
const { getUserConfig, toPublicUserConfig } = require('../config/userConfig');
const { toEditableSearch, applySearchSettings, toEditableNotifications, applyNotificationSettings, saveUserConfigFile } = require('../config/searchSettings');
const { getNotificationSettings } = require('../config/userConfig');
const { getNtfyConfig, defaultSend } = require('../notifications/ntfy');
const { createSetupService } = require('../setup/setupService');
const { createLinkedinSessionService } = require('../session/linkedinSessionService');
const { createHuntRunManager } = require('../run/huntRunManager');
const { createMarketDiscoveryRunManager } = require('../run/marketDiscoveryRunManager');
const { createRuntimeService } = require('../install/runtimeService');
const { createBrowserInstallManager } = require('../install/browserInstallManager');
const { createScheduleStore } = require('../scheduler/scheduleStore');
const { createLocalScheduler } = require('../scheduler/localScheduler');
const { createTelegramService } = require('../telegram/telegramService');
const { acquireUiLock, releaseUiLock } = require('../runtime/uiLock');
const { version: APP_VERSION } = require('../../package.json');

const PORT = Number(process.env.UI_PORT) || 4173;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UI_DIR = __dirname;

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) {
        const error = new Error('Body demasiado grande');
        error.statusCode = 413;
        error.expose = true;
        reject(error);
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        const error = new Error('JSON invalido en el body');
        error.statusCode = 400;
        error.expose = true;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function calibrationsFor(jobs) {
  return jobs
    .map((j) => computeCalibrationSignal(j))
    .filter((c) => c.aiDecision && c.userStatus && c.userStatus !== 'new');
}

async function handleApi(req, res, url, svc, setupService, linkedinSessionService, huntRunManager, operations = {}) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (method === 'GET' && parts.length === 2 && parts[1] === 'health') {
    return sendJson(res, 200, { status: 'ok', app: 'job-hunter', version: APP_VERSION, setupReady: !!setupService.getStatus().readyForHunt });
  }
  if (method === 'GET' && parts[1] === 'runtime' && parts[2] === 'status') {
    return sendJson(res, 200, operations.runtimeService.getStatus());
  }
  if (method === 'POST' && parts[1] === 'runtime' && parts[2] === 'install-browser') {
    return sendJson(res, 202, operations.browserInstallManager.start());
  }
  if (method === 'GET' && parts[1] === 'runtime' && parts[2] === 'install-browser') {
    return sendJson(res, 200, operations.browserInstallManager.getStatus());
  }
  if (method === 'GET' && parts.length === 2 && parts[1] === 'schedule') {
    return sendJson(res, 200, operations.scheduler.getStatus());
  }
  if (method === 'PUT' && parts.length === 2 && parts[1] === 'schedule') {
    requireJsonContentType(req);
    return sendJson(res, 200, operations.scheduler.update(await readBody(req)));
  }
  if (method === 'GET' && parts[1] === 'schedule' && parts[2] === 'status') {
    return sendJson(res, 200, operations.scheduler.getStatus());
  }

  if (method === 'POST' && parts[1] === 'linkedin' && parts[2] === 'session' && parts[3] === 'open') {
    return sendJson(res, 202, await linkedinSessionService.open());
  }
  if (method === 'GET' && parts[1] === 'linkedin' && parts[2] === 'session' && parts[3] === 'status') {
    return sendJson(res, 200, await linkedinSessionService.getStatus());
  }
  if (method === 'POST' && parts[1] === 'linkedin' && parts[2] === 'session' && parts[3] === 'verify-persisted') {
    return sendJson(res, 200, await linkedinSessionService.verifyPersistedSession());
  }
  if (method === 'POST' && parts[1] === 'linkedin' && parts[2] === 'session' && parts[3] === 'close') {
    await linkedinSessionService.close();
    return sendJson(res, 200, await linkedinSessionService.verifyPersistedSession());
  }
  if (method === 'POST' && parts.length === 2 && parts[1] === 'hunt') {
    if (operations.lifecycle && operations.lifecycle.shuttingDown) {
      const error = new Error('Job Hunter se está cerrando.');
      error.code = 'APP_SHUTTING_DOWN'; error.statusCode = 503; error.expose = true; throw error;
    }
    return sendJson(res, 202, await huntRunManager.start());
  }
  if (method === 'GET' && parts[1] === 'hunt' && parts[2] === 'status') {
    return sendJson(res, 200, huntRunManager.getStatus());
  }
  if (method === 'POST' && parts[1] === 'hunt' && parts[2] === 'cancel') {
    return sendJson(res, 202, huntRunManager.cancel());
  }

  // --- Market Discovery (MD7). Solo lectura sobre la configuracion de Hunter:
  // ninguna ruta aplica la propuesta ni modifica las queries activas.
  if (parts[1] === 'market-discovery') {
    const marketDiscovery = operations.marketDiscoveryRunManager;
    if (!marketDiscovery) return sendJson(res, 503, { error: 'La exploración de mercado no está disponible.', code: 'MARKET_DISCOVERY_UNAVAILABLE' });
    if (method === 'POST' && parts.length === 3 && parts[2] === 'start') {
      if (operations.lifecycle && operations.lifecycle.shuttingDown) {
        return sendJson(res, 503, { error: 'Job Hunter se está cerrando.', code: 'APP_SHUTTING_DOWN' });
      }
      // No espera a que la exploracion termine: devuelve la corrida aceptada.
      return sendJson(res, 202, await marketDiscovery.start());
    }
    if (method === 'GET' && parts.length === 3 && parts[2] === 'status') {
      return sendJson(res, 200, marketDiscovery.getStatus());
    }
    if (method === 'POST' && parts.length === 3 && parts[2] === 'cancel') {
      return sendJson(res, 202, marketDiscovery.cancel());
    }
    if (method === 'GET' && parts[2] === 'runs' && parts[3]) {
      const runId = decodeURIComponent(parts[3]);
      // El id nunca llega al sistema de archivos sin validarse.
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) return sendJson(res, 400, { error: 'Identificador de exploración inválido.', code: 'INVALID_RUN_ID' });
      if (parts.length === 5 && parts[4] === 'proposal') {
        const proposal = marketDiscovery.getProposal(runId);
        if (!proposal) return sendJson(res, 404, { error: 'No hay propuesta para esa exploración.', code: 'PROPOSAL_NOT_FOUND' });
        return sendJson(res, 200, proposal);
      }
      if (parts.length === 4) {
        const run = marketDiscovery.getRun(runId);
        if (!run) return sendJson(res, 404, { error: 'Exploración no encontrada.', code: 'RUN_NOT_FOUND' });
        return sendJson(res, 200, run);
      }
    }
  }

  // GET /api/jobs
  if (method === 'GET' && parts.length === 2 && parts[1] === 'jobs') {
    return sendJson(res, 200, { jobs: svc.getAllJobs() });
  }
  // GET /api/user-config (solo campos publicos; nunca secretos)
  // Configuracion editable por el usuario. Escribe SIEMPRE en runtime-data,
  // nunca en el codigo fuente.
  if (method === 'GET' && parts.length === 2 && parts[1] === 'settings') {
    const cfg = getUserConfig();
    return sendJson(res, 200, { search: toEditableSearch(cfg), notifications: toEditableNotifications(cfg) });
  }
  if (method === 'PUT' && parts[1] === 'settings' && parts[2] === 'search') {
    const next = applySearchSettings(getUserConfig(), await readBody(req));
    saveUserConfigFile(next);
    return sendJson(res, 200, { search: toEditableSearch(next) });
  }
  if (method === 'PUT' && parts[1] === 'settings' && parts[2] === 'notifications') {
    const next = applyNotificationSettings(getUserConfig(), await readBody(req));
    saveUserConfigFile(next);
    return sendJson(res, 200, { notifications: toEditableNotifications(next) });
  }
  // Envio de prueba: usa la configuracion guardada y NO toca ninguna oferta.
  if (method === 'POST' && parts[1] === 'settings' && parts[2] === 'notifications' && parts[3] === 'test') {
    const config = getNtfyConfig(getNotificationSettings(getUserConfig()));
    if (!config.enabled) return sendJson(res, 409, { error: 'Activá las notificaciones antes de probarlas.' });
    if (config.configError) return sendJson(res, 400, { error: config.configError });
    const send = operations.sendNotification || defaultSend;
    await send(config.url, { title: 'Job Hunter - Test', body: 'Notification integration working', priority: 'high', click: null });
    return sendJson(res, 200, { ok: true, topic: config.topic });
  }

  // --- Telegram / control remoto ---
  // Ninguna respuesta de este bloque contiene el token: solo se informa de si
  // hay uno guardado y de la identidad visible del bot y de la cuenta.
  if (parts[1] === 'settings' && parts[2] === 'telegram') {
    const telegram = operations.telegramService;
    if (method === 'GET' && parts.length === 3) {
      return sendJson(res, 200, telegram.getStatus());
    }
    if (method === 'PUT' && parts.length === 3) {
      requireJsonContentType(req);
      return sendJson(res, 200, await telegram.setEnabled((await readBody(req)).enabled === true));
    }
    if (method === 'PUT' && parts[3] === 'bot-token') {
      requireJsonContentType(req);
      return sendJson(res, 200, await telegram.validateAndSaveToken((await readBody(req)).token));
    }
    if (method === 'POST' && parts[3] === 'detect-account') {
      return sendJson(res, 200, await telegram.detectAccount());
    }
    if (method === 'PUT' && parts[3] === 'account') {
      requireJsonContentType(req);
      const body = await readBody(req);
      return sendJson(res, 200, await telegram.linkAccount({ detectionId: body.detectionId, userId: body.userId }));
    }
    if (method === 'DELETE' && parts[3] === 'account') {
      return sendJson(res, 200, await telegram.unlinkAccount());
    }
    if (method === 'POST' && parts[3] === 'test') {
      return sendJson(res, 200, await telegram.sendTestMessage());
    }
  }

  if (method === 'GET' && parts.length === 2 && parts[1] === 'user-config') {
    return sendJson(res, 200, toPublicUserConfig(getUserConfig()));
  }
  if (method === 'GET' && parts[1] === 'setup' && parts[2] === 'status') {
    return sendJson(res, 200, setupService.getStatus());
  }
  if (method === 'POST' && parts[1] === 'setup' && parts[2] === 'profile' && parts[3] === 'generate') {
    requireJsonContentType(req);
    return sendJson(res, 200, await setupService.generateProfileDraft(await readBody(req)));
  }
  if (method === 'GET' && parts[1] === 'setup' && parts[2] === 'profile' && parts[3] === 'draft') {
    const draft = setupService.getProfileDraft();
    if (!draft) return sendJson(res, 404, { error: 'No existe un borrador de perfil.' });
    return sendJson(res, 200, draft);
  }
  if (method === 'POST' && parts[1] === 'setup' && parts[2] === 'profile' && parts[3] === 'confirm') {
    return sendJson(res, 200, setupService.confirmProfileDraft());
  }
  if (method === 'DELETE' && parts[1] === 'setup' && parts[2] === 'profile' && parts[3] === 'draft') {
    return sendJson(res, 200, setupService.deleteProfileDraft());
  }
  if (method === 'GET' && parts.length === 2 && parts[1] === 'setup') {
    return sendJson(res, 200, setupService.getEditableSetup());
  }
  if (method === 'PUT' && parts[1] === 'setup' && parts[2] === 'user-config') {
    requireJsonContentType(req);
    return sendJson(res, 200, setupService.saveUserConfig(await readBody(req)));
  }
  if (method === 'PUT' && parts[1] === 'setup' && parts[2] === 'openai-key') {
    requireJsonContentType(req);
    const body = await readBody(req);
    return sendJson(res, 200, setupService.saveOpenAiKey(body.openAiKey));
  }
  // GET /api/reasons
  if (method === 'GET' && parts[1] === 'reasons') {
    return sendJson(res, 200, { reasons: FEEDBACK_REASONS });
  }
  // GET /api/learned-preferences
  if (method === 'GET' && parts[1] === 'learned-preferences') {
    return sendJson(res, 200, computeLearnedPreferences(svc.getAllJobs()));
  }
  // GET /api/calibration
  if (method === 'GET' && parts[1] === 'calibration') {
    return sendJson(res, 200, { calibrations: calibrationsFor(svc.getAllJobs()) });
  }
  // GET /api/job/:id
  if (method === 'GET' && parts[1] === 'job' && parts[2]) {
    const job = svc.getJob(decodeURIComponent(parts[2]));
    if (!job) return sendJson(res, 404, { error: 'Oferta no encontrada' });
    return sendJson(res, 200, { job, calibration: computeCalibrationSignal(job) });
  }
  // POST /api/job/:id/:action
  if (method === 'POST' && parts[1] === 'job' && parts[2] && parts[3]) {
    const jobId = decodeURIComponent(parts[2]);
    const action = parts[3];
    if (!svc.getJob(jobId)) return sendJson(res, 404, { error: 'Oferta no encontrada' });
    const body = await readBody(req);
    let job;
    switch (action) {
      case 'read':
        job = svc.markAsRead(jobId);
        break;
      case 'interested':
        job = svc.markAsInterested(jobId, { comment: body.comment });
        break;
      case 'priority':
        job = svc.markAsPriority(jobId, { comment: body.comment });
        break;
      case 'applied':
        job = svc.markAsApplied(jobId, { comment: body.comment });
        break;
      case 'discard':
        job = svc.markAsDiscarded(jobId, { reasons: body.reasons || [], comment: body.comment });
        break;
      default:
        return sendJson(res, 400, { error: 'Accion desconocida' });
    }
    return sendJson(res, 200, { job, calibration: computeCalibrationSignal(job) });
  }

  return sendJson(res, 404, { error: 'Endpoint no encontrado' });
}

function handleStatic(req, res, url) {
  if (url.pathname === '/setup') {
    return sendFile(res, path.join(PUBLIC_DIR, 'setup.html'));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (url.pathname === '/jobListLogic.js') {
    return sendFile(res, path.join(UI_DIR, 'jobListLogic.js'));
  }
  // Solo servir archivos dentro de public (evitar path traversal).
  const safe = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  return sendFile(res, filePath);
}

function createServer(options = {}) {
  const repository = options.repository || createLocalRepository();
  const svc = options.jobService || createJobService(repository);
  const setupService = options.setupService || createSetupService();
  const linkedinSessionService = options.linkedinSessionService || createLinkedinSessionService();
  const huntRunManager = options.huntRunManager || createHuntRunManager({ setupService, sessionService: linkedinSessionService });
  const runtimeService = options.runtimeService || createRuntimeService();
  const browserInstallManager = options.browserInstallManager || createBrowserInstallManager();
  const scheduleStore = options.scheduleStore || createScheduleStore();
  const scheduler = options.scheduler || createLocalScheduler({ scheduleStore, huntRunManager, browserInstallManager });
  const telegramService = options.telegramService || createTelegramService({ huntRunManager });
  const lifecycle = options.lifecycle || { shuttingDown: false };
  const marketDiscoveryRunManager = options.marketDiscoveryRunManager
    || createMarketDiscoveryRunManager({ setupService });
  const operations = { runtimeService, browserInstallManager, scheduler, telegramService, lifecycle, marketDiscoveryRunManager };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, svc, setupService, linkedinSessionService, huntRunManager, operations);
      } else {
        handleStatic(req, res, url);
      }
    } catch (err) {
      const expectedStatus = err && (err.statusCode || (err.code === 'CONFIGURATION_REQUIRED' ? 409 : undefined));
      const status = expectedStatus || 500;
      if (status >= 500) {
        const identity = err && (err.code || err.name) ? (err.code || err.name) : 'Error';
        console.error(`[ui-server] internal error: ${identity}`);
      }
      if (!res.headersSent) {
        const expose = !!(err && (err.expose || err.code === 'CONFIGURATION_REQUIRED'));
        sendJson(res, status, expose
          ? { error: err.message, code: err.code }
          : { error: 'Error interno' });
      }
    }
  });
}

function requireJsonContentType(req) {
  const contentType = req.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    const error = new Error('Content-Type debe ser application/json.');
    error.statusCode = 415;
    error.expose = true;
    throw error;
  }
}

function startServer(options = {}) {
  const port = options.port === undefined ? PORT : options.port;
  const host = '127.0.0.1';
  const ephemeral = port === 0 && !options.acquireUiLock && !options.releaseUiLock;
  const lock = ephemeral ? (() => {}) : (options.acquireUiLock || acquireUiLock);
  const unlock = ephemeral ? (() => {}) : (options.releaseUiLock || releaseUiLock);
  lock();
  let server;
  try { server = createServer(options); }
  catch (error) { unlock(); throw error; }
  let released = false;
  server.once('close', () => { if (!released) { released = true; unlock(); } });
  server.once('error', (error) => {
    if (!server.listening && !released) { released = true; unlock(); }
    if (error && error.code === 'EADDRINUSE') console.error(`Job Hunter no pudo iniciar: el puerto ${port} ya está ocupado.`);
    else console.error('Job Hunter no pudo iniciar el servidor local.');
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Job Hunter UI corriendo en  http://${host}:${server.address().port}`);
    console.log('Ctrl+C para detener.');
  });
  return server;
}

function installShutdownHandlers(server, options = {}) {
  const sessionService = options.linkedinSessionService;
  const scheduler = options.scheduler;
  const telegramService = options.telegramService;
  const browserInstallManager = options.browserInstallManager;
  const huntRunManager = options.huntRunManager;
  const marketDiscovery = options.marketDiscoveryRunManager;
  const lifecycle = options.lifecycle || { shuttingDown: false };
  const shutdownTimeoutMs = options.shutdownTimeoutMs === undefined ? 30000 : options.shutdownTimeoutMs;
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle.shuttingDown = true;
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    if (huntRunManager && huntRunManager.stopAccepting) huntRunManager.stopAccepting();
    // Market Discovery se cancela y limpia lo SUYO: su gestor cierra su navegador
    // y libera su propia propiedad. No se toca ninguna otra operacion.
    if (marketDiscovery && marketDiscovery.stopAccepting) marketDiscovery.stopAccepting();
    try { if (marketDiscovery && marketDiscovery.cancel) marketDiscovery.cancel(); } catch (_) { console.error('[shutdown] No se pudo cancelar la exploración de mercado limpiamente.'); }
    try { if (scheduler) scheduler.stop(); } catch (_) { console.error('[shutdown] No se pudo detener el scheduler limpiamente.'); }
    try { if (telegramService) await telegramService.stop(); } catch (_) { console.error('[shutdown] No se pudo detener el control remoto de Telegram limpiamente.'); }
    try { if (browserInstallManager && browserInstallManager.stop) browserInstallManager.stop(); } catch (_) { console.error('[shutdown] No se pudo detener el instalador de Chromium limpiamente.'); }
    try { if (sessionService) await sessionService.close(); } catch (_) { console.error('[shutdown] No se pudo cerrar la ventana manual limpiamente.'); }
    if (huntRunManager && huntRunManager.waitForIdle) {
      let timeout;
      const timedOut = await Promise.race([
        huntRunManager.waitForIdle().then(() => false),
        new Promise((resolve) => { timeout = scheduleTimeout(() => resolve(true), shutdownTimeoutMs); }),
      ]);
      if (timeout) cancelTimeout(timeout);
      if (timedOut) console.error('[shutdown] El hunt sigue activo después del tiempo de espera; no se lo cancela ni se elimina su lock.');
    }
    if (marketDiscovery && marketDiscovery.waitForIdle) {
      let mdTimeout;
      const mdTimedOut = await Promise.race([
        marketDiscovery.waitForIdle().then(() => false),
        new Promise((resolve) => { mdTimeout = scheduleTimeout(() => resolve(true), shutdownTimeoutMs); }),
      ]);
      if (mdTimeout) cancelTimeout(mdTimeout);
      if (mdTimedOut) console.error('[shutdown] La exploración de mercado sigue activa después del tiempo de espera.');
    }
    await new Promise((resolve) => { if (!server.listening) return resolve(); server.close(resolve); });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return shutdown;
}

function startupErrorMessage(error) {
  if (error && error.code === 'UI_LOCK_HELD') return 'Job Hunter ya está abierto.';
  if (error && error.code === 'EADDRINUSE') return 'Job Hunter no pudo iniciar: el puerto local ya está ocupado.';
  return 'Job Hunter no pudo iniciar.';
}

if (require.main === module) {
  const setupService = createSetupService();
  const linkedinSessionService = createLinkedinSessionService();
  const scheduleStore = createScheduleStore();
  const browserInstallManager = createBrowserInstallManager();
  const huntRunManager = createHuntRunManager({ setupService, sessionService: linkedinSessionService });
  const scheduler = createLocalScheduler({ scheduleStore, huntRunManager, browserInstallManager });
  const telegramService = createTelegramService({ huntRunManager });
  // Se construye aqui (y no solo dentro del server) para que el apagado ordenado
  // reciba EL MISMO gestor que atiende la API.
  const marketDiscoveryRunManager = createMarketDiscoveryRunManager({ setupService });
  const lifecycle = { shuttingDown: false };
  try {
    const server = startServer({ setupService, linkedinSessionService, huntRunManager, scheduleStore, scheduler, telegramService, browserInstallManager, marketDiscoveryRunManager, lifecycle });
    try { scheduler.start(); }
    catch (error) { console.error(`[scheduler] ${error.code || 'INVALID_SCHEDULE'}: configuración inválida; scheduler desactivado.`); }
    // Sin control remoto configurado esto es un no-op y no genera trafico.
    try { telegramService.start(); }
    catch (error) { console.error('[telegram] no se pudo iniciar el control remoto; Job Hunter sigue funcionando.'); }
    installShutdownHandlers(server, { linkedinSessionService, scheduler, telegramService, browserInstallManager, huntRunManager, marketDiscoveryRunManager, lifecycle });
  } catch (error) {
    console.error(startupErrorMessage(error));
    process.exitCode = 1;
  }
}

module.exports = { createServer, startServer, installShutdownHandlers, startupErrorMessage, handleApi, handleStatic, readBody, requireJsonContentType };

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
const { createSetupService } = require('../setup/setupService');

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

async function handleApi(req, res, url, svc, setupService) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // GET /api/jobs
  if (method === 'GET' && parts.length === 2 && parts[1] === 'jobs') {
    return sendJson(res, 200, { jobs: svc.getAllJobs() });
  }
  // GET /api/user-config (solo campos publicos; nunca secretos)
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
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, svc, setupService);
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
  const server = createServer(options);
  server.listen(port, host, () => {
    console.log(`Job Hunter UI corriendo en  http://${host}:${server.address().port}`);
    console.log('Ctrl+C para detener.');
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { createServer, startServer, handleApi, handleStatic, readBody, requireJsonContentType };

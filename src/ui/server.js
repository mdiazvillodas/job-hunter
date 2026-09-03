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

const PORT = Number(process.env.UI_PORT) || 4173;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UI_DIR = __dirname;

const repository = createLocalRepository();
const svc = createJobService(repository);

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
      if (data.length > 1e6) reject(new Error('Body demasiado grande'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('JSON invalido en el body'));
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

async function handleApi(req, res, url) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      handleStatic(req, res, url);
    }
  } catch (err) {
    // No filtrar stack traces al cliente; log en consola para desarrollo.
    console.error('[ui-server] error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      const status = err && err.code === 'CONFIGURATION_REQUIRED' ? 409 : 400;
      sendJson(res, status, { error: err && err.message ? err.message : 'Error interno', code: err && err.code });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Job Hunter UI corriendo en  http://localhost:${PORT}`);
  console.log(`Repository local: ${repository.dir}`);
  console.log('Ctrl+C para detener.');
});

module.exports = { server };

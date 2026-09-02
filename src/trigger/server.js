'use strict';

// Trigger service ASINCRONO (Milestone 10C): n8n dispara el hunt en Windows sin mantener una
// conexion HTTP larga. POST /run responde 202 al instante; el estado se consulta por GET /run/:runId.
// Solo modulos nativos. Comando fijo (node src/hunt.js), sin args del request, sin secretos por HTTP.
//
//   GET  /health            -> 200 (sin auth)
//   POST /run               -> 202 {runId, status:"started"} | 401 | 409
//   GET  /run/:runId        -> 200 estado | 404 | 401
//   GET  /runs              -> 200 historial compacto | 401

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { inspectLock } = require('../domain/huntLock');

const VERSION = '1';
const SERVICE = 'job-hunter-trigger';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const STDERR_TAIL_MAX = 8000;
const STDERR_LOG_MAX = 64000;
const STDOUT_MAX = 2000000;
const RUNID_RE = /^run_[A-Za-z0-9]+$/; // formato seguro (sin '/', '.', etc.)

function redactSecrets(str) {
  if (str == null) return str;
  let out = String(str);
  for (const key of ['OPENAI_API_KEY', 'HUNT_TRIGGER_TOKEN']) {
    const v = process.env[key];
    if (v && v.length >= 8) out = out.split(v).join('[redacted]');
  }
  return out;
}
function tail(str, max) { const s = str || ''; return s.length > max ? s.slice(s.length - max) : s; }
function nowIso() { return new Date().toISOString(); }
function genRunId() { return 'run_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }

// Comando FIJO: exactamente lo que hace `npm run hunt` (node src/hunt.js). Sin shell, sin args del request.
function defaultSpawnHunt(projectRoot) {
  return spawn(process.execPath, [path.join(projectRoot, 'src', 'hunt.js')], {
    cwd: projectRoot, shell: false, env: process.env, windowsHide: false,
  });
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function createServer(options = {}) {
  const token = options.token !== undefined ? options.token : process.env.HUNT_TRIGGER_TOKEN;
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const runsDir = options.runsDir || path.join(projectRoot, 'runs');
  const spawnHunt = options.spawnHunt || (() => defaultSpawnHunt(projectRoot));
  const lockInspector = options.inspectLock || (() => inspectLock());
  const log = options.log || ((m) => console.log('[trigger] ' + m));

  if (!token) throw new Error('HUNT_TRIGGER_TOKEN no esta definido. El trigger service no arranca sin token.');

  const runStates = new Map(); // runId -> state (fuente rapida; el archivo es la fuente durable)
  let current = null; // { runId, startedAt } mientras hay un hunt activo lanzado por este servicio.

  function checkAuth(req) {
    const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/);
    return m ? timingSafeEqualStr(m[1], token) : false;
  }

  function runFilePath(runId) {
    // runId ya validado contra RUNID_RE; ademas se ancla dentro de runsDir (anti path traversal).
    const p = path.join(runsDir, runId + '.json');
    if (path.dirname(path.resolve(p)) !== path.resolve(runsDir)) return null;
    return p;
  }

  function persistState(state) {
    try {
      fs.mkdirSync(runsDir, { recursive: true });
      const p = runFilePath(state.runId);
      if (p) fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) { log('no se pudo escribir run log: ' + e.message); }
  }

  function readState(runId) {
    if (runStates.has(runId)) return runStates.get(runId);
    if (!RUNID_RE.test(runId)) return null;
    const p = runFilePath(runId);
    if (!p || !fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  }

  function newState(runId, startedAt) {
    return { runId, status: 'starting', startedAt, finishedAt: null, durationMs: null, exitCode: null, pid: null, summary: null, stderrTail: '', error: null };
  }

  function startRun(req, res) {
    if (!checkAuth(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

    // Concurrencia: ni dos runs del servicio ni pisar un `npm run hunt` manual (lock compartido).
    if (current) return sendJson(res, 409, { ok: false, error: 'hunt_already_running', runId: current.runId, startedAt: current.startedAt });
    const lock = lockInspector();
    if (lock.busy) return sendJson(res, 409, { ok: false, error: 'hunt_already_running', pid: lock.info && lock.info.pid, startedAt: lock.info && lock.info.startedAt });

    const runId = genRunId();
    const startedAt = nowIso();
    const startMs = Date.now();
    const state = newState(runId, startedAt);
    runStates.set(runId, state);
    current = { runId, startedAt };
    persistState(state);

    let child;
    try {
      child = spawnHunt();
    } catch (e) {
      current = null;
      state.status = 'failed';
      state.error = 'spawn_failed: ' + e.message;
      state.finishedAt = nowIso();
      state.durationMs = Date.now() - startMs;
      persistState(state);
      return sendJson(res, 500, { ok: false, error: 'spawn_failed: ' + e.message });
    }

    state.pid = child.pid || null;
    state.status = 'running';
    persistState(state);

    // Respuesta INMEDIATA (no espera al hunt).
    sendJson(res, 202, { ok: true, runId, status: 'started', startedAt });

    let stdout = '';
    let stderr = '';
    let settled = false;
    if (child.stdout) child.stdout.on('data', (d) => { if (stdout.length < STDOUT_MAX) stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });

    const finalize = (code, spawnErr) => {
      if (settled) return;
      settled = true;
      current = null;
      state.finishedAt = nowIso();
      state.durationMs = Date.now() - startMs;
      let summary = null;
      try { summary = JSON.parse(stdout); } catch (e) { summary = null; }
      state.summary = summary;
      state.exitCode = spawnErr ? 1 : code;
      const ok = !spawnErr && code === 0 && summary !== null;
      state.status = ok ? 'success' : 'failed';
      state.stderrTail = tail(redactSecrets(stderr), STDERR_LOG_MAX);
      if (spawnErr) state.error = 'spawn_failed: ' + spawnErr.message;
      else if (!ok && summary === null) state.error = 'hunt_output_not_json_or_failed';
      persistState(state);
      log(`run ${runId} -> ${state.status} (exit ${state.exitCode})`);
    };

    child.on('error', (e) => finalize(1, e));
    child.on('close', (code) => finalize(code, null));
  }

  function getRun(res, runId, isLiveAuthoritative) {
    if (!RUNID_RE.test(runId)) return sendJson(res, 404, { ok: false, error: 'not_found' });
    const state = readState(runId);
    if (!state) return sendJson(res, 404, { ok: false, error: 'not_found' });

    // Deteccion conservadora de estado huerfano (p.ej. tras reinicio del trigger): el archivo dice
    // running/starting pero no es el run vivo actual -> se marca stale (no se reescribe el archivo).
    const isLive = current && current.runId === runId;
    const stale = (state.status === 'running' || state.status === 'starting') && !isLive;

    const body = {
      ok: state.status !== 'failed',
      runId: state.runId,
      status: state.status,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      durationMs: state.durationMs,
      exitCode: state.exitCode,
    };
    if (stale) body.stale = true;
    if (state.status === 'success' || state.status === 'failed') {
      body.summary = state.summary;
      body.stderrTail = tail(state.stderrTail, STDERR_TAIL_MAX);
      if (state.error) body.error = state.error;
    }
    return sendJson(res, 200, body);
  }

  function listRuns(res) {
    let files = [];
    try { files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')) : []; } catch (e) { files = []; }
    const runs = files
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')); } catch (e) { return null; } })
      .filter(Boolean)
      .map((s) => ({ runId: s.runId, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, durationMs: s.durationMs, exitCode: s.exitCode }))
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, 20);
    return sendJson(res, 200, { runs });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (url.pathname === '/health') {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return sendJson(res, 200, { ok: true, service: SERVICE, version: VERSION, huntRunning: !!current, currentRunId: current ? current.runId : null });
      }
      if (url.pathname === '/runs') {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        if (!checkAuth(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return listRuns(res);
      }
      if (url.pathname === '/run') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        req.resume(); // body ignorado: no se aceptan command/args del request
        return startRun(req, res);
      }
      if (parts[0] === 'run' && parts.length === 2) {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        if (!checkAuth(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return getRun(res, decodeURIComponent(parts[1]));
      }
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (e) {
      log('error: ' + (e && e.message));
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal_error' });
    }
  });

  return server;
}

module.exports = { createServer, redactSecrets, defaultSpawnHunt, RUNID_RE };

// Arranque directo: npm run trigger
if (require.main === module) {
  const token = process.env.HUNT_TRIGGER_TOKEN;
  if (!token) {
    console.error('ERROR: HUNT_TRIGGER_TOKEN no esta definido. Defini la variable y reintenta.');
    console.error('  PowerShell:  $env:HUNT_TRIGGER_TOKEN="<token-fuerte>"; npm run trigger');
    process.exit(1);
  }
  const port = Number(process.env.HUNT_TRIGGER_PORT) || 8787;
  const host = process.env.HUNT_TRIGGER_HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`${SERVICE} v${VERSION} (async) escuchando en ${host}:${port}`);
    console.log(`  GET  /health`);
    console.log(`  POST /run        -> 202 {runId}  (Authorization: Bearer <token>)`);
    console.log(`  GET  /run/:runId -> estado`);
    console.log(`  GET  /runs       -> historial`);
    console.log('  Comando disparado: node src/hunt.js  (== npm run hunt)');
    console.log('  Ctrl+C para detener.');
  });
}

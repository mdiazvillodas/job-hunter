'use strict';

// Tests del trigger service ASINCRONO + hunt lock (Milestone 10C). Sin LinkedIn ni OpenAI:
// el hunt se mockea con un child falso. Ejecutar: node src/tests/trigger.test.js

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createServer } = require('../trigger/server');
const { acquireLock, releaseLock, inspectLock, isPidAlive } = require('../domain/huntLock');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }
function tmpDir(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = 4321;
  c.finish = (code, out, err) => { if (out) c.stdout.emit('data', Buffer.from(out)); if (err) c.stderr.emit('data', Buffer.from(err)); c.emit('close', code); };
  c.fail = (msg) => c.emit('error', new Error(msg));
  return c;
}
function autoSpawn({ code = 0, stdout = '', stderr = '' } = {}) {
  return () => { const c = fakeChild(); setImmediate(() => c.finish(code, stdout, stderr)); return c; };
}

function request(server, method, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const headers = {};
    if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
    let payload = null;
    if (opts.body) { payload = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ host: '127.0.0.1', port: addr.port, method, path: pathname, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function withServer(opts, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(opts);
    server.listen(0, '127.0.0.1', async () => {
      try { await fn(server); resolve(); } catch (e) { reject(e); } finally { server.close(); }
    });
  });
}
async function pollStatus(server, runId, token, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = await request(server, 'GET', '/run/' + runId, { token });
    if (r.json && (r.json.status === 'success' || r.json.status === 'failed')) return r;
    await sleep(10);
  }
  return request(server, 'GET', '/run/' + runId, { token });
}

const TOKEN = 'test-token-supersecret';
const freeLock = () => ({ busy: false, info: null });

async function run() {
  // ---------- startup ----------
  section('Startup / token');
  { let threw = false; try { createServer({ token: '' }); } catch (e) { threw = true; } ok('no arranca sin token', threw); }

  // ---------- health ----------
  section('/health');
  await withServer({ token: TOKEN, inspectLock: freeLock, runsDir: tmpDir('t10c-h-') }, async (s) => {
    const r = await request(s, 'GET', '/health');
    ok('GET /health -> 200', r.status === 200 && r.json.ok === true && r.json.huntRunning === false && r.json.currentRunId === null);
    ok('POST /health -> 405', (await request(s, 'POST', '/health')).status === 405);
  });

  // ---------- auth ----------
  section('Auth');
  await withServer({ token: TOKEN, inspectLock: freeLock, spawnHunt: autoSpawn(), runsDir: tmpDir('t10c-a-') }, async (s) => {
    ok('POST /run sin token -> 401', (await request(s, 'POST', '/run')).status === 401);
    ok('POST /run token malo -> 401', (await request(s, 'POST', '/run', { token: 'x' })).status === 401);
    ok('GET /runs sin token -> 401', (await request(s, 'GET', '/runs')).status === 401);
    ok('GET /run/:id sin token -> 401', (await request(s, 'GET', '/run/run_abc')).status === 401);
    ok('GET /run (POST) -> 405', (await request(s, 'GET', '/run', { token: TOKEN })).status === 405);
    ok('ruta desconocida -> 404', (await request(s, 'GET', '/nope')).status === 404);
  });

  // ---------- async: 202 + running + success ----------
  section('POST /run -> 202 async, running -> success');
  {
    const runsDir = tmpDir('t10c-ok-');
    const children = [];
    const spawnHunt = () => { const c = fakeChild(); children.push(c); return c; };
    await withServer({ token: TOKEN, inspectLock: freeLock, spawnHunt, runsDir }, async (s) => {
      const t0 = Date.now();
      const r = await request(s, 'POST', '/run', { token: TOKEN });
      const elapsed = Date.now() - t0;
      ok('202 rapido (no bloquea)', r.status === 202 && r.json.status === 'started' && !!r.json.runId && elapsed < 1000);
      const runId = r.json.runId;
      ok('run log inicial escrito', fs.existsSync(path.join(runsDir, runId + '.json')));
      // mientras corre
      for (let i = 0; i < 30 && children.length === 0; i++) await sleep(5);
      const running = await request(s, 'GET', '/run/' + runId, { token: TOKEN });
      ok('GET running', running.status === 200 && running.json.status === 'running' && running.json.finishedAt === null);
      // termina exito
      children[0].finish(0, JSON.stringify({ runId, discovery: { uniqueResults: 5 } }), 'debug');
      const done = await pollStatus(s, runId, TOKEN);
      ok('GET success', done.json.status === 'success' && done.json.ok === true && done.json.exitCode === 0);
      ok('summary presente', done.json.summary && done.json.summary.discovery.uniqueResults === 5);
      const logged = JSON.parse(fs.readFileSync(path.join(runsDir, runId + '.json'), 'utf8'));
      ok('run log final actualizado', logged.status === 'success' && logged.finishedAt && logged.durationMs != null);
    });
  }

  // ---------- failed ----------
  section('run failed (exit 1)');
  await withServer({ token: TOKEN, inspectLock: freeLock, spawnHunt: autoSpawn({ code: 1, stderr: 'boom' }), runsDir: tmpDir('t10c-f-') }, async (s) => {
    const r = await request(s, 'POST', '/run', { token: TOKEN });
    const done = await pollStatus(s, r.json.runId, TOKEN);
    ok('status failed', done.json.status === 'failed' && done.json.ok === false && done.json.exitCode === 1);
    ok('stderrTail disponible', typeof done.json.stderrTail === 'string');
  });

  // ---------- stdout invalido ----------
  section('stdout no-JSON -> failed');
  await withServer({ token: TOKEN, inspectLock: freeLock, spawnHunt: autoSpawn({ code: 0, stdout: 'no json' }), runsDir: tmpDir('t10c-j-') }, async (s) => {
    const r = await request(s, 'POST', '/run', { token: TOKEN });
    const done = await pollStatus(s, r.json.runId, TOKEN);
    ok('summary null + failed', done.json.status === 'failed' && done.json.summary === null && !!done.json.error);
  });

  // ---------- spawn failure ----------
  section('spawn failure -> failed');
  {
    const children = [];
    const spawnHunt = () => { const c = fakeChild(); children.push(c); setImmediate(() => c.fail('ENOENT')); return c; };
    await withServer({ token: TOKEN, inspectLock: freeLock, spawnHunt, runsDir: tmpDir('t10c-s-') }, async (s) => {
      const r = await request(s, 'POST', '/run', { token: TOKEN });
      ok('202 igual (async)', r.status === 202);
      const done = await pollStatus(s, r.json.runId, TOKEN);
      ok('spawn error -> failed', done.json.status === 'failed' && /spawn_failed/.test(done.json.error));
    });
  }

  // ---------- unknown runId + path traversal ----------
  section('unknown runId + path traversal');
  await withServer({ token: TOKEN, inspectLock: freeLock, runsDir: tmpDir('t10c-pt-') }, async (s) => {
    ok('runId inexistente -> 404', (await request(s, 'GET', '/run/run_nope', { token: TOKEN })).status === 404);
    ok('traversal ..%2f.. -> 404', (await request(s, 'GET', '/run/..%2f..%2fsecret', { token: TOKEN })).status === 404);
    ok('runId invalido -> 404', (await request(s, 'GET', '/run/etc-passwd', { token: TOKEN })).status === 404);
  });

  // ---------- GET /runs historial ----------
  section('GET /runs historial');
  {
    const runsDir = tmpDir('t10c-list-');
    await withServer({ token: TOKEN, inspectLock: freeLock, spawnHunt: autoSpawn({ code: 0, stdout: '{}' }), runsDir }, async (s) => {
      const a = await request(s, 'POST', '/run', { token: TOKEN }); await pollStatus(s, a.json.runId, TOKEN);
      const b = await request(s, 'POST', '/run', { token: TOKEN }); await pollStatus(s, b.json.runId, TOKEN);
      const list = await request(s, 'GET', '/runs', { token: TOKEN });
      ok('lista >= 2', list.status === 200 && list.json.runs.length >= 2);
      ok('compacto sin stderr/summary', list.json.runs.every((r) => r.stderr === undefined && r.summary === undefined && r.runId && r.status));
    });
  }

  // ---------- concurrencia: segundo POST -> 409 ----------
  section('Concurrencia: segundo POST -> 409');
  {
    const children = [];
    const spawnHunt = () => { const c = fakeChild(); children.push(c); return c; };
    await withServer({ token: TOKEN, inspectLock: freeLock, spawnHunt, runsDir: tmpDir('t10c-c-') }, async (s) => {
      const r1 = await request(s, 'POST', '/run', { token: TOKEN });
      ok('primero 202', r1.status === 202);
      const r2 = await request(s, 'POST', '/run', { token: TOKEN });
      ok('segundo -> 409', r2.status === 409 && r2.json.error === 'hunt_already_running');
      ok('solo un spawn', children.length === 1);
      children[0].finish(0, JSON.stringify({ runId: r1.json.runId }), '');
    });
  }

  // ---------- lock activo (manual) -> 409 ----------
  section('Lock activo (hunt manual) -> 409');
  await withServer({ token: TOKEN, inspectLock: () => ({ busy: true, info: { pid: 9090, startedAt: 't' } }), spawnHunt: autoSpawn(), runsDir: tmpDir('t10c-l-') }, async (s) => {
    const r = await request(s, 'POST', '/run', { token: TOKEN });
    ok('lock activo -> 409', r.status === 409 && r.json.pid === 9090);
  });

  // ---------- secretos ----------
  section('Sin secretos en respuesta/logs');
  {
    process.env.OPENAI_API_KEY = 'sk-SECRET-KEY-123456';
    const runsDir = tmpDir('t10c-sec-');
    await withServer({ token: TOKEN, inspectLock: freeLock, spawnHunt: autoSpawn({ code: 0, stdout: '{}', stderr: 'log con sk-SECRET-KEY-123456' }), runsDir }, async (s) => {
      const r = await request(s, 'POST', '/run', { token: TOKEN });
      const done = await pollStatus(s, r.json.runId, TOKEN);
      ok('API key redactada en stderrTail', !done.raw.includes('sk-SECRET-KEY-123456'));
      const logged = fs.readFileSync(path.join(runsDir, r.json.runId + '.json'), 'utf8');
      ok('API key redactada en run log', !logged.includes('sk-SECRET-KEY-123456'));
      ok('token nunca en respuesta', !done.raw.includes(TOKEN));
    });
    delete process.env.OPENAI_API_KEY;
  }

  // ---------- body no cambia el comando ----------
  section('Body no puede cambiar el comando');
  {
    let calls = 0;
    const spawnHunt = () => { calls += 1; const c = fakeChild(); setImmediate(() => c.finish(0, JSON.stringify({ runId: 'x' }), '')); return c; };
    await withServer({ token: TOKEN, inspectLock: freeLock, spawnHunt, runsDir: tmpDir('t10c-arb-') }, async (s) => {
      const r = await request(s, 'POST', '/run', { token: TOKEN, body: { command: 'rm -rf /', args: ['x'], shell: true } });
      ok('body ignorado (spawn fijo)', r.status === 202 && calls === 1);
    });
  }

  // ---------- hunt lock (unidad) ----------
  section('Hunt lock (compartido)');
  {
    const lp = path.join(tmpDir('t10c-lock-'), 'hunt.lock');
    const h = acquireLock(lp);
    ok('acquire crea lock', fs.existsSync(lp) && JSON.parse(fs.readFileSync(lp, 'utf8')).pid === process.pid);
    ok('inspect busy', inspectLock(lp).busy === true);
    let held = false; try { acquireLock(lp); } catch (e) { held = e.code === 'LOCK_HELD'; }
    ok('segundo acquire -> LOCK_HELD', held);
    ok('release', releaseLock(lp) === true && !fs.existsSync(lp));
    fs.writeFileSync(lp, JSON.stringify({ pid: 999999998, startedAt: 't', hostname: 'x' }));
    ok('pid muerto -> stale', isPidAlive(999999998) === false && inspectLock(lp).stale === true);
    acquireLock(lp); releaseLock(lp);
    fs.writeFileSync(lp, 'corrupto'); ok('lock corrupto -> busy', inspectLock(lp).busy === true); fs.unlinkSync(lp);
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((e) => { console.error(e); process.exit(1); });

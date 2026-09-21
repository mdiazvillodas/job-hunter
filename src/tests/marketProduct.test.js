'use strict';

// MD8 — producto "Explorar mercado": endpoints HTTP y pantalla.
//
// Cubre lo que el usuario puede hacer: arrancar, ver progreso, cancelar, leer
// el resultado (completo, parcial, fallo, interrupcion), revisar la propuesta
// frente a sus busquedas actuales y aplicarla EXPLICITAMENTE con reemplazo.
//
// Determinista: sin LinkedIn, sin Chromium, sin OpenAI, sin red externa
// (solo loopback HTTP) y sin tocar la configuracion real del usuario.

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { startServer } = require('../ui/server');

let passed = 0;
const roots = [];
function test(name, fn) { fn(); passed += 1; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed += 1; console.log('[PASS] ' + name); }
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md8ui-')); roots.push(dir); return dir; }

function request(server, method, pathname) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({ hostname: '127.0.0.1', port: address.port, method, path: pathname }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(text || '{}') }); } catch (e) { resolve({ status: res.statusCode, json: {} }); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// Doble del gestor de Market Discovery con el contrato que usa el servidor.
function fakeManager(overrides = {}) {
  const calls = { start: 0, cancel: 0, apply: 0, preview: 0 };
  return {
    calls,
    start: async () => { calls.start += 1; return overrides.startStatus || { runId: 'r1', status: 'STARTING', phase: 'PREPARING' }; },
    cancel: () => { calls.cancel += 1; return { runId: 'r1', status: 'CANCELLING' }; },
    getStatus: () => overrides.status || { runId: 'r1', status: 'IDLE', phase: 'IDLE', progress: {} },
    getRun: (runId) => (overrides.run === undefined ? { runId } : overrides.run),
    getProposal: (runId) => (overrides.proposal === undefined ? null : overrides.proposal),
    previewApply: (runId) => { calls.preview += 1; if (overrides.previewThrows) throw overrides.previewThrows; return overrides.preview || { runId, change: { mode: 'REPLACE' } }; },
    applyProposal: (runId) => { calls.apply += 1; if (overrides.applyThrows) throw overrides.applyThrows; return overrides.applyResult || { runId, applied: true, changed: true }; },
    stopAccepting: () => {},
    waitForIdle: async () => {},
  };
}

async function withServer(marketDiscovery, fn) {
  const server = startServer({
    port: 0,
    jobService: { getAllJobs: () => [] },
    setupService: { getStatus: () => ({ readyForHunt: true }) },
    linkedinSessionService: {},
    huntRunManager: { getStatus: () => ({ status: 'IDLE' }) },
    scheduler: { getStatus: () => ({ enabled: false }), update: () => ({ enabled: false }), stop: () => {} },
    telegramService: { getStatus: () => ({ enabled: false }), stop: () => {} },
    runtimeService: { getStatus: () => ({}) },
    browserInstallManager: { getStatus: () => ({}) },
    marketDiscoveryRunManager: marketDiscovery,
  });
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(server); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const html = fs.readFileSync(path.join(__dirname, '../ui/public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../ui/public/app.js'), 'utf8');

(async () => {
  console.log('\n### Pantalla en español');

  test('1. existe la sección "Explorar mercado" y su panel', () => {
    assert.ok(html.includes('data-section="market"'), 'nav + panel');
    assert.ok(html.includes('>Explorar mercado<'), 'nombre en español');
    assert.ok(html.includes('id="marketStartBtn"'));
    assert.ok(html.includes('id="marketCancelBtn"'));
    assert.ok(html.includes('id="marketApplyBtn"'));
  });

  test('2. explica en lenguaje llano qué hace y que no cambia nada solo', () => {
    assert.ok(/Revisa cómo nombra el mercado local/.test(html));
    assert.ok(/No cambia nada por su cuenta/.test(html));
  });

  test('3. distingue CLARAMENTE búsquedas actuales de propuestas', () => {
    assert.ok(html.includes('Búsquedas actuales'));
    assert.ok(html.includes('Búsquedas propuestas'));
    assert.ok(html.includes('id="marketCurrentQueries"'));
    assert.ok(html.includes('id="marketProposedQueries"'));
    assert.ok(/REEMPLAZA tus búsquedas actuales/.test(appJs), 'el reemplazo se comunica');
  });

  test('4. muestra progreso en lenguaje de producto, no interno', () => {
    for (const phrase of ['Buscando puestos', 'Analizando compatibilidad', 'Preparando recomendaciones']) {
      assert.ok(appJs.includes(phrase), 'falta la fase legible: ' + phrase);
    }
  });

  test('5. la pantalla NO expone jerga interna', () => {
    // Se inspecciona solo el texto que el usuario ve.
    const visible = html.replace(/<!--[\s\S]*?-->/g, '');
    for (const jargon of ['MD4', 'MD5', 'MD6', 'semantic contract', 'evaluation reserve', 'depth-1']) {
      assert.ok(!visible.includes('>' + jargon) && !visible.includes(jargon + '<'), 'jerga visible: ' + jargon);
    }
  });

  test('6. cada estado final tiene un mensaje entendible', () => {
    for (const reason of ['LOGIN_REQUIRED', 'CHECKPOINT_REQUIRED', 'SCOPE_NOT_VERIFIED', 'SOURCE_FAILED', 'SEMANTIC_FAILED', 'DETAIL_FAILED', 'CANCELLED', 'BUDGET_EXHAUSTED']) {
      assert.ok(appJs.includes(reason + ':'), 'sin mensaje para ' + reason);
    }
    assert.ok(/iniciar sesión/.test(appJs), 'login se explica');
    assert.ok(/verificación de seguridad/.test(appJs), 'checkpoint se explica');
  });

  console.log('\n### Endpoints');

  await testAsync('7. arrancar, consultar y cancelar', async () => {
    const manager = fakeManager({ status: { runId: 'r1', status: 'RUNNING', phase: 'INITIAL_SEARCH', progress: { compatible: 0 } } });
    await withServer(manager, async (server) => {
      const started = await request(server, 'POST', '/api/market-discovery/start');
      assert.equal(started.status, 202);
      const status = await request(server, 'GET', '/api/market-discovery/status');
      assert.equal(status.status, 200);
      assert.equal(status.json.phase, 'INITIAL_SEARCH');
      const cancelled = await request(server, 'POST', '/api/market-discovery/cancel');
      assert.equal(cancelled.status, 202);
      assert.equal(manager.calls.start, 1);
      assert.equal(manager.calls.cancel, 1);
    });
  });

  await testAsync('8. la vista previa de aplicar NO aplica', async () => {
    const manager = fakeManager({ preview: { runId: 'r1', applicable: true, change: { mode: 'REPLACE', current: [], proposed: [], removed: [], added: [], kept: [] } } });
    await withServer(manager, async (server) => {
      const res = await request(server, 'GET', '/api/market-discovery/runs/r1/apply');
      assert.equal(res.status, 200);
      assert.equal(res.json.change.mode, 'REPLACE');
      assert.equal(manager.calls.preview, 1);
      assert.equal(manager.calls.apply, 0, 'la vista previa nunca aplica');
    });
  });

  await testAsync('9. aplicar exige POST explicito', async () => {
    const manager = fakeManager({ applyResult: { runId: 'r1', applied: true, changed: true } });
    await withServer(manager, async (server) => {
      const res = await request(server, 'POST', '/api/market-discovery/runs/r1/apply');
      assert.equal(res.status, 200);
      assert.equal(res.json.applied, true);
      assert.equal(manager.calls.apply, 1);
    });
  });

  await testAsync('10. una propuesta vacia no se puede aplicar y el error se explica', async () => {
    const error = new Error('La propuesta no contiene consultas defendibles: no se puede aplicar.');
    error.code = 'PROPOSAL_EMPTY'; error.statusCode = 409; error.expose = true;
    await withServer(fakeManager({ applyThrows: error }), async (server) => {
      const res = await request(server, 'POST', '/api/market-discovery/runs/r1/apply');
      assert.equal(res.status, 409);
      assert.ok(/no se puede aplicar/.test(res.json.error));
    });
  });

  await testAsync('11. una propuesta inexistente responde 404', async () => {
    await withServer(fakeManager({ proposal: null }), async (server) => {
      const res = await request(server, 'GET', '/api/market-discovery/runs/r1/proposal');
      assert.equal(res.status, 404);
      assert.equal(res.json.code, 'PROPOSAL_NOT_FOUND');
    });
  });

  await testAsync('12. un id de exploracion invalido se rechaza', async () => {
    await withServer(fakeManager(), async (server) => {
      const res = await request(server, 'GET', '/api/market-discovery/runs/..%2F..%2Fetc/apply');
      assert.equal(res.status, 400);
      assert.equal(res.json.code, 'INVALID_RUN_ID');
    });
  });

  console.log('\n### Estados de la exploración');

  await testAsync('13. exploracion completa, parcial, fallida e interrumpida se sirven igual', async () => {
    for (const outcome of [
      { status: 'COMPLETED', reason: 'COMPLETED', partial: false },
      { status: 'COMPLETED', reason: 'BUDGET_EXHAUSTED', partial: true },
      { status: 'FAILED', reason: 'SOURCE_FAILED', partial: true },
      { status: 'INTERRUPTED', reason: 'CHECKPOINT_REQUIRED', partial: true },
    ]) {
      await withServer(fakeManager({ status: { runId: 'r1', phase: 'DONE', progress: {}, ...outcome } }), async (server) => {
        const res = await request(server, 'GET', '/api/market-discovery/status');
        assert.equal(res.status, 200);
        assert.equal(res.json.reason, outcome.reason);
      });
    }
  });

  console.log('\n### Aislamiento');

  test('14. el producto no arranca hunt ni notifica al aplicar', () => {
    const marketUi = appJs.slice(appJs.indexOf('Explorar mercado (MD8)'));
    for (const forbidden of ['/api/hunt', 'ntfy', 'telegram']) {
      assert.ok(!marketUi.includes(forbidden), 'la pantalla de mercado no debe tocar: ' + forbidden);
    }
  });

  test('15. aplicar pide confirmacion explicita antes de escribir', () => {
    const marketUi = appJs.slice(appJs.indexOf('Explorar mercado (MD8)'));
    assert.ok(/window\.confirm/.test(marketUi), 'hay confirmacion explicita');
    const confirmIdx = marketUi.indexOf('window.confirm');
    const postIdx = marketUi.indexOf("api(base, 'POST')");
    assert.ok(confirmIdx > 0 && postIdx > confirmIdx, 'la confirmacion ocurre ANTES del POST');
  });

  test('16. el empaquetado incluye los modulos nuevos', () => {
    const packaging = fs.readFileSync(path.join(__dirname, '../../scripts/package-windows.js'), 'utf8');
    assert.ok(/src/.test(packaging), 'el empaquetado copia src');
    assert.ok(fs.existsSync(path.join(__dirname, '../marketDiscovery/proposalApply.js')));
  });

  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nMD8 Product: ${passed} tests passed`);
})().catch((error) => {
  for (const dir of roots) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* noop */ } }
  console.error('\n[FAIL]', error && error.stack ? error.stack : error);
  process.exit(1);
});

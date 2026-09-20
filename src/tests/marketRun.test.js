'use strict';

// MD7 — gestor de corridas, orquestacion, API y resultado persistido.
// Determinista: sin LinkedIn, sin Chromium, sin OpenAI, sin red externa.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createMarketDiscoveryRunManager, STATUSES, PHASES } = require('../run/marketDiscoveryRunManager');
const { createMarketDiscoveryRunStore } = require('../marketDiscovery/runStore');
const { createExplorationEngine } = require('../marketDiscovery/explorationEngine');
const { acquireLock, releaseLock } = require('../domain/huntLock');
const { OPERATION_TYPES, createOwner } = require('../domain/operationOwner');
const { deriveProfile } = require('../marketDiscovery/profileMap');
const { startServer } = require('../ui/server');
const runtime = require('../runtime');

const roots = [];
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed++; console.log('[PASS] ' + name); }
// Compuerta compartida: TODAS las busquedas esperan la misma senal, de modo que
// abrirla una vez libera la corrida entera.
function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { open, wait: () => opened };
}
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md7-')); roots.push(dir); return dir; }
const tick = () => new Promise((resolve) => setImmediate(resolve));

function request(server, method, urlPath, body) {
  const options = { host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: body ? { 'Content-Type': 'application/json' } : {} };
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (_) { json = null; } resolve({ status: res.statusCode, json, raw: data }); });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const PROFILE = deriveProfile({
  profile: {
    meta: { person: 'Example Person' },
    capabilities: [{ statement: 'Coordinate retail construction works', evidence: ['Delivered fit-out programmes'] }],
    targetResponsibilities: [{ statement: 'Retail store delivery', evidence: ['Ran store openings'], language: 'en' }],
    seniority: { assessedLevel: 'Senior', evidence: ['Led teams'] },
  },
  matchingProfile: { roleTypesToAvoid: ['Exclusively commercial sales positions'] },
  config: { identity: { name: 'Example Person' }, search: { locations: ['Example region'] } },
});
const SEED_PLAN = {
  seeds: [
    { familyId: 'family-1111111111111111', expression: 'Gestor de obra', language: 'es', rank: 1 },
    { familyId: 'family-2222222222222222', expression: 'Site Manager', language: 'en', rank: 2 },
    { familyId: 'family-3333333333333333', expression: 'Delineante obra', language: 'es', rank: 3 },
  ],
  familiesConsidered: 3, familiesSelected: 3, truncated: false, omittedFamilies: [], priority: ['evidence category'],
};
const card = (id, company) => ({ jobId: String(id), url: `https://www.linkedin.com/jobs/view/${id}/`, title: `Title ${id}`, company, location: 'Somewhere', easyApply: false });

function fakeSource(script) {
  const calls = [];
  return {
    calls,
    search: async (request_) => {
      calls.push(request_);
      // El guion puede devolver una promesa: asi se simula una busqueda en curso.
      const entry = (await (typeof script === 'function' ? script(request_) : script[request_.search.query])) || { results: [] };
      return {
        status: entry.status || 'COMPLETED', stopReason: entry.stopReason || 'no_next_page',
        results: (entry.results || []).map((r, i) => ({ ...r, searchId: request_.search.searchId, familyId: request_.search.familyId, query: request_.search.query, position: i + 1 })),
        metrics: { rawCards: (entry.results || []).length, uniqueResults: (entry.results || []).length, duplicatesWithinSearch: 0, pagesVisited: 1, limitReached: false },
        challenge: entry.challenge || null, observedScope: { location: 'NOT_REQUESTED' },
      };
    },
  };
}
function fakeEvaluator(script) {
  const calls = [];
  return {
    calls,
    evaluatePosting: async (request_) => {
      calls.push(request_);
      const entry = (await (typeof script === 'function' ? script(request_) : script[request_.posting.postingId])) || { classification: 'UNCERTAIN' };
      if (entry.throws) { const e = new Error('semantic'); e.name = entry.throws; throw e; }
      const promotable = entry.classification === 'COMPATIBLE';
      return {
        classification: entry.classification, dimensions: {},
        terminology: (entry.terms || []).map((t) => ({ type: 'ROLE_TITLE', expression: t, normalized: t.toLowerCase(), sourceField: 'title', offset: 0, length: t.length, postingId: request_.posting.postingId, eligibility: promotable ? 'ELIGIBLE' : 'REVIEW_ONLY', promotable })),
        identity: { cacheKey: 'k_' + request_.posting.postingId },
      };
    },
  };
}

// Banco de pruebas: gestor real con dependencias falsas y lock/persistencia reales.
function bench(overrides = {}) {
  const dataDir = overrides.dataDir || temp();
  const lockPath = path.join(dataDir, 'hunt.lock');
  const events = [];
  const page = { marker: 'md-page' };
  const context = { closed: 0, close: async () => { context.closed += 1; events.push('browser:close'); } };
  const source = overrides.source || fakeSource({});
  const evaluator = overrides.evaluator || fakeEvaluator({});
  let sessions = 0;
  const manager = createMarketDiscoveryRunManager({
    setupService: overrides.setupService || { getStatus: () => ({ readyForHunt: true }) },
    profileLoader: overrides.profileLoader || (() => PROFILE),
    seedPlanner: overrides.seedPlanner || (() => SEED_PLAN),
    // Alcance fijado en el test: nunca depende de la configuracion real de la maquina.
    resolveFilters: overrides.resolveFilters || (() => ({ location: 'Example region' })),
    // Sin detalle real: estas pruebas son del ciclo de vida del gestor. MD7.1
    // tiene su propia suite.
    enricher: overrides.enricher || { enrich: async () => ({ outcome: 'DETAIL_UNAVAILABLE', description: null, descriptionAvailable: false }) },
    runStore: createMarketDiscoveryRunStore({ dataDir }),
    clock: () => new Date(0),
    makeRunId: overrides.makeRunId || (() => 'mdrun_test1'),
    makeOperationId: () => 'md_op1',
    acquireLock: (owner) => { events.push('lock:acquire'); return acquireLock(lockPath, { owner }); },
    releaseLock: (owner) => { events.push('lock:release'); return releaseLock(lockPath, { owner }); },
    openSession: overrides.openSession || (async () => { sessions += 1; events.push('browser:open'); return { context, page }; }),
    source, evaluator,
    ...(overrides.manager || {}),
  });
  return { manager, dataDir, lockPath, events, page, context, source, evaluator, sessionCount: () => sessions };
}
const lockExists = (b) => fs.existsSync(b.lockPath);

(async () => {
  try {
    // ------------------------------------------------- A. ciclo de vida
    await testAsync('1+2+3. starts from IDLE, returns before the run finishes, and refuses a second run', async () => {
      const held = gate();
      const source = fakeSource(async () => { await held.wait(); return { results: [] }; });
      const b = bench({ source });
      assert.equal(b.manager.getStatus().status, STATUSES.IDLE);
      const accepted = await b.manager.start();
      assert.equal(accepted.status, STATUSES.STARTING);
      assert.equal(accepted.runId, 'mdrun_test1');
      await tick();
      // La corrida sigue viva: start() no espero a que terminara.
      assert(['STARTING', 'RUNNING'].includes(b.manager.getStatus().status));
      let code;
      try { await b.manager.start(); } catch (error) { code = error.code; }
      assert.equal(code, 'MARKET_DISCOVERY_ALREADY_RUNNING');
      held.open();
      await b.manager.waitForIdle();
      assert.equal(b.manager.getStatus().status, STATUSES.COMPLETED);
    });

    // ------------------------------------------------- B. propiedad y sesion
    await testAsync('4+5+6+7+8. ownership precedes the browser, and one session serves every search', async () => {
      const source = fakeSource({ 'Gestor de obra': { results: [card(1, 'A SA')] }, 'Site Manager': { results: [card(2, 'B SA')] }, 'Delineante obra': { results: [card(3, 'C SA')] } });
      const b = bench({ source, evaluator: fakeEvaluator(() => ({ classification: 'UNCERTAIN' })) });
      await b.manager.start();
      await b.manager.waitForIdle();
      assert.equal(b.events[0], 'lock:acquire', 'la propiedad se toma antes de abrir el navegador');
      assert.equal(b.events[1], 'browser:open');
      assert.equal(b.sessionCount(), 1, 'un solo navegador para toda la corrida');
      assert.equal(b.source.calls.length, 3, 'tres busquedas');
      for (const call of b.source.calls) {
        assert.equal(call.page, b.page, 'la MISMA pagina en cada busqueda');
        assert.equal(call.owner.operationType, OPERATION_TYPES.MARKET_DISCOVERY);
        assert.equal(call.owner.operationId, 'md_op1');
      }
      assert.equal(new Set(b.source.calls.map((c) => c.owner.operationId)).size, 1, 'una unica identidad de operacion');
    });
    await testAsync('9+10+18+19+20. completion releases ownership; a foreign lock is never touched', async () => {
      const b = bench();
      await b.manager.start();
      await b.manager.waitForIdle();
      assert.equal(b.manager.getStatus().status, STATUSES.COMPLETED);
      assert.equal(lockExists(b), false, 'propiedad liberada al completar');
      assert.equal(b.events[b.events.length - 1], 'lock:release');
      assert(b.events.indexOf('browser:close') < b.events.lastIndexOf('lock:release'), 'primero se cierra, despues se libera');
      // Un HUNT vivo bloquea Market Discovery y sobrevive intacto.
      const busy = bench();
      acquireLock(busy.lockPath, { owner: createOwner(OPERATION_TYPES.HUNT, 'run_hunt_1') });
      await busy.manager.start();
      await busy.manager.waitForIdle();
      assert.equal(busy.manager.getStatus().status, STATUSES.FAILED);
      assert.equal(busy.manager.getStatus().reason, 'RESOURCE_BUSY');
      assert.equal(busy.sessionCount(), 0, 'nunca se abrio el navegador');
      assert.equal(JSON.parse(fs.readFileSync(busy.lockPath, 'utf8')).operationId, 'run_hunt_1', 'la propiedad ajena intacta');
      releaseLock(busy.lockPath, { owner: createOwner(OPERATION_TYPES.HUNT, 'run_hunt_1') });
    });
    await testAsync('11-17. ownership is released on every terminal outcome', async () => {
      const cases = [
        ['login', { 'Gestor de obra': { status: 'INTERRUPTED', stopReason: 'login_required', results: [], challenge: { code: 'LOGIN_REQUIRED' } } }, STATUSES.INTERRUPTED, 'LOGIN_REQUIRED'],
        ['checkpoint', { 'Gestor de obra': { status: 'INTERRUPTED', stopReason: 'checkpoint_required', results: [], challenge: { code: 'CHECKPOINT_REQUIRED' } } }, STATUSES.INTERRUPTED, 'CHECKPOINT_REQUIRED'],
        ['source', { 'Gestor de obra': { status: 'FAILED', results: [] }, 'Site Manager': { status: 'FAILED', results: [] }, 'Delineante obra': { results: [] } }, STATUSES.FAILED, 'SOURCE_FAILED'],
      ];
      for (const [label, script, status, reason] of cases) {
        const b = bench({ source: fakeSource(script) });
        await b.manager.start();
        await b.manager.waitForIdle();
        assert.equal(b.manager.getStatus().status, status, label);
        assert.equal(b.manager.getStatus().reason, reason, label);
        assert.equal(lockExists(b), false, `propiedad liberada tras ${label}`);
        assert.equal(b.context.closed, 1, `navegador cerrado tras ${label}`);
      }
      // Fallo semantico repetido.
      const semantic = bench({
        source: fakeSource({
          'Gestor de obra': { results: [card(10, 'A SA'), card(11, 'B SA')] },
          'Site Manager': { results: [card(12, 'C SA')] },
          'Delineante obra': { results: [card(13, 'D SA')] },
        }),
        evaluator: fakeEvaluator(() => ({ throws: 'SemanticContractError' })),
      });
      await semantic.manager.start();
      await semantic.manager.waitForIdle();
      assert.equal(semantic.manager.getStatus().reason, 'SEMANTIC_FAILED');
      assert.equal(lockExists(semantic), false);
      // Fallo inesperado del motor.
      const boom = bench({ manager: { explorationEngine: { explore: async () => { throw new Error('unexpected'); } } } });
      await boom.manager.start();
      await boom.manager.waitForIdle();
      assert.equal(boom.manager.getStatus().status, STATUSES.FAILED);
      assert.equal(boom.manager.getStatus().reason, 'INTERNAL_ERROR');
      assert.equal(lockExists(boom), false, 'propiedad liberada incluso ante excepcion');
      assert.equal(boom.context.closed, 1);
      // Fallo al abrir la sesion: login/checkpoint conservan su taxonomia.
      for (const [name, reason, status] of [['AuthenticationError', 'LOGIN_REQUIRED', STATUSES.INTERRUPTED], ['SecurityChallengeError', 'CHECKPOINT_REQUIRED', STATUSES.INTERRUPTED], ['Error', 'SOURCE_FAILED', STATUSES.FAILED]]) {
        const s = bench({ openSession: async () => { const e = new Error('x'); e.name = name; throw e; } });
        await s.manager.start();
        await s.manager.waitForIdle();
        assert.equal(s.manager.getStatus().reason, reason);
        assert.equal(s.manager.getStatus().status, status);
        assert.equal(lockExists(s), false);
      }
    });

    // ------------------------------------------------- C. perfil
    await testAsync('21+22+23+24. profile problems fail before LinkedIn; inputs are persisted', async () => {
      const notReady = bench({ setupService: { getStatus: () => ({ readyForHunt: false }) } });
      await assert.rejects(() => notReady.manager.start(), (e) => e.code === 'SETUP_REQUIRED');
      assert.equal(notReady.sessionCount(), 0, 'sin navegador');
      assert.equal(lockExists(notReady), false, 'sin propiedad');
      const noProfile = bench({ profileLoader: () => { throw new Error('missing profile'); } });
      await assert.rejects(() => noProfile.manager.start(), (e) => e.code === 'PROFILE_REQUIRED');
      assert.equal(noProfile.sessionCount(), 0);
      // Entradas persistidas de forma auditable.
      const b = bench();
      await b.manager.start();
      await b.manager.waitForIdle();
      const runDir = path.join(b.dataDir, 'market-discovery', 'runs', 'mdrun_test1');
      assert.deepEqual(fs.readdirSync(runDir).sort(), ['exploration.json', 'manifest.json', 'profile-map.json', 'result.json', 'seed-plan.json']);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'seed-plan.json'), 'utf8')).seedPlan.seeds.length, 3);
      assert(JSON.parse(fs.readFileSync(path.join(runDir, 'profile-map.json'), 'utf8')).profile.demonstratedCapabilities);
    });

    // ------------------------------------------------- D+E. orquestacion y progreso
    await testAsync('25-33. MD5/MD6 are composed, progress is real and the proposal stays inert', async () => {
      const source = fakeSource({
        'Gestor de obra': { results: [card(100, 'A SA'), card(101, 'B SA'), card(102, 'C SA')] },
        'Site Manager': { results: [card(200, 'D SA')] },
        'Delineante obra': { results: [card(300, 'E SA')] },
        'Obra term': { results: [card(400, 'F SA')] },
      });
      const evaluator = fakeEvaluator((r) => (Number(r.posting.postingId) < 200
        ? { classification: 'COMPATIBLE', terms: ['Obra term'] }
        : { classification: 'UNCERTAIN' }));
      const b = bench({ source, evaluator });
      await b.manager.start();
      await b.manager.waitForIdle();
      const status = b.manager.getStatus();
      assert.equal(status.status, STATUSES.COMPLETED);
      assert.equal(status.phase, PHASES.DONE);
      assert(Object.isFrozen(status), 'el estado expuesto es inmutable');
      // Contadores reales, sin porcentajes inventados.
      assert.equal(status.progress.searchesCompleted, b.source.calls.length);
      assert.equal(status.progress.evaluationsCompleted, b.evaluator.calls.length);
      assert.equal(status.progress.compatible, 3);
      // 200 y 300 iniciales, mas 400 hallada por la expansion de "Obra term".
      assert.equal(status.progress.uncertain, 3);
      assert.equal(status.progress.uniquePostings, 6);
      assert.equal(status.progress.expansionSearches, 1);
      assert.equal(status.progress.searchesMax, 10);
      assert.equal(status.progress.evaluationsMax, 60);
      assert(!JSON.stringify(status).includes('percent'));
      // MD6 corrio y la propuesta es inerte.
      assert.equal(status.proposalAvailable, true);
      const proposal = b.manager.getProposal('mdrun_test1');
      assert.equal(proposal.applied, false);
      assert(proposal.proposalId && proposal.selectedQueries.length >= 1);
      assert.equal(status.progress.selectedQueries, proposal.selectedQueries.length);
      // La exploracion persistida viene de MD5, no de una reimplementacion.
      const exploration = JSON.parse(fs.readFileSync(path.join(b.dataDir, 'market-discovery/runs/mdrun_test1/exploration.json'), 'utf8')).exploration;
      assert.equal(exploration.operationType, 'MARKET_DISCOVERY');
      assert(Array.isArray(exploration.searches) && Array.isArray(exploration.observations));
    });
    await testAsync('27+28+48. no proposal is fabricated without compatible evidence', async () => {
      const b = bench({ source: fakeSource(() => ({ results: [card(500, 'A SA')] })), evaluator: fakeEvaluator(() => ({ classification: 'OUT_OF_SCOPE' })) });
      await b.manager.start();
      await b.manager.waitForIdle();
      assert.equal(b.manager.getStatus().proposalAvailable, false);
      assert.equal(fs.existsSync(path.join(b.dataDir, 'market-discovery/runs/mdrun_test1/proposal.json')), false, 'no se escribe propuesta vacia');
      assert.equal(b.manager.getProposal('mdrun_test1'), null);
      // Exploracion parcial CON evidencia: la propuesta existe y queda marcada parcial.
      // La interrupcion llega en la expansion, cuando YA hay evidencia evaluada.
      const partial = bench({
        source: fakeSource({
          'Gestor de obra': { results: [card(600, 'A SA'), card(601, 'B SA'), card(602, 'C SA')] },
          'Site Manager': { results: [card(610, 'D SA')] },
          'Delineante obra': { results: [card(620, 'E SA')] },
          'Obra term': { status: 'INTERRUPTED', stopReason: 'checkpoint_required', results: [], challenge: { code: 'CHECKPOINT_REQUIRED' } },
        }),
        evaluator: fakeEvaluator(() => ({ classification: 'COMPATIBLE', terms: ['Obra term'] })),
      });
      await partial.manager.start();
      await partial.manager.waitForIdle();
      assert.equal(partial.manager.getStatus().status, STATUSES.INTERRUPTED);
      assert.equal(partial.manager.getStatus().partial, true);
      assert.equal(partial.manager.getStatus().proposalAvailable, true);
      const partialProposal = partial.manager.getProposal('mdrun_test1');
      assert.equal(partialProposal.sourceExploration.partial, true, 'la propuesta hereda el caracter parcial');
      assert(partialProposal.warnings.some((w) => /partial/.test(w)));
      assert.equal(partialProposal.applied, false);
    });

    // ------------------------------------------------- F. cancelacion
    await testAsync('34-40. cancellation is idempotent, immediate and preserves partial evidence', async () => {
      // Cancelar antes de la primera busqueda.
      const early = bench({ openSession: async () => { early.manager.cancel(); return { context: early.context, page: early.page }; } });
      await early.manager.start();
      await early.manager.waitForIdle();
      assert.equal(early.manager.getStatus().status, STATUSES.CANCELLED);
      assert.equal(early.source.calls.length, 0, 'ninguna busqueda tras cancelar');
      assert.equal(lockExists(early), false);
      // Cancelar durante una busqueda.
      let duringSearch;
      const source = fakeSource(() => { duringSearch.manager.cancel(); return { results: [card(700, 'A SA')] }; });
      duringSearch = bench({ source });
      await duringSearch.manager.start();
      await duringSearch.manager.waitForIdle();
      assert.equal(duringSearch.manager.getStatus().status, STATUSES.CANCELLED);
      assert.equal(duringSearch.source.calls.length, 1, 'no se lanzan mas busquedas');
      assert.equal(duringSearch.evaluator.calls.length, 0, 'ni evaluaciones');
      assert.equal(duringSearch.context.closed, 1);
      assert.equal(lockExists(duringSearch), false);
      // Cancelar durante una evaluacion: la evidencia previa se conserva.
      let duringEval;
      const evaluator = fakeEvaluator(() => { duringEval.manager.cancel(); return { classification: 'COMPATIBLE', terms: ['Obra term'] }; });
      duringEval = bench({ source: fakeSource(() => ({ results: [card(800, 'A SA'), card(801, 'B SA')] })), evaluator });
      await duringEval.manager.start();
      await duringEval.manager.waitForIdle();
      assert.equal(duringEval.manager.getStatus().status, STATUSES.CANCELLED);
      assert.equal(duringEval.evaluator.calls.length, 1, 'no se evalua despues de cancelar');
      const exploration = JSON.parse(fs.readFileSync(path.join(duringEval.dataDir, 'market-discovery/runs/mdrun_test1/exploration.json'), 'utf8')).exploration;
      assert(exploration.postings.length > 0, 'la evidencia parcial se conserva');
      // Idempotente y seguro en IDLE.
      const idle = bench();
      assert.equal(idle.manager.cancel().status, STATUSES.IDLE);
      assert.equal(idle.manager.cancel().status, STATUSES.IDLE);
      assert.deepEqual(duringEval.manager.cancel(), duringEval.manager.cancel());
    });

    // ------------------------------------------------- G. persistencia
    await testAsync('41-52. artifacts stay under market-discovery, are safe and readable afterwards', async () => {
      const b = bench({ source: fakeSource(() => ({ results: [card(900, 'A SA')] })), evaluator: fakeEvaluator(() => ({ classification: 'COMPATIBLE', terms: ['Obra term'] })) });
      await b.manager.start();
      await b.manager.waitForIdle();
      assert.deepEqual(fs.readdirSync(b.dataDir), ['hunt.lock.removed'].filter(() => false).concat(['market-discovery']), 'solo el namespace de Market Discovery');
      for (const dir of ['jobs', 'runs', 'feedback', 'config', 'profile']) {
        assert.equal(fs.existsSync(path.join(b.dataDir, dir)), false, `no se escribe ${dir}`);
      }
      const store = createMarketDiscoveryRunStore({ dataDir: b.dataDir });
      // Lectura despues de perder el estado en memoria.
      const fresh = createMarketDiscoveryRunStore({ dataDir: b.dataDir }).readRun('mdrun_test1');
      assert.equal(fresh.runId, 'mdrun_test1');
      assert.equal(fresh.manifest.status, STATUSES.COMPLETED);
      assert.equal(fresh.result.result.status, STATUSES.COMPLETED);
      assert.equal(fresh.proposalAvailable, true);
      assert.deepEqual(fresh.artifacts.sort(), ['exploration', 'manifest', 'profileMap', 'proposal', 'result', 'seedPlan']);
      // Recorrido de rutas y nombres de artefacto rechazados.
      for (const bad of ['../escape', 'a/b', '..', '', 'x'.repeat(80), './x']) {
        assert.throws(() => store.readRun(bad), /invalid run id/);
      }
      assert.throws(() => store.readArtifact('mdrun_test1', 'cookies'), /unknown artifact/);
      // Identidad create-only.
      assert.throws(() => store.createRun('mdrun_test1', { runId: 'mdrun_test1' }));
      // Ni secretos, ni cookies, ni HTML, ni datos de navegador.
      const everything = fs.readdirSync(path.join(b.dataDir, 'market-discovery/runs/mdrun_test1')).map((f) => fs.readFileSync(path.join(b.dataDir, 'market-discovery/runs/mdrun_test1', f), 'utf8')).join('\n');
      for (const token of ['li_at', 'cookie', 'Cookie', 'sk-', 'Bearer', 'apiKey', 'OPENAI', 'browser-profile', '<html', '<div', 'botToken']) {
        assert(!everything.includes(token), `no debe persistirse ${token}`);
      }
    });
    test('51. a linked market-discovery directory is rejected', () => {
      const dataDir = temp();
      const other = temp();
      fs.mkdirSync(path.join(dataDir, 'market-discovery'));
      fs.symlinkSync(other, path.join(dataDir, 'market-discovery', 'runs'), 'junction');
      const store = createMarketDiscoveryRunStore({ dataDir });
      assert.throws(() => store.createRun('mdrun_x', { runId: 'mdrun_x' }), /linked market discovery directory/);
      assert.deepEqual(fs.readdirSync(other), []);
    });

    // ------------------------------------------------- H. API
    await testAsync('53-61. the API accepts, reports, cancels and reads back safely', async () => {
      // La corrida se mantiene viva para poder ejercer el rechazo por ocupado.
      const held = gate();
      const b = bench({
        source: fakeSource(async () => { await held.wait(); return { results: [card(1000, 'A SA')] }; }),
        evaluator: fakeEvaluator(() => ({ classification: 'COMPATIBLE', terms: ['Obra term'] })),
      });
      // Stub de Hunt con la forma que exige el scheduler existente; MD7 no lo usa.
      const huntStub = { start: async () => ({}), waitForRun: async () => ({}), getStatus: () => ({}), cancel: () => ({}), stopAccepting() {}, waitForIdle: async () => {} };
      const server = startServer({ port: 0, jobService: {}, setupService: {}, linkedinSessionService: {}, huntRunManager: huntStub, marketDiscoveryRunManager: b.manager });
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      try {
        const started = await request(server, 'POST', '/api/market-discovery/start');
        assert.equal(started.status, 202);
        assert.equal(started.json.runId, 'mdrun_test1');
        assert.equal(started.json.status, STATUSES.STARTING, 'responde sin esperar la exploracion');
        const busy = await request(server, 'POST', '/api/market-discovery/start');
        assert.equal(busy.status, 409);
        assert.equal(busy.json.code, 'MARKET_DISCOVERY_ALREADY_RUNNING');
        held.open();
        await b.manager.waitForIdle();
        const status = await request(server, 'GET', '/api/market-discovery/status');
        assert.equal(status.status, 200);
        assert.equal(status.json.status, STATUSES.COMPLETED);
        const cancelled = await request(server, 'POST', '/api/market-discovery/cancel');
        assert.equal(cancelled.status, 202);
        const run = await request(server, 'GET', '/api/market-discovery/runs/mdrun_test1');
        assert.equal(run.status, 200);
        assert.equal(run.json.manifest.status, STATUSES.COMPLETED);
        const proposal = await request(server, 'GET', '/api/market-discovery/runs/mdrun_test1/proposal');
        assert.equal(proposal.status, 200);
        assert.equal(proposal.json.applied, false);
        const invalid = await request(server, 'GET', '/api/market-discovery/runs/..%2Fescape');
        assert.equal(invalid.status, 400);
        assert.equal(invalid.json.code, 'INVALID_RUN_ID');
        const missing = await request(server, 'GET', '/api/market-discovery/runs/mdrun_absent');
        assert.equal(missing.status, 404);
        assert.equal(missing.json.code, 'RUN_NOT_FOUND');
        const noProposal = await request(server, 'GET', '/api/market-discovery/runs/mdrun_absent/proposal');
        assert.equal(noProposal.status, 404);
        // Ninguna respuesta filtra stack, secretos ni errores crudos.
        for (const response of [started, busy, status, run, proposal, invalid, missing, noProposal]) {
          const text = response.raw;
          for (const token of ['stack', 'at Object', 'sk-', 'Bearer', 'li_at', 'C:\\\\dev']) assert(!text.includes(token));
        }
      } finally { await new Promise((resolve) => server.close(resolve)); }
    });

    // ------------------------------------------------- I. shutdown
    await testAsync('62-65. shutdown cancels Market Discovery and releases only its own resources', async () => {
      const { installShutdownHandlers } = require('../ui/server');
      const held = gate();
      const b = bench({ source: fakeSource(async () => { await held.wait(); return { results: [] }; }) });
      // Una operacion ajena en otro lock no debe verse afectada.
      const foreign = temp();
      const foreignLock = path.join(foreign, 'hunt.lock');
      acquireLock(foreignLock, { owner: createOwner(OPERATION_TYPES.HUNT, 'run_other') });
      await b.manager.start();
      await tick();
      const server = { listening: false, close: (cb) => cb() };
      const shutdown = installShutdownHandlers(server, { marketDiscoveryRunManager: b.manager, shutdownTimeoutMs: 5000 });
      const pending = shutdown();
      await tick();
      assert.equal(b.manager.getStatus().status, STATUSES.CANCELLING);
      held.open();
      await pending;
      assert.equal(b.manager.getStatus().status, STATUSES.CANCELLED);
      assert.equal(b.context.closed, 1, 'cierra su navegador');
      assert.equal(lockExists(b), false, 'libera su propiedad');
      assert.equal(fs.existsSync(foreignLock), true, 'no toca la propiedad ajena');
      assert.equal(JSON.parse(fs.readFileSync(foreignLock, 'utf8')).operationId, 'run_other');
      await assert.rejects(() => b.manager.start(), (e) => e.code === 'APP_SHUTTING_DOWN');
      releaseLock(foreignLock, { owner: createOwner(OPERATION_TYPES.HUNT, 'run_other') });
    });

    // ------------------------------------------------- J. aislamiento
    test('66-74. MD7 never reaches Hunter state and adds no second process', () => {
      const files = ['src/run/marketDiscoveryRunManager.js', 'src/marketDiscovery/runStore.js'];
      // Se analiza el CODIGO, no los comentarios (que nombran lo que NO se usa).
      const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const source = files.map((f) => stripComments(fs.readFileSync(path.join(runtime.PROJECT_ROOT, f), 'utf8'))).join('\n');
      for (const token of [
        'huntRunManager', 'runPipeline', 'jobAnalyzer', 'analyzeJob', 'jobRepository', 'jobService',
        'learnedPreferences', 'runOutcome', 'notifications/ntfy', 'telegram', 'searchSettings', 'saveUserConfigFile',
        'applySearchSettings', 'scheduleStore', 'child_process', 'http.createServer', 'spawn',
      ]) {
        assert(!source.includes(token), `MD7 no debe referenciar ${token}`);
      }
      for (const loaded of Object.keys(require.cache)) {
        assert(!loaded.includes('jobAnalyzer'), 'el Analyzer normal no se carga');
      }
      // El servidor sigue sin tocar el lock directamente (invariante de fase 4).
      const server = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/ui/server.js'), 'utf8');
      assert(!server.includes("require('../domain/huntLock')") && !server.includes('releaseLock('));
      // El gestor usa el contrato de propiedad de MD3a, no PIDs sueltos.
      const manager = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/run/marketDiscoveryRunManager.js'), 'utf8');
      assert(manager.includes('OPERATION_TYPES.MARKET_DISCOVERY') && manager.includes('createOwner'));
      assert(!/releaseLock\(\s*\)/.test(manager), 'nunca libera sin dueño');
      // El arranque real entrega EL MISMO gestor al server y al apagado ordenado.
      const bootstrap = server.slice(server.indexOf('if (require.main === module)'));
      assert(/startServer\({[^}]*marketDiscoveryRunManager/.test(bootstrap), 'el server recibe el gestor');
      assert(/installShutdownHandlers\(server, {[^}]*marketDiscoveryRunManager/.test(bootstrap), 'el apagado recibe el gestor');
    });

    // ------------------------------------------------- K. integracion MD1 -> MD7
    await testAsync('END-TO-END: MD1 through MD7 compose into a persisted, inert proposal', async () => {
      const dataDir = temp();
      const configDir = temp();
      const configFile = path.join(configDir, 'user.json');
      fs.writeFileSync(configFile, JSON.stringify({ search: { queryGroups: [{ family: 'user', queries: [{ query: 'original query', enabled: true }] }] } }, null, 2));
      const before = fs.readFileSync(configFile);
      const source = fakeSource({
        'Gestor de obra': { results: [card(11, 'Alfa SA'), card(12, 'Beta SA'), card(13, 'Gamma SA')] },
        'Site Manager': { results: [card(21, 'Delta SA'), card(13, 'Gamma SA')] },
        'Delineante obra': { results: [card(31, 'Epsilon SA')] },
        'Obra retail': { results: [card(41, 'Zeta SA')] },
      });
      const evaluator = fakeEvaluator((r) => {
        const id = Number(r.posting.postingId);
        if (id === 21) return { classification: 'OUT_OF_SCOPE' };
        if (id === 31) return { classification: 'UNCERTAIN' };
        return { classification: 'COMPATIBLE', terms: ['Obra retail'] };
      });
      const b = bench({ dataDir, source, evaluator });
      const accepted = await b.manager.start();
      assert.equal(accepted.status, STATUSES.STARTING);
      await b.manager.waitForIdle();
      const status = b.manager.getStatus();
      assert.equal(status.status, STATUSES.COMPLETED);
      assert.equal(status.partial, false);
      assert.equal(status.progress.compatible, 4);
      assert.equal(status.progress.outOfScope, 1);
      assert.equal(status.progress.uncertain, 1);
      // La oferta duplicada (13) se evaluo una sola vez.
      assert.equal(b.evaluator.calls.filter((c) => c.posting.postingId === '13').length, 1);
      // Expansion ejecutada a partir de evidencia compatible.
      assert(b.source.calls.some((c) => c.search.query === 'Obra retail' && c.search.searchId.startsWith('d1')));
      // Propuesta persistida e inerte.
      const proposal = b.manager.getProposal('mdrun_test1');
      assert.equal(proposal.applied, false);
      assert(proposal.selectedQueries.length >= 1);
      assert(proposal.selectedQueries.every((q) => q.whySelected));
      // Recursos cerrados y propiedad liberada.
      assert.equal(b.context.closed, 1);
      assert.equal(lockExists(b), false);
      // La configuracion de Hunter queda byte por byte igual.
      assert.deepEqual(fs.readFileSync(configFile), before, 'MD7 no toca las queries de Hunter');
      // Todo lo escrito vive bajo market-discovery.
      assert.deepEqual(fs.readdirSync(dataDir), ['market-discovery']);
    });

    console.log('Market Run (MD7): ' + passed + ' tests passed');
  } finally {
    for (const dir of roots.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

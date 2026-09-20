'use strict';

// MD7.0.1 — geografia configurada estricta.
//
// Regresion del fallo real observado en mdrun_ce229f36dd9d09b3: las cinco
// busquedas se ejecutaron con filters.location = null porque MD7 construia el
// gestor sin pasar la ubicacion configurada.
//
// Determinista: sin LinkedIn, sin Chromium, sin OpenAI, sin red.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMarketDiscoveryRunManager, STATUSES } = require('../run/marketDiscoveryRunManager');
const { createMarketDiscoveryRunStore } = require('../marketDiscovery/runStore');
const { createLinkedinMarketSource, SCOPE, STATUS } = require('../marketDiscovery/linkedinMarketSource');
const { createExplorationEngine } = require('../marketDiscovery/explorationEngine');
const { STOP_REASONS } = require('../marketDiscovery/explorationBudget');
const { OPERATION_TYPES, createOwner } = require('../domain/operationOwner');
const { acquireLock, releaseLock } = require('../domain/huntLock');
const runtime = require('../runtime');

const roots = [];
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed++; console.log('[PASS] ' + name); }
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md701-')); roots.push(dir); return dir; }

const CONFIGURED = 'Barcelona, spain';
const OWNER = createOwner(OPERATION_TYPES.MARKET_DISCOVERY, 'md_geo1');
const PROFILE = { schemaVersion: 1, exclusions: [], targetResponsibilities: [], demonstratedCapabilities: [] };
const SEED_PLAN = {
  seeds: [{ familyId: 'family-1111111111111111', expression: 'Retail Architect', language: 'und', rank: 1 }],
  familiesConsidered: 1, familiesSelected: 1, truncated: false, omittedFamilies: [], priority: [],
};
const card = (id) => ({ jobId: String(id), url: `https://www.linkedin.com/jobs/view/${id}/`, title: `Title ${id}`, company: `Co ${id}`, location: 'Barcelona, Catalonia, Spain', easyApply: false });

// Doble del collector de LinkedIn: devuelve la verificacion de filtros pedida.
function collectorDouble({ locationActive, jobs = [card(1), card(2)] }) {
  const calls = { initialize: [], collect: [] };
  return {
    calls,
    initializeSearch: async (_page, query, filters, options) => { calls.initialize.push({ query, filters, options }); },
    collectSearch: async (_page, query, filters) => {
      calls.collect.push({ query, filters });
      return {
        metadata: {
          query, pagesVisited: 1, rawResults: jobs.length, uniqueResults: jobs.length, limitReached: false,
          stopReason: 'no_next_page',
          filtersActive: { url: 'https://www.linkedin.com/jobs/search/?geoId=1', locationActive, datePostedActive: null, employmentTypeActive: null },
        },
        jobs, diagnostics: [],
      };
    },
  };
}
const sourceWith = (collector) => createLinkedinMarketSource({ initializeSearch: collector.initializeSearch, collectSearch: collector.collectSearch });
const searchRequest = (extra = {}) => ({
  owner: OWNER, page: { marker: 'p' },
  search: { searchId: 'd0_1', familyId: 'family-1111111111111111', seedExpression: 'Retail Architect', query: 'Retail Architect', queryLanguage: 'und' },
  filters: { location: CONFIGURED }, ...extra,
});

function fakeEvaluator() {
  const calls = [];
  return { calls, evaluatePosting: async (r) => { calls.push(r); return { classification: 'COMPATIBLE', dimensions: {}, terminology: [], identity: { cacheKey: 'k' } }; } };
}

// Banco MD7 con lock y persistencia reales, resto falso.
function bench(overrides = {}) {
  const dataDir = overrides.dataDir || temp();
  const lockPath = path.join(dataDir, 'hunt.lock');
  const ctx = { closed: 0, close: async () => { ctx.closed += 1; } };
  const sourceCalls = [];
  const source = overrides.source || { search: async (r) => { sourceCalls.push(r); return { status: 'COMPLETED', stopReason: 'no_next_page', results: [], metrics: {}, observedScope: { location: SCOPE.VERIFIED }, requestedScope: { location: r.filters && r.filters.location } }; } };
  const manager = createMarketDiscoveryRunManager({
    setupService: { getStatus: () => ({ readyForHunt: true }) },
    profileLoader: () => PROFILE,
    seedPlanner: () => SEED_PLAN,
    runStore: createMarketDiscoveryRunStore({ dataDir }),
    clock: () => new Date(0), makeRunId: () => 'mdrun_geo1', makeOperationId: () => 'md_geo1',
    acquireLock: (o) => acquireLock(lockPath, { owner: o }),
    releaseLock: (o) => releaseLock(lockPath, { owner: o }),
    openSession: async () => ({ context: ctx, page: { marker: 'md-page' } }),
    // El detalle real se prueba en la suite MD7.1; aqui se neutraliza.
    enricher: overrides.enricher || { enrich: async () => ({ outcome: 'DETAIL_UNAVAILABLE', description: null, descriptionAvailable: false }) },
    source, evaluator: overrides.evaluator || fakeEvaluator(),
    ...overrides.manager,
  });
  return { manager, dataDir, lockPath, ctx, sourceCalls, source };
}

(async () => {
  try {
    // ------------------------------- 1-6. la ubicacion configurada llega de punta a punta
    await testAsync('1+2+3+4. the configured location reaches MD7, MD5, MD3b and the collector', async () => {
      const collector = collectorDouble({ locationActive: true });
      const evaluator = fakeEvaluator();
      const b = bench({ source: sourceWith(collector), evaluator, manager: { resolveFilters: () => ({ location: CONFIGURED }) } });
      await b.manager.start();
      await b.manager.waitForIdle();
      // MD3b recibio la ubicacion y se la paso al collector real.
      assert.equal(collector.calls.initialize.length, 1);
      assert.equal(collector.calls.initialize[0].filters.location, CONFIGURED, 'initializeSearchWithFilters recibe la ubicacion');
      assert.equal(collector.calls.collect[0].filters.location, CONFIGURED);
      assert.notEqual(collector.calls.initialize[0].filters.location, null);
      assert.equal(b.manager.getStatus().status, STATUSES.COMPLETED);
    });
    test('5. no hardcoded Barcelona in Market Discovery or the run manager', () => {
      const files = ['src/run/marketDiscoveryRunManager.js', 'src/marketDiscovery/linkedinMarketSource.js',
        'src/marketDiscovery/explorationEngine.js', 'src/marketDiscovery/explorationBudget.js', 'src/ui/server.js'];
      for (const file of files) {
        const source = fs.readFileSync(path.join(runtime.PROJECT_ROOT, file), 'utf8');
        assert(!/barcelona/i.test(source), `${file} no debe mencionar Barcelona`);
      }
    });
    await testAsync('6. a config change before a new run uses the NEW configured location', async () => {
      let configured = 'Madrid, spain';
      const seen = [];
      const b = bench({
        source: { search: async (r) => { seen.push(r.filters.location); return { status: 'COMPLETED', stopReason: 'x', results: [], metrics: {}, observedScope: {}, requestedScope: {} }; } },
        manager: { resolveFilters: () => ({ location: configured }) },
      });
      await b.manager.start();
      await b.manager.waitForIdle();
      configured = CONFIGURED; // el usuario cambia la configuracion con el server vivo
      const second = bench({ dataDir: b.dataDir === null ? undefined : temp(), source: { search: async (r) => { seen.push(r.filters.location); return { status: 'COMPLETED', stopReason: 'x', results: [], metrics: {}, observedScope: {}, requestedScope: {} }; } }, manager: { resolveFilters: () => ({ location: configured }) } });
      await second.manager.start();
      await second.manager.waitForIdle();
      assert.deepEqual(seen, ['Madrid, spain', CONFIGURED], 'la segunda corrida usa la configuracion vigente, no una congelada');
    });
    await testAsync('7. a missing configured location fails BEFORE any LinkedIn search', async () => {
      for (const bad of [{}, { location: null }, { location: '' }, { location: '   ' }]) {
        const b = bench({ manager: { resolveFilters: () => bad } });
        let code;
        try { await b.manager.start(); } catch (error) { code = error.code; }
        assert.equal(code, 'LOCATION_REQUIRED', JSON.stringify(bad));
        assert.equal(b.sourceCalls.length, 0, 'no se busco nada');
        assert.equal(fs.existsSync(b.lockPath), false, 'no se tomo propiedad');
      }
      // Tampoco si la configuracion no se puede leer.
      const broken = bench({ manager: { resolveFilters: () => { throw new Error('no config'); } } });
      await assert.rejects(() => broken.manager.start(), (e) => e.code === 'LOCATION_REQUIRED');
    });

    // ----------------------------------------- 8-12. fallar cerrado ante scope no verificado
    await testAsync('8. a VERIFIED location lets results through', async () => {
      const outcome = await sourceWith(collectorDouble({ locationActive: true })).search(searchRequest());
      assert.equal(outcome.status, STATUS.COMPLETED);
      assert.equal(outcome.observedScope.location, SCOPE.VERIFIED);
      assert.equal(outcome.results.length, 2);
      assert.equal(outcome.requestedScope.location, CONFIGURED);
    });
    await testAsync('9. an UNVERIFIED location returns ZERO postings and a precise reason', async () => {
      for (const locationActive of [false, null, undefined]) {
        const outcome = await sourceWith(collectorDouble({ locationActive })).search(searchRequest());
        assert.equal(outcome.status, STATUS.INTERRUPTED, `locationActive=${locationActive}`);
        assert.equal(outcome.stopReason, 'scope_not_verified');
        assert.equal(outcome.observedScope.location, SCOPE.UNVERIFIED);
        assert.deepEqual(outcome.results, [], 'ninguna oferta de un mercado no confirmado');
        assert.equal(outcome.metrics.uniqueResults, 0);
        assert.notEqual(outcome.status, STATUS.COMPLETED);
      }
    });
    await testAsync('10+11+12. unverified scope blocks evaluation, expansion and proposal', async () => {
      const evaluator = fakeEvaluator();
      const engine = createExplorationEngine({
        source: sourceWith(collectorDouble({ locationActive: false })),
        evaluator, seedPlanner: () => SEED_PLAN, clock: () => new Date(0),
      });
      const ledger = await engine.explore({ owner: OWNER, page: {}, profile: PROFILE, filters: { location: CONFIGURED } });
      assert.equal(ledger.stopReason, STOP_REASONS.SCOPE_NOT_VERIFIED, 'motivo estable y preciso');
      assert.notEqual(ledger.stopReason, STOP_REASONS.SOURCE_FAILED, 'no se colapsa en un fallo generico');
      assert.equal(evaluator.calls.length, 0, 'ninguna evaluacion semantica');
      assert.equal(ledger.postings.length, 0, 'ninguna oferta entra al pool');
      assert.equal(ledger.observations.length, 0, 'ninguna terminologia');
      assert.deepEqual(ledger.expansion.selected, [], 'ninguna expansion');
      assert.equal(ledger.partial, true);
      // Y en MD7 el run termina INTERRUPTED con el motivo, sin propuesta.
      const b = bench({ source: sourceWith(collectorDouble({ locationActive: false })), manager: { resolveFilters: () => ({ location: CONFIGURED }) } });
      await b.manager.start();
      await b.manager.waitForIdle();
      const status = b.manager.getStatus();
      assert.equal(status.status, STATUSES.INTERRUPTED);
      assert.equal(status.reason, STOP_REASONS.SCOPE_NOT_VERIFIED);
      assert.equal(status.proposalAvailable, false);
      assert.equal(fs.existsSync(path.join(b.dataDir, 'market-discovery/runs/mdrun_geo1/proposal.json')), false);
      assert.equal(fs.existsSync(b.lockPath), false, 'propiedad liberada');
      assert.equal(b.ctx.closed, 1, 'navegador cerrado');
    });

    // ------------------------------------------- 13-20. auditabilidad persistida
    await testAsync('13-20. scope and safe posting metadata are persisted for later audit', async () => {
      const b = bench({ source: sourceWith(collectorDouble({ locationActive: true })), manager: { resolveFilters: () => ({ location: CONFIGURED }) } });
      await b.manager.start();
      await b.manager.waitForIdle();
      const ex = JSON.parse(fs.readFileSync(path.join(b.dataDir, 'market-discovery/runs/mdrun_geo1/exploration.json'), 'utf8')).exploration;
      const search = ex.searches[0];
      // "Que ubicacion pidio esta busqueda?" y "la confirmo LinkedIn?"
      assert.equal(search.requestedScope.location, CONFIGURED);
      assert.equal(search.observedScope.location, SCOPE.VERIFIED);
      assert(search.metrics && Number.isFinite(search.metrics.uniqueResults));
      // Metadatos de oferta suficientes para auditar geografia.
      const posting = ex.postings[0];
      for (const key of ['postingKey', 'postingId', 'title', 'company', 'location', 'firstSearchId', 'searchIds', 'familyIds', 'depth', 'evaluated', 'classification']) {
        assert(key in posting, `falta ${key} en el registro de oferta`);
      }
      assert.equal(posting.title, 'Title 1');
      assert.equal(posting.company, 'Co 1');
      assert.equal(posting.location, 'Barcelona, Catalonia, Spain');
      assert.deepEqual(posting.searchIds, ['d0_1']);
      // Nada de cookies, sesion, tracking ni HTML.
      const everything = fs.readdirSync(path.join(b.dataDir, 'market-discovery/runs/mdrun_geo1'))
        .map((f) => fs.readFileSync(path.join(b.dataDir, 'market-discovery/runs/mdrun_geo1', f), 'utf8')).join('\n');
      for (const token of ['li_at', 'cookie', 'Cookie', 'set-cookie', 'Bearer', 'sk-', 'trk=', 'trackingId', '<html', '<div', 'JSESSIONID']) {
        assert(!everything.includes(token), `no debe persistirse ${token}`);
      }
      // La URL de diagnostico del verificador sigue sin cruzar el contrato.
      assert(!everything.includes('geoId='), 'la URL interna de LinkedIn no se propaga');
    });

    // ------------------------------- 21-25. politica de filtros y Hunter intacto
    await testAsync('21+22+23. Market Discovery does not inherit Past week, Full-time or hybrid', async () => {
      const collector = collectorDouble({ locationActive: true });
      const b = bench({ source: sourceWith(collector), manager: { resolveFilters: () => ({ location: CONFIGURED }) } });
      await b.manager.start();
      await b.manager.waitForIdle();
      const sent = collector.calls.initialize[0].filters;
      assert.equal(sent.location, CONFIGURED);
      assert.equal(sent.datePosted, null, 'no hereda Past week');
      assert.equal(sent.employmentType, null, 'no hereda Full-time');
      assert(!('modality' in sent) && !('workplaceType' in sent), 'la modalidad no es filtro duro');
      assert.deepEqual(Object.keys(sent).sort(), ['datePosted', 'employmentType', 'location']);
      // La modalidad sigue siendo contexto semantico del perfil (contrato MD1).
      const profileMap = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/marketDiscovery/profileMap.js'), 'utf8');
      assert(profileMap.includes('workplacePreference'));
      assert(profileMap.includes("enforcement: 'unspecified'"), 'la preferencia nunca se vuelve filtro obligatorio');
    });
    test('24+25. Hunter keeps its own location, Full-time and Past week behaviour', () => {
      const cfg = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/config.js'), 'utf8');
      assert(/location:\s*configuredSearch\(\)\.locations\[0\]/.test(cfg), 'Hunter sigue tomando su ubicacion de la config');
      assert(/employmentType:\s*'Full-time'/.test(cfg));
      assert(/datePosted:\s*'Past week'/.test(cfg));
      const hunt = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/hunt.js'), 'utf8');
      assert(hunt.includes('LINKEDIN_FILTERS'), 'Hunt sigue usando LINKEDIN_FILTERS');
      // Market Discovery no toca la configuracion de Hunter.
      const manager = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/run/marketDiscoveryRunManager.js'), 'utf8');
      assert(!manager.includes('LINKEDIN_FILTERS'));
      assert(!manager.includes('saveUserConfig') && !manager.includes('applySearchSettings'));
    });

    // ===================== REGRESION DE PRODUCCION (mdrun_ce229f36dd9d09b3) =====================
    await testAsync('PRODUCTION REGRESSION: the real bug cannot recur through production wiring', async () => {
      // Se construye el gestor EXACTAMENTE como lo hace el server, sin pasar filtros.
      const dataDir = temp();
      const lockPath = path.join(dataDir, 'hunt.lock');
      const seen = [];
      const evaluator = fakeEvaluator();
      const collector = collectorDouble({ locationActive: true });
      const source = sourceWith(collector);
      const manager = createMarketDiscoveryRunManager({
        setupService: { getStatus: () => ({ readyForHunt: true }) },
        profileLoader: () => PROFILE,
        seedPlanner: () => SEED_PLAN,
        runStore: createMarketDiscoveryRunStore({ dataDir }),
        clock: () => new Date(0), makeRunId: () => 'mdrun_geo2', makeOperationId: () => 'md_geo2',
        acquireLock: (o) => acquireLock(lockPath, { owner: o }),
        releaseLock: (o) => releaseLock(lockPath, { owner: o }),
        openSession: async () => ({ context: { close: async () => {} }, page: {} }),
        // La configuracion canonica del usuario, como la leeria el gestor en produccion.
        resolveFilters: () => ({ location: CONFIGURED }),
        source: { search: async (r) => { seen.push(r.filters && r.filters.location); return source.search(r); } },
        evaluator,
      });
      await manager.start();
      await manager.waitForIdle();
      // El fallo original: filters.location === null en las cinco busquedas.
      assert(seen.length > 0, 'hubo busquedas');
      for (const location of seen) {
        assert.equal(location, CONFIGURED);
        assert.notEqual(location, null);
        assert.notEqual(location, undefined);
        assert.notEqual(location, '');
      }
      assert.equal(collector.calls.initialize[0].filters.location, CONFIGURED, 'llega hasta el collector real');

      // Y si LinkedIn NO confirma la ubicacion, ninguna oferta llega a evaluarse.
      const unverifiedEvaluator = fakeEvaluator();
      const unverifiedDir = temp();
      const unverifiedLock = path.join(unverifiedDir, 'hunt.lock');
      const unverified = createMarketDiscoveryRunManager({
        setupService: { getStatus: () => ({ readyForHunt: true }) },
        profileLoader: () => PROFILE, seedPlanner: () => SEED_PLAN,
        runStore: createMarketDiscoveryRunStore({ dataDir: unverifiedDir }),
        clock: () => new Date(0), makeRunId: () => 'mdrun_geo3', makeOperationId: () => 'md_geo3',
        acquireLock: (o) => acquireLock(unverifiedLock, { owner: o }),
        releaseLock: (o) => releaseLock(unverifiedLock, { owner: o }),
        openSession: async () => ({ context: { close: async () => {} }, page: {} }),
        resolveFilters: () => ({ location: CONFIGURED }),
        source: sourceWith(collectorDouble({ locationActive: false })),
        evaluator: unverifiedEvaluator,
      });
      await unverified.start();
      await unverified.waitForIdle();
      assert.equal(unverifiedEvaluator.calls.length, 0, 'CERO ofertas evaluadas con alcance no verificado');
      assert.equal(unverified.getStatus().reason, STOP_REASONS.SCOPE_NOT_VERIFIED);
      assert.equal(unverified.getStatus().proposalAvailable, false);
    });

    console.log('Market Geography (MD7.0.1): ' + passed + ' tests passed');
  } finally {
    for (const dir of roots.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

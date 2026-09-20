'use strict';

// MD3b — adaptador de fuente de mercado de LinkedIn (solo lectura).
// Determinista: sin LinkedIn, sin Chromium, sin red, sin OpenAI.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createLinkedinMarketSource, MD_MAX_PAGES, MD_MAX_RESULTS, STATUS, SCOPE, SUPPORTED_FILTERS,
} = require('../marketDiscovery/linkedinMarketSource');
const { OPERATION_TYPES, createOwner } = require('../domain/operationOwner');
const { acquireLock, releaseLock } = require('../domain/huntLock');
const runtime = require('../runtime');

const roots = [];
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed++; console.log('[PASS] ' + name); }
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md3b-')); roots.push(dir); return dir; }

const mdOwner = (id = 'md_run_1') => createOwner(OPERATION_TYPES.MARKET_DISCOVERY, id);
const huntOwner = (id = 'run_hunt_1') => createOwner(OPERATION_TYPES.HUNT, id);
const FAMILY = 'family-0123456789abcdef';
const page = { marker: 'authenticated-page' };

function card(jobId, extra = {}) {
  return { jobId, url: `https://www.linkedin.com/jobs/view/${jobId}/`, title: `Title ${jobId}`, company: `Company ${jobId}`, location: 'Somewhere', easyApply: false, ...extra };
}

// Doble del collector: replica el contrato real de collectCurrentSearch,
// incluyendo el dedupe intra-busqueda por identidad canonica (jobId || url).
function fakeCollector(cards, { filtersActive = {}, stopReason = 'no_next_page', pagesVisited = 1 } = {}) {
  const calls = [];
  const collectSearch = async (_page, query, filters, options) => {
    calls.push({ query, filters, options });
    const unique = new Map();
    for (const item of cards) {
      const key = item.jobId || item.url;
      if (!key || unique.has(key)) continue;
      if (options.maxResults && unique.size >= options.maxResults) break;
      unique.set(key, item);
    }
    return {
      metadata: {
        query, pagesVisited, rawResults: cards.length, uniqueResults: unique.size,
        limitReached: Boolean(options.maxResults && unique.size >= options.maxResults),
        stopReason, filtersActive,
      },
      jobs: [...unique.values()],
      diagnostics: [],
    };
  };
  return { collectSearch, calls };
}
function sourceWith(collector, initializeCalls = []) {
  return createLinkedinMarketSource({
    initializeSearch: async (_page, query, filters, options) => { initializeCalls.push({ query, filters, options }); },
    collectSearch: collector.collectSearch,
  });
}
const baseRequest = (extra = {}) => ({
  owner: mdOwner(), page,
  search: { searchId: 'search_1', familyId: FAMILY, seedExpression: 'Retail Architect', query: 'retail architect', queryLanguage: 'en' },
  ...extra,
});

(async () => {
  try {
    // ----------------------------------------------------- 1. resultado estructurado
    await testAsync('1. one query returns a structured, attributed result', async () => {
      const collector = fakeCollector([card('111'), card('222')]);
      const outcome = await sourceWith(collector).search(baseRequest());
      assert.equal(outcome.status, STATUS.COMPLETED);
      assert.equal(outcome.operationType, 'MARKET_DISCOVERY');
      assert.equal(outcome.search.query, 'retail architect');
      assert.equal(outcome.results.length, 2);
      assert.equal(outcome.metrics.uniqueResults, 2);
      assert.equal(outcome.stopReason, 'no_next_page');
      assert.equal(outcome.challenge, null);
      assert(Object.isFrozen(outcome) && Object.isFrozen(outcome.results));
      assert.deepEqual(Object.keys(outcome.results[0]).sort(),
        ['company', 'easyApply', 'familyId', 'jobId', 'location', 'position', 'query', 'searchId', 'title', 'url']);
    });

    // ------------------------------------------------------------- 2-5. presupuesto
    await testAsync('2+3. defaults are one page and ten results', async () => {
      const collector = fakeCollector([card('1')]);
      const outcome = await sourceWith(collector).search(baseRequest());
      assert.equal(collector.calls[0].options.maxPages, 1);
      assert.equal(collector.calls[0].options.maxResults, 10);
      assert.equal(outcome.requestedScope.maxPages, 1);
      assert.equal(outcome.requestedScope.maxResults, 10);
      assert.equal(MD_MAX_PAGES, 1);
      assert.equal(MD_MAX_RESULTS, 10);
    });
    await testAsync('4+5. limits above the MD3b budget fail closed', async () => {
      const source = sourceWith(fakeCollector([card('1')]));
      for (const limits of [{ maxPages: 2 }, { maxPages: 99 }, { maxResults: 11 }, { maxResults: 25 }, { maxPages: 2, maxResults: 25 }]) {
        await assert.rejects(() => source.search(baseRequest({ limits })), /MARKET_DISCOVERY_INVALID/);
      }
      // Tampoco se aceptan valores no enteros, cero o negativos.
      for (const limits of [{ maxPages: 0 }, { maxResults: 0 }, { maxResults: -1 }, { maxResults: 1.5 }, { maxResults: '10' }]) {
        await assert.rejects(() => source.search(baseRequest({ limits })), /MARKET_DISCOVERY_INVALID/);
      }
      // Un presupuesto menor SI es valido: acotar nunca es ensanchar.
      const smaller = await source.search(baseRequest({ limits: { maxPages: 1, maxResults: 3 } }));
      assert.equal(smaller.requestedScope.maxResults, 3);
    });
    await testAsync('24. the adapter never broadens what it asks the collector for', async () => {
      const collector = fakeCollector(Array.from({ length: 40 }, (_, i) => card(String(1000 + i))));
      const outcome = await sourceWith(collector).search(baseRequest());
      assert.equal(collector.calls[0].options.maxResults, 10);
      assert.equal(collector.calls[0].options.maxPages, 1);
      assert.equal(outcome.results.length, 10, 'el presupuesto se respeta aunque haya 40 tarjetas');
      assert.equal(outcome.metrics.limitReached, true);
    });

    // ------------------------------------------------------------- 6-7. atribucion
    await testAsync('6. every result keeps seed, family and search identity', async () => {
      const collector = fakeCollector([card('111'), card('222')]);
      const outcome = await sourceWith(collector).search(baseRequest());
      assert.equal(outcome.search.searchId, 'search_1');
      assert.equal(outcome.search.familyId, FAMILY);
      assert.equal(outcome.search.seedExpression, 'Retail Architect');
      for (const result of outcome.results) {
        assert.equal(result.searchId, 'search_1');
        assert.equal(result.familyId, FAMILY);
        assert.equal(result.query, 'retail architect');
      }
      assert.deepEqual(outcome.results.map((r) => r.position), [1, 2]);
      assert.deepEqual(outcome.results.map((r) => r.jobId), ['111', '222']);
    });
    await testAsync('7. query language is kept apart from posting data', async () => {
      const collector = fakeCollector([card('111')]);
      const outcome = await sourceWith(collector).search(baseRequest());
      assert.equal(outcome.search.queryLanguage, 'en');
      // Ninguna oferta recibe un idioma inferido de la query.
      for (const result of outcome.results) {
        assert(!('language' in result) && !('queryLanguage' in result) && !('postingLanguage' in result));
      }
      const undetermined = await sourceWith(fakeCollector([card('111')]))
        .search(baseRequest({ search: { searchId: 's2', familyId: FAMILY, query: 'arquitecto retail' } }));
      assert.equal(undetermined.search.queryLanguage, 'und', 'sin declaracion explicita, indeterminado');
      await assert.rejects(() => sourceWith(collector).search(
        baseRequest({ search: { searchId: 's3', query: 'x', queryLanguage: 'english' } })), /MARKET_DISCOVERY_INVALID/);
    });

    // --------------------------------------------------------------- 8-9. dedupe
    await testAsync('8. duplicate cards within one search are deduplicated', async () => {
      const collector = fakeCollector([card('111'), card('111'), card('222'), card('111')]);
      const outcome = await sourceWith(collector).search(baseRequest());
      assert.deepEqual(outcome.results.map((r) => r.jobId), ['111', '222']);
      assert.equal(outcome.metrics.rawCards, 4);
      assert.equal(outcome.metrics.uniqueResults, 2);
      assert.equal(outcome.metrics.duplicatesWithinSearch, 2);
    });
    await testAsync('9. the same job may appear independently in two separate searches', async () => {
      const a = await sourceWith(fakeCollector([card('111'), card('333')]))
        .search(baseRequest({ search: { searchId: 'search_a', familyId: FAMILY, query: 'retail architect' } }));
      const b = await sourceWith(fakeCollector([card('111'), card('444')]))
        .search(baseRequest({ search: { searchId: 'search_b', familyId: 'family-fedcba9876543210', query: 'store designer' } }));
      // El solapamiento entre busquedas es evidencia: el adaptador no lo borra.
      assert(a.results.some((r) => r.jobId === '111'));
      assert(b.results.some((r) => r.jobId === '111'));
      assert.equal(a.results.find((r) => r.jobId === '111').searchId, 'search_a');
      assert.equal(b.results.find((r) => r.jobId === '111').searchId, 'search_b');
      assert.notEqual(a.results.find((r) => r.jobId === '111').familyId, b.results.find((r) => r.jobId === '111').familyId);
    });

    // ------------------------------------------------------------- 10-11. scope
    await testAsync('10. requested and observed scope are distinguished', async () => {
      const collector = fakeCollector([card('111')], {
        filtersActive: { url: 'https://www.linkedin.com/jobs/search/?geoId=123&f_TPR=r604800', locationActive: true, datePostedActive: true, employmentTypeActive: false },
      });
      const outcome = await sourceWith(collector).search(baseRequest({
        filters: { location: 'Example region', datePosted: 'past week', employmentType: 'full-time' },
      }));
      assert.deepEqual(outcome.requestedScope, { location: 'Example region', employmentType: 'full-time', datePosted: 'past week', maxPages: 1, maxResults: 10 });
      assert.equal(outcome.observedScope.location, SCOPE.VERIFIED);
      assert.equal(outcome.observedScope.datePosted, SCOPE.VERIFIED);
      assert.equal(outcome.observedScope.employmentType, SCOPE.UNVERIFIED, 'pedido pero no confirmado');
      // La URL de diagnostico de LinkedIn no cruza el contrato.
      const text = JSON.stringify(outcome);
      assert(!text.includes('geoId') && !text.includes('f_TPR') && !text.includes('linkedin.com/jobs/search'));
      assert.equal(outcome.observedScope.verifiedAgainstUrl, true);
    });
    await testAsync('11. an unverifiable filter is never presented as verified', async () => {
      // El verificador devuelve null cuando no sabe mapear la etiqueta pedida.
      const collector = fakeCollector([card('111')], { filtersActive: { url: 'https://x', locationActive: null, datePostedActive: null, employmentTypeActive: null } });
      const outcome = await sourceWith(collector).search(baseRequest({ filters: { location: 'Nowhere', datePosted: 'ayer' } }));
      assert.equal(outcome.observedScope.location, SCOPE.UNVERIFIED);
      assert.equal(outcome.observedScope.datePosted, SCOPE.UNVERIFIED);
      assert.equal(outcome.observedScope.employmentType, SCOPE.NOT_REQUESTED, 'no pedido no es lo mismo que no verificado');
      // Solo se aceptan los filtros que el collector ya soporta con seguridad.
      assert.deepEqual(SUPPORTED_FILTERS, ['location', 'employmentType', 'datePosted']);
      for (const filters of [{ seniority: 'senior' }, { modality: 'remote' }, { language: 'en' }]) {
        await assert.rejects(() => sourceWith(collector).search(baseRequest({ filters })), /unsupported market discovery filter/);
      }
    });

    // ------------------------------------------------ 12-15. interrupcion
    await testAsync('12. login required is propagated safely', async () => {
      const error = new Error('No se detecto una sesion autenticada de LinkedIn en ./browser-profile');
      error.name = 'AuthenticationError';
      const source = createLinkedinMarketSource({ initializeSearch: async () => { throw error; }, collectSearch: async () => { throw new Error('unreachable'); } });
      const outcome = await source.search(baseRequest());
      assert.equal(outcome.status, STATUS.INTERRUPTED);
      assert.equal(outcome.stopReason, 'login_required');
      assert.equal(outcome.challenge.code, 'LOGIN_REQUIRED');
      assert.notEqual(outcome.status, STATUS.COMPLETED);
      assert(!JSON.stringify(outcome).includes('browser-profile'));
    });
    await testAsync('13. checkpoint required is propagated without leaking diagnostics', async () => {
      const error = new Error('LinkedIn presento un checkpoint');
      error.name = 'SecurityChallengeError';
      error.challengeDiagnostic = { source: 'url', signal: 'checkpoint/challenge', stage: 'discovery', at: '2026-01-01T00:00:00.000Z', url: 'https://www.linkedin.com/checkpoint/xyz', excerpt: '<div class="secret-selector">verify</div>' };
      const source = createLinkedinMarketSource({ initializeSearch: async () => {}, collectSearch: async () => { throw error; } });
      const outcome = await source.search(baseRequest());
      assert.equal(outcome.status, STATUS.INTERRUPTED);
      assert.equal(outcome.stopReason, 'checkpoint_required');
      assert.deepEqual(outcome.challenge, { code: 'CHECKPOINT_REQUIRED', source: 'url', signal: 'checkpoint/challenge', stage: 'discovery', at: '2026-01-01T00:00:00.000Z' });
      const text = JSON.stringify(outcome);
      assert(!text.includes('checkpoint/xyz') && !text.includes('secret-selector') && !text.includes('<div'));
    });
    await testAsync('14. cancellation stops the search and mutates nothing', async () => {
      const controller = new AbortController();
      let collected = false;
      const source = createLinkedinMarketSource({
        initializeSearch: async () => { controller.abort(); },
        collectSearch: async () => { collected = true; return { metadata: {}, jobs: [] }; },
      });
      const outcome = await source.search(baseRequest({ signal: controller.signal }));
      assert.equal(outcome.status, STATUS.CANCELLED);
      assert.equal(outcome.stopReason, 'cancelled');
      assert.equal(collected, false, 'no se recolecta despues de cancelar');
      assert.deepEqual(outcome.results, []);
      // Cancelacion antes de empezar tampoco ejecuta nada.
      const preCancelled = new AbortController(); preCancelled.abort();
      let touched = false;
      const untouched = createLinkedinMarketSource({ initializeSearch: async () => { touched = true; }, collectSearch: async () => { touched = true; } });
      assert.equal((await untouched.search(baseRequest({ signal: preCancelled.signal }))).status, STATUS.CANCELLED);
      assert.equal(touched, false);
    });
    await testAsync('15. an interrupted or failed search is never marked completed', async () => {
      const failing = createLinkedinMarketSource({ initializeSearch: async () => {}, collectSearch: async () => { const e = new Error('selector li[data-occludable-job-id] not found at https://linkedin.com/x'); e.name = 'LinkedInSelectorError'; throw e; } });
      const outcome = await failing.search(baseRequest());
      assert.equal(outcome.status, STATUS.FAILED);
      assert.equal(outcome.stopReason, 'source_failed');
      assert.equal(outcome.partial, false);
      assert.deepEqual(outcome.results, []);
      assert.equal(outcome.metrics.uniqueResults, 0);
      // Ni el mensaje, ni el selector, ni la URL del fallo cruzan el contrato.
      const text = JSON.stringify(outcome);
      assert(!text.includes('data-occludable') && !text.includes('linkedin.com/x') && !text.includes('not found'));
      for (const status of [STATUS.INTERRUPTED, STATUS.CANCELLED, STATUS.FAILED]) assert.notEqual(status, STATUS.COMPLETED);
    });

    // ------------------------------------------- 16-21. sin contaminacion de Hunter
    test('16-21. the source imports nothing that can mutate Hunter state', () => {
      const source = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/marketDiscovery/linkedinMarketSource.js'), 'utf8');
      const forbidden = [
        'jobRepository', 'jobService', 'jobAnalyzer', 'analyzeJob', 'learnedPreferences', 'runOutcome',
        'notifications/ntfy', 'telegram', 'huntRunManager', 'searchSettings', 'userConfig', 'scheduleStore',
        'pipeline', 'detailCollector', 'multiSearch', 'writeFileSync', 'mkdirSync',
      ];
      for (const token of forbidden) assert(!source.includes(token), `linkedinMarketSource no debe referenciar ${token}`);
      // Solo puede apoyarse en primitivas de busqueda y en el contrato de propiedad.
      const requires = (source.match(/require\('([^']+)'\)/g) || []).join(' ');
      assert(requires.includes('./domain') && requires.includes('../domain/operationOwner') && requires.includes('../linkedin/searchScope'));
      assert(!requires.includes('../linkedin/detailCollector'), 'MD3b no recolecta descripciones');
    });
    await testAsync('16-21. a search writes nothing to the data directory', async () => {
      const dataDir = temp();
      const before = fs.readdirSync(dataDir);
      const collector = fakeCollector([card('111'), card('222')]);
      const outcome = await sourceWith(collector).search(baseRequest());
      assert.equal(outcome.status, STATUS.COMPLETED);
      assert.deepEqual(fs.readdirSync(dataDir), before, 'ni jobs, ni runs, ni feedback, ni config');
      for (const dir of ['jobs', 'runs', 'feedback', 'config', 'profile', 'market-discovery']) {
        assert.equal(fs.existsSync(path.join(dataDir, dir)), false);
      }
      // El resultado no lleva nada del vocabulario de decision de Hunter.
      const text = JSON.stringify(outcome);
      for (const token of ['decision', 'overallMatchScore', 'analysis', 'matchedQueries', 'matchedFamilies', 'YES', 'MAYBE']) {
        assert(!text.includes(token), `el contrato de MD no debe incluir ${token}`);
      }
    });

    // --------------------------------------------------------- 22-23. propiedad
    await testAsync('23. MARKET_DISCOVERY ownership is required', async () => {
      const source = sourceWith(fakeCollector([card('111')]));
      for (const owner of [undefined, null, {}, huntOwner(), createOwner(OPERATION_TYPES.MANUAL_SESSION, 'session_1'),
        createOwner(OPERATION_TYPES.CLI_TOOL, 'cli_1'), createOwner(OPERATION_TYPES.UNSPECIFIED, 'unspecified')]) {
        await assert.rejects(() => source.search(baseRequest({ owner })), /MARKET_DISCOVERY_INVALID/);
      }
      const ok = await source.search(baseRequest({ owner: mdOwner('md_run_x') }));
      assert.equal(ok.operationId, 'md_run_x');
    });
    await testAsync('22. the adapter cannot release any ownership, foreign or its own', async () => {
      const file = path.join(temp(), 'hunt.lock');
      acquireLock(file, { owner: huntOwner('run_foreign') });
      const owner = mdOwner('md_run_1');
      const outcome = await sourceWith(fakeCollector([card('111')])).search(baseRequest({ owner }));
      assert.equal(outcome.status, STATUS.COMPLETED);
      assert.equal(fs.existsSync(file), true, 'la propiedad ajena sigue intacta');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).operationId, 'run_foreign');
      // Estructural: el adaptador no contiene ninguna primitiva de lock.
      const source = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/marketDiscovery/linkedinMarketSource.js'), 'utf8');
      for (const token of ['acquireLock', 'releaseLock', 'huntLock', 'launchLinkedInBrowser', 'chromium']) {
        assert(!source.includes(token), `el adaptador no debe usar ${token}: la propiedad es del run`);
      }
      releaseLock(file, { owner: huntOwner('run_foreign') });
    });
    await testAsync('the operation identity is stable across several searches of one run', async () => {
      const owner = mdOwner('md_run_stable');
      const source = sourceWith(fakeCollector([card('111')]));
      const first = await source.search(baseRequest({ owner, search: { searchId: 's1', familyId: FAMILY, query: 'a' } }));
      const second = await source.search(baseRequest({ owner, search: { searchId: 's2', familyId: FAMILY, query: 'b' } }));
      assert.equal(first.operationId, 'md_run_stable');
      assert.equal(second.operationId, 'md_run_stable', 'no se genera una identidad por query');
      assert.notEqual(first.search.searchId, second.search.searchId);
    });

    // ----------------------------------------------------------- 25. Hunter intacto
    test('25. Hunter discovery semantics are unchanged', () => {
      const config = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/config.js'), 'utf8');
      assert(/MAX_RESULTS_PER_SEARCH'\s*,\s*25\)/.test(config), 'Hunter sigue en 25 resultados por busqueda');
      assert(/MAX_PAGES_PER_SEARCH'\s*,\s*2\)/.test(config), 'Hunter sigue en 2 paginas por busqueda');
      // Ningun archivo de LinkedIn conoce a Market Discovery.
      for (const file of fs.readdirSync(path.join(runtime.PROJECT_ROOT, 'src/linkedin'))) {
        const text = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/linkedin', file), 'utf8');
        assert(!/marketDiscovery|MARKET_DISCOVERY/.test(text), `src/linkedin/${file} no debe conocer Market Discovery`);
      }
      // El presupuesto de Hunter se sigue tomando de su propia configuracion.
      const hunt = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/hunt.js'), 'utf8');
      assert(hunt.includes('maxResultsPerSearch: MAX_RESULTS_PER_SEARCH'));
      assert(hunt.includes('maxPagesPerSearch: MAX_PAGES_PER_SEARCH'));
    });

    console.log('Market Source (MD3b): ' + passed + ' tests passed');
  } finally {
    for (const dir of roots.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

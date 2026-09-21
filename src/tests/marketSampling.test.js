'use strict';

// MD9 — retencion de muestra por busqueda.
//
// Auditoria de las corridas 4, 5 y 6 (artefactos persistidos): las QUINCE
// busquedas observaron 25 tarjetas distintas en la primera pagina y retuvieron
// 10, descartando 15 ya descargadas y ya parseadas. Las quince pararon por
// `max_results_reached`, nunca por fin de pagina.
//
// Ningun otro presupuesto se acerco a su tope. La corrida 6 termino COMPLETED
// -candidatos agotados- con 31 de 60 evaluaciones, 31 de 100 ofertas unicas,
// 5 de 10 busquedas y el 39% del tiempo.
//
// Estos tests fijan que la retencion es la primera pagina ENTERA y que ningun
// otro presupuesto, ni ninguna compuerta de evidencia, se ha tocado.
//
// Determinista: sin LinkedIn, sin Chromium, sin OpenAI, sin red.

const assert = require('assert/strict');

const { createLinkedinMarketSource, MD_MAX_PAGES, MD_MAX_RESULTS } = require('../marketDiscovery/linkedinMarketSource');
const { HARD_CAPS, POLICY } = require('../marketDiscovery/explorationBudget');
const { OPERATION_TYPES, createOwner } = require('../domain/operationOwner');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed += 1; console.log('[PASS] ' + name); }

const OWNER = createOwner(OPERATION_TYPES.MARKET_DISCOVERY, 'md_sampling');
const card = (id) => ({ jobId: String(id), url: 'https://www.linkedin.com/jobs/view/' + id + '/', title: 'Title ' + id, company: 'Co ' + id, location: 'Somewhere', easyApply: false });

// Collector que imita al real: dedupe interno y corte por maxResults.
function fakeCollector(cards) {
  const calls = [];
  return {
    calls,
    collect: async (page, query, filters, options) => {
      calls.push({ options });
      const unique = new Map();
      let raw = 0;
      for (const item of cards) {
        raw += 1;
        if (options.maxResults && unique.size >= options.maxResults) break;
        if (!unique.has(item.jobId)) unique.set(item.jobId, item);
      }
      return {
        metadata: {
          rawResults: raw, uniqueResults: unique.size, pagesVisited: 1,
          limitReached: Boolean(options.maxResults && unique.size >= options.maxResults),
          stopReason: 'max_results_reached',
          filtersActive: { url: 'https://x', locationActive: true, datePostedActive: null, employmentTypeActive: null },
        },
        jobs: [...unique.values()],
      };
    },
  };
}

const sourceWith = (collector) => createLinkedinMarketSource({
  initializeSearch: async () => {},
  collectSearch: (page, query, filters, options) => collector.collect(page, query, filters, options),
});
const baseRequest = (extra = {}) => ({
  owner: OWNER, page: {},
  search: { searchId: 'd0_1', familyId: null, query: 'Some role', queryLanguage: 'und' },
  filters: { location: 'Somewhere' },
  ...extra,
});

(async () => {
  console.log('\n### Retención por búsqueda');

  test('1. la retención por búsqueda es la primera página entera', () => {
    assert.equal(MD_MAX_RESULTS, 25, 'se retiene la primera pagina completa');
    assert.equal(MD_MAX_PAGES, 1, 'la profundidad de paginacion NO aumenta');
    assert.deepEqual(POLICY.searchLimits, { maxPages: 1, maxResults: 25 });
  });

  await testAsync('2. una página con 25 tarjetas ya no pierde 15', async () => {
    const cards = Array.from({ length: 25 }, (_, i) => card(2000 + i));
    const collector = fakeCollector(cards);
    const outcome = await sourceWith(collector).search(baseRequest());
    assert.equal(outcome.results.length, 25, 'se conserva toda la evidencia ya descargada');
    assert.equal(outcome.metrics.rawCards, 25);
    assert.equal(outcome.metrics.duplicatesWithinSearch, 0, 'ya no se descarta nada por el tope');
  });

  await testAsync('3. el tope sigue siendo DURO: nunca se pide más de una página', async () => {
    const cards = Array.from({ length: 80 }, (_, i) => card(3000 + i));
    const collector = fakeCollector(cards);
    const outcome = await sourceWith(collector).search(baseRequest());
    assert.equal(collector.calls[0].options.maxPages, 1, 'jamas se piden mas paginas');
    assert.equal(collector.calls[0].options.maxResults, 25);
    assert.equal(outcome.results.length, 25, 'no se pasa del tope aunque haya 80 tarjetas');
    assert.equal(outcome.metrics.limitReached, true);
  });

  await testAsync('4. pedir más que el presupuesto sigue fallando cerrado', async () => {
    const source = sourceWith(fakeCollector([card('1')]));
    for (const limits of [{ maxResults: 26 }, { maxResults: 100 }, { maxPages: 2 }]) {
      await assert.rejects(() => source.search(baseRequest({ limits })), /MARKET_DISCOVERY_INVALID/);
    }
  });

  await testAsync('5. una página más corta retiene solo lo que existe', async () => {
    const outcome = await sourceWith(fakeCollector(Array.from({ length: 7 }, (_, i) => card(4000 + i)))).search(baseRequest());
    assert.equal(outcome.results.length, 7, 'no se inventa evidencia que LinkedIn no dio');
    assert.equal(outcome.metrics.limitReached, false);
  });

  console.log('\n### Nada más cambió');

  test('6. ningún otro presupuesto se movió', () => {
    assert.equal(HARD_CAPS.maxEvaluations, 60);
    assert.equal(HARD_CAPS.initialEvaluationReserve, 36);
    assert.equal(HARD_CAPS.expansionEvaluationReserve, 24, 'la reserva de expansion sigue protegida');
    assert.equal(HARD_CAPS.maxUniquePostings, 100);
    assert.equal(HARD_CAPS.maxSearches, 10);
    assert.equal(HARD_CAPS.maxInitialSearches, 6);
    assert.equal(HARD_CAPS.maxExpansionSearches, 4);
    assert.equal(HARD_CAPS.maxExpansionDepth, 1);
    assert.equal(HARD_CAPS.maxSemanticFailures, 3);
    assert.equal(HARD_CAPS.maxSourceFailures, 2);
    assert.equal(HARD_CAPS.maxDetailFailures, 5);
    assert.equal(HARD_CAPS.maxDurationMs, 45 * 60 * 1000);
  });

  test('7. las compuertas de evidencia NO se relajaron', () => {
    // La auditoria demostro que bajar el umbral no habria promocionado NADA:
    // en las corridas 4, 5 y 6 ningun termino llego siquiera a 2 ofertas
    // distintas. El problema era el tamaño de la muestra, no el liston.
    assert.equal(POLICY.minExpansionPostings, 2);
    assert.equal(POLICY.minExpansionCompanies, 2);
    assert.equal(POLICY.saturationOverlapRatio, 0.8);
    assert.equal(POLICY.saturationConsecutiveSearches, 2);
    assert.equal(POLICY.minFamilyEvaluationSample, 4);
    assert.equal(POLICY.zeroYieldProbeInterval, 3);
  });

  test('8. la política de promoción de vocabulario sigue intacta', () => {
    const { PROMOTION, QUERY_TEST, PORTFOLIO } = require('../marketDiscovery/vocabularyPolicy');
    assert.equal(PROMOTION.minDistinctPostings, 3, 'el liston de promocion NO se bajo');
    assert.equal(PROMOTION.minDistinctCompanies, 2);
    assert.equal(QUERY_TEST.minSample, 5);
    assert.equal(QUERY_TEST.minCompatibleRatio, 0.6);
    assert.equal(QUERY_TEST.minIncrementalCompatible, 2);
    assert.equal(PORTFOLIO.targetMin, 8);
  });

  console.log(`\nMD9 Sampling: ${passed} tests passed`);
})().catch((error) => {
  console.error('\n[FAIL]', error && error.stack ? error.stack : error);
  process.exit(1);
});

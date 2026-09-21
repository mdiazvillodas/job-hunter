'use strict';

// Tests de la transicion de keyword entre busquedas de LinkedIn.
// No abren navegador, no llaman a LinkedIn ni a OpenAI, no ejecutan hunts reales.
// Ejecutar: node src/tests/queryChange.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  changeSearchQuery,
  normalizeKeyword,
  keywordMatchesUrl,
  withKeyword,
  QUERY_CHANGE_FAILURES,
} = require('../linkedin/searchScope');
const { collectMultipleSearches } = require('../linkedin/multiSearch');
const { runPipeline } = require('../pipeline/pipeline');
const { createLocalRepository } = require('../data/jobRepository');
const { createJobService } = require('../services/jobService');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }
function tmpSvc() { return createJobService(createLocalRepository({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'jh-qc-')) })); }

const BASE = 'https://www.linkedin.com/jobs/search/?keywords=Previous%20Query&location=Barcelona&f_TPR=r604800&f_JT=F';

// --- Fake de la pagina de LinkedIn -------------------------------------------
// Modela lo que importa aqui: el valor de la caja, si el typeahead esta abierto
// y que ocurre al pulsar Enter. `behaviour` decide como se comporta cada intento.
function makePage(behaviour = {}) {
  const state = {
    url: behaviour.startUrl || BASE,
    inputValue: 'Previous Query',
    typeaheadOpen: false,
    enterPresses: 0,
    attemptsSeen: 0,
    gotos: [],
    fills: [],
    escapes: 0,
    inputVisible: behaviour.inputVisible !== false,
  };

  const setUrlKeyword = (kw) => {
    const u = new URL(state.url);
    u.searchParams.set('keywords', kw);
    state.url = u.toString();
  };

  const keywordLocator = {
    click: async () => { state.typeaheadOpen = true; },
    fill: async (v) => { state.inputValue = v; state.fills.push(v); if (v) state.typeaheadOpen = true; },
    inputValue: async () => state.inputValue,
    press: async (key) => {
      if (key !== 'Enter') return;
      state.enterPresses += 1;
      state.attemptsSeen += 1;
      const outcome = typeof behaviour.onEnter === 'function'
        ? behaviour.onEnter(state, state.attemptsSeen)
        : 'submit';
      if (outcome === 'submit') setUrlKeyword(state.inputValue);
      else if (outcome === 'nothing') { /* typeahead se comio el Enter: URL intacta */ }
      else if (typeof outcome === 'string') setUrlKeyword(outcome); // sugerencia equivocada
    },
    waitFor: async () => {
      if (!state.inputVisible) { const e = new Error('not visible'); throw e; }
    },
    isVisible: async () => state.inputVisible,
    first() { return this; },
    innerText: async () => '',
  };

  const genericLocator = {
    first() { return this; },
    waitFor: async () => {},
    isVisible: async () => false,
    innerText: async () => '',
  };

  const page = {
    url: () => state.url,
    goto: async (target) => {
      state.gotos.push(target);
      const outcome = typeof behaviour.onGoto === 'function' ? behaviour.onGoto(state, target) : 'follow';
      if (outcome === 'follow') state.url = target;
      state.typeaheadOpen = false;
    },
    keyboard: {
      press: async (key) => {
        if (key === 'Escape') {
          state.escapes += 1;
          state.typeaheadOpen = false;
          if (behaviour.escapeClearsInput) state.inputValue = '';
        }
      },
    },
    locator: (selector) => {
      if (/jobs-search-box-keyword|organization-title|title, skill|cargo, aptitud/.test(selector)) return keywordLocator;
      return genericLocator;
    },
    // Se evalua la MISMA funcion que correria en el navegador, con un
    // `location` controlado: el test ejercita el gate real, no una copia.
    waitForFunction: async (fn, arg, opts) => {
      const deadline = Date.now() + ((opts && opts.timeout) || 1000);
      for (;;) {
        let value = false;
        try { value = evalWithLocation(fn, arg, state.url); } catch (_) { value = false; }
        if (value) return true;
        if (Date.now() >= deadline) throw new Error('waitForFunction timeout');
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => null,
    state,
  };
  return page;
}

// Ejecuta la funcion del gate con un `location` controlado, sin navegador.
function evalWithLocation(fn, arg, href) {
  const source = `return (${fn.toString()})(arg);`;
  // eslint-disable-next-line no-new-func
  const runner = new Function('location', 'arg', source);
  return runner({ href }, arg);
}

const OPTS = { confirmTimeoutMs: 200 };

async function run() {
  // ---------- helpers puros ----------
  section('Keyword identity helpers');
  {
    ok('normaliza espacios y mayusculas', normalizeKeyword('  Retail   ARCHITECT ') === 'retail architect');
    ok('acepta la URL con la query exacta', keywordMatchesUrl(BASE.replace('Previous%20Query', 'Retail%20Architect'), 'Retail Architect'));
    ok('acepta codificacion con +', keywordMatchesUrl('https://x/jobs/search/?keywords=Retail+Architect', 'Retail Architect'));
    ok('RECHAZA otra query', !keywordMatchesUrl('https://x/jobs/search/?keywords=Solution+Architect', 'Retail Architect'));
    ok('RECHAZA un substring', !keywordMatchesUrl('https://x/jobs/search/?keywords=Retail', 'Retail Architect'));
    ok('RECHAZA la ausencia del parametro', !keywordMatchesUrl('https://x/jobs/search/', 'Retail Architect'));
    const rebuilt = new URL(withKeyword(BASE, 'Retail Architect'));
    ok('la navegacion de respaldo conserva TODOS los filtros',
      rebuilt.searchParams.get('location') === 'Barcelona' &&
      rebuilt.searchParams.get('f_TPR') === 'r604800' &&
      rebuilt.searchParams.get('f_JT') === 'F' &&
      rebuilt.searchParams.get('keywords') === 'Retail Architect');
  }

  // ---------- 1. exito al primer intento ----------
  section('1. Query changes successfully on the first attempt');
  {
    const page = makePage();
    const r = await changeSearchQuery(page, 'Retail Architect', OPTS);
    ok('changed=true', r.changed === true, JSON.stringify(r));
    ok('un solo intento', r.attempts === 1, String(r.attempts));
    ok('confirmado por la caja de busqueda', r.confirmedBy === 'search_box');
    ok('sin failureReason', r.failureReason === null);
    ok('la URL quedo con la query pedida', keywordMatchesUrl(page.state.url, 'Retail Architect'), page.state.url);
    ok('no hizo falta navegar', page.state.gotos.length === 0);
    ok('la caja se vacio antes de escribir', page.state.fills[0] === '');
    ok('se cerro el typeahead antes del Enter', page.state.escapes >= 1 && page.state.typeaheadOpen === false);
  }

  // ---------- 2. falla el primero, funciona el segundo ----------
  section('2. First attempt fails, second succeeds');
  {
    const page = makePage({ onEnter: (s, n) => (n === 1 ? 'nothing' : 'submit') });
    const r = await changeSearchQuery(page, 'Retail Architect', OPTS);
    ok('changed=true', r.changed === true, JSON.stringify(r));
    ok('dos intentos', r.attempts === 2, String(r.attempts));
    ok('sin navegacion de respaldo (basto la caja)', page.state.gotos.length === 0);
    ok('URL correcta', keywordMatchesUrl(page.state.url, 'Retail Architect'));
  }

  // ---------- 3. se escribe pero no se envia (typeahead se come el Enter) ----------
  section('3. Text entered but submission/navigation never happens');
  {
    const page = makePage({ onEnter: () => 'nothing' });
    const r = await changeSearchQuery(page, 'Retail Architect', OPTS);
    ok('el respaldo por URL rescata la transicion', r.changed === true, JSON.stringify(r));
    ok('agoto los intentos de caja y navego', r.attempts === 3 && r.confirmedBy === 'url_navigation');
    ok('navego exactamente una vez', page.state.gotos.length === 1, String(page.state.gotos.length));
    ok('la navegacion llevo la query correcta', keywordMatchesUrl(page.state.gotos[0], 'Retail Architect'), page.state.gotos[0]);
    ok('y conservo los filtros', /f_TPR=r604800/.test(page.state.gotos[0]) && /location=Barcelona/.test(page.state.gotos[0]));

    // Si ni siquiera la navegacion cambia la URL, se falla en vez de aceptar.
    const stuck = makePage({ onEnter: () => 'nothing', onGoto: () => 'ignore' });
    const r2 = await changeSearchQuery(stuck, 'Retail Architect', OPTS);
    ok('sin confirmacion no hay changed=true', r2.changed === false);
    ok('motivo registrado', r2.failureReason === QUERY_CHANGE_FAILURES.NOT_CONFIRMED, r2.failureReason);
  }

  // ---------- 4. keyword anterior detectado y rechazado ----------
  section('4. Stale previous query is detected and rejected');
  {
    // Enter no hace nada y la URL sigue teniendo "Previous Query": el gate NO
    // debe darlo por bueno aunque la pagina tenga resultados cargados.
    const page = makePage({ onEnter: () => 'nothing', onGoto: () => 'ignore' });
    const r = await changeSearchQuery(page, 'Retail Architect', OPTS);
    ok('no acepta el keyword anterior', r.changed === false, JSON.stringify(r));
    ok('la URL sigue siendo la vieja (no se contamina)', keywordMatchesUrl(page.state.url, 'Previous Query'));

    // Una sugerencia del typeahead lanza OTRA busqueda: tampoco vale.
    const hijacked = makePage({ onEnter: () => 'Solution Architect', onGoto: () => 'ignore' });
    const r2 = await changeSearchQuery(hijacked, 'Retail Architect', OPTS);
    ok('rechaza la busqueda de una sugerencia distinta', r2.changed === false);
    ok('nunca confirma una query que no es la pedida', !keywordMatchesUrl(hijacked.state.url, 'Retail Architect'));

    // Deriva DESPUES de confirmar: LinkedIn reescribe el keyword mientras carga
    // la pagina. Lo que hay en pantalla ya no es lo pedido y no puede aceptarse.
    const makeDrifting = (driftTimes) => {
      let drifts = 0;
      const p = makePage({ onEnter: () => 'submit' });
      const original = p.waitForLoadState;
      p.waitForLoadState = async (...args) => {
        await original(...args);
        if (drifts < driftTimes) {
          drifts += 1;
          const u = new URL(p.state.url);
          u.searchParams.set('keywords', 'Something Else');
          p.state.url = u.toString();
        }
      };
      return p;
    };

    // Deriva siempre -> nunca se acepta, y el motivo es la deriva.
    const always = makeDrifting(Infinity);
    const r3 = await changeSearchQuery(always, 'Retail Architect', OPTS);
    ok('deriva persistente => no se acepta', r3.changed === false, JSON.stringify(r3));
    ok('motivo = keyword_drifted_after_load', r3.failureReason === QUERY_CHANGE_FAILURES.DRIFTED, r3.failureReason);
    ok('agoto los intentos acotados', r3.attempts === 3);

    // Deriva una vez -> el intento derivado se descarta y se reintenta.
    const once = makeDrifting(1);
    const r4 = await changeSearchQuery(once, 'Retail Architect', OPTS);
    ok('deriva puntual: se descarta ese intento y se reintenta', r4.changed === true && r4.attempts === 2, JSON.stringify(r4));
    ok('termina con la query pedida activa', keywordMatchesUrl(once.state.url, 'Retail Architect'), once.state.url);
  }

  // ---------- 5. fallo final => query_change_failed ----------
  section('5. Final failure produces query_change_failed');
  {
    const failing = () => makePage({ onEnter: () => 'nothing', onGoto: () => 'ignore' });
    const queries = [
      { query: 'First Query', family: 'user', familyLabel: 'User targets' },
      { query: 'Second Query', family: 'user', familyLabel: 'User targets' },
    ];
    const page = failing();
    // La primera query usa initializeSearchWithFilters, que aqui se inyecta.
    const result = await collectMultipleSearches(page, queries, { location: 'Barcelona' }, {
      searchScope: null,
      maxResultsPerSearch: 5,
      maxPagesPerSearch: 1,
      changeSearchQueryImpl: async () => ({ changed: false, attempts: 3, failureReason: QUERY_CHANGE_FAILURES.NOT_CONFIRMED, confirmedBy: null }),
      initializeSearchWithFiltersImpl: async () => ({ filtersActive: {} }),
      collectCurrentSearchImpl: async () => ({ jobs: [{ jobId: 'A1', title: 'Arquitecto retail', url: 'u1' }], metadata: { rawResults: 1, uniqueResults: 1, pagesVisited: 1, stopReason: 'done', filtersActive: {} } }),
    });
    const second = result.perQuery.find((q) => q.query === 'Second Query');
    ok('la query fallida queda registrada', !!second, JSON.stringify(result.perQuery.map((q) => q.query)));
    ok('status = query_change_failed', second && second.status === 'query_change_failed', second && second.status);
    ok('stopReason preservado', second && second.stopReason === 'query_change_failed');
    ok('motivo concreto', second && second.failureReason === QUERY_CHANGE_FAILURES.NOT_CONFIRMED, second && second.failureReason);
    ok('intentos registrados', second && second.attempts === 3);
    ok('no cuenta como ejecutada', result.metadata.searches.completed === 1 && result.metadata.searches.total === 2);

    // ---------- 6. no contamina los resultados de la query anterior ----------
    section('6. A failed query does not contaminate the previous query results');
    ok('la query fallida aporta 0 resultados crudos', second && second.rawResults === 0);
    ok('y 0 contribucion unica', second && second.uniqueContribution === 0);
    ok('solo la query buena atribuye jobs', result.jobs.length === 1 && result.jobs[0].matchedQueries.join(',') === 'First Query',
      JSON.stringify(result.jobs.map((j) => j.matchedQueries)));
    ok('el total de unicos no crece con la fallida', result.metadata.results.uniqueResults === 1);
    const first = result.perQuery.find((q) => q.query === 'First Query');
    ok('la query buena queda como completed', first && first.status === 'completed');
    ok('con su contribucion unica', first && first.uniqueContribution === 1);
    ok('cada outcome trae startedAt y completedAt', result.perQuery.every((q) => typeof q.startedAt === 'string' && typeof q.completedAt === 'string'));
  }

  // ---------- 7. el desenlace por query se reporta end-to-end ----------
  section('7. Per-query outcome is reported through the pipeline and the run status');
  {
    const perQuery = [
      { query: 'Retail Architect', family: 'user', status: 'completed', rawResults: 12, uniqueResults: 9, uniqueContribution: 4, pagesVisited: 1, attempts: 1, confirmedBy: 'search_box', failureReason: null, stopReason: 'done', startedAt: '2026-09-21T21:00:00.000Z', completedAt: '2026-09-21T21:01:00.000Z' },
      { query: 'Senior Retail Architect', family: 'user', status: 'query_change_failed', rawResults: 0, uniqueResults: 0, uniqueContribution: 0, pagesVisited: 0, attempts: 3, confirmedBy: null, failureReason: 'keyword_not_confirmed', stopReason: 'query_change_failed', startedAt: '2026-09-21T21:01:00.000Z', completedAt: '2026-09-21T21:01:40.000Z' },
    ];
    const svc = tmpSvc();
    const summary = await runPipeline({
      jobService: svc, analyzeLimit: 5, analysisTarget: 5,
      discover: async () => ({ jobs: [{ jobId: 'J1', title: 'Arquitecto retail', matchedQueries: ['Retail Architect'], matchedFamilies: ['user'] }],
        discovery: { queriesExecuted: 1, rawResults: 12, duplicatesRemoved: 3, perQuery } }),
      fetchDetails: (j) => Promise.resolve({ ...j, description: 'd', descriptionLength: 1 }),
      analyze: null,
    });
    ok('el pipeline transporta perQuery', Array.isArray(summary.discovery.perQuery) && summary.discovery.perQuery.length === 2);
    ok('sin perQuery el campo es null (callers antiguos siguen valiendo)',
      (await runPipeline({ jobService: tmpSvc(), analyzeLimit: 0, discover: async () => ({ jobs: [], discovery: {} }), fetchDetails: async (j) => j, analyze: null })).discovery.perQuery === null);

    // El estado del run lo sanea con lista blanca, igual que el resto del summary.
    const { safeSummary } = require('../run/huntRunManager');
    const safe = safeSummary({ discovery: { queriesExecuted: 1, perQuery }, analysis: {}, persistence: {} });
    ok('el run status expone perQuery', Array.isArray(safe.discovery.perQuery) && safe.discovery.perQuery.length === 2);
    ok('conserva query, status, motivo e intentos',
      safe.discovery.perQuery[1].query === 'Senior Retail Architect' &&
      safe.discovery.perQuery[1].status === 'query_change_failed' &&
      safe.discovery.perQuery[1].failureReason === 'keyword_not_confirmed' &&
      safe.discovery.perQuery[1].attempts === 3);
    ok('conserva raw / contribucion unica / tiempos',
      safe.discovery.perQuery[0].rawResults === 12 &&
      safe.discovery.perQuery[0].uniqueContribution === 4 &&
      safe.discovery.perQuery[0].startedAt === '2026-09-21T21:00:00.000Z' &&
      safe.discovery.perQuery[0].completedAt === '2026-09-21T21:01:00.000Z');
    const dirty = safeSummary({ discovery: { perQuery: [{ query: 'x'.repeat(500), status: { evil: true }, attempts: 'NaN' }] }, analysis: {}, persistence: {} });
    ok('sanea tipos y longitudes', dirty.discovery.perQuery[0].query.length === 200 && dirty.discovery.perQuery[0].status === null && dirty.discovery.perQuery[0].attempts === null);
    ok('perQuery ausente sigue siendo null', safeSummary({ discovery: {}, analysis: {}, persistence: {} }).discovery.perQuery === null);
    ok('el resto del summary no cambio de forma',
      Object.keys(safe).join(',') === 'runId,stoppedByChallenge,challenge,discovery,analysis,persistence');
  }

  // ---------- 8. dedup y priorizacion intactos ----------
  section('8. Deduplication and candidate prioritization are unchanged');
  {
    const { prioritizeCandidates } = require('../domain/candidatePriority');
    const QUERIES = ['Arquitecto retail', 'Retail Architect', 'Retail Project Manager'];
    const j = (id, title) => ({ jobId: id, title, company: 'c', location: 'Barcelona', url: 'u', easyApply: true, matchedQueries: ['Retail Architect'], matchedFamilies: ['user'] });
    const out = prioritizeCandidates([j('sol', 'Solution Architect'), j('ai', 'AI Architect'), j('real', 'Arquitecto retail obras')], { queries: QUERIES });
    ok('la priorizacion sigue poniendo el dominio primero', out[0].jobId === 'real');
    ok('sigue sin borrar nada', out.length === 3);

    // Dedup dentro de multiSearch: el mismo jobId desde dos queries se fusiona.
    const page = makePage();
    const result = await collectMultipleSearches(page, [
      { query: 'Q1', family: 'user', familyLabel: 'User' },
      { query: 'Q2', family: 'user', familyLabel: 'User' },
    ], { location: 'Barcelona' }, {
      initializeSearchWithFiltersImpl: async () => ({ filtersActive: {} }),
      changeSearchQueryImpl: async () => ({ changed: true, attempts: 1, failureReason: null, confirmedBy: 'search_box' }),
      collectCurrentSearchImpl: async () => ({ jobs: [{ jobId: 'DUP', title: 'Arquitecto retail', url: 'u' }], metadata: { rawResults: 1, uniqueResults: 1, pagesVisited: 1, stopReason: 'done', filtersActive: {} } }),
    });
    ok('el jobId repetido se fusiona en uno', result.jobs.length === 1, String(result.jobs.length));
    ok('acumula ambas queries (union)', result.jobs[0].matchedQueries.sort().join(',') === 'Q1,Q2', result.jobs[0].matchedQueries.join(','));
    ok('rawResults cuenta ambas apariciones', result.metadata.results.rawResults === 2);
    ok('duplicatesRemoved sigue calculandose igual', result.metadata.results.duplicatesRemoved === 1);
    ok('la segunda query reporta 0 contribucion unica', result.perQuery[1].uniqueContribution === 0);
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((error) => { console.error('UNCAUGHT: ' + (error && error.stack ? error.stack : error)); process.exitCode = 1; });

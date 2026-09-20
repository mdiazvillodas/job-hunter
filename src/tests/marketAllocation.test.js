'use strict';

// MD7.2 — reparto ADAPTATIVO del presupuesto inicial de evaluacion + cableado
// de las queries actuales de Hunter hacia la comparacion de MD6.
//
// Regresion de lo observado en la cuarta corrida real (mdrun_38e4572f7635d05a):
// el reparto round-robin daba los mismos turnos a familias que producian
// evidencia compatible y a familias que llevaban decenas de resultados sin
// producir ninguna, de modo que el presupuesto se agotaba antes de llegar a los
// candidatos mas prometedores.
//
// Esto NO cambia ningun presupuesto: cambia a QUIEN se le dan los turnos que ya
// existian.
//
// Determinista: sin LinkedIn, sin Chromium, sin OpenAI, sin red.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createExplorationEngine } = require('../marketDiscovery/explorationEngine');
const { STOP_REASONS, DEFAULT_BUDGET, HARD_CAPS, POLICY } = require('../marketDiscovery/explorationBudget');
const { buildQueryPortfolio } = require('../marketDiscovery/queryPortfolio');
const { createMarketDiscoveryRunManager } = require('../run/marketDiscoveryRunManager');
const { createMarketDiscoveryRunStore } = require('../marketDiscovery/runStore');
const { OPERATION_TYPES, createOwner } = require('../domain/operationOwner');

let passed = 0;
const roots = [];
function test(name, fn) { fn(); passed += 1; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed += 1; console.log('[PASS] ' + name); }
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md72-')); roots.push(dir); return dir; }

const OWNER = createOwner(OPERATION_TYPES.MARKET_DISCOVERY, 'md_alloc1');
const PROFILE = Object.freeze({ exclusions: [] });
const familyId = (n) => `family-${String(n).repeat(16).slice(0, 16)}`;

// Cada familia devuelve `perFamily` ofertas propias, con ids disjuntos.
function seedPlanFor(count) {
  const seeds = Array.from({ length: count }, (_, i) => ({
    familyId: familyId(i + 1), expression: `Family ${String.fromCharCode(65 + i)}`, language: 'en', rank: i + 1,
  }));
  return () => ({ seeds, familiesConsidered: count, familiesSelected: count, truncated: false, omittedFamilies: [], priority: [] });
}

const card = (id, extra = {}) => ({
  jobId: String(id), url: `https://www.linkedin.com/jobs/view/${id}/`,
  title: `Title ${id}`, company: `Company ${id}`, location: 'Somewhere', ...extra,
});

// Fuente: familia i (1-based) produce ids i01..i{perFamily}, salvo overrides.
function sourceFor(families, perFamily, overrides = {}) {
  return {
    search: async (request) => {
      const index = Number(String(request.search.familyId).replace(/\D/g, '').slice(0, 1));
      const ids = overrides[request.search.query]
        || Array.from({ length: perFamily }, (_, n) => `${index}${String(n + 1).padStart(2, '0')}`);
      const results = ids.map((id, position) => ({ ...card(id), searchId: request.search.searchId, position: position + 1 }));
      return {
        status: 'COMPLETED', stopReason: 'no_next_page', results,
        metrics: { rawCards: results.length, uniqueResults: results.length, duplicatesWithinSearch: 0, pagesVisited: 1, limitReached: false },
        observedScope: { location: 'VERIFIED' }, requestedScope: { location: 'Somewhere' }, challenge: null,
      };
    },
  };
}

// Evaluador: clasifica por id segun una funcion. Cuenta llamadas por posting.
function evaluatorFor(classify) {
  const seen = [];
  return {
    seen,
    evaluator: {
      evaluatePosting: async (request) => {
        const id = request.posting.postingId;
        seen.push(id);
        const outcome = classify(id) || 'OUT_OF_SCOPE';
        if (typeof outcome === 'object' && outcome.throws) {
          const error = new Error('boom'); error.name = outcome.throws; error.code = outcome.code || 'X';
          error.safeMessage = 'bounded'; throw error;
        }
        const promotable = outcome === 'COMPATIBLE';
        return {
          classification: outcome, dimensions: {}, identity: { cacheKey: 'k_' + id },
          terminology: promotable
            ? [{ type: 'ROLE_TITLE', expression: 'Term ' + id, normalized: 'term ' + id, sourceField: 'title', eligibility: 'ELIGIBLE', promotable: true }]
            : [],
        };
      },
    },
  };
}

const explore = (engine, budget) => engine.explore({
  owner: OWNER, page: {}, profile: PROFILE, filters: { location: 'Somewhere' }, budget,
});

// Presupuesto acotado que conserva las proporciones reales del producto.
const BUDGET = { maxSearches: 10, maxInitialSearches: 6, maxExpansionSearches: 4, maxEvaluations: 60, initialEvaluationReserve: 36, expansionEvaluationReserve: 24 };
const alloc = (ledger, n) => ledger.families[n - 1].allocation;
const turnsOf = (ledger, n) => alloc(ledger, n).evaluationTurns;

(async () => {
  console.log('\n### A-B. muestra minima y ausencia de inanicion');

  await testAsync('A. toda familia recibe al menos la muestra minima', async () => {
    // Solo la familia 1 produce compatibles; ninguna debe quedarse sin muestra.
    const { evaluator } = evaluatorFor((id) => (id.startsWith('1') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine, BUDGET);
    for (let f = 1; f <= 5; f += 1) {
      assert.ok(alloc(ledger, f).observedEvaluated >= POLICY.minFamilyEvaluationSample,
        `family ${f} got ${alloc(ledger, f).observedEvaluated}, below the minimum sample`);
      assert.equal(alloc(ledger, f).minimumSampleMet, true);
    }
  });

  await testAsync('B. ninguna familia se queda sin turnos antes de su muestra minima', async () => {
    // La familia 1 es compatible desde su primer resultado: aun asi, las demas
    // tienen que alcanzar su muestra antes de que nadie reciba extras.
    const order = [];
    const { evaluator } = evaluatorFor((id) => { order.push(id); return id.startsWith('1') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'; });
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
    await explore(engine, BUDGET);
    // En los primeros 5*minSample turnos ninguna familia puede superar su minimo.
    const firstWindow = order.slice(0, 5 * POLICY.minFamilyEvaluationSample);
    for (let f = 1; f <= 5; f += 1) {
      const count = firstWindow.filter((id) => id.startsWith(String(f))).length;
      assert.ok(count <= POLICY.minFamilyEvaluationSample, `family ${f} took ${count} turns inside the minimum window`);
    }
  });

  console.log('\n### C-E. explotacion segun evidencia observada');

  await testAsync('C. una familia productiva recibe MAS turnos que una de rendimiento cero', async () => {
    const { evaluator } = evaluatorFor((id) => (id.startsWith('1') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine, BUDGET);
    const productive = turnsOf(ledger, 1);
    for (let f = 2; f <= 5; f += 1) {
      assert.ok(productive > turnsOf(ledger, f),
        `productive family got ${productive}, zero-yield family ${f} got ${turnsOf(ledger, f)}`);
    }
    assert.equal(alloc(ledger, 1).state, 'PRIORITIZED');
    assert.equal(alloc(ledger, 2).state, 'DEPRIORITIZED');
    assert.ok(/no compatible evidence/.test(alloc(ledger, 2).stateReason));
  });

  await testAsync('D. con UNA sola familia productiva, esa concentra los turnos restantes', async () => {
    const { evaluator } = evaluatorFor((id) => (id.startsWith('3') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine, BUDGET);
    const winner = turnsOf(ledger, 3);
    const others = [1, 2, 4, 5].map((f) => turnsOf(ledger, f));
    assert.ok(others.every((t) => winner > t), `winner ${winner} vs others ${others}`);
    // Y las de rendimiento cero siguen recibiendo sondas acotadas, no cero.
    assert.ok([1, 2, 4, 5].every((f) => alloc(ledger, f).probes >= 1), 'zero-yield families keep bounded probing');
  });

  await testAsync('E. con VARIAS familias productivas, todas se priorizan sobre las de cero', async () => {
    const { evaluator } = evaluatorFor((id) => ((id.startsWith('1') || id.startsWith('4')) ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine, BUDGET);
    const productive = [turnsOf(ledger, 1), turnsOf(ledger, 4)];
    const zero = [turnsOf(ledger, 2), turnsOf(ledger, 3), turnsOf(ledger, 5)];
    assert.ok(Math.min(...productive) > Math.max(...zero), `productive ${productive} vs zero ${zero}`);
    for (const f of [1, 4]) assert.equal(alloc(ledger, f).state, 'PRIORITIZED');
  });

  console.log('\n### F. arranque en frio');

  await testAsync('F. sin ninguna evidencia compatible la exploracion NO se detiene ni se sesga', async () => {
    const { evaluator, seen } = evaluatorFor(() => 'OUT_OF_SCOPE');
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine, BUDGET);
    assert.equal(seen.length, 36, 'the whole initial reserve is still spent');
    const turns = [1, 2, 3, 4, 5].map((f) => turnsOf(ledger, f));
    // Reparto equitativo: ninguna familia puede llevar mas de un turno de ventaja
    // sobre otra cuando no hay nada que explotar.
    assert.ok(Math.max(...turns) - Math.min(...turns) <= 1, 'cold start must stay even, got ' + turns.join('/'));
  });

  await testAsync('F2. una compatible TARDIA en la cola sigue siendo alcanzable', async () => {
    // 5 familias x 6 ofertas = 30 candidatos, por debajo de la reserva de 36:
    // todo lo alcanzable DEBE alcanzarse. La unica compatible es el ULTIMO
    // resultado de la ultima familia; si la politica matara a las familias sin
    // evidencia temprana, nunca se encontraria.
    const { evaluator, seen } = evaluatorFor((id) => (id === '506' ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(5, 6), evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine, BUDGET);
    assert.equal(seen.length, 30, 'everything within budget is evaluated');
    const found = ledger.postings.filter((p) => p.classification === 'COMPATIBLE');
    assert.equal(found.length, 1, 'the late compatible posting was reached');
    assert.equal(found[0].postingId, '506');
  });

  console.log('\n### G-I. determinismo y presupuesto');

  await testAsync('G. el reparto es determinista y reproducible', async () => {
    const run = async () => {
      const { evaluator } = evaluatorFor((id) => (id.startsWith('2') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
      const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
      const ledger = await explore(engine, BUDGET);
      return ledger.families.map((f) => f.allocation.evaluationTurns).join('/');
    };
    const a = await run();
    const b = await run();
    assert.equal(a, b, 'two identical runs must allocate identically');
  });

  await testAsync('H. el presupuesto sigue acotado EXACTAMENTE igual', async () => {
    const { evaluator, seen } = evaluatorFor((id) => (id.startsWith('1') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine, BUDGET);
    const initialEvaluations = ledger.evaluations.filter((e) => e.depth === 0).length;
    assert.ok(initialEvaluations <= BUDGET.initialEvaluationReserve, 'initial reserve respected');
    assert.ok(seen.length <= BUDGET.maxEvaluations, 'total evaluations respected');
    assert.equal(ledger.budget.limits.initialEvaluationReserve, 36);
    assert.equal(ledger.budget.limits.maxEvaluations, 60);
    assert.equal(HARD_CAPS.initialEvaluationReserve, 36);
    assert.equal(HARD_CAPS.maxEvaluations, 60);
    assert.equal(DEFAULT_BUDGET.maxSemanticFailures, 3);
  });

  await testAsync('I. la reserva de expansion sigue protegida', async () => {
    const { evaluator } = evaluatorFor((id) => (id.startsWith('1') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine, BUDGET);
    const initial = ledger.evaluations.filter((e) => e.depth === 0).length;
    assert.ok(initial <= BUDGET.initialEvaluationReserve,
      'the initial phase can never eat the expansion reserve: ' + initial);
    assert.ok(BUDGET.maxEvaluations - initial >= 0);
  });

  console.log('\n### J-L. dedup global y atribucion');

  // Familias 1 y 2 comparten EXACTAMENTE las mismas ofertas.
  const SHARED = { 'Family A': ['900', '901', '902', '903', '904'], 'Family B': ['900', '901', '902', '903', '904'] };

  await testAsync('J+K. una oferta compartida se evalua UNA sola vez', async () => {
    const { evaluator, seen } = evaluatorFor(() => 'OUT_OF_SCOPE');
    const engine = createExplorationEngine({ source: sourceFor(2, 5, SHARED), evaluator, seedPlanner: seedPlanFor(2) });
    const ledger = await explore(engine, BUDGET);
    assert.equal(ledger.postings.length, 5, 'dedup global: 5 ofertas unicas');
    assert.equal(seen.length, 5, 'cada oferta se evaluo exactamente una vez');
    assert.equal(new Set(seen).size, 5);
    // La atribucion se conserva para AMBAS familias.
    for (const posting of ledger.postings) assert.equal(posting.familyIds.length, 2, 'attribution preserved');
  });

  await testAsync('L. una oferta compartida NO se cuenta dos veces como evidencia', async () => {
    const { evaluator } = evaluatorFor((id) => (id === '900' ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(2, 5, SHARED), evaluator, seedPlanner: seedPlanFor(2) });
    const ledger = await explore(engine, BUDGET);
    const compatibleKeys = ledger.postings.filter((p) => p.classification === 'COMPATIBLE').map((p) => p.postingKey);
    assert.equal(compatibleKeys.length, 1, 'one compatible POSTING, not one per family');
    // El candidato de expansion cuenta OFERTAS distintas, no atribuciones.
    for (const candidate of ledger.expansion.candidates) {
      assert.equal(candidate.distinctPostings, 1, 'a shared posting is one posting of evidence');
      assert.equal(candidate.distinctCompanies, 1);
      assert.equal(candidate.eligible, false, 'one posting cannot promote a term');
    }
  });

  console.log('\n### M-P. comportamientos que NO cambian');

  await testAsync('M. la cancelacion sigue cortando de inmediato', async () => {
    const controller = new AbortController();
    let n = 0;
    const { evaluator } = evaluatorFor(() => { n += 1; if (n === 3) controller.abort(); return 'OUT_OF_SCOPE'; });
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await engine.explore({ owner: OWNER, page: {}, profile: PROFILE, filters: {}, budget: BUDGET, signal: controller.signal });
    assert.equal(ledger.stopReason, STOP_REASONS.CANCELLED);
    assert.ok(n <= 4, 'no sigue evaluando tras la cancelacion');
  });

  await testAsync('N. el manejo de fallos semanticos no cambia (umbral 3)', async () => {
    const { evaluator } = evaluatorFor(() => ({ throws: 'SemanticContractError', code: 'EVIDENCE_LIMIT_EXCEEDED' }));
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine, BUDGET);
    assert.equal(ledger.stopReason, STOP_REASONS.SEMANTIC_FAILED);
    assert.equal(ledger.failures.semantic.length, 3);
    assert.equal(ledger.failures.semantic[0].code, 'EVIDENCE_LIMIT_EXCEEDED');
  });

  await testAsync('O. el manejo de fallos de detalle no cambia', async () => {
    const { evaluator } = evaluatorFor(() => 'OUT_OF_SCOPE');
    const enricher = { enrich: async () => ({ outcome: 'DETAIL_FAILED' }) };
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5), enricher });
    const ledger = await explore(engine, BUDGET);
    assert.equal(ledger.stopReason, STOP_REASONS.DETAIL_FAILED);
    assert.equal(ledger.detail.failed, DEFAULT_BUDGET.maxDetailFailures);
  });

  await testAsync('P. el manejo de fallos de fuente no cambia', async () => {
    const failing = { search: async () => ({ status: 'FAILED', stopReason: 'source_failed', results: [], metrics: null, challenge: null }) };
    const { evaluator } = evaluatorFor(() => 'OUT_OF_SCOPE');
    const engine = createExplorationEngine({ source: failing, evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine, BUDGET);
    assert.equal(ledger.stopReason, STOP_REASONS.SOURCE_FAILED);
    assert.equal(ledger.failures.source.length, DEFAULT_BUDGET.maxSourceFailures);
  });

  console.log('\n### Q-T. queries actuales de Hunter hacia MD6');

  const LEDGER_FOR_MD6 = async () => {
    const { evaluator } = evaluatorFor((id) => (id.startsWith('1') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(2, 10), evaluator, seedPlanner: seedPlanFor(2) });
    return explore(engine, BUDGET);
  };

  await testAsync('Q. las queries ACTIVAS configuradas llegan a la comparacion de MD6', async () => {
    const exploration = await LEDGER_FOR_MD6();
    const queryGroups = [{ family: 'user', enabled: true, queries: [{ query: 'Family A', enabled: true }, { query: 'Arquitecto retail', enabled: true }] }];
    const proposal = buildQueryPortfolio({ exploration, profile: PROFILE, currentQueries: { queryGroups } });
    assert.ok(Array.isArray(proposal.currentQueryComparison), 'comparison is produced');
    assert.equal(proposal.currentQueryComparison.length, 2);
    const tested = proposal.currentQueryComparison.find((row) => row.normalized === 'family a');
    const untested = proposal.currentQueryComparison.find((row) => row.normalized === 'arquitecto retail');
    assert.ok(tested.test, 'a query executed in this exploration carries its test');
    assert.equal(untested.status, 'NOT_SUPPORTED_BY_THIS_SAMPLE');
    assert.ok(/says nothing about it/.test(untested.note), 'absence is never treated as failure');
  });

  await testAsync('Q2. sin queries actuales la comparacion queda null, nunca inventada', async () => {
    const exploration = await LEDGER_FOR_MD6();
    const proposal = buildQueryPortfolio({ exploration, profile: PROFILE });
    assert.equal(proposal.currentQueryComparison, null);
  });

  await testAsync('R+S+T. el run manager pasa las queries actuales SIN mutarlas ni aplicarlas', async () => {
    const dataDir = temp();
    const configured = { queryGroups: [{ family: 'user', enabled: true, queries: [{ query: 'Family A', enabled: true }] }] };
    const snapshot = JSON.stringify(configured);
    let received = null;
    const manager = createMarketDiscoveryRunManager({
      runStore: createMarketDiscoveryRunStore({ dataDir }),
      setupService: { getStatus: () => ({ readyForHunt: true }) },
      profileLoader: () => PROFILE,
      seedPlanner: seedPlanFor(2),
      resolveFilters: () => ({ location: 'Somewhere' }),
      resolveCurrentQueries: () => configured,
      acquireLock: () => ({}), releaseLock: () => true,
      openSession: async () => ({ context: { close: async () => {} }, page: {} }),
      source: sourceFor(2, 10),
      evaluator: evaluatorFor((id) => (id.startsWith('1') ? 'COMPATIBLE' : 'OUT_OF_SCOPE')).evaluator,
      explorationBudget: BUDGET,
      buildPortfolio: (input) => {
        received = input.currentQueries;
        return buildQueryPortfolio(input);
      },
    });
    const started = await manager.start();
    await manager.waitForIdle();
    // Q: llegaron.
    assert.ok(received && Array.isArray(received.queryGroups), 'current queries reached MD6');
    assert.equal(received.queryGroups[0].queries[0].query, 'Family A');
    // R: intactas byte a byte.
    assert.equal(JSON.stringify(configured), snapshot, 'current queries must not be mutated');
    // S: la propuesta sigue sin aplicarse.
    const proposal = manager.getProposal(started.runId);
    assert.ok(proposal, 'a proposal exists');
    assert.equal(proposal.applied, false);
    assert.ok(Array.isArray(proposal.currentQueryComparison), 'comparison persisted');
  });

  test('T2. no se introduce ninguna ejecucion de Hunter', () => {
    const source = fs.readFileSync(path.join(__dirname, '../run/marketDiscoveryRunManager.js'), 'utf8');
    // Se juzga el CODIGO, no los comentarios: la cabecera del modulo cita esas
    // rutas precisamente para declarar que NO se usan.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['runPipeline', 'huntRunManager', 'collectMultipleSearches', 'analyzeJobs']) {
      assert.ok(!code.includes(forbidden), 'market discovery must not reach Hunter execution: ' + forbidden);
    }
    // Lectura de configuracion, nunca escritura.
    assert.ok(!/saveUserConfig|writeUserConfig|updateUserConfig/.test(code), 'no config mutation');
    assert.ok(/getUserConfig/.test(code), 'current queries are read from the canonical config');
  });

  console.log('\n### Observabilidad');

  await testAsync('U. el artefacto explica por que cada familia recibio sus turnos', async () => {
    const { evaluator } = evaluatorFor((id) => (id.startsWith('1') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(5, 10), evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine, BUDGET);
    for (const family of ledger.families) {
      const a = family.allocation;
      assert.ok(a, 'every family carries its allocation record');
      for (const key of ['evaluationTurns', 'observedEvaluated', 'observedCompatible', 'probes', 'remainingCandidates', 'minimumSample', 'minimumSampleMet', 'phase', 'state', 'stateReason']) {
        assert.ok(key in a, 'missing allocation field: ' + key);
      }
      assert.ok(typeof a.stateReason === 'string' && a.stateReason.length > 0);
    }
    // Y no arrastra nada del contenido de las ofertas ni del modelo.
    const serialized = JSON.stringify(ledger.families);
    assert.ok(!serialized.includes('description') && !serialized.includes('rationale'), 'no posting or model content');
  });

  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nMD7.2 Adaptive Allocation: ${passed} tests passed`);
})().catch((error) => {
  for (const dir of roots) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* noop */ } }
  console.error('\n[FAIL]', error && error.stack ? error.stack : error);
  process.exit(1);
});

'use strict';

// MD9.1 — RECLAMO de la reserva de expansion no utilizada.
//
// Auditoria de la corrida 7 (artefactos persistidos): 36 de 60 evaluaciones
// usadas, 0 busquedas de expansion, 18 candidatos de expansion y NINGUNO
// elegible ("fewer than 2 distinct compatible postings"), con 64 candidatos
// iniciales sin evaluar. Resultado: 24 evaluaciones quedaron VARADAS.
//
// La reserva de expansion existe para GARANTIZAR la oportunidad de expandir, no
// para quedarse sin usar. Estos tests fijan que:
//   - el tope total sigue siendo maxEvaluations (nunca se ensancha);
//   - la fase inicial PROTEGIDA sigue acotada por su reserva;
//   - la expansion recibe su oportunidad ANTES de cualquier reclamo;
//   - solo el sobrante no consumido vuelve a las familias iniciales;
//   - el reclamo usa la MISMA politica adaptativa de MD7.2.
//
// Determinista: sin LinkedIn, sin Chromium, sin OpenAI, sin red.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const { createExplorationEngine } = require('../marketDiscovery/explorationEngine');
const { STOP_REASONS, HARD_CAPS, POLICY } = require('../marketDiscovery/explorationBudget');
const { OPERATION_TYPES, createOwner } = require('../domain/operationOwner');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed += 1; console.log('[PASS] ' + name); }

const OWNER = createOwner(OPERATION_TYPES.MARKET_DISCOVERY, 'md_reclaim');
const PROFILE = Object.freeze({ exclusions: [] });
const familyId = (n) => `family-${String(n).repeat(16).slice(0, 16)}`;
const BUDGET = { maxSearches: 10, maxInitialSearches: 6, maxExpansionSearches: 4, maxEvaluations: 60, initialEvaluationReserve: 36, expansionEvaluationReserve: 24 };

function seedPlanFor(count) {
  const seeds = Array.from({ length: count }, (_, i) => ({
    familyId: familyId(i + 1), expression: `Family ${String.fromCharCode(65 + i)}`, language: 'en', rank: i + 1,
  }));
  return () => ({ seeds, familiesConsidered: count, familiesSelected: count, truncated: false, omittedFamilies: [], priority: [] });
}
const card = (id) => ({ jobId: String(id), url: 'https://www.linkedin.com/jobs/view/' + id + '/', title: 'Title ' + id, company: 'Company ' + id, location: 'Somewhere' });

// Fuente: familias iniciales con ids propios; las busquedas de expansion
// (depth 1) devuelven ofertas NUEVAS y se cuentan aparte.
function sourceFor(perFamily, expansionResults = 0) {
  const calls = [];
  return {
    calls,
    source: {
      search: async (request) => {
        calls.push({ searchId: request.search.searchId, query: request.search.query, limits: request.limits });
        const expansion = String(request.search.searchId).startsWith('d1');
        const index = expansion ? 9 : Number(String(request.search.familyId).replace(/\D/g, '').slice(0, 1));
        const count = expansion ? expansionResults : perFamily;
        const ids = Array.from({ length: count }, (_, n) => `${index}${String(n + 1).padStart(3, '0')}`);
        const results = ids.map((id, position) => ({ ...card(id), searchId: request.search.searchId, position: position + 1 }));
        return {
          status: 'COMPLETED', stopReason: 'no_next_page', results,
          metrics: { rawCards: results.length, uniqueResults: results.length, duplicatesWithinSearch: 0, pagesVisited: 1, limitReached: false },
          observedScope: { location: 'VERIFIED' }, requestedScope: { location: 'Somewhere' }, challenge: null,
        };
      },
    },
  };
}

// `terms` permite que varias ofertas compartan un termino y produzcan un
// candidato de expansion ELEGIBLE (>=2 ofertas y >=2 empresas distintas).
function evaluatorFor(classify, termFor) {
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
        const expression = promotable ? (termFor ? termFor(id) : 'Term ' + id) : null;
        return {
          classification: outcome, dimensions: {}, identity: { cacheKey: 'k_' + id },
          terminology: expression
            ? [{ type: 'ROLE_TITLE', expression, normalized: expression.toLowerCase(), sourceField: 'title', eligibility: 'ELIGIBLE', promotable: true }]
            : [],
        };
      },
    },
  };
}

const explore = (engine, budget = BUDGET) => engine.explore({
  owner: OWNER, page: {}, profile: PROFILE, filters: { location: 'Somewhere' }, budget,
});
const phasesOf = (ledger) => ledger.budget.evaluationPhases;

(async () => {
  console.log('\n### A-B. el tope total y la fase protegida');

  await testAsync('A. maxEvaluations sigue siendo 60 y nunca se supera', async () => {
    const { evaluator, seen } = evaluatorFor(() => 'OUT_OF_SCOPE');
    const engine = createExplorationEngine({ source: sourceFor(18).source, evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine);
    assert.equal(HARD_CAPS.maxEvaluations, 60, 'el tope duro no se movio');
    assert.equal(ledger.budget.limits.maxEvaluations, 60);
    assert.ok(seen.length <= 60, 'nunca se evalua por encima del tope: ' + seen.length);
    assert.equal(phasesOf(ledger).total, seen.length);
    assert.equal(phasesOf(ledger).protectedInitial + phasesOf(ledger).expansion + phasesOf(ledger).reclaimed, phasesOf(ledger).total);
  });

  await testAsync('B. las primeras 36 siguen siendo la fase protegida', async () => {
    const { evaluator } = evaluatorFor(() => 'OUT_OF_SCOPE');
    const engine = createExplorationEngine({ source: sourceFor(18).source, evaluator, seedPlanner: seedPlanFor(5) });
    const phases = phasesOf(await explore(engine));
    assert.equal(phases.protectedInitial, BUDGET.initialEvaluationReserve, 'la reserva inicial se consume entera');
    assert.ok(phases.protectedInitial <= BUDGET.initialEvaluationReserve, 'y nunca la supera');
  });

  console.log('\n### C-E. la expansion cobra primero');

  await testAsync('C. con expansion ELEGIBLE, la expansion recibe su oportunidad antes del reclamo', async () => {
    // Dos ofertas de empresas distintas comparten termino -> candidato elegible.
    const shared = new Set(['1001', '2001']);
    const { evaluator } = evaluatorFor((id) => (shared.has(id) ? 'COMPATIBLE' : 'OUT_OF_SCOPE'), () => 'Shared Market Term');
    const built = sourceFor(18, 6);
    const engine = createExplorationEngine({ source: built.source, evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine);
    const phases = phasesOf(ledger);
    assert.ok(ledger.expansion.selected.length >= 1, 'hubo expansion elegible');
    assert.ok(phases.expansion > 0, 'la expansion consumio evaluaciones: ' + phases.expansion);
    assert.ok(ledger.searches.some((s) => s.depth === 1), 'se ejecuto una busqueda de expansion');
    assert.ok(phases.total <= BUDGET.maxEvaluations);
  });

  await testAsync('D. SIN expansion elegible, la reserva no consumida se reclama', async () => {
    // Cada compatible produce un termino distinto -> ningun candidato elegible,
    // que es exactamente lo observado en la corrida 7.
    const { evaluator } = evaluatorFor((id) => (id.startsWith('1') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const built = sourceFor(18);
    const engine = createExplorationEngine({ source: built.source, evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine);
    const phases = phasesOf(ledger);
    assert.equal(ledger.expansion.selected.length, 0, 'no habia expansion elegible');
    assert.equal(phases.expansion, 0);
    assert.equal(phases.reclaimed, BUDGET.maxEvaluations - BUDGET.initialEvaluationReserve, 'se reclamaron las 24');
    assert.equal(phases.total, BUDGET.maxEvaluations, 'no queda capacidad varada');
    assert.equal(phases.remaining, 0);
    assert.ok(/no eligible expansion terms/.test(phases.reclaimReason), phases.reclaimReason);
    assert.equal(built.calls.filter((c) => c.searchId.startsWith('d1')).length, 0, 'el reclamo NO lanza busquedas');
  });

  await testAsync('E. con expansion PARCIAL, solo se reclama el sobrante', async () => {
    const shared = new Set(['1001', '2001']);
    const { evaluator } = evaluatorFor((id) => (shared.has(id) ? 'COMPATIBLE' : 'OUT_OF_SCOPE'), () => 'Shared Market Term');
    // La busqueda de expansion solo devuelve 3 ofertas: no puede gastar las 24.
    const built = sourceFor(18, 3);
    const engine = createExplorationEngine({ source: built.source, evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine);
    const phases = phasesOf(ledger);
    assert.ok(phases.expansion > 0 && phases.expansion < BUDGET.expansionEvaluationReserve,
      'la expansion uso parte de su reserva: ' + phases.expansion);
    assert.ok(phases.reclaimed > 0, 'el sobrante se reclamo: ' + phases.reclaimed);
    assert.equal(phases.protectedInitial + phases.expansion + phases.reclaimed, phases.total);
    assert.ok(phases.total <= BUDGET.maxEvaluations);
    assert.ok(/did not consume its whole reserve/.test(phases.reclaimReason), phases.reclaimReason);
  });

  console.log('\n### F-G. el reclamo usa la politica de MD7.2');

  await testAsync('F. el reclamo prioriza a las familias con evidencia compatible', async () => {
    const { evaluator } = evaluatorFor((id) => (id.startsWith('1') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(18).source, evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine);
    const rows = ledger.families.map((f) => f.allocation);
    const productive = rows[0];
    assert.equal(productive.state, 'PRIORITIZED');
    assert.ok(productive.reclaimedTurns > 0, 'la familia productiva recibio turnos reclamados');
    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(productive.evaluationTurns > rows[i].evaluationTurns,
        'productiva ' + productive.evaluationTurns + ' vs cero-rendimiento ' + rows[i].evaluationTurns);
    }
    // Las de rendimiento cero siguen recibiendo sondas acotadas, no cero.
    assert.ok(rows.slice(1).every((r) => r.probes >= 1), 'se conservan las sondas');
  });

  await testAsync('G. arranque en frio: sin ninguna compatible, el reclamo reparte por igual', async () => {
    const { evaluator, seen } = evaluatorFor(() => 'OUT_OF_SCOPE');
    const engine = createExplorationEngine({ source: sourceFor(18).source, evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine);
    assert.equal(seen.length, BUDGET.maxEvaluations, 'se usa todo el presupuesto');
    const turns = ledger.families.map((f) => f.allocation.evaluationTurns);
    assert.ok(Math.max(...turns) - Math.min(...turns) <= 2, 'reparto equitativo: ' + turns.join('/'));
    // Y una compatible tardia sigue siendo alcanzable gracias al reclamo.
    const late = evaluatorFor((id) => (id === '5018' ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine2 = createExplorationEngine({ source: sourceFor(12).source, evaluator: late.evaluator, seedPlanner: seedPlanFor(5) });
    const ledger2 = await explore(engine2);
    assert.equal(ledger2.postings.filter((p) => p.classification === 'COMPATIBLE').length, 0,
      'ese id no existe con 12 por familia: el fixture no inventa evidencia');
    assert.equal(phasesOf(ledger2).total, Math.min(BUDGET.maxEvaluations, 5 * 12));
  });

  await testAsync('G2. la evidencia hallada DURANTE el reclamo llega al libro mayor', async () => {
    // Observado en la corrida 8: las dos ofertas compatibles aparecieron en las
    // evaluaciones 41 y 42, ya dentro del reclamo. La agregacion de terminos se
    // hace antes, asi que sin recalcular el libro mayor diria "0 candidatos"
    // aunque la corrida si produjo terminologia.
    // Posiciones 10 y 11: fuera del alcance de la fase protegida (~7 por familia)
    // y dentro del alcance del reclamo.
    const late = new Set(['1010', '2011']);
    const { evaluator } = evaluatorFor((id) => (late.has(id) ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
    const engine = createExplorationEngine({ source: sourceFor(18).source, evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine);
    assert.ok(phasesOf(ledger).reclaimed > 0, 'hubo reclamo');
    assert.ok(ledger.postings.some((x) => x.classification === 'COMPATIBLE'), 'la evidencia tardia existe');
    assert.ok(ledger.observations.some((o) => o.promotable), 'la terminologia esta en el libro mayor');
    assert.ok(ledger.expansion.candidates.length > 0,
      'los candidatos reflejan la evidencia del reclamo, no solo la previa');
    // La expansion NO se reabre: no se ejecuta ninguna busqueda tras el reclamo.
    assert.equal(ledger.searches.filter((x) => x.depth === 1).length, 0, 'el reclamo no reabre la expansion');
    for (const c of ledger.expansion.candidates) {
      if (c.eligible && !c.selected) assert.ok(/arrived during the reclaim phase/.test(c.selectionReason), c.selectionReason);
    }
  });

  console.log('\n### H-I. dedup y atribucion');

  await testAsync('H+I. el reclamo no reevalua ni duplica nada', async () => {
    const { evaluator, seen } = evaluatorFor(() => 'OUT_OF_SCOPE');
    const engine = createExplorationEngine({ source: sourceFor(18).source, evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine);
    assert.equal(new Set(seen).size, seen.length, 'ninguna oferta se evalua dos veces');
    const evaluated = ledger.postings.filter((p) => p.evaluated);
    assert.equal(evaluated.length, seen.length, 'el libro mayor coincide con las llamadas');
    for (const p of ledger.postings) assert.ok(p.familyIds.length >= 1, 'se conserva la atribucion');
  });

  console.log('\n### J-M. lo que NO cambia');

  await testAsync('J. fallos semanticos: umbral 3 intacto', async () => {
    const { evaluator } = evaluatorFor(() => ({ throws: 'SemanticContractError', code: 'EVIDENCE_LIMIT_EXCEEDED' }));
    const engine = createExplorationEngine({ source: sourceFor(18).source, evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await explore(engine);
    assert.equal(ledger.stopReason, STOP_REASONS.SEMANTIC_FAILED);
    assert.equal(ledger.failures.semantic.length, 3);
  });

  await testAsync('K. fallos de detalle: umbral intacto', async () => {
    const { evaluator } = evaluatorFor(() => 'OUT_OF_SCOPE');
    const enricher = { enrich: async () => ({ outcome: 'DETAIL_FAILED' }) };
    const engine = createExplorationEngine({ source: sourceFor(18).source, evaluator, seedPlanner: seedPlanFor(5), enricher });
    const ledger = await explore(engine);
    assert.equal(ledger.stopReason, STOP_REASONS.DETAIL_FAILED);
    assert.equal(ledger.detail.failed, HARD_CAPS.maxDetailFailures);
  });

  await testAsync('L. la cancelacion corta tambien durante el reclamo', async () => {
    const controller = new AbortController();
    let n = 0;
    const { evaluator } = evaluatorFor(() => { n += 1; if (n === 40) controller.abort(); return 'OUT_OF_SCOPE'; });
    const engine = createExplorationEngine({ source: sourceFor(18).source, evaluator, seedPlanner: seedPlanFor(5) });
    const ledger = await engine.explore({ owner: OWNER, page: {}, profile: PROFILE, filters: {}, budget: BUDGET, signal: controller.signal });
    assert.equal(ledger.stopReason, STOP_REASONS.CANCELLED);
    assert.ok(n <= 41, 'no sigue evaluando tras la cancelacion: ' + n);
    assert.ok(n > BUDGET.initialEvaluationReserve, 'la cancelacion ocurrio ya dentro del reclamo');
  });

  await testAsync('M. el reparto con reclamo es determinista', async () => {
    const run = async () => {
      const { evaluator } = evaluatorFor((id) => (id.startsWith('2') ? 'COMPATIBLE' : 'OUT_OF_SCOPE'));
      const engine = createExplorationEngine({ source: sourceFor(18).source, evaluator, seedPlanner: seedPlanFor(5) });
      const ledger = await explore(engine);
      return ledger.families.map((f) => f.allocation.evaluationTurns).join('/') + '|' + JSON.stringify(phasesOf(ledger));
    };
    assert.equal(await run(), await run(), 'dos corridas identicas reparten igual');
  });

  console.log('\n### N-Q. sin efectos fuera de su alcance');

  await testAsync('N. el reclamo no lanza busquedas ni pide mas paginas', async () => {
    const { evaluator } = evaluatorFor(() => 'OUT_OF_SCOPE');
    const built = sourceFor(18);
    const engine = createExplorationEngine({ source: built.source, evaluator, seedPlanner: seedPlanFor(5) });
    await explore(engine);
    assert.equal(built.calls.length, 5, 'exactamente una busqueda por familia inicial');
    for (const call of built.calls) assert.deepEqual(call.limits, { maxPages: 1, maxResults: 25 });
  });

  test('O+P+Q. umbrales, semillas y Hunter intactos', () => {
    const { PROMOTION, QUERY_TEST, PORTFOLIO } = require('../marketDiscovery/vocabularyPolicy');
    assert.equal(PROMOTION.minDistinctPostings, 3);
    assert.equal(PROMOTION.minDistinctCompanies, 2);
    assert.equal(QUERY_TEST.minSample, 5);
    assert.equal(PORTFOLIO.targetMin, 8);
    assert.equal(POLICY.minExpansionPostings, 2);
    assert.equal(POLICY.minFamilyEvaluationSample, 4);
    assert.equal(POLICY.zeroYieldProbeInterval, 3);
    assert.deepEqual(POLICY.searchLimits, { maxPages: 1, maxResults: 25 });
    // El motor no importa nada de Hunter.
    const engineSource = fs.readFileSync(path.join(__dirname, '../marketDiscovery/explorationEngine.js'), 'utf8');
    const code = engineSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['runPipeline', 'huntRunManager', 'jobService', 'notify']) {
      assert.ok(!code.includes(forbidden), 'el motor no debe tocar: ' + forbidden);
    }
    // La generacion de semillas no se toca desde aqui.
    assert.ok(code.includes('generateSeedPlan'), 'sigue usando el generador existente, sin reimplementarlo');
  });

  console.log(`\nMD9.1 Reclaim: ${passed} tests passed`);
})().catch((error) => {
  console.error('\n[FAIL]', error && error.stack ? error.stack : error);
  process.exit(1);
});

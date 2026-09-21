'use strict';

// MD5 — motor de exploracion acotada de Market Discovery.
// Determinista: sin LinkedIn, sin Chromium, sin OpenAI, sin red, sin timers reales.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createExplorationEngine } = require('../marketDiscovery/explorationEngine');
const { STOP_REASONS, HARD_CAPS, DEFAULT_BUDGET, POLICY, resolveBudget } = require('../marketDiscovery/explorationBudget');
const { OPERATION_TYPES, createOwner } = require('../domain/operationOwner');
const runtime = require('../runtime');

const roots = [];
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed++; console.log('[PASS] ' + name); }
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md5-')); roots.push(dir); return dir; }

const OWNER = createOwner(OPERATION_TYPES.MARKET_DISCOVERY, 'md_run_1');
const familyId = (n) => `family-${String(n).repeat(16).slice(0, 16)}`;

// --- Perfil y plan de semillas sinteticos (sin datos ni identidad reales).
const PROFILE = Object.freeze({ exclusions: [{ text: 'Exclusively commercial sales positions' }] });
function seedPlanFor(count) {
  const seeds = Array.from({ length: count }, (_, i) => ({
    familyId: familyId(i + 1), expression: `Family ${String.fromCharCode(65 + i)} role`,
    language: 'en', rank: i + 1,
  }));
  return () => ({ seeds, familiesConsidered: count, familiesSelected: count, truncated: false, omittedFamilies: [], priority: ['evidence category'] });
}

const card = (id, extra = {}) => ({ jobId: String(id), url: `https://www.linkedin.com/jobs/view/${id}/`, title: `Title ${id}`, company: `Company ${id}`, location: 'Somewhere', ...extra });

// Fuente falsa: devuelve lo que diga el guion, por query.
function fakeSource(script) {
  const calls = [];
  const search = async (request) => {
    calls.push(request);
    const entry = typeof script === 'function' ? script(request, calls.length) : script[request.search.query];
    const outcome = entry || { status: 'COMPLETED', results: [] };
    return {
      status: outcome.status || 'COMPLETED',
      stopReason: outcome.stopReason || 'no_next_page',
      results: (outcome.results || []).map((result, index) => ({ ...result, searchId: request.search.searchId, familyId: request.search.familyId, query: request.search.query, position: index + 1 })),
      metrics: { rawCards: (outcome.results || []).length, uniqueResults: (outcome.results || []).length, duplicatesWithinSearch: 0, pagesVisited: 1, limitReached: false },
      challenge: outcome.challenge || null,
      observedScope: { location: 'NOT_REQUESTED' },
    };
  };
  return { source: { search }, calls };
}

// Evaluador falso: clasifica por jobId segun el guion.
function fakeEvaluator(script) {
  const calls = [];
  const evaluatePosting = async (request) => {
    calls.push(request);
    const entry = (typeof script === 'function' ? script(request) : script[request.posting.postingId]) || { classification: 'UNCERTAIN' };
    if (entry.throws) { const error = new Error('semantic boom'); error.name = entry.throws; throw error; }
    const classification = entry.classification;
    const promotable = classification === 'COMPATIBLE';
    return {
      classification,
      dimensions: {},
      terminology: (entry.terms || []).map((term) => ({
        type: term.type || 'DISCRIMINATOR', expression: term.expression, normalized: term.expression.toLowerCase(),
        sourceField: 'title', offset: 0, length: term.expression.length,
        postingId: request.posting.postingId, eligibility: promotable ? 'ELIGIBLE' : 'REVIEW_ONLY', promotable,
      })),
      identity: { cacheKey: 'k_' + request.posting.postingId },
    };
  };
  return { evaluator: { evaluatePosting }, calls };
}

function engineFor(source, evaluator, options = {}) {
  return createExplorationEngine({ source, evaluator, seedPlanner: seedPlanFor(options.families === undefined ? 3 : options.families), clock: options.clock || (() => new Date(0)) });
}
const run = (engine, request = {}) => engine.explore({ owner: OWNER, profile: PROFILE, ...request });

(async () => {
  try {
    // ------------------------------------------------ 1-5. amplitud antes que profundidad
    await testAsync('1+4+5. every family gets an initial search; fewer or zero families are safe', async () => {
      const six = fakeSource(() => ({ results: [] }));
      const evaluatorSix = fakeEvaluator({});
      const result = await run(createExplorationEngine({ source: six.source, evaluator: evaluatorSix.evaluator, seedPlanner: seedPlanFor(6), clock: () => new Date(0) }));
      assert.equal(six.calls.length, 6, 'una busqueda inicial por familia');
      assert.deepEqual(six.calls.map((c) => c.search.searchId), ['d0_1', 'd0_2', 'd0_3', 'd0_4', 'd0_5', 'd0_6']);
      assert.equal(new Set(six.calls.map((c) => c.search.familyId)).size, 6, 'ninguna familia se busca dos veces antes que otra');
      assert.equal(result.families.length, 6);
      const two = fakeSource(() => ({ results: [] }));
      const small = await run(createExplorationEngine({ source: two.source, evaluator: fakeEvaluator({}).evaluator, seedPlanner: seedPlanFor(2), clock: () => new Date(0) }));
      assert.equal(two.calls.length, 2);
      assert.equal(small.status, STOP_REASONS.SATURATED, 'dos busquedas vacias consecutivas saturan');
      const none = fakeSource(() => ({ results: [] }));
      const empty = await run(createExplorationEngine({ source: none.source, evaluator: fakeEvaluator({}).evaluator, seedPlanner: seedPlanFor(0), clock: () => new Date(0) }));
      assert.equal(none.calls.length, 0);
      assert.equal(empty.status, STOP_REASONS.COMPLETED);
      assert.equal(empty.partial, false);
      assert.deepEqual(empty.families, []);
    });

    // ================= REGRESION DE EQUIDAD (failure mode observado en Hunter) =========
    await testAsync('2+3. FAIRNESS REGRESSION: a noisy early family cannot consume the semantic budget', async () => {
      // Familia A: 10 resultados ruidosos. Familias B y C: 2 resultados cada una,
      // con la evidencia COMPATIBLE. Presupuesto semantico = 6.
      // Un motor secuencial gastaria las 6 evaluaciones en A y no encontraria nada.
      const noisy = Array.from({ length: 10 }, (_, i) => card(100 + i));
      const source = fakeSource({
        'Family A role': { results: noisy },
        'Family B role': { results: [card(200), card(201)] },
        'Family C role': { results: [card(300), card(301)] },
      });
      const evaluator = fakeEvaluator((request) => {
        const id = Number(request.posting.postingId);
        if (id >= 300) return { classification: 'COMPATIBLE', terms: [{ type: 'ROLE_TITLE', expression: 'Gamma term' }] };
        if (id >= 200) return { classification: 'COMPATIBLE', terms: [{ type: 'ROLE_TITLE', expression: 'Beta term' }] };
        return { classification: 'OUT_OF_SCOPE' };
      });
      const engine = createExplorationEngine({
        source: source.source, evaluator: evaluator.evaluator,
        seedPlanner: seedPlanFor(3), clock: () => new Date(0),
      });
      const result = await engine.explore({ owner: OWNER, profile: PROFILE, budget: { initialEvaluationReserve: 6, expansionEvaluationReserve: 0, maxEvaluations: 6 } });

      const perFamily = Object.fromEntries(result.families.map((f) => [f.expression, f.evaluations]));
      assert.equal(perFamily['Family A role'], 2, 'la familia ruidosa NO acapara el presupuesto');
      assert.equal(perFamily['Family B role'], 2);
      assert.equal(perFamily['Family C role'], 2);
      // La evidencia compatible de las familias tardias SI se descubre.
      const compatible = result.evaluations.filter((e) => e.classification === 'COMPATIBLE');
      assert.equal(compatible.length, 4);
      assert(result.observations.some((o) => o.expression === 'Beta term'));
      assert(result.observations.some((o) => o.expression === 'Gamma term'));
      // El reparto es round-robin observable: A,B,C,A,B,C.
      const order = evaluator.calls.map((c) => c.posting.postingId);
      assert.deepEqual(order, ['100', '200', '300', '101', '201', '301']);
    });

    // ------------------------------------------- 6-10. dedup global / atribucion
    await testAsync('6-10. a cross-search duplicate is evaluated once and never inflates support', async () => {
      const shared = card(500, { company: 'Shared Co' });
      const source = fakeSource({
        'Family A role': { results: [shared, card(501, { company: 'A Co' })] },
        'Family B role': { results: [shared] },
        'Family C role': { results: [shared] },
      });
      const evaluator = fakeEvaluator(() => ({ classification: 'COMPATIBLE', terms: [{ type: 'ROLE_TITLE', expression: 'Shared term' }] }));
      const result = await run(engineFor(source.source, evaluator.evaluator));
      const evaluatedIds = evaluator.calls.map((c) => c.posting.postingId);
      assert.equal(evaluatedIds.filter((id) => id === '500').length, 1, 'evaluada una sola vez');
      const record = result.postings.find((p) => p.postingId === '500');
      assert.deepEqual(record.searchIds, ['d0_1', 'd0_2', 'd0_3'], 'conserva las tres atribuciones');
      assert.equal(record.familyIds.length, 3);
      assert.equal(result.overlaps.length, 1);
      assert.deepEqual(result.overlaps[0].searchIds, ['d0_1', 'd0_2', 'd0_3']);
      // No cuenta como tres ofertas compatibles independientes.
      assert.equal(result.evaluations.filter((e) => e.classification === 'COMPATIBLE').length, 2);
      const term = result.expansion.candidates.find((c) => c.expression === 'Shared term');
      assert.equal(term.distinctPostings, 2, 'la repeticion no infla el soporte del termino');
      assert.deepEqual([...term.postingKeys].sort(), ['job:500', 'job:501']);
    });

    // ------------------------------------------------------ 11-17. presupuestos
    test('11-17. the budget contract is explicit and fails closed', () => {
      assert.equal(DEFAULT_BUDGET.maxSearches, 10);
      assert.equal(DEFAULT_BUDGET.maxInitialSearches, 6);
      assert.equal(DEFAULT_BUDGET.maxExpansionSearches, 4);
      assert.equal(DEFAULT_BUDGET.maxUniquePostings, 100);
      assert.equal(DEFAULT_BUDGET.maxEvaluations, 60);
      assert.equal(DEFAULT_BUDGET.initialEvaluationReserve, 36);
      assert.equal(DEFAULT_BUDGET.expansionEvaluationReserve, 24);
      assert.equal(DEFAULT_BUDGET.maxExpansionDepth, 1);
      assert.equal(DEFAULT_BUDGET.maxDurationMs, 45 * 60 * 1000);
      assert.deepEqual(POLICY.searchLimits, { maxPages: 1, maxResults: 25 });
      for (const key of Object.keys(HARD_CAPS)) {
        assert.throws(() => resolveBudget({ [key]: HARD_CAPS[key] + 1 }), /must not exceed/);
      }
      assert.throws(() => resolveBudget({ unknownKey: 1 }), /unknown budget key/);
      assert.throws(() => resolveBudget({ maxEvaluations: 1.5 }), /non-negative integer/);
      assert.throws(() => resolveBudget({ maxEvaluations: 10, initialEvaluationReserve: 8, expansionEvaluationReserve: 8 }), /reserves must not exceed/);
      assert.throws(() => resolveBudget({ maxSearches: 5, maxInitialSearches: 4, maxExpansionSearches: 4 }), /must not exceed maxSearches/);
    });
    await testAsync('13+14+15. the engine never asks for more than MD3b allows and honours caps', async () => {
      const many = Array.from({ length: 10 }, (_, i) => card(700 + i));
      const source = fakeSource(() => ({ results: many }));
      const evaluator = fakeEvaluator(() => ({ classification: 'UNCERTAIN' }));
      const engine = createExplorationEngine({ source: source.source, evaluator: evaluator.evaluator, seedPlanner: seedPlanFor(3), clock: () => new Date(0) });
      const result = await engine.explore({ owner: OWNER, profile: PROFILE, budget: { maxUniquePostings: 4, maxEvaluations: 3, initialEvaluationReserve: 3, expansionEvaluationReserve: 0 } });
      for (const call of source.calls) assert.deepEqual(call.limits, { maxPages: 1, maxResults: 25 });
      assert.equal(result.postings.length, 4, 'tope global de ofertas unicas');
      assert.equal(evaluator.calls.length, 3, 'tope de evaluaciones semanticas');
      assert.equal(result.budget.consumed.evaluations, 3);
      assert.equal(result.budget.remaining.evaluations, 0);
      assert(result.searches.some((s) => s.uniquePostingCapReached));
    });

    // ------------------------------------------- 18-29. expansion
    const expansionSource = {
      'Family A role': { results: [card(800, { company: 'Alpha SA' }), card(801, { company: 'Beta SA' })] },
      'Family B role': { results: [card(810, { company: 'Gamma SA' })] },
      'Family C role': { results: [card(820, { company: 'Delta SA' })] },
    };
    const expansionEvaluator = (request) => {
      const id = Number(request.posting.postingId);
      if (id === 800 || id === 801) return { classification: 'COMPATIBLE', terms: [{ type: 'ROLE_TITLE', expression: 'Strong term' }] };
      if (id === 810) return { classification: 'COMPATIBLE', terms: [{ type: 'DISCRIMINATOR', expression: 'Weak term' }] };
      if (id === 820) return { classification: 'UNCERTAIN', terms: [{ type: 'ROLE_TITLE', expression: 'Uncertain term' }] };
      return { classification: 'OUT_OF_SCOPE', terms: [{ type: 'ROLE_TITLE', expression: 'Rejected term' }] };
    };
    await testAsync('18+19+21+28+29. only well-supported COMPATIBLE terms expand', async () => {
      const source = fakeSource({ ...expansionSource, 'Strong term': { results: [card(900, { company: 'Omega SA' })] } });
      const evaluator = fakeEvaluator(expansionEvaluator);
      const result = await run(engineFor(source.source, evaluator.evaluator));
      const byExpression = Object.fromEntries(result.expansion.candidates.map((c) => [c.expression, c]));
      assert.equal(byExpression['Strong term'].eligible, true);
      assert.equal(byExpression['Strong term'].distinctPostings, 2);
      assert.equal(byExpression['Strong term'].distinctCompanies, 2);
      assert.equal(byExpression['Weak term'].eligible, false);
      assert(/fewer than 2 distinct compatible postings/.test(byExpression['Weak term'].reason));
      assert.equal(byExpression['Uncertain term'], undefined, 'UNCERTAIN no aporta candidatos');
      assert.equal(byExpression['Rejected term'], undefined, 'OUT_OF_SCOPE no aporta candidatos');
      assert.deepEqual(result.expansion.selected.map((s) => s.expression), ['Strong term']);
      assert(source.calls.some((c) => c.search.query === 'Strong term' && c.search.searchId === 'd1_1'));
    });
    await testAsync('20+22. repeated identical postings and already-searched queries cannot expand', async () => {
      // La MISMA oferta vista por tres busquedas no crea soporte falso.
      const same = card(950, { company: 'Same SA' });
      const source = fakeSource(() => ({ results: [same] }));
      const evaluator = fakeEvaluator(() => ({ classification: 'COMPATIBLE', terms: [{ type: 'ROLE_TITLE', expression: 'Echoed term' }] }));
      const result = await run(engineFor(source.source, evaluator.evaluator));
      const echoed = result.expansion.candidates.find((c) => c.expression === 'Echoed term');
      assert.equal(echoed.distinctPostings, 1);
      assert.equal(echoed.eligible, false);
      // Un termino identico a una query ya ejecutada no se vuelve a buscar.
      const source2 = fakeSource({
        'Family A role': { results: [card(960, { company: 'A SA' }), card(961, { company: 'B SA' })] },
        'Family B role': { results: [] }, 'Family C role': { results: [] },
      });
      const evaluator2 = fakeEvaluator(() => ({ classification: 'COMPATIBLE', terms: [{ type: 'ROLE_TITLE', expression: 'Family A role' }] }));
      const repeated = await run(engineFor(source2.source, evaluator2.evaluator));
      const selfTerm = repeated.expansion.candidates.find((c) => c.normalized === 'family a role');
      assert.equal(selfTerm.eligible, false);
      assert.equal(selfTerm.reason, 'already searched in this run');
      assert.equal(source2.calls.filter((c) => c.search.depth === undefined && c.search.query === 'Family A role').length, 1);
    });
    await testAsync('23+24. at most four expansion searches, ranked deterministically and not by hash', async () => {
      const results = Array.from({ length: 12 }, (_, i) => card(1000 + i, { company: `Co ${i}` }));
      // Cada familia aporta ofertas DISTINTAS, y cada expansion trae una nueva:
      // asi el corte de este test es el tope de 4, no la saturacion.
      const expansionCards = { 'Term 0': card(3000, { company: 'X SA' }), 'Term 1': card(3001, { company: 'Y SA' }), 'Term 2': card(3002, { company: 'Z SA' }), 'Term 3': card(3003, { company: 'W SA' }) };
      const source = fakeSource((request) => {
        const query = request.search.query;
        if (query === 'Family A role') return { results: results.slice(0, 6) };
        if (query === 'Family B role') return { results: results.slice(6, 9) };
        if (query === 'Family C role') return { results: results.slice(9, 12) };
        return { results: expansionCards[query] ? [expansionCards[query]] : [] };
      });
      const evaluator = fakeEvaluator((request) => {
        const id = Number(request.posting.postingId) - 1000;
        // Cada termino recibe soporte decreciente: T0 en 6 ofertas, T1 en 5, etc.
        const terms = [];
        for (let t = 0; t <= 5; t += 1) if (id >= t) terms.push({ type: 'ROLE_TITLE', expression: `Term ${t}` });
        return { classification: 'COMPATIBLE', terms };
      });
      const result = await run(engineFor(source.source, evaluator.evaluator));
      assert.equal(result.expansion.selected.length, 4, 'como mucho cuatro expansiones');
      assert.deepEqual(result.expansion.selected.map((s) => s.expression), ['Term 0', 'Term 1', 'Term 2', 'Term 3']);
      const eligible = result.expansion.candidates.filter((c) => c.eligible);
      const supports = eligible.map((c) => c.distinctPostings);
      assert.deepEqual(supports, [...supports].sort((a, b) => b - a), 'ordenado por soporte, no por id');
      assert.equal(eligible[4].selected, false);
      assert.equal(eligible[4].selectionReason, 'eligible but beyond the expansion search budget');
      assert.equal(result.searches.filter((s) => s.depth === 1).length, 4);
    });
    await testAsync('25+26+27. expansion is depth 1 only and inherits no compatibility', async () => {
      const source = fakeSource({
        'Family A role': { results: [card(1100, { company: 'A SA' }), card(1101, { company: 'B SA' })] },
        'Family B role': { results: [card(1110, { company: 'C SA' })] },
        'Family C role': { results: [card(1120, { company: 'D SA' })] },
        'Parent term': { results: [card(1200, { company: 'Drift SA' })] },
      });
      const evaluator = fakeEvaluator((request) => {
        const id = Number(request.posting.postingId);
        // La oferta hallada POR la expansion es un rol de ventas: no encaja.
        if (id === 1200) return { classification: 'OUT_OF_SCOPE', terms: [{ type: 'ROLE_TITLE', expression: 'Grandchild term' }] };
        if (id === 1100 || id === 1101) return { classification: 'COMPATIBLE', terms: [{ type: 'ROLE_TITLE', expression: 'Parent term' }] };
        return { classification: 'UNCERTAIN' };
      });
      const result = await run(engineFor(source.source, evaluator.evaluator));
      const child = result.evaluations.find((e) => e.postingKey === 'job:1200');
      assert.equal(child.classification, 'OUT_OF_SCOPE', 'la oferta de expansion vuelve a pasar por la compuerta');
      assert.equal(child.depth, 1);
      // La terminologia de profundidad 1 se observa pero NO genera busquedas nuevas.
      assert(result.observations.some((o) => o.expression === 'Grandchild term' && o.depth === 1));
      assert.equal(result.searches.filter((s) => s.depth === 1).length, 1);
      assert.equal(Math.max(...result.searches.map((s) => s.depth)), 1, 'no existe profundidad 2');
      assert(!source.calls.some((c) => c.search.query === 'Grandchild term'));
      // Estructural: no hay cola recursiva en el motor.
      const engineSource = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/marketDiscovery/explorationEngine.js'), 'utf8');
      assert(!/while\s*\(\s*queue/.test(engineSource) && !/EXPANSION_DEPTH\s*\+\s*1/.test(engineSource));
    });

    // --------------------------------------------------- 30-33. saturacion
    await testAsync('30+31+32+33. saturation is conservative and distinct from budget exhaustion', async () => {
      const repeated = [card(1300), card(1301)];
      const source = fakeSource(() => ({ results: repeated }));
      const evaluator = fakeEvaluator(() => ({ classification: 'OUT_OF_SCOPE' }));
      const result = await run(engineFor(source.source, evaluator.evaluator));
      assert.equal(result.status, STOP_REASONS.SATURATED);
      // La primera busqueda no solapa; la 2a y la 3a si, y sin evidencia nueva.
      assert.equal(result.searches[0].saturationQualified, false);
      assert.equal(result.searches[1].saturationQualified, true);
      assert.equal(result.searches[2].saturationQualified, true);
      assert.equal(result.expansion.selected.length, 0, 'saturado no expande');

      // Una sola busqueda de alto solapamiento NO satura.
      const once = fakeSource({
        'Family A role': { results: [card(1400), card(1401)] },
        'Family B role': { results: [card(1400), card(1401)] },
        'Family C role': { results: [card(1500, { company: 'New SA' })] },
      });
      const single = await run(engineFor(once.source, fakeEvaluator(() => ({ classification: 'OUT_OF_SCOPE' })).evaluator));
      assert.equal(single.searches[1].saturationQualified, true);
      assert.equal(single.searches[2].saturationQualified, false, 'la tercera trae ofertas nuevas');
      assert.notEqual(single.status, STOP_REASONS.SATURATED);

      // Una busqueda FALLIDA no cuenta para la saturacion.
      const withFailure = fakeSource({
        'Family A role': { results: [card(1600)] },
        'Family B role': { status: 'FAILED', stopReason: 'source_failed', results: [] },
        'Family C role': { results: [card(1600)] },
      });
      const failed = await run(engineFor(withFailure.source, fakeEvaluator(() => ({ classification: 'OUT_OF_SCOPE' })).evaluator));
      assert.equal(failed.searches[1].countedForSaturation, false, 'la fallida no entra en la racha');
      assert.equal(failed.searches[2].saturationQualified, true);
      assert.notEqual(failed.status, STOP_REASONS.SATURATED, 'una sola busqueda cualificada no satura');

      // Presupuesto agotado NO es saturacion: una familia se queda sin busqueda.
      let seq = 0;
      const busy = fakeSource(() => ({ results: [card(1700000 + (seq += 1))] }));
      const exhausted = await createExplorationEngine({ source: busy.source, evaluator: fakeEvaluator(() => ({ classification: 'COMPATIBLE' })).evaluator, seedPlanner: seedPlanFor(3), clock: () => new Date(0) })
        .explore({ owner: OWNER, profile: PROFILE, budget: { maxSearches: 2, maxInitialSearches: 2, maxExpansionSearches: 0 } });
      assert.equal(exhausted.status, STOP_REASONS.BUDGET_EXHAUSTED);
      assert.notEqual(exhausted.status, STOP_REASONS.SATURATED);
      assert.equal(busy.calls.length, 2, 'la tercera familia nunca recibio busqueda');
      assert.equal(exhausted.families[2].searchIds.length, 0);
      // Y agotar las evaluaciones tambien es presupuesto, no saturacion.
      const plenty = fakeSource(() => ({ results: [card(1800000 + (seq += 1)), card(1800000 + (seq += 1))] }));
      const noEvals = await createExplorationEngine({ source: plenty.source, evaluator: fakeEvaluator(() => ({ classification: 'COMPATIBLE' })).evaluator, seedPlanner: seedPlanFor(3), clock: () => new Date(0) })
        .explore({ owner: OWNER, profile: PROFILE, budget: { maxEvaluations: 2, initialEvaluationReserve: 2, expansionEvaluationReserve: 0 } });
      assert.equal(noEvals.status, STOP_REASONS.BUDGET_EXHAUSTED);
    });

    // ------------------------------------- 34-42. interrupcion / fallo / tiempo
    await testAsync('34+35. login and checkpoint stop immediately, preserving partial evidence', async () => {
      for (const [code, expected] of [['LOGIN_REQUIRED', STOP_REASONS.LOGIN_REQUIRED], ['CHECKPOINT_REQUIRED', STOP_REASONS.CHECKPOINT_REQUIRED]]) {
        const source = fakeSource({
          'Family A role': { results: [card(1700)] },
          'Family B role': { status: 'INTERRUPTED', stopReason: code.toLowerCase(), results: [], challenge: { code } },
          'Family C role': { results: [card(1800)] },
        });
        const result = await run(engineFor(source.source, fakeEvaluator(() => ({ classification: 'COMPATIBLE' })).evaluator));
        assert.equal(result.status, expected);
        assert.equal(result.partial, true);
        assert.equal(source.calls.length, 2, 'no se sigue buscando tras el corte');
        assert.equal(result.postings.length, 1, 'la evidencia parcial se conserva');
      }
    });
    await testAsync('36+37. cancellation stops immediately with no further calls', async () => {
      const controller = new AbortController();
      const source = fakeSource(() => { controller.abort(); return { results: [card(1900)] }; });
      const evaluator = fakeEvaluator(() => ({ classification: 'COMPATIBLE' }));
      const result = await run(engineFor(source.source, evaluator.evaluator), { signal: controller.signal });
      assert.equal(result.status, STOP_REASONS.CANCELLED);
      assert.equal(result.partial, true);
      assert.equal(source.calls.length, 1, 'ninguna busqueda despues de cancelar');
      assert.equal(evaluator.calls.length, 0, 'ninguna evaluacion despues de cancelar');
      // Cancelado de entrada: no se llama a nada.
      const pre = new AbortController(); pre.abort();
      const quiet = fakeSource(() => ({ results: [] }));
      const immediate = await run(engineFor(quiet.source, fakeEvaluator({}).evaluator), { signal: pre.signal });
      assert.equal(immediate.status, STOP_REASONS.CANCELLED);
      assert.equal(quiet.calls.length, 0);
    });
    await testAsync('38+39+40. source and semantic failures have explicit thresholds', async () => {
      const source = fakeSource({
        'Family A role': { status: 'FAILED', stopReason: 'source_failed', results: [] },
        'Family B role': { status: 'FAILED', stopReason: 'source_failed', results: [] },
        'Family C role': { results: [card(2000)] },
      });
      const failed = await run(engineFor(source.source, fakeEvaluator({}).evaluator));
      assert.equal(failed.status, STOP_REASONS.SOURCE_FAILED);
      assert.equal(failed.failures.source.length, 2);
      assert.equal(source.calls.length, 2, 'no se insiste sobre LinkedIn');
      // Un fallo semantico aislado se registra y se sigue.
      let flakyDone = 0;
      const okSource = fakeSource(() => ({ results: [card(2100)] }));
      const flaky = fakeEvaluator((request) => (request.posting.postingId === '2100' && !flakyDone++ ? { throws: 'SemanticContractError' } : { classification: 'UNCERTAIN' }));
      const isolated = await run(engineFor(okSource.source, flaky.evaluator));
      assert.equal(isolated.failures.semantic.length, 1);
      assert.notEqual(isolated.status, STOP_REASONS.SEMANTIC_FAILED);
      assert.equal(isolated.observations.length, 0, 'no se extrae terminologia de una evaluacion fallida');
      // Cruzar el umbral detiene el run.
      const broken = fakeEvaluator(() => ({ throws: 'SemanticContractError' }));
      const brokenSource = fakeSource({
        'Family A role': { results: [card(2200)] },
        'Family B role': { results: [card(2201)] },
        'Family C role': { results: [card(2202)] },
      });
      const stopped = await run(engineFor(brokenSource.source, broken.evaluator));
      assert.equal(stopped.status, STOP_REASONS.SEMANTIC_FAILED);
      assert.equal(stopped.failures.semantic.length, 3);
    });
    await testAsync('41+42+43. time limit, partial marking and normal completion', async () => {
      let now = 0;
      const source = fakeSource(() => { now += 30 * 60 * 1000; return { results: [card(2300 + now)] }; });
      const timed = await run(createExplorationEngine({ source: source.source, evaluator: fakeEvaluator(() => ({ classification: 'UNCERTAIN' })).evaluator, seedPlanner: seedPlanFor(3), clock: () => new Date(now) }));
      assert.equal(timed.status, STOP_REASONS.TIME_LIMIT);
      assert.equal(timed.partial, true);
      assert(timed.elapsedMs > DEFAULT_BUDGET.maxDurationMs);
      // Final normal: se completa sin saturar ni agotar.
      const clean = fakeSource({
        'Family A role': { results: [card(2400, { company: 'A SA' }), card(2401, { company: 'B SA' })] },
        'Family B role': { results: [card(2410, { company: 'C SA' })] },
        'Family C role': { results: [card(2420, { company: 'D SA' })] },
        'Common term': { results: [card(2500, { company: 'E SA' })] },
      });
      const done = await run(engineFor(clean.source, fakeEvaluator(() => ({ classification: 'COMPATIBLE', terms: [{ type: 'ROLE_TITLE', expression: 'Common term' }] })).evaluator));
      assert.equal(done.status, STOP_REASONS.COMPLETED);
      assert.equal(done.partial, false);
      assert.equal(done.stopReason, STOP_REASONS.COMPLETED);
    });

    // ------------------------------------------- 44-46. determinismo / inmutabilidad
    await testAsync('44+45+46. repeated runs match, the result is frozen and inputs are untouched', async () => {
      const script = {
        'Family A role': { results: [card(2600, { company: 'A SA' }), card(2601, { company: 'B SA' })] },
        'Family B role': { results: [card(2610, { company: 'C SA' })] },
        'Family C role': { results: [card(2620, { company: 'D SA' })] },
      };
      const profile = { exclusions: [{ text: 'Exclusively commercial sales positions' }] };
      const snapshot = structuredClone(profile);
      const evaluate = () => fakeEvaluator(() => ({ classification: 'COMPATIBLE', terms: [{ type: 'ROLE_TITLE', expression: 'Repeat term' }] })).evaluator;
      const first = await run(engineFor(fakeSource(script).source, evaluate()), { profile });
      const second = await run(engineFor(fakeSource(script).source, evaluate()), { profile });
      assert.deepEqual(first, second, 'mismo fixture, mismo resultado');
      assert.deepEqual(profile, snapshot, 'el perfil de entrada no se muta');
      assert(Object.isFrozen(first) && Object.isFrozen(first.searches) && Object.isFrozen(first.budget));
      assert.throws(() => first.searches.push({}));
      assert.throws(() => { first.status = 'X'; });
    });

    // ------------------------------------------------- 47-55. aislamiento
    test('47-55. MD5 cannot reach Hunter state and owns no browser lock', () => {
      const files = ['src/marketDiscovery/explorationEngine.js', 'src/marketDiscovery/explorationBudget.js'];
      const source = files.map((file) => fs.readFileSync(path.join(runtime.PROJECT_ROOT, file), 'utf8')).join('\n');
      for (const token of [
        'jobAnalyzer', 'analyzeJob', 'runPipeline', 'huntRunManager', 'jobRepository', 'jobService',
        'learnedPreferences', 'runOutcome', 'notifications/ntfy', 'telegram', 'userConfig', 'searchSettings',
        'scheduleStore', 'acquireLock', 'releaseLock', 'huntLock', 'writeFileSync', 'mkdirSync', 'launchLinkedInBrowser',
      ]) {
        assert(!source.includes(token), `MD5 no debe referenciar ${token}`);
      }
      for (const loaded of Object.keys(require.cache)) {
        assert(!loaded.includes('jobAnalyzer'), 'el Analyzer normal no se carga');
        assert(!loaded.includes(path.join('src', 'pipeline')), 'el pipeline de Hunter no se carga');
        assert(!loaded.includes('huntRunManager'), 'el run manager de Hunter no se carga');
      }
    });
    await testAsync('47-55. a full run writes nothing and requires MARKET_DISCOVERY ownership', async () => {
      const dataDir = temp();
      const before = fs.readdirSync(dataDir);
      const source = fakeSource(() => ({ results: [card(2700, { company: 'A SA' })] }));
      const engine = engineFor(source.source, fakeEvaluator(() => ({ classification: 'COMPATIBLE' })).evaluator);
      const result = await run(engine);
      assert.deepEqual(fs.readdirSync(dataDir), before);
      for (const dir of ['jobs', 'runs', 'feedback', 'config', 'profile', 'market-discovery']) {
        assert.equal(fs.existsSync(path.join(dataDir, dir)), false);
      }
      const text = JSON.stringify(result);
      for (const token of ['decision', 'overallMatchScore', 'YES', 'MAYBE', 'analysisStatus', 'matchedQueries']) {
        assert(!text.includes(token), `el ledger no debe incluir ${token}`);
      }
      // Propiedad: exige MARKET_DISCOVERY y nunca la adquiere ni la libera.
      for (const owner of [undefined, createOwner(OPERATION_TYPES.HUNT, 'run_1'), createOwner(OPERATION_TYPES.MANUAL_SESSION, 'session_1')]) {
        await assert.rejects(() => engine.explore({ owner, profile: PROFILE }), /MARKET_DISCOVERY_INVALID/);
      }
      assert.equal(result.operationId, 'md_run_1');
      // El owner viaja sin cambios a cada busqueda.
      for (const call of source.calls) assert.equal(call.owner.operationId, 'md_run_1');
    });

    console.log('Market Exploration (MD5): ' + passed + ' tests passed');
  } finally {
    for (const dir of roots.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

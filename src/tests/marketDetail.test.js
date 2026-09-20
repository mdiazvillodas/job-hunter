'use strict';

// MD7.1 — enriquecimiento de detalle antes de la evaluacion semantica.
// Determinista: sin LinkedIn, sin Chromium, sin OpenAI, sin red.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDetailEnricher, DETAIL_OUTCOMES } = require('../marketDiscovery/detailEnricher');
const { createExplorationEngine } = require('../marketDiscovery/explorationEngine');
const { createLinkedinMarketSource, SCOPE } = require('../marketDiscovery/linkedinMarketSource');
const { STOP_REASONS, resolveBudget, DEFAULT_BUDGET } = require('../marketDiscovery/explorationBudget');
const { createMarketDiscoveryRunManager, STATUSES } = require('../run/marketDiscoveryRunManager');
const { createMarketDiscoveryRunStore } = require('../marketDiscovery/runStore');
const { buildQueryPortfolio } = require('../marketDiscovery/queryPortfolio');
const { MAX_DESCRIPTION_CHARS } = require('../marketDiscovery/semanticContract');
const { OPERATION_TYPES, createOwner } = require('../domain/operationOwner');
const { acquireLock, releaseLock } = require('../domain/huntLock');
const runtime = require('../runtime');

const roots = [];
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed++; console.log('[PASS] ' + name); }
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md71-')); roots.push(dir); return dir; }

const CONFIGURED = 'Barcelona, spain';
const OWNER = createOwner(OPERATION_TYPES.MARKET_DISCOVERY, 'md_detail');
const PROFILE = { schemaVersion: 1, exclusions: [], targetResponsibilities: [], demonstratedCapabilities: [] };
const PAGE = { marker: 'shared-md-page' };
const card = (id, extra = {}) => ({ jobId: String(id), url: `https://www.linkedin.com/jobs/view/${id}/`, title: `Title ${id}`, company: `Co ${id}`, location: 'Barcelona, Catalonia, Spain', easyApply: false, ...extra });

function seedPlan(expressions) {
  return () => ({
    seeds: expressions.map((expression, i) => ({ familyId: `family-${String(i + 1).repeat(16).slice(0, 16)}`, expression, language: 'und', rank: i + 1 })),
    familiesConsidered: expressions.length, familiesSelected: expressions.length, truncated: false, omittedFamilies: [], priority: [],
  });
}

// Fuente falsa con alcance VERIFICADO por defecto.
function fakeSource(script, { locationVerified = true } = {}) {
  const calls = [];
  return {
    calls,
    search: async (request) => {
      calls.push(request);
      const entry = (await (typeof script === 'function' ? script(request) : script[request.search.query])) || { results: [] };
      if (!locationVerified) {
        return { status: 'INTERRUPTED', stopReason: 'scope_not_verified', results: [], metrics: { uniqueResults: 0 },
          requestedScope: { location: request.filters.location }, observedScope: { location: SCOPE.UNVERIFIED }, challenge: null };
      }
      return {
        status: 'COMPLETED', stopReason: 'no_next_page',
        results: (entry.results || []).map((r, i) => ({ ...r, searchId: request.search.searchId, familyId: request.search.familyId, query: request.search.query, position: i + 1 })),
        metrics: { rawCards: (entry.results || []).length, uniqueResults: (entry.results || []).length, duplicatesWithinSearch: 0, pagesVisited: 1, limitReached: false },
        requestedScope: { location: request.filters.location },
        observedScope: { location: SCOPE.VERIFIED }, challenge: null,
      };
    },
  };
}

// Enriquecedor falso: guion por postingId, registrando el orden de llamada.
function fakeEnricher(script) {
  const calls = [];
  return {
    calls,
    enrich: async (posting, context) => {
      calls.push({ postingKey: posting.key, postingId: posting.postingId, page: context.page, owner: context.owner, signal: context.signal });
      const entry = (await (typeof script === 'function' ? script(posting) : script[posting.postingId])) || { outcome: DETAIL_OUTCOMES.DETAIL_UNAVAILABLE };
      return { postingKey: posting.key, postingId: posting.postingId, description: null, descriptionAvailable: false, descriptionLength: 0, ...entry };
    },
  };
}

// Evaluador falso que recuerda si recibio descripcion.
function fakeEvaluator(script) {
  const calls = [];
  return {
    calls,
    evaluatePosting: async (request) => {
      calls.push({ postingId: request.posting.postingId, description: request.posting.description, title: request.posting.title });
      const entry = (typeof script === 'function' ? script(request) : script[request.posting.postingId]) || { classification: 'UNCERTAIN' };
      const promotable = entry.classification === 'COMPATIBLE';
      return {
        classification: entry.classification, dimensions: {},
        terminology: (entry.terms || []).map((t) => ({ type: t.type || 'ROLE_TITLE', expression: t.expression, normalized: t.expression.toLowerCase(), sourceField: 'description', offset: 0, length: t.expression.length, postingId: request.posting.postingId, eligibility: promotable ? 'ELIGIBLE' : 'REVIEW_ONLY', promotable })),
        identity: { cacheKey: 'k_' + request.posting.postingId },
      };
    },
  };
}

const engineWith = (source, evaluator, enricher, families, extra = {}) => createExplorationEngine({
  source, evaluator, enricher, seedPlanner: seedPlan(families), clock: () => new Date(0), ...extra,
});
const explore = (engine, extra = {}) => engine.explore({ owner: OWNER, page: PAGE, profile: PROFILE, filters: { location: CONFIGURED }, ...extra });

(async () => {
  try {
    // ------------------------------------- 1-2. el detalle precede a la evaluacion
    await testAsync('1+2. detail is fetched immediately before evaluation and reaches MD4', async () => {
      const order = [];
      const source = fakeSource({ A: { results: [card(1)] } });
      const enricher = { enrich: async (p) => { order.push('detail:' + p.postingId); return { outcome: DETAIL_OUTCOMES.DETAIL_AVAILABLE, description: 'Responsable de la implantacion de locales comerciales.', descriptionAvailable: true }; } };
      const evaluator = { evaluatePosting: async (r) => { order.push('evaluate:' + r.posting.postingId + ':desc=' + Boolean(r.posting.description)); return { classification: 'UNCERTAIN', dimensions: {}, terminology: [], identity: {} }; } };
      await explore(engineWith(source, evaluator, enricher, ['A']));
      assert.deepEqual(order, ['detail:1', 'evaluate:1:desc=true'], 'detalle inmediatamente antes de evaluar');
    });

    // ------------------------------------- 3-8. dedup, equidad y sin pre-enriquecimiento
    await testAsync('3+4+5+7. a duplicate is enriched and evaluated exactly once', async () => {
      const shared = card(100);
      const source = fakeSource({
        A: { results: [shared, card(101)] }, B: { results: [shared] }, C: { results: [shared, card(102)] },
      });
      const enricher = fakeEnricher(() => ({ outcome: DETAIL_OUTCOMES.DETAIL_AVAILABLE, description: 'texto', descriptionAvailable: true }));
      const evaluator = fakeEvaluator(() => ({ classification: 'UNCERTAIN' }));
      const ledger = await explore(engineWith(source, evaluator, enricher, ['A', 'B', 'C']));
      const enrichedIds = enricher.calls.map((c) => c.postingId);
      assert.equal(enrichedIds.filter((id) => id === '100').length, 1, 'la oferta repetida se enriquece una sola vez');
      assert.equal(evaluator.calls.filter((c) => c.postingId === '100').length, 1);
      assert.equal(enricher.calls.length, ledger.postings.filter((p) => p.evaluated).length, 'un detalle por candidato evaluado');
      assert(enricher.calls.length <= ledger.postings.length);
      // Atribucion de MD3b preservada pese al detalle.
      const record = ledger.postings.find((p) => p.postingId === '100');
      assert.deepEqual(record.searchIds, ['d0_1', 'd0_2', 'd0_3']);
    });
    await testAsync('6+7. family order stays fair and no family is pre-enriched', async () => {
      const source = fakeSource({
        A: { results: [card(1), card(2), card(3)] }, B: { results: [card(4), card(5)] }, C: { results: [card(6)] },
      });
      const enricher = fakeEnricher(() => ({ outcome: DETAIL_OUTCOMES.DETAIL_AVAILABLE, description: 'x', descriptionAvailable: true }));
      const evaluator = fakeEvaluator(() => ({ classification: 'UNCERTAIN' }));
      await explore(engineWith(source, evaluator, enricher, ['A', 'B', 'C']));
      // Round-robin intacto: A,B,C,A,B,A — nunca A,A,A primero.
      assert.deepEqual(enricher.calls.map((c) => c.postingId), ['1', '4', '6', '2', '5', '3']);
      assert.deepEqual(enricher.calls.map((c) => c.postingId), evaluator.calls.map((c) => c.postingId), 'mismo orden que la evaluacion');
    });
    await testAsync('8+9+10. the shared page, owner and signal are reused; nothing else is opened', async () => {
      const source = fakeSource({ A: { results: [card(1)] } });
      const enricher = fakeEnricher(() => ({ outcome: DETAIL_OUTCOMES.DETAIL_UNAVAILABLE }));
      await explore(engineWith(source, fakeEvaluator(() => ({ classification: 'UNCERTAIN' })), enricher, ['A']));
      assert.equal(enricher.calls[0].page, PAGE, 'la MISMA pagina compartida');
      assert.equal(enricher.calls[0].owner.operationId, OWNER.operationId, 'el MISMO dueño');
      // Estructural: el enriquecedor no abre navegadores ni toca la propiedad.
      const source_ = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/marketDiscovery/detailEnricher.js'), 'utf8');
      for (const token of ['launchLinkedInBrowser', 'launchPersistentContext', 'chromium', 'acquireLock', 'releaseLock', 'huntLock', 'newContext', 'newPage']) {
        assert(!source_.includes(token), `el enriquecedor no debe usar ${token}`);
      }
    });

    // ------------------------------------- 11-14+20. fallbacks y umbrales
    await testAsync('11+12+13+20. unavailable and failed details fall back to card-only, counted, no retry', async () => {
      const source = fakeSource({ A: { results: [card(1), card(2), card(3)] } });
      const enricher = fakeEnricher({
        1: { outcome: DETAIL_OUTCOMES.DETAIL_AVAILABLE, description: 'con descripcion', descriptionAvailable: true },
        2: { outcome: DETAIL_OUTCOMES.DETAIL_UNAVAILABLE },
        3: { outcome: DETAIL_OUTCOMES.DETAIL_FAILED },
      });
      const evaluator = fakeEvaluator(() => ({ classification: 'UNCERTAIN' }));
      const ledger = await explore(engineWith(source, evaluator, enricher, ['A']));
      assert.equal(evaluator.calls.length, 3, 'las tres se evaluan igual');
      assert.equal(evaluator.calls.find((c) => c.postingId === '1').description, 'con descripcion');
      assert.equal(evaluator.calls.find((c) => c.postingId === '2').description, null, 'sin descripcion inventada');
      assert.equal(evaluator.calls.find((c) => c.postingId === '3').description, null);
      assert.deepEqual(ledger.detail, { attempted: 3, available: 1, unavailable: 1, failed: 1, maxDetailFetches: DEFAULT_BUDGET.maxDetailFetches, maxDetailFailures: DEFAULT_BUDGET.maxDetailFailures });
      // Un intento por candidato: sin bucles de reintento.
      assert.equal(enricher.calls.length, 3);
      assert.equal(new Set(enricher.calls.map((c) => c.postingId)).size, 3);
      assert.equal(ledger.stopReason, STOP_REASONS.COMPLETED);
    });
    await testAsync('14. crossing the detail-failure threshold stops the run', async () => {
      const source = fakeSource({ A: { results: Array.from({ length: 8 }, (_, i) => card(200 + i)) } });
      const enricher = fakeEnricher(() => ({ outcome: DETAIL_OUTCOMES.DETAIL_FAILED }));
      const evaluator = fakeEvaluator(() => ({ classification: 'UNCERTAIN' }));
      const ledger = await explore(engineWith(source, evaluator, enricher, ['A']));
      assert.equal(ledger.stopReason, STOP_REASONS.DETAIL_FAILED);
      assert.equal(ledger.detail.failed, DEFAULT_BUDGET.maxDetailFailures);
      assert.equal(ledger.failures.detail.length, DEFAULT_BUDGET.maxDetailFailures);
      assert.equal(ledger.partial, true);
    });
    test('21. the detail budget can never exceed the semantic budget', () => {
      assert.equal(resolveBudget({}).maxDetailFetches, 60);
      // Bajar las evaluaciones baja los detalles automaticamente.
      assert.equal(resolveBudget({ maxEvaluations: 6, initialEvaluationReserve: 6, expansionEvaluationReserve: 0 }).maxDetailFetches, 6);
      assert.throws(() => resolveBudget({ maxEvaluations: 10, initialEvaluationReserve: 10, expansionEvaluationReserve: 0, maxDetailFetches: 11 }),
        /maxDetailFetches must not exceed maxEvaluations/);
      assert.throws(() => resolveBudget({ maxDetailFetches: 61 }), /must not exceed/);
    });
    await testAsync('22. a posting never selected for evaluation gets no detail at all', async () => {
      const source = fakeSource({ A: { results: Array.from({ length: 6 }, (_, i) => card(300 + i)) } });
      const enricher = fakeEnricher(() => ({ outcome: DETAIL_OUTCOMES.DETAIL_UNAVAILABLE }));
      const evaluator = fakeEvaluator(() => ({ classification: 'UNCERTAIN' }));
      const engine = engineWith(source, evaluator, enricher, ['A']);
      const ledger = await engine.explore({ owner: OWNER, page: PAGE, profile: PROFILE, filters: { location: CONFIGURED }, budget: { maxEvaluations: 2, initialEvaluationReserve: 2, expansionEvaluationReserve: 0 } });
      assert.equal(evaluator.calls.length, 2);
      assert.equal(enricher.calls.length, 2, 'solo los candidatos evaluados reciben detalle');
      assert.equal(ledger.postings.filter((p) => !p.evaluated).length, 4);
      for (const p of ledger.postings.filter((x) => !x.evaluated)) assert.equal(p.detailAttempted, false);
    });

    // ------------------------------------- 15-19. interrupcion y cancelacion
    await testAsync('15+16. login and checkpoint during detail interrupt the run, not a generic failure', async () => {
      for (const [outcome, reason] of [[DETAIL_OUTCOMES.LOGIN_REQUIRED, STOP_REASONS.LOGIN_REQUIRED], [DETAIL_OUTCOMES.CHECKPOINT_REQUIRED, STOP_REASONS.CHECKPOINT_REQUIRED]]) {
        const source = fakeSource({ A: { results: [card(1), card(2)] } });
        const enricher = fakeEnricher(() => ({ outcome }));
        const evaluator = fakeEvaluator(() => ({ classification: 'UNCERTAIN' }));
        const ledger = await explore(engineWith(source, evaluator, enricher, ['A']));
        assert.equal(ledger.stopReason, reason);
        assert.notEqual(ledger.stopReason, STOP_REASONS.DETAIL_FAILED, 'un challenge no se degrada a fallo de detalle');
        assert.equal(evaluator.calls.length, 0, 'no se evalua tras la interrupcion');
        assert.equal(enricher.calls.length, 1, 'no se sigue pidiendo detalle');
      }
    });
    await testAsync('17+18+19. cancellation before, during and after detail stops cleanly', async () => {
      // Antes del detalle.
      const pre = new AbortController(); pre.abort();
      const beforeEnricher = fakeEnricher(() => ({ outcome: DETAIL_OUTCOMES.DETAIL_AVAILABLE, description: 'x', descriptionAvailable: true }));
      const beforeEval = fakeEvaluator(() => ({ classification: 'UNCERTAIN' }));
      const before = await explore(engineWith(fakeSource({ A: { results: [card(1)] } }), beforeEval, beforeEnricher, ['A']), { signal: pre.signal });
      assert.equal(before.stopReason, STOP_REASONS.CANCELLED);
      assert.equal(beforeEnricher.calls.length, 0, 'ningun detalle tras cancelar');
      assert.equal(beforeEval.calls.length, 0);
      // Durante el detalle: el enriquecedor devuelve CANCELLED.
      const duringEval = fakeEvaluator(() => ({ classification: 'UNCERTAIN' }));
      const during = await explore(engineWith(fakeSource({ A: { results: [card(1), card(2)] } }), duringEval, fakeEnricher(() => ({ outcome: DETAIL_OUTCOMES.CANCELLED })), ['A']));
      assert.equal(during.stopReason, STOP_REASONS.CANCELLED);
      assert.equal(duringEval.calls.length, 0, 'no se evalua despues de cancelar durante el detalle');
      // Despues del detalle y antes del evaluador.
      const after = new AbortController();
      const afterEval = fakeEvaluator(() => ({ classification: 'UNCERTAIN' }));
      const afterEnricher = { enrich: async () => { after.abort(); return { outcome: DETAIL_OUTCOMES.DETAIL_AVAILABLE, description: 'x', descriptionAvailable: true }; } };
      const afterLedger = await explore(engineWith(fakeSource({ A: { results: [card(1), card(2)] } }), afterEval, afterEnricher, ['A']), { signal: after.signal });
      assert.equal(afterLedger.stopReason, STOP_REASONS.CANCELLED);
      assert.equal(afterEval.calls.length, 0, 'el evaluador no llega a ejecutarse');
    });

    // ------------------------------------- 23-24. normalizacion y persistencia
    await testAsync('23. the description is plain, normalized and bounded', async () => {
      const long = 'Responsable de obra.  \n\n\tImplantacion\u0000 de locales. '.repeat(900);
      const enricher = createDetailEnricher({ collectDetail: async () => ({ detail: { description: long, location: 'Barcelona' } }) });
      const result = await enricher.enrich({ key: 'job:1', postingId: '1', url: 'https://www.linkedin.com/jobs/view/1/' }, { page: PAGE });
      assert.equal(result.outcome, DETAIL_OUTCOMES.DETAIL_AVAILABLE);
      assert.equal(result.description.length, MAX_DESCRIPTION_CHARS, 'acotada al maximo que ya usa MD4');
      assert(!/\n|\t|\u0000/.test(result.description), 'texto plano normalizado');
      assert(!/\s{2,}/.test(result.description), 'espacios colapsados');
      assert.equal(result.descriptionAvailable, true);
      // Determinista.
      const again = await enricher.enrich({ key: 'job:1', postingId: '1', url: 'u' }, { page: PAGE });
      assert.equal(again.description, result.description);
      // Sin descripcion no se inventa nada.
      const empty = createDetailEnricher({ collectDetail: async () => ({ detail: { description: '   ' } }) });
      const none = await empty.enrich({ key: 'job:2', postingId: '2', url: 'u' }, { page: PAGE });
      assert.equal(none.outcome, DETAIL_OUTCOMES.DETAIL_UNAVAILABLE);
      assert.equal(none.description, null);
    });
    await testAsync('24. full descriptions, HTML and secrets are never persisted', async () => {
      const dataDir = temp();
      const lockPath = path.join(dataDir, 'hunt.lock');
      const secret = 'DESCRIPCION_COMPLETA_QUE_NO_DEBE_PERSISTIRSE';
      const manager = createMarketDiscoveryRunManager({
        setupService: { getStatus: () => ({ readyForHunt: true }) },
        profileLoader: () => PROFILE, seedPlanner: seedPlan(['A']),
        runStore: createMarketDiscoveryRunStore({ dataDir }), clock: () => new Date(0),
        makeRunId: () => 'mdrun_detail1', makeOperationId: () => 'md_detail1',
        acquireLock: (o) => acquireLock(lockPath, { owner: o }), releaseLock: (o) => releaseLock(lockPath, { owner: o }),
        openSession: async () => ({ context: { close: async () => {} }, page: PAGE }),
        resolveFilters: () => ({ location: CONFIGURED }),
        source: fakeSource({ A: { results: [card(1)] } }),
        enricher: fakeEnricher(() => ({ outcome: DETAIL_OUTCOMES.DETAIL_AVAILABLE, description: secret + ' <div>html</div>', descriptionAvailable: true })),
        evaluator: fakeEvaluator(() => ({ classification: 'UNCERTAIN' })),
      });
      await manager.start();
      await manager.waitForIdle();
      const dir = path.join(dataDir, 'market-discovery/runs/mdrun_detail1');
      const everything = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
      assert(!everything.includes(secret), 'la descripcion completa NO se persiste');
      for (const token of ['<div>', '<html', 'li_at', 'cookie', 'Bearer', 'sk-', 'trackingId']) assert(!everything.includes(token));
      // Pero si queda la trazabilidad del detalle.
      const ex = JSON.parse(fs.readFileSync(path.join(dir, 'exploration.json'), 'utf8')).exploration;
      const posting = ex.postings[0];
      assert.equal(posting.detailAttempted, true);
      assert.equal(posting.detailOutcome, DETAIL_OUTCOMES.DETAIL_AVAILABLE);
      assert.equal(posting.descriptionAvailable, true);
      assert(posting.descriptionLength > 0, 'se guarda la longitud, no el texto');
      assert.equal(ex.detail.available, 1);
      // Progreso real expuesto por el gestor.
      const progress = manager.getStatus().progress;
      assert.equal(progress.detailFetchesAttempted, 1);
      assert.equal(progress.detailAvailable, 1);
      assert.equal(progress.detailUnavailable, 0);
      assert.equal(progress.detailFailed, 0);
      assert(Number.isInteger(progress.evaluationsCompleted), 'los campos previos siguen');
    });

    // ============ 25-28 + 15. REGRESION GEOGRAFIA + DETALLE (protege MD7.0.1) ============
    await testAsync('GEOGRAPHY+DETAIL: search A → detail → search B keeps the configured verified scope', async () => {
      const source = fakeSource({ A: { results: [card(1)] }, B: { results: [card(2)] } });
      const enricher = fakeEnricher(() => ({ outcome: DETAIL_OUTCOMES.DETAIL_AVAILABLE, description: 'descripcion real', descriptionAvailable: true }));
      const evaluator = fakeEvaluator(() => ({ classification: 'UNCERTAIN' }));
      const ledger = await explore(engineWith(source, evaluator, enricher, ['A', 'B']));
      // Ambas busquedas pidieron y verificaron la ubicacion configurada.
      assert.equal(source.calls.length, 2);
      for (const call of source.calls) assert.equal(call.filters.location, CONFIGURED);
      for (const search of ledger.searches) {
        assert.equal(search.requestedScope.location, CONFIGURED, `${search.searchId} pide la ubicacion`);
        assert.equal(search.observedScope.location, SCOPE.VERIFIED, `${search.searchId} la verifica`);
      }
      // La busqueda B se inicializa de nuevo (navegacion explicita), no hereda DOM.
      assert.deepEqual(ledger.searches.map((s) => s.searchId), ['d0_1', 'd0_2']);
      assert.equal(enricher.calls.length, 2);
      // La ubicacion del detalle NUNCA redefine el alcance.
      const enricherSource = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/marketDiscovery/detailEnricher.js'), 'utf8');
      assert(!/observedScope|requestedScope|VERIFIED/.test(enricherSource), 'el enriquecedor no toca el alcance');
    });
    await testAsync('GEOGRAPHY+DETAIL: UNVERIFIED scope means zero details, evaluations, expansions and proposal', async () => {
      const source = fakeSource({ A: { results: [card(1), card(2)] } }, { locationVerified: false });
      const enricher = fakeEnricher(() => ({ outcome: DETAIL_OUTCOMES.DETAIL_AVAILABLE, description: 'x', descriptionAvailable: true }));
      const evaluator = fakeEvaluator(() => ({ classification: 'COMPATIBLE', terms: [{ expression: 'x' }] }));
      const ledger = await explore(engineWith(source, evaluator, enricher, ['A']));
      assert.equal(ledger.stopReason, STOP_REASONS.SCOPE_NOT_VERIFIED);
      assert.equal(enricher.calls.length, 0, 'CERO detalles');
      assert.equal(evaluator.calls.length, 0, 'CERO evaluaciones');
      assert.equal(ledger.postings.length, 0);
      assert.equal(ledger.observations.length, 0);
      assert.deepEqual(ledger.expansion.selected, []);
      assert.equal(ledger.detail.attempted, 0);
    });

    // ================= 31-36. FIXTURE DE MERCADO REAL (vocabulario observado) =================
    await testAsync('REAL-RUN FIXTURE: description evidence — not the title — produces COMPATIBLE, terms, expansion and a proposal', async () => {
      // Titulo observado en la primera corrida real.
      const TITLE = 'Project Manager Espacios Comerciales';
      const DESCRIPTION = 'Buscamos un perfil responsable de la implantacion de locales comerciales, '
        + 'coordinando aperturas y reformas con contratistas y direccion de obra. '
        + 'Gestion del proyecto ejecutivo y seguimiento de plazos en retail.';
      const withTitle = (id, company) => card(id, { title: TITLE, company });
      const source = fakeSource({
        A: { results: [withTitle(11, 'Alfa SA'), withTitle(12, 'Beta SA'), withTitle(13, 'Gamma SA')] },
        B: { results: [withTitle(21, 'Delta SA')] },
        'implantacion de locales comerciales': { results: [withTitle(31, 'Epsilon SA')] },
      });
      // El detalle SOLO se entrega a las ofertas de la familia A y a la expansion.
      const enricher = fakeEnricher((posting) => (Number(posting.postingId) === 21
        ? { outcome: DETAIL_OUTCOMES.DETAIL_UNAVAILABLE }
        : { outcome: DETAIL_OUTCOMES.DETAIL_AVAILABLE, description: DESCRIPTION, descriptionAvailable: true }));
      // MD4 simulado con su regla real: sin descripcion no hay evidencia anclada.
      const evaluator = fakeEvaluator((request) => {
        if (!request.posting.description) return { classification: 'UNCERTAIN' };
        return { classification: 'COMPATIBLE', terms: [{ type: 'DISCRIMINATOR', expression: 'implantacion de locales comerciales' }] };
      });
      const ledger = await explore(engineWith(source, evaluator, enricher, ['A', 'B']));

      // La oferta SIN descripcion queda UNCERTAIN: el titulo por si solo no basta.
      const cardOnly = ledger.postings.find((p) => p.postingId === '21');
      assert.equal(cardOnly.descriptionAvailable, false);
      assert.equal(cardOnly.classification, 'UNCERTAIN', 'el titulo por si solo no produce COMPATIBLE');
      // Las que SI recibieron descripcion son COMPATIBLE por evidencia anclada.
      for (const id of ['11', '12', '13']) {
        const p = ledger.postings.find((x) => x.postingId === id);
        assert.equal(p.descriptionAvailable, true);
        assert.equal(p.classification, 'COMPATIBLE');
      }
      assert(evaluator.calls.find((c) => c.postingId === '11').description.includes('implantacion de locales comerciales'));
      // Terminologia promocionable -> expansion de profundidad 1.
      assert(ledger.observations.some((o) => o.promotable && o.normalized === 'implantacion de locales comerciales'));
      assert.equal(ledger.expansion.selected.length, 1);
      assert.equal(ledger.expansion.selected[0].expression, 'implantacion de locales comerciales');
      // La oferta hallada POR la expansion tambien pasa por detalle antes de evaluar.
      const expansionPosting = ledger.postings.find((p) => p.postingId === '31');
      assert.equal(expansionPosting.depth, 1);
      assert.equal(expansionPosting.detailAttempted, true, 'sin atajos para profundidad 1');
      assert.equal(expansionPosting.descriptionAvailable, true);
      // MD6 puede construir una propuesta, y queda inerte.
      const proposal = buildQueryPortfolio({ exploration: ledger, profile: PROFILE });
      assert(proposal.selectedQueries.length >= 1);
      assert.equal(proposal.applied, false);
      assert(proposal.selectedQueries.every((q) => q.whySelected));
    });

    // ------------------------------------- 30 + 37-41. contratos y aislamiento
    test('30+37+38+39. MD4 gate untouched, Hunter detail collection unchanged, no Hunter state', () => {
      const contract = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/marketDiscovery/semanticContract.js'), 'utf8');
      assert(contract.includes('COMPATIBLE requires supported capabilities or responsibilities'), 'la compuerta de MD4 sigue intacta');
      assert(contract.includes('COMPATIBLE requires at least one grounded evidence snippet'));
      // El bucle de Hunter sigue existiendo y exportado igual que antes.
      const detail = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/linkedin/detailCollector.js'), 'utf8');
      assert(detail.includes('async function collectJobDetails('), 'collectJobDetails sigue existiendo');
      assert(/module\.exports\s*=\s*\{[\s\S]*collectJobDetails/.test(detail), 'sigue exportado');
      assert(/module\.exports\s*=\s*\{[\s\S]*collectJobDetail,/.test(detail), 'collectJobDetail ahora tambien se exporta');
      // El enriquecedor no toca estado de Hunter.
      const enricher = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/marketDiscovery/detailEnricher.js'), 'utf8');
      for (const token of ['jobRepository', 'jobService', 'jobAnalyzer', 'runPipeline', 'huntRunManager', 'userConfig', 'searchSettings', 'writeFileSync']) {
        assert(!enricher.includes(token), `el enriquecedor no debe referenciar ${token}`);
      }
      assert(enricher.includes("require('../linkedin/detailCollector')"), 'reutiliza el collector existente');
    });
    test('40. packaging includes the new module and still excludes runtime data', () => {
      const pkg = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'scripts/package-windows.js'), 'utf8');
      assert(/forbiddenRoots\s*=\s*new Set\(\['runtime-data'/.test(pkg), 'runtime-data sigue excluido');
      assert(pkg.includes("relative.startsWith('src/tests/')"), 'los tests siguen excluidos');
      // El modulo vive bajo src/, que el empaquetado copia por defecto.
      assert(fs.existsSync(path.join(runtime.PROJECT_ROOT, 'src/marketDiscovery/detailEnricher.js')));
    });

    console.log('Market Detail (MD7.1): ' + passed + ' tests passed');
  } finally {
    for (const dir of roots.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

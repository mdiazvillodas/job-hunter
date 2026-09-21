'use strict';

// MD5 — motor de exploracion acotada de Market Discovery.
//
// Compone lo ya construido: mapa de perfil y plan de semillas (MD1/MD2),
// propiedad de operacion (MD3a), fuente de LinkedIn de solo lectura (MD3b) y
// evaluador semantico (MD4). No redisena ninguno de esos contratos.
//
// PRINCIPIO RECTOR: AMPLITUD ANTES QUE PROFUNDIDAD. Una familia temprana y ruidosa
// no puede consumir el presupuesto semantico antes de que las demas tengan su
// oportunidad. La reparticion es round-robin y esta testeada como regresion.
//
// El motor NO adquiere ni libera el lock del navegador (eso es del futuro run
// manager), no escribe estado de Hunter y no produce el portafolio final.

const { freeze, assert, normalize } = require('./domain');
const { generateSeedPlan } = require('./seedGenerator');
const { assertMarketDiscoveryOwner } = require('./linkedinMarketSource');
const { STOP_REASONS, POLICY, resolveBudget } = require('./explorationBudget');
const { DETAIL_OUTCOMES } = require('./detailEnricher');
const { toSafeSemanticDiagnostic } = require('./semanticContract');

const INITIAL_DEPTH = 0;
const EXPANSION_DEPTH = 1;

function isCancelled(signal) { return Boolean(signal && signal.aborted); }

// Identidad canonica de la oferta. Se usa la de LinkedIn cuando existe; si no, la
// URL canonica que ya establecio MD3b. Nunca se fusiona por titulo/empresa.
function postingKey(result) {
  if (result && typeof result.jobId === 'string' && result.jobId) return 'job:' + result.jobId;
  if (result && typeof result.url === 'string' && result.url) return 'url:' + result.url;
  return null;
}

function createExplorationEngine(options = {}) {
  const source = options.source;
  const evaluator = options.evaluator;
  assert(source && typeof source.search === 'function', 'a market source is required');
  assert(evaluator && typeof evaluator.evaluatePosting === 'function', 'a semantic evaluator is required');
  const planSeeds = options.seedPlanner || generateSeedPlan;
  const clock = options.clock || (() => new Date());
  // MD7.1: enriquecedor OPCIONAL e inyectable. Sin el, la exploracion se comporta
  // exactamente como antes (solo tarjeta), asi que MD5 sigue siendo compatible.
  const enrich = options.enricher && typeof options.enricher.enrich === 'function'
    ? (posting, context) => options.enricher.enrich(posting, context)
    : null;

  async function explore(request = {}) {
    const owner = assertMarketDiscoveryOwner(request.owner);
    const budget = resolveBudget(request.budget);
    const profile = request.profile;
    const filters = request.filters || {};
    const signal = request.signal;
    const page = request.page;
    const startedAtMs = clock().getTime();
    const startedAt = new Date(startedAtMs).toISOString();

    // --- Libro mayor. Ninguna decision de reparto vive solo en una variable local.
    const searches = [];            // orden de ejecucion
    const postings = new Map();     // key -> registro global unico
    const evaluations = [];
    const observations = [];        // terminologia observada (todas las profundidades)
    const sourceFailures = [];
    const semanticFailures = [];
    let evaluationsUsed = 0;
    let saturationStreak = 0;
    let stop = null;                // motivo terminal, si se alcanza uno
    let candidates = [];            // terminos agregados, elegibles o no
    const selectedTerms = [];       // los que reciben una busqueda de expansion
    // MD7.1: contabilidad acotada del detalle de oferta.
    let detailFetches = 0;
    const detailCounters = { available: 0, unavailable: 0, failed: 0 };
    const detailFailures = [];
    // MD7.2: por que cada familia recibio los turnos de evaluacion que recibio.
    const initialAllocation = new Map();
    // MD9.1: en que se gasto el presupuesto de evaluacion, por fase.
    let protectedInitialEvaluations = 0;
    let expansionEvaluations = 0;
    let reclaimedEvaluations = 0;
    let expansionEligible = 0;

    // Una familia puede recibir turnos en DOS pasadas (inicial y reclamo). Los
    // turnos y las sondas se suman; el resto del estado es el de la ultima.
    function mergeAllocation(rows, pass) {
      for (const row of rows || []) {
        const prior = initialAllocation.get(row.key);
        const reclaimedTurns = (prior ? prior.reclaimedTurns || 0 : 0) + (pass === 'reclaim' ? row.evaluationTurns : 0);
        initialAllocation.set(row.key, prior
          ? {
            ...row,
            evaluationTurns: prior.evaluationTurns + row.evaluationTurns,
            probes: prior.probes + row.probes,
            reclaimedTurns,
          }
          : { ...row, reclaimedTurns });
      }
    }

    const seedPlan = planSeeds(profile);
    const families = seedPlan.seeds.map((seed, index) => ({
      familyId: seed.familyId,
      expression: seed.expression,
      query: seed.expression,
      queryLanguage: seed.language,
      rank: seed.rank === undefined ? index + 1 : seed.rank,
    }));

    const elapsedMs = () => clock().getTime() - startedAtMs;
    const timeExceeded = () => elapsedMs() > budget.maxDurationMs;

    // Una sola compuerta para todos los cortes. Devuelve el motivo o null.
    function checkStop() {
      if (stop) return stop;
      if (isCancelled(signal)) { stop = STOP_REASONS.CANCELLED; return stop; }
      if (timeExceeded()) { stop = STOP_REASONS.TIME_LIMIT; return stop; }
      return null;
    }

    function executedQueries() {
      return new Set(searches.map((entry) => normalize(entry.query)));
    }

    async function runSearch(spec) {
      if (checkStop()) return null;
      if (searches.length >= budget.maxSearches) { stop = STOP_REASONS.BUDGET_EXHAUSTED; return null; }
      const searchId = spec.searchId;
      let outcome;
      try {
        outcome = await source.search({
          owner, page, signal,
          search: { searchId, familyId: spec.familyId, seedExpression: spec.expression, query: spec.query, queryLanguage: spec.queryLanguage },
          filters,
          limits: { ...POLICY.searchLimits },
        });
      } catch (error) {
        // La fuente de MD3b devuelve resultados estructurados; un throw es un fallo
        // ordinario y se contabiliza igual, sin reintentos.
        outcome = { status: 'FAILED', stopReason: 'source_threw', results: [], metrics: null, challenge: null };
      }
      const entry = {
        searchId, depth: spec.depth, familyId: spec.familyId, query: spec.query,
        origin: spec.origin, originTermId: spec.originTermId || null,
        status: outcome.status, stopReason: outcome.stopReason || null,
        resultKeys: [], newPostingKeys: [], overlapRatio: null, newCompatible: 0,
        countedForSaturation: false,
        metrics: outcome.metrics ? { ...outcome.metrics } : null,
        // Alcance PEDIDO y OBSERVADO: sin esto no se puede auditar despues que
        // ubicacion se pidio ni si LinkedIn la confirmo.
        requestedScope: outcome.requestedScope ? { ...outcome.requestedScope } : null,
        observedScope: outcome.observedScope ? { ...outcome.observedScope } : null,
      };
      searches.push(entry);

      if (outcome.status === 'CANCELLED') { stop = STOP_REASONS.CANCELLED; return entry; }
      if (outcome.status === 'INTERRUPTED') {
        const code = outcome.challenge && outcome.challenge.code;
        stop = code === 'LOGIN_REQUIRED' ? STOP_REASONS.LOGIN_REQUIRED
          : code === 'CHECKPOINT_REQUIRED' ? STOP_REASONS.CHECKPOINT_REQUIRED
            // Ubicacion no confirmada: motivo propio, nunca un fallo generico.
            : outcome.stopReason === 'scope_not_verified' ? STOP_REASONS.SCOPE_NOT_VERIFIED
              : STOP_REASONS.SOURCE_FAILED;
        return entry;
      }
      if (outcome.status !== 'COMPLETED') {
        sourceFailures.push({ searchId, stopReason: entry.stopReason });
        if (sourceFailures.length >= budget.maxSourceFailures) stop = STOP_REASONS.SOURCE_FAILED;
        return entry;
      }

      // Dedup GLOBAL para evaluar una sola vez, conservando TODA la atribucion.
      for (const result of outcome.results || []) {
        const key = postingKey(result);
        if (!key) continue;
        entry.resultKeys.push(key);
        const known = postings.get(key);
        if (known) {
          if (!known.searchIds.includes(searchId)) known.searchIds.push(searchId);
          if (spec.familyId && !known.familyIds.includes(spec.familyId)) known.familyIds.push(spec.familyId);
          continue;
        }
        if (postings.size >= budget.maxUniquePostings) { entry.capReached = true; continue; }
        entry.newPostingKeys.push(key);
        postings.set(key, {
          key, postingId: result.jobId || null, url: result.url || null,
          title: result.title || null, company: result.company || null, location: result.location || null,
          firstSearchId: searchId, searchIds: [searchId], familyIds: spec.familyId ? [spec.familyId] : [],
          depth: spec.depth, evaluated: false, classification: null,
        });
      }
      const total = entry.resultKeys.length;
      // Una busqueda completada sin resultados no aporta nada: solapamiento 1.
      entry.overlapRatio = total === 0 ? 1 : (total - entry.newPostingKeys.length) / total;
      return entry;
    }

    // Evaluacion JUSTA: round-robin por grupo. Un duplicado no gasta evaluacion,
    // solo avanza el cursor, asi que el turno se reparte por EVALUACIONES reales.
    //
    // MD7.2: con `adaptive`, el reparto tiene dos fases sobre el MISMO presupuesto:
    //   EXPLORAR  -> round-robin puro hasta que cada familia alcanza su muestra
    //                minima (o se queda sin candidatos). Nadie es descartado por
    //                uno o dos resultados malos.
    //   EXPLOTAR  -> los turnos restantes van a las familias que YA produjeron
    //                evidencia compatible; las de rendimiento cero reciben una
    //                sonda acotada cada N rondas, no un turno por ronda.
    // ARRANQUE EN FRIO: si NINGUNA familia tiene evidencia compatible no hay nada
    // que explotar, asi que se sigue repartiendo por igual. La politica nunca
    // puede impedir encontrar la primera oferta compatible.
    async function evaluateFairly(groups, allowance, options = {}) {
      const adaptive = options.adaptive === true && groups.length > 1;
      const cursors = groups.map(() => 0);
      // Turnos REALMENTE pagados por cada grupo (un duplicado no paga turno).
      const turns = groups.map(() => 0);
      const probes = groups.map(() => 0);
      const phases = groups.map(() => null);
      let used = 0;
      let exploitRound = 0;
      const unevaluatedRemains = () => groups.some((group) => group.keys.some((key) => {
        const record = postings.get(key);
        return record && !record.evaluated;
      }));

      // Avanza el cursor por encima de lo ya evaluado y DEVUELVE el siguiente
      // candidato sin consumirlo. Es idempotente: mirar no gasta el turno.
      function peek(g) {
        const queue = groups[g].keys;
        while (cursors[g] < queue.length) {
          const record = postings.get(queue[cursors[g]]);
          if (record && !record.evaluated) return record;
          cursors[g] += 1;
        }
        return null;
      }
      // Evidencia OBSERVADA por el grupo, la haya pagado el o no: una oferta
      // compartida entre familias cuenta para ambas (igual que la atribucion del
      // libro mayor) y no se vuelve a evaluar ni se paga dos veces.
      function observed(g, predicate) {
        let n = 0;
        for (const key of groups[g].keys) {
          const record = postings.get(key);
          if (record && record.evaluated && predicate(record)) n += 1;
        }
        return n;
      }
      const evaluatedIn = (g) => observed(g, () => true);
      const compatibleIn = (g) => observed(g, (record) => record.classification === 'COMPATIBLE');

      // Orden de grupos elegibles en esta ronda. Determinista: siempre el orden
      // de las familias (rango de semilla), nunca aleatorio.
      function allocationOrder() {
        const all = groups.map((_, index) => index);
        if (!adaptive) return all;
        const pending = all.filter((g) => peek(g) !== null);
        const belowMinimum = pending.filter((g) => evaluatedIn(g) < POLICY.minFamilyEvaluationSample);
        if (belowMinimum.length) {
          for (const g of belowMinimum) phases[g] = 'EXPLORE';
          return belowMinimum;
        }
        const productive = pending.filter((g) => compatibleIn(g) > 0);
        // Arranque en frio: sin evidencia compatible en ninguna familia se
        // mantiene el reparto equitativo.
        if (!productive.length) {
          for (const g of pending) phases[g] = 'EXPLORE';
          return pending;
        }
        for (const g of productive) phases[g] = 'EXPLOIT';
        const probing = exploitRound % POLICY.zeroYieldProbeInterval === 0
          ? pending.filter((g) => compatibleIn(g) === 0)
          : [];
        for (const g of probing) { phases[g] = 'PROBE'; probes[g] += 1; }
        exploitRound += 1;
        return productive.concat(probing);
      }

      while (used < allowance) {
        let sweep = allocationOrder().filter((g) => peek(g) !== null);
        // Si la politica no deja a nadie con candidatos, no se desperdicia
        // presupuesto: se vuelve a abrir a todos los grupos que aun tengan cola.
        if (!sweep.length) sweep = groups.map((_, index) => index).filter((g) => peek(g) !== null);
        if (!sweep.length) break;
        let progressed = false;
        for (const g of sweep) {
          if (used >= allowance) break;
          if (checkStop()) return { used, exhausted: false, allocation: buildAllocation() };
          const picked = peek(g);
          if (!picked) continue;
          cursors[g] += 1;
          turns[g] += 1;
          progressed = true;
          if (evaluationsUsed >= budget.maxEvaluations) { stop = STOP_REASONS.BUDGET_EXHAUSTED; return { used, exhausted: true, allocation: buildAllocation() }; }
          picked.evaluated = true;
          used += 1;
          evaluationsUsed += 1;

          // --- MD7.1: el detalle se busca AQUI, justo antes de evaluar, y solo
          // para este candidato ya deduplicado. Un unico intento, sin reintentos.
          if (enrich && detailFetches < budget.maxDetailFetches) {
            detailFetches += 1;
            picked.detailAttempted = true;
            const enriched = await enrich(picked, { page, signal, owner });
            picked.detailOutcome = enriched ? enriched.outcome : DETAIL_OUTCOMES.DETAIL_FAILED;
            if (picked.detailOutcome === DETAIL_OUTCOMES.CANCELLED) { stop = STOP_REASONS.CANCELLED; return { used, exhausted: false, allocation: buildAllocation() }; }
            if (picked.detailOutcome === DETAIL_OUTCOMES.LOGIN_REQUIRED) { stop = STOP_REASONS.LOGIN_REQUIRED; return { used, exhausted: false, allocation: buildAllocation() }; }
            if (picked.detailOutcome === DETAIL_OUTCOMES.CHECKPOINT_REQUIRED) { stop = STOP_REASONS.CHECKPOINT_REQUIRED; return { used, exhausted: false, allocation: buildAllocation() }; }
            if (picked.detailOutcome === DETAIL_OUTCOMES.DETAIL_AVAILABLE) {
              picked.description = enriched.description;
              picked.descriptionAvailable = true;
              detailCounters.available += 1;
            } else {
              // Sin descripcion se evalua igual, solo con la tarjeta. Nunca se inventa.
              if (picked.detailOutcome === DETAIL_OUTCOMES.DETAIL_UNAVAILABLE) detailCounters.unavailable += 1;
              else { detailCounters.failed += 1; detailFailures.push({ postingKey: picked.key, outcome: picked.detailOutcome }); }
              if (detailFailures.length >= budget.maxDetailFailures) { stop = STOP_REASONS.DETAIL_FAILED; return { used, exhausted: false, allocation: buildAllocation() }; }
            }
            if (checkStop()) return { used, exhausted: false, allocation: buildAllocation() };
          }

          let assessment = null;
          try {
            assessment = await evaluator.evaluatePosting({
              profile,
              posting: {
                postingId: picked.postingId || picked.key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120),
                url: picked.url, title: picked.title, company: picked.company, location: picked.location,
                description: picked.description === undefined ? null : picked.description,
                provenance: { searchId: picked.firstSearchId, familyId: picked.familyIds[0] || null, query: null },
              },
              signal,
            });
          } catch (error) {
            // Un fallo semantico aislado no corrompe el run: se registra y se sigue.
            // El diagnostico dice QUE regla del contrato se rompio, para que un
            // fallo futuro sea explicable sin volver a llamar al modelo. Es
            // deliberadamente pobre: ni respuesta del modelo, ni descripcion,
            // ni prompt, ni payload de la API.
            const failure = { postingKey: picked.key, searchId: picked.firstSearchId, ...toSafeSemanticDiagnostic(error) };
            semanticFailures.push(failure);
            picked.classification = null;
            if (isCancelled(signal)) { stop = STOP_REASONS.CANCELLED; return { used, exhausted: false, allocation: buildAllocation() }; }
            if (semanticFailures.length >= budget.maxSemanticFailures) { stop = STOP_REASONS.SEMANTIC_FAILED; return { used, exhausted: false, allocation: buildAllocation() }; }
            continue;
          }
          picked.classification = assessment.classification;
          evaluations.push({
            postingKey: picked.key, postingId: picked.postingId, searchIds: [...picked.searchIds],
            familyIds: [...picked.familyIds], firstSearchId: picked.firstSearchId, depth: picked.depth,
            classification: assessment.classification, cacheKey: assessment.identity ? assessment.identity.cacheKey : null,
          });
          for (const term of assessment.terminology || []) {
            observations.push({
              type: term.type, expression: term.expression, normalized: term.normalized,
              sourceField: term.sourceField, promotable: term.promotable === true, eligibility: term.eligibility,
              postingKey: picked.key, company: picked.company || null,
              familyIds: [...picked.familyIds], searchIds: [...picked.searchIds], depth: picked.depth,
            });
          }
          if (assessment.classification === 'COMPATIBLE') {
            const origin = searches.find((entry) => entry.searchId === picked.firstSearchId);
            if (origin) origin.newCompatible += 1;
          }
        }
        if (!progressed) break;
      }
      return { used, exhausted: unevaluatedRemains(), allocation: buildAllocation() };

      // Por que cada grupo recibio los turnos que recibio. Solo agregados: ni
      // descripciones, ni salida del modelo, ni texto de oferta.
      function buildAllocation() {
        return groups.map((group, g) => {
          const remaining = group.keys.filter((key) => { const r = postings.get(key); return r && !r.evaluated; }).length;
          const compatible = compatibleIn(g);
          const evaluated = evaluatedIn(g);
          // `state` es UNA sola cosa: la postura de reparto. Que la cola se haya
          // agotado es un hecho aparte (remainingCandidates) y se anota en el
          // motivo, para no perder POR QUE la familia recibio esos turnos.
          let state;
          let reason;
          if (!adaptive) {
            state = 'ROUND_ROBIN';
            reason = 'single group: no adaptive allocation';
          } else if (compatible > 0) {
            state = 'PRIORITIZED';
            reason = `${compatible} compatible in ${evaluated} evaluated: prioritized for the remaining turns`;
          } else if (evaluated < POLICY.minFamilyEvaluationSample) {
            state = 'MINIMUM_PENDING';
            reason = `budget ended before the minimum sample of ${POLICY.minFamilyEvaluationSample} was completed`;
          } else if (probes[g] > 0) {
            state = 'DEPRIORITIZED';
            reason = `no compatible evidence in ${evaluated} evaluated: probed once every ${POLICY.zeroYieldProbeInterval} rounds`;
          } else {
            state = 'MINIMUM_SAMPLE';
            reason = `no compatible evidence in ${evaluated} evaluated: received the guaranteed minimum sample only`;
          }
          if (!remaining) reason += '; queue exhausted';
          return { key: group.key, evaluationTurns: turns[g], observedEvaluated: evaluated, observedCompatible: compatible, probes: probes[g], remainingCandidates: remaining, minimumSample: POLICY.minFamilyEvaluationSample, minimumSampleMet: evaluated >= POLICY.minFamilyEvaluationSample, phase: phases[g] || 'EXPLORE', state, stateReason: reason };
        });
      }
    }

    // Saturacion: solo cuentan busquedas COMPLETADAS. Dos consecutivas con
    // solapamiento alto y sin evidencia compatible nueva detienen la exploracion.
    function updateSaturation(fromIndex) {
      for (let i = fromIndex; i < searches.length; i += 1) {
        const entry = searches[i];
        if (entry.status !== 'COMPLETED') continue; // fallida/interrumpida NO cuenta
        entry.countedForSaturation = true;
        const qualifies = entry.overlapRatio > POLICY.saturationOverlapRatio && entry.newCompatible === 0;
        entry.saturationQualified = qualifies;
        saturationStreak = qualifies ? saturationStreak + 1 : 0;
      }
      return saturationStreak >= POLICY.saturationConsecutiveSearches;
    }

    // ---------------- Fase 0: sin familias no hay nada que explorar.
    if (!families.length) {
      return buildResult(STOP_REASONS.COMPLETED);
    }

    // ---------------- Fase 1: AMPLITUD. Una busqueda por familia, antes de evaluar nada.
    const initialSpecs = families.slice(0, budget.maxInitialSearches).map((family, index) => ({
      searchId: `d0_${index + 1}`, depth: INITIAL_DEPTH, familyId: family.familyId,
      expression: family.expression, query: family.query, queryLanguage: family.queryLanguage, origin: 'SEED',
    }));
    for (const spec of initialSpecs) {
      if (checkStop()) break;
      await runSearch(spec);
      if (stop) break;
    }

    // ---------------- Fase 2: evaluacion JUSTA entre familias.
    const initialSearchIndex = 0;
    // Si el presupuesto de busqueda no alcanzo para dar una oportunidad a cada
    // familia, el run esta limitado por presupuesto, no saturado.
    const familiesNotSearched = initialSpecs.length < families.length;
    let candidatesRemain = false;
    // Los grupos iniciales se conservan: la fase de RECLAMO vuelve a repartir
    // sobre ELLOS, con la misma politica adaptativa y sin nuevas busquedas.
    const initialGroups = initialSpecs.map((spec) => ({
      key: spec.familyId,
      keys: (searches.find((entry) => entry.searchId === spec.searchId) || { resultKeys: [] }).resultKeys,
    }));
    if (!stop) {
      const pass = await evaluateFairly(
        initialGroups,
        Math.min(budget.initialEvaluationReserve, budget.maxEvaluations),
        { adaptive: true }
      );
      protectedInitialEvaluations = pass.used;
      candidatesRemain = pass.exhausted;
      mergeAllocation(pass.allocation, 'initial');
    }

    // ---------------- Fase 3: agregacion + elegibilidad de expansion.
    candidates = aggregateCandidates();
    const saturated = updateSaturation(initialSearchIndex);

    if (!stop && saturated) stop = STOP_REASONS.SATURATED;

    // ---------------- Fase 4: expansion controlada, profundidad 1 y solo una vez.
    if (!stop && !checkStop()) {
      const eligible = candidates.filter((candidate) => candidate.eligible);
      for (const candidate of eligible.slice(0, budget.maxExpansionSearches)) {
        candidate.selected = true;
        candidate.selectionReason = 'ranked within the expansion budget';
        selectedTerms.push(candidate);
      }
      for (const candidate of eligible.slice(budget.maxExpansionSearches)) {
        candidate.selectionReason = 'eligible but beyond the expansion search budget';
      }
      const perTerm = selectedTerms.length
        ? Math.max(1, Math.floor(budget.expansionEvaluationReserve / selectedTerms.length))
        : 0;
      for (let i = 0; i < selectedTerms.length; i += 1) {
        if (checkStop() || stop) break;
        const candidate = selectedTerms[i];
        const before = searches.length;
        const entry = await runSearch({
          searchId: `d1_${i + 1}`, depth: EXPANSION_DEPTH, familyId: null,
          expression: candidate.expression, query: candidate.expression, queryLanguage: 'und',
          origin: 'EXPANSION', originTermId: candidate.termId,
        });
        if (stop) break;
        if (entry && entry.status === 'COMPLETED') {
          // Toda oferta de expansion vuelve a pasar por la MISMA compuerta MD4
          // contra el perfil original: no se hereda compatibilidad.
          const pass = await evaluateFairly([{ key: candidate.termId, keys: entry.resultKeys }], perTerm);
          expansionEvaluations += pass.used;
          if (stop) break;
        }
        if (updateSaturation(before)) { stop = STOP_REASONS.SATURATED; break; }
      }
      expansionEligible = eligible.length;
    }

    // ---------------- Fase 5: RECLAMO.
    //
    // La reserva de expansion existe para GARANTIZAR la oportunidad de expandir,
    // no para quedarse sin usar. Llegados aqui la expansion ya tuvo su turno
    // completo (fase 4). Si no pudo consumir su reserva -porque no habia terminos
    // elegibles, o no los suficientes- esa capacidad vuelve a las familias
    // iniciales en lugar de quedar varada.
    //
    // El tope total NO se mueve: sigue siendo maxEvaluations, y evaluateFairly lo
    // hace cumplir. No se lanza ninguna busqueda nueva ni se abre ninguna pagina
    // nueva: se reparte sobre candidatos YA recuperados, con la MISMA politica
    // adaptativa de MD7.2 (muestra minima, priorizacion por evidencia, sondas).
    if (!stop && !checkStop()) {
      const remaining = budget.maxEvaluations - evaluationsUsed;
      if (remaining > 0 && initialGroups.length) {
        const pass = await evaluateFairly(initialGroups, remaining, { adaptive: true });
        reclaimedEvaluations = pass.used;
        // Tras el reclamo, "quedan candidatos" vuelve a medirse: si se consumieron
        // todos, la corrida esta COMPLETA, no limitada por presupuesto.
        candidatesRemain = pass.exhausted;
        mergeAllocation(pass.allocation, 'reclaim');
      }
    }

    // El agotamiento de presupuesto NUNCA se reporta como saturacion.
    if (!stop && (familiesNotSearched || candidatesRemain)) stop = STOP_REASONS.BUDGET_EXHAUSTED;
    return buildResult(stop || STOP_REASONS.COMPLETED);

    // --- Agregacion: solo terminologia promocionable de ofertas COMPATIBLE.
    function aggregateCandidates() {
      const compatible = new Set(evaluations.filter((item) => item.classification === 'COMPATIBLE').map((item) => item.postingKey));
      const already = executedQueries();
      const exclusions = (profile && Array.isArray(profile.exclusions) ? profile.exclusions : []).map((fact) => normalize(fact.text)).filter(Boolean);
      const grouped = new Map();
      for (const observation of observations) {
        if (!observation.promotable) continue;                 // UNCERTAIN/OUT_OF_SCOPE quedan fuera
        if (!compatible.has(observation.postingKey)) continue;  // solo evidencia COMPATIBLE
        const termId = observation.type + ':' + observation.normalized;
        if (!grouped.has(termId)) {
          grouped.set(termId, {
            termId, type: observation.type, expression: observation.expression, normalized: observation.normalized,
            postingKeys: [], companies: [], familyIds: [], searchIds: [],
          });
        }
        const group = grouped.get(termId);
        if (!group.postingKeys.includes(observation.postingKey)) group.postingKeys.push(observation.postingKey);
        if (observation.company && !group.companies.includes(observation.company)) group.companies.push(observation.company);
        for (const familyId of observation.familyIds) if (!group.familyIds.includes(familyId)) group.familyIds.push(familyId);
        for (const searchId of observation.searchIds) if (!group.searchIds.includes(searchId)) group.searchIds.push(searchId);
      }
      const list = [...grouped.values()].map((group) => {
        const postingsWithCompany = group.postingKeys.filter((key) => {
          const record = postings.get(key);
          return record && record.company;
        }).length;
        const companyRequired = postingsWithCompany >= POLICY.minExpansionCompanies;
        let eligible = true;
        let reason = 'supported by distinct compatible postings';
        if (group.postingKeys.length < POLICY.minExpansionPostings) {
          eligible = false; reason = `fewer than ${POLICY.minExpansionPostings} distinct compatible postings`;
        } else if (companyRequired && group.companies.length < POLICY.minExpansionCompanies) {
          eligible = false; reason = `fewer than ${POLICY.minExpansionCompanies} distinct companies`;
        } else if (already.has(group.normalized)) {
          eligible = false; reason = 'already searched in this run';
        } else if (exclusions.some((text) => text === group.normalized || text.includes(group.normalized) || group.normalized.includes(text))) {
          eligible = false; reason = 'matches an explicit profile exclusion';
        } else if (!companyRequired) {
          reason = 'supported by distinct compatible postings (company unavailable)';
        }
        return {
          ...group, distinctPostings: group.postingKeys.length, distinctCompanies: group.companies.length,
          distinctFamilies: group.familyIds.length, companyRequirementApplied: companyRequired,
          eligible, reason, selected: false, selectionReason: eligible ? null : reason,
        };
      });
      // Orden determinista y explicable. El id NUNCA es prioridad semantica:
      // solo desempata al final, y por texto normalizado, no por hash.
      list.sort((a, b) => b.distinctPostings - a.distinctPostings
        || b.distinctCompanies - a.distinctCompanies
        || b.distinctFamilies - a.distinctFamilies
        // Un ROLE_TITLE es directamente utilizable como query de busqueda, igual
        // que una expresion semilla; un DISCRIMINATOR describe contexto.
        || (a.type === b.type ? 0 : a.type === 'ROLE_TITLE' ? -1 : 1)
        || a.normalized.localeCompare(b.normalized, 'en'));
      return list;
    }

    function buildResult(reason) {
      const completedSearches = searches.filter((entry) => entry.status === 'COMPLETED').length;
      const byFamily = families.map((family) => {
        const familySearches = searches.filter((entry) => entry.familyId === family.familyId);
        const familyEvaluations = evaluations.filter((item) => item.familyIds.includes(family.familyId));
        const tally = { COMPATIBLE: 0, UNCERTAIN: 0, OUT_OF_SCOPE: 0 };
        for (const item of familyEvaluations) if (tally[item.classification] !== undefined) tally[item.classification] += 1;
        return {
          familyId: family.familyId, expression: family.expression, rank: family.rank,
          searchIds: familySearches.map((entry) => entry.searchId),
          postingsObserved: [...postings.values()].filter((record) => record.familyIds.includes(family.familyId)).length,
          evaluations: familyEvaluations.length, classifications: tally,
          // MD7.2: reparto adaptativo del presupuesto inicial de evaluacion.
          allocation: initialAllocation.get(family.familyId) || null,
        };
      });
      const overlaps = [...postings.values()]
        .filter((record) => record.searchIds.length > 1)
        .map((record) => ({ postingKey: record.key, searchIds: [...record.searchIds], familyIds: [...record.familyIds] }));
      return freeze({
        schemaVersion: 1,
        operationType: 'MARKET_DISCOVERY',
        operationId: owner.operationId,
        status: reason,
        partial: reason !== STOP_REASONS.COMPLETED,
        stopReason: reason,
        startedAt,
        finishedAt: new Date(startedAtMs + elapsedMs()).toISOString(),
        elapsedMs: elapsedMs(),
        seedPlan: {
          familiesConsidered: seedPlan.familiesConsidered, familiesSelected: seedPlan.familiesSelected,
          truncated: seedPlan.truncated,
          omittedFamilies: seedPlan.omittedFamilies.map((family) => ({ familyId: family.familyId, expression: family.expression, rank: family.rank, reason: family.reason })),
          priority: [...seedPlan.priority],
        },
        families: byFamily,
        searches: searches.map((entry) => ({
          searchId: entry.searchId, depth: entry.depth, familyId: entry.familyId, query: entry.query,
          origin: entry.origin, originTermId: entry.originTermId, status: entry.status, stopReason: entry.stopReason,
          resultKeys: [...entry.resultKeys], newPostingKeys: [...entry.newPostingKeys],
          overlapRatio: entry.overlapRatio, newCompatible: entry.newCompatible,
          countedForSaturation: entry.countedForSaturation === true,
          saturationQualified: entry.saturationQualified === true,
          uniquePostingCapReached: entry.capReached === true,
          requestedScope: entry.requestedScope, observedScope: entry.observedScope,
          metrics: entry.metrics,
        })),
        // Metadatos de tarjeta seguros: suficientes para auditar geografia y
        // atribucion despues. Sin HTML, sin URLs de tracking, sin sesion.
        postings: [...postings.values()].map((record) => ({
          postingKey: record.key, postingId: record.postingId, title: record.title,
          company: record.company, location: record.location, url: record.url,
          firstSearchId: record.firstSearchId, searchIds: [...record.searchIds], familyIds: [...record.familyIds],
          depth: record.depth, evaluated: record.evaluated, classification: record.classification,
          // Trazabilidad del detalle SIN guardar la descripcion completa.
          detailAttempted: record.detailAttempted === true,
          detailOutcome: record.detailOutcome || null,
          descriptionAvailable: record.descriptionAvailable === true,
          descriptionLength: typeof record.description === 'string' ? record.description.length : 0,
        })),
        overlaps,
        evaluations,
        observations,
        expansion: {
          depth: EXPANSION_DEPTH,
          candidates: candidatesSnapshot(),
          selected: selectedTerms.map((candidate) => ({ termId: candidate.termId, expression: candidate.expression, type: candidate.type })),
        },
        failures: { source: sourceFailures, semantic: semanticFailures, detail: detailFailures },
        detail: {
          attempted: detailFetches, available: detailCounters.available,
          unavailable: detailCounters.unavailable, failed: detailCounters.failed,
          maxDetailFetches: budget.maxDetailFetches, maxDetailFailures: budget.maxDetailFailures,
        },
        budget: {
          limits: { ...budget }, policy: { ...POLICY, searchLimits: { ...POLICY.searchLimits } },
          consumed: {
            searches: searches.length, initialSearches: searches.filter((entry) => entry.depth === INITIAL_DEPTH).length,
            expansionSearches: searches.filter((entry) => entry.depth === EXPANSION_DEPTH).length,
            completedSearches, evaluations: evaluationsUsed, uniquePostings: postings.size,
            sourceFailures: sourceFailures.length, semanticFailures: semanticFailures.length,
          },
          // MD9.1: en que fase se gasto cada evaluacion. Permite ver de un
          // vistazo si la reserva de expansion quedo varada o se reclamo.
          evaluationPhases: {
            protectedInitial: protectedInitialEvaluations,
            expansion: expansionEvaluations,
            reclaimed: reclaimedEvaluations,
            total: evaluationsUsed,
            remaining: Math.max(0, budget.maxEvaluations - evaluationsUsed),
            expansionEligibleTerms: expansionEligible,
            reclaimReason: reclaimedEvaluations > 0
              ? (expansionEligible === 0
                ? 'no eligible expansion terms: unused expansion capacity returned to the initial families'
                : 'expansion did not consume its whole reserve: the remainder returned to the initial families')
              : null,
          },
          remaining: {
            searches: Math.max(0, budget.maxSearches - searches.length),
            evaluations: Math.max(0, budget.maxEvaluations - evaluationsUsed),
            uniquePostings: Math.max(0, budget.maxUniquePostings - postings.size),
          },
        },
      });
    }

    function candidatesSnapshot() {
      return (candidates || []).map((candidate) => ({
        termId: candidate.termId, type: candidate.type, expression: candidate.expression, normalized: candidate.normalized,
        distinctPostings: candidate.distinctPostings, distinctCompanies: candidate.distinctCompanies,
        distinctFamilies: candidate.distinctFamilies, companyRequirementApplied: candidate.companyRequirementApplied,
        postingKeys: [...candidate.postingKeys], familyIds: [...candidate.familyIds],
        eligible: candidate.eligible, selected: candidate.selected,
        reason: candidate.reason, selectionReason: candidate.selectionReason,
      }));
    }
  }

  return { explore };
}

module.exports = { createExplorationEngine, postingKey, INITIAL_DEPTH, EXPANSION_DEPTH };

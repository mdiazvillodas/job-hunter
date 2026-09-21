'use strict';

// MD7 — gestor de UNA corrida de Market Discovery dentro del proceso existente.
//
// Orquesta lo ya construido y no reimplementa nada: MD1 (mapa de perfil), MD2
// (plan de semillas), MD3a (propiedad de operacion), MD3b (fuente de LinkedIn),
// MD4 (evaluador semantico), MD5 (motor de exploracion) y MD6 (portafolio).
//
// NO pasa por huntRunManager, NO llama a runPipeline, NO usa el Analyzer normal,
// NO crea un segundo proceso ni servidor, NO notifica y —invariante critica—
// NO modifica las queries de Hunter: la propuesta queda applied:false.

const crypto = require('crypto');
const { OPERATION_TYPES, createOwner } = require('../domain/operationOwner');
const { acquireLock, releaseLock } = require('../domain/huntLock');
const { operationalError } = require('../session/linkedinSessionService');
const { deriveCurrentProfile } = require('../marketDiscovery/profileMap');
const { generateSeedPlan } = require('../marketDiscovery/seedGenerator');
const { createLinkedinMarketSource } = require('../marketDiscovery/linkedinMarketSource');
const { createSemanticEvaluator } = require('../marketDiscovery/semanticEvaluator');
const { createExplorationEngine } = require('../marketDiscovery/explorationEngine');
const { buildQueryPortfolio } = require('../marketDiscovery/queryPortfolio');
const { createMarketDiscoveryRunStore } = require('../marketDiscovery/runStore');
const { createDetailEnricher, DETAIL_OUTCOMES } = require('../marketDiscovery/detailEnricher');
const { createProposalApplyService } = require('../marketDiscovery/proposalApply');

const STATUSES = Object.freeze({
  IDLE: 'IDLE', STARTING: 'STARTING', RUNNING: 'RUNNING', CANCELLING: 'CANCELLING',
  COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', INTERRUPTED: 'INTERRUPTED', FAILED: 'FAILED',
});
const PHASES = Object.freeze({
  IDLE: 'IDLE', PREPARING: 'PREPARING', OPENING_LINKEDIN: 'OPENING_LINKEDIN',
  INITIAL_SEARCH: 'INITIAL_SEARCH', INITIAL_EVALUATION: 'INITIAL_EVALUATION', EXPANSION: 'EXPANSION',
  BUILDING_PORTFOLIO: 'BUILDING_PORTFOLIO', PERSISTING: 'PERSISTING', CLEANUP: 'CLEANUP', DONE: 'DONE',
});
const ACTIVE = new Set([STATUSES.STARTING, STATUSES.RUNNING, STATUSES.CANCELLING]);
// Como termina la corrida segun el motivo de parada del ledger de MD5.
const OUTCOME = Object.freeze({
  COMPLETED: STATUSES.COMPLETED, SATURATED: STATUSES.COMPLETED, BUDGET_EXHAUSTED: STATUSES.COMPLETED,
  CANCELLED: STATUSES.CANCELLED,
  LOGIN_REQUIRED: STATUSES.INTERRUPTED, CHECKPOINT_REQUIRED: STATUSES.INTERRUPTED, TIME_LIMIT: STATUSES.INTERRUPTED,
  SCOPE_NOT_VERIFIED: STATUSES.INTERRUPTED,
  SOURCE_FAILED: STATUSES.FAILED, SEMANTIC_FAILED: STATUSES.FAILED, DETAIL_FAILED: STATUSES.FAILED,
});

const EMPTY_PROGRESS = Object.freeze({
  searchesCompleted: 0, searchesMax: null, initialSearches: 0, expansionSearches: 0,
  uniquePostings: 0, evaluationsCompleted: 0, evaluationsMax: null,
  compatible: 0, uncertain: 0, outOfScope: 0, selectedQueries: 0,
  // MD7.1: detalle de oferta, contadores reales sin porcentajes inventados.
  detailFetchesAttempted: 0, detailAvailable: 0, detailUnavailable: 0, detailFailed: 0,
});

// Diagnostico interno acotado: nunca el error crudo del navegador o del proveedor.
function safeDiagnostic(error) {
  const text = (value, limit) => (typeof value === 'string' && value ? value.slice(0, limit) : null);
  return { name: text(error && error.name, 64) || 'Error', code: text(error && error.code, 64) || null };
}

function createMarketDiscoveryRunManager(options = {}) {
  const setupService = options.setupService;
  const runStore = options.runStore || createMarketDiscoveryRunStore();
  const clock = options.clock || (() => new Date());
  const makeRunId = options.makeRunId || (() => `mdrun_${crypto.randomBytes(8).toString('hex')}`);
  const makeOperationId = options.makeOperationId || (() => `md_${crypto.randomBytes(8).toString('hex')}`);
  const lock = options.acquireLock || ((owner) => acquireLock(undefined, { owner }));
  const unlock = options.releaseLock || ((owner) => releaseLock(undefined, { owner }));
  const loadProfile = options.profileLoader || deriveCurrentProfile;
  const planSeeds = options.seedPlanner || generateSeedPlan;
  const buildPortfolio = options.buildPortfolio || buildQueryPortfolio;
  // El alcance externo de Market Discovery es SOLO query + ubicacion configurada.
  // No hereda datePosted ni employmentType de Hunter (esto es investigacion de
  // mercado, no caza de ofertas frescas), ni convierte la modalidad en filtro duro.
  // Se resuelve EN CADA ARRANQUE para no congelar una configuracion obsoleta.
  const resolveFilters = options.resolveFilters
    || (options.filters ? () => options.filters : () => {
      const { getUserConfig } = require('../config/userConfig');
      const locations = getUserConfig().search.locations;
      return { location: Array.isArray(locations) && locations[0] ? locations[0] : null };
    });
  // MD7.2: las queries ACTIVAS de Hunter, SOLO LECTURA, para que MD6 pueda
  // compararlas con lo observado. No se ejecutan, no se modifican y no acoplan
  // esta corrida al pipeline de Hunter: es una foto para un informe neutral.
  // Si no se pueden leer, la comparacion queda en null en vez de inventarse.
  const resolveCurrentQueries = options.resolveCurrentQueries
    || (() => {
      try {
        const { getUserConfig } = require('../config/userConfig');
        const groups = getUserConfig().search.queryGroups;
        return Array.isArray(groups) ? { queryGroups: groups } : null;
      } catch (error) {
        return null;
      }
    });
  const explorationBudget = options.explorationBudget;

  // Sesion de navegador propia de Market Discovery: UNA sola para toda la corrida.
  const openSession = options.openSession || (async () => {
    const { launchLinkedInBrowser, getInitialPage } = require('../linkedin/browser');
    const { assertAuthenticatedSession } = require('../linkedin/session');
    const { BROWSER_PROFILE_DIR } = require('../runtime');
    const context = await launchLinkedInBrowser(BROWSER_PROFILE_DIR);
    try {
      const page = await getInitialPage(context);
      await assertAuthenticatedSession(context, page);
      return { context, page };
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  });

  let current = { runId: null, status: STATUSES.IDLE, reason: null, phase: PHASES.IDLE, startedAt: null, finishedAt: null, progress: { ...EMPTY_PROGRESS }, proposalAvailable: false, partial: false, error: null };
  let activePromise = null;
  let controller = null;
  let accepting = true;

  const snapshot = () => Object.freeze(JSON.parse(JSON.stringify(current)));
  // La fase solo avanza mientras la corrida sigue viva.
  const setPhase = (phase) => { if (ACTIVE.has(current.status)) current.phase = phase; };

  // Envoltorios de instrumentacion: dan progreso REAL sin tocar el contrato de MD5.
  function instrument(source, evaluator) {
    return {
      source: {
        search: async (request) => {
          const depth = String(request.search.searchId || '').startsWith('d1') ? 1 : 0;
          setPhase(depth === 1 ? PHASES.EXPANSION : PHASES.INITIAL_SEARCH);
          const outcome = await source.search(request);
          if (outcome && outcome.status === 'COMPLETED') {
            current.progress.searchesCompleted += 1;
            if (depth === 1) current.progress.expansionSearches += 1; else current.progress.initialSearches += 1;
          }
          return outcome;
        },
      },
      evaluator: {
        evaluatePosting: async (request) => {
          if (current.phase === PHASES.INITIAL_SEARCH) setPhase(PHASES.INITIAL_EVALUATION);
          const assessment = await evaluator.evaluatePosting(request);
          current.progress.evaluationsCompleted += 1;
          if (assessment && assessment.classification === 'COMPATIBLE') current.progress.compatible += 1;
          else if (assessment && assessment.classification === 'UNCERTAIN') current.progress.uncertain += 1;
          else if (assessment && assessment.classification === 'OUT_OF_SCOPE') current.progress.outOfScope += 1;
          return assessment;
        },
      },
    };
  }

  // Contadores reales del detalle, sin tocar el contrato de MD5.
  function instrumentEnricher(enricher) {
    return {
      enrich: async (posting, context) => {
        current.progress.detailFetchesAttempted += 1;
        const result = await enricher.enrich(posting, context);
        const outcome = result && result.outcome;
        if (outcome === DETAIL_OUTCOMES.DETAIL_AVAILABLE) current.progress.detailAvailable += 1;
        else if (outcome === DETAIL_OUTCOMES.DETAIL_UNAVAILABLE) current.progress.detailUnavailable += 1;
        else if (outcome === DETAIL_OUTCOMES.DETAIL_FAILED) current.progress.detailFailed += 1;
        return result;
      },
    };
  }

  async function start() {
    if (!accepting) throw operationalError('APP_SHUTTING_DOWN', 'Job Hunter se está cerrando.', 503);
    if (ACTIVE.has(current.status)) throw operationalError('MARKET_DISCOVERY_ALREADY_RUNNING', 'Ya hay una exploración de mercado en curso.');

    // Validacion ANTES de tocar LinkedIn: nunca se abre el navegador sin perfil.
    if (setupService && !setupService.getStatus().readyForHunt) {
      throw operationalError('SETUP_REQUIRED', 'Completá la configuración antes de explorar el mercado.');
    }
    let profile;
    let seedPlan;
    try {
      profile = loadProfile();
      seedPlan = planSeeds(profile);
    } catch (_) {
      throw operationalError('PROFILE_REQUIRED', 'El perfil necesario para explorar el mercado no está disponible.');
    }
    // Sin ubicacion configurada NO se busca: una busqueda sin geografia explora
    // un mercado cualquiera. Se falla antes de abrir LinkedIn.
    let filters;
    try { filters = resolveFilters() || {}; } catch (_) { filters = {}; }
    if (!filters.location || !String(filters.location).trim()) {
      throw operationalError('LOCATION_REQUIRED', 'Configurá la ubicación de búsqueda antes de explorar el mercado.');
    }

    const runId = makeRunId();
    const owner = createOwner(OPERATION_TYPES.MARKET_DISCOVERY, makeOperationId());
    const startedAt = clock().toISOString();
    controller = new AbortController();
    current = {
      runId, status: STATUSES.STARTING, reason: null, phase: PHASES.PREPARING, startedAt, finishedAt: null,
      progress: { ...EMPTY_PROGRESS }, proposalAvailable: false, partial: false, error: null,
    };
    try {
      runStore.createRun(runId, { runId, operationId: owner.operationId, startedAt, status: STATUSES.STARTING });
      runStore.writeArtifact(runId, 'profileMap', { runId, profile });
      runStore.writeArtifact(runId, 'seedPlan', { runId, seedPlan });
    } catch (error) {
      // Nada se adquirio todavia: se vuelve a IDLE con un motivo estable, sin
      // filtrar el error crudo del sistema de archivos.
      current = { runId: null, status: STATUSES.IDLE, reason: null, phase: PHASES.IDLE, startedAt: null, finishedAt: null, progress: { ...EMPTY_PROGRESS }, proposalAvailable: false, partial: false, error: null };
      controller = null;
      console.error(`[market-discovery] run creation diagnostic=${JSON.stringify(safeDiagnostic(error))}`);
      throw operationalError('RUN_PERSISTENCE_FAILED', 'No se pudo crear la exploración de mercado.', 500);
    }

    const accepted = snapshot();
    // Arranque ASINCRONO: start() no espera a que termine la exploracion.
    activePromise = orchestrate({ runId, owner, profile, seedPlan, filters }).catch((error) => {
      // Red de seguridad: ninguna rechazo sin manejar puede escapar de aqui.
      current.status = STATUSES.FAILED;
      current.reason = 'INTERNAL_ERROR';
      current.error = { code: 'INTERNAL_ERROR', message: 'La exploración de mercado no pudo completarse.' };
      current.phase = PHASES.DONE;
      current.finishedAt = clock().toISOString();
      console.error(`[market-discovery] internal error diagnostic=${JSON.stringify(safeDiagnostic(error))}`);
    }).finally(() => { activePromise = null; controller = null; });
    return accepted;
  }

  async function orchestrate({ runId, owner, profile, seedPlan, filters }) {
    let session = null;
    let exploration = null;
    let proposal = null;
    let locked = false;
    let cleanupFailed = false;
    current.status = STATUSES.RUNNING;

    try {
      // 1) Propiedad ANTES de cualquier uso del navegador persistente.
      try {
        lock(owner);
        locked = true;
      } catch (error) {
        if (error && error.code === 'LOCK_HELD') return finish(runId, STATUSES.FAILED, 'RESOURCE_BUSY', { exploration, proposal, message: 'El navegador de LinkedIn está ocupado por otra operación.' });
        throw error;
      }
      if (controller.signal.aborted) return finish(runId, STATUSES.CANCELLED, 'CANCELLED', { exploration, proposal });

      // 2) UNA sola sesion persistente para toda la corrida.
      setPhase(PHASES.OPENING_LINKEDIN);
      try {
        session = await openSession({ signal: controller.signal });
      } catch (error) {
        const reason = error && error.name === 'AuthenticationError' ? 'LOGIN_REQUIRED'
          : error && error.name === 'SecurityChallengeError' ? 'CHECKPOINT_REQUIRED' : 'SOURCE_FAILED';
        console.error(`[market-discovery] session diagnostic=${JSON.stringify(safeDiagnostic(error))}`);
        return finish(runId, reason === 'SOURCE_FAILED' ? STATUSES.FAILED : STATUSES.INTERRUPTED, reason, { exploration, proposal });
      }

      // 3) Exploracion acotada (MD5), con fuente MD3b y evaluador MD4.
      const wired = instrument(
        options.source || createLinkedinMarketSource(),
        options.evaluator || createSemanticEvaluator()
      );
      // El enriquecedor usa la MISMA pagina/sesion y la misma propiedad: no abre
      // navegadores ni adquiere ni libera nada.
      const enricher = instrumentEnricher(options.enricher || createDetailEnricher());
      const engine = options.explorationEngine || createExplorationEngine({
        source: wired.source, evaluator: wired.evaluator, enricher, seedPlanner: () => seedPlan, clock,
      });
      exploration = await engine.explore({
        owner, page: session.page, profile, filters, signal: controller.signal, budget: explorationBudget,
      });
      current.progress.uniquePostings = exploration.postings.length;
      current.progress.searchesMax = exploration.budget.limits.maxSearches;
      current.progress.evaluationsMax = exploration.budget.limits.maxEvaluations;
      runStore.writeArtifact(runId, 'exploration', { runId, exploration });

      // 4) Portafolio (MD6) SOLO si hay evidencia compatible real. Una exploracion
      // parcial puede producir propuesta: queda marcada como parcial por su origen.
      const compatible = exploration.postings.filter((posting) => posting.classification === 'COMPATIBLE').length;
      if (compatible > 0) {
        setPhase(PHASES.BUILDING_PORTFOLIO);
        proposal = buildPortfolio({ exploration, profile, currentQueries: resolveCurrentQueries() });
        current.progress.selectedQueries = proposal.selectedQueries.length;
        runStore.writeArtifact(runId, 'proposal', { runId, proposal });
      }

      const status = OUTCOME[exploration.stopReason] || STATUSES.FAILED;
      return finish(runId, status, exploration.stopReason, { exploration, proposal });
    } catch (error) {
      // Fallo inesperado: se registra un resultado auditable en lugar de escapar.
      console.error(`[market-discovery] orchestration diagnostic=${JSON.stringify(safeDiagnostic(error))}`);
      return finish(runId, STATUSES.FAILED, 'INTERNAL_ERROR', { exploration, proposal, message: 'La exploración de mercado no pudo completarse.' });
    } finally {
      // 5) Cerrar SOLO lo que abrio esta corrida, y despues liberar la propiedad.
      setPhase(PHASES.CLEANUP);
      if (session && session.context) {
        try { await session.context.close(); } catch (error) { cleanupFailed = true; console.error(`[market-discovery] cleanup diagnostic=${JSON.stringify(safeDiagnostic(error))}`); }
      }
      if (locked) {
        // El lock se libera SIEMPRE con el dueño exacto, y solo tras el cierre.
        try { unlock(owner); } catch (_) { console.error('[market-discovery] no se pudo liberar la propiedad limpiamente.'); }
      }
      if (cleanupFailed && current.error === null) {
        current.error = { code: 'CLEANUP_INCOMPLETE', message: 'La exploración terminó pero el navegador no cerró limpiamente.' };
      }
      current.phase = PHASES.DONE;
    }
  }

  function finish(runId, status, reason, { exploration, proposal, message }) {
    current.status = status;
    current.reason = reason;
    current.partial = status !== STATUSES.COMPLETED;
    current.proposalAvailable = proposal !== null && proposal !== undefined;
    current.finishedAt = clock().toISOString();
    if (message) current.error = { code: reason, message };
    const result = {
      runId, status, reason, partial: current.partial,
      startedAt: current.startedAt, finishedAt: current.finishedAt,
      progress: { ...current.progress },
      exploration: exploration ? { status: exploration.status, stopReason: exploration.stopReason, partial: exploration.partial, operationId: exploration.operationId } : null,
      proposal: proposal ? { proposalId: proposal.proposalId, applied: proposal.applied, selectedQueries: proposal.selectedQueries.length, warnings: proposal.warnings } : null,
    };
    try {
      runStore.writeArtifact(runId, 'result', { runId, result });
      runStore.writeArtifact(runId, 'manifest', { runId, startedAt: current.startedAt, finishedAt: current.finishedAt, status, reason });
    } catch (error) {
      console.error(`[market-discovery] persist diagnostic=${JSON.stringify(safeDiagnostic(error))}`);
    }
    return result;
  }

  function cancel() {
    if (!ACTIVE.has(current.status)) return snapshot();
    current.status = STATUSES.CANCELLING;
    if (controller && !controller.signal.aborted) controller.abort();
    return snapshot();
  }

  function getStatus() { return snapshot(); }
  function stopAccepting() { accepting = false; }
  function waitForIdle() { return activePromise || Promise.resolve(); }
  function getRun(runId) { return runStore.readRun(runId); }
  // MD8: historial SOLO LECTURA. No cambia getStatus(): una corrida pasada
  // jamas puede parecer una corrida activa.
  function listRuns() { return runStore.listRuns(); }
  // MD8: aplicar la propuesta es SIEMPRE una accion explicita del usuario.
  // Semantica de REEMPLAZO; conserva el resto de la configuracion; no arranca
  // hunt, no relanza la exploracion y no notifica.
  const applyService = options.proposalApplyService || createProposalApplyService({ runStore });
  function previewApply(runId) { return applyService.preview(runId); }
  function applyProposal(runId) { return applyService.apply(runId); }

  function getProposal(runId) {
    const artifact = runStore.readArtifact(runId, 'proposal');
    return artifact ? artifact.proposal || null : null;
  }

  return { start, cancel, getStatus, stopAccepting, waitForIdle, getRun, listRuns, getProposal, previewApply, applyProposal, STATUSES, PHASES };
}

module.exports = { createMarketDiscoveryRunManager, STATUSES, PHASES, PHASE_ORDER: Object.values(PHASES), OUTCOME };

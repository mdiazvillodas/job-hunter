'use strict';

const crypto = require('crypto');
const { acquireLock, releaseLock } = require('../domain/huntLock');
const { STATES, operationalError } = require('../session/linkedinSessionService');
const { isKnownStage } = require('../linkedin/challengeSignals');

const ACTIVE = new Set(['STARTING', 'RUNNING']);
const INITIAL_PROGRESS = Object.freeze({
  phase: 'idle', searchesCompleted: 0, searchesTotal: 0,
  rawJobsDiscovered: 0, uniqueJobsDiscovered: 0, jobsPersisted: 0,
  analysisAttempted: 0, analysisCompleted: 0, analysisFailed: 0,
  analysisTarget: 20, currentQueryIndex: null, currentQueryLabel: null,
  cancellationRequested: false,
});

function safeProgress(value = {}) {
  const progress = {};
  for (const key of Object.keys(INITIAL_PROGRESS)) {
    const next = value[key];
    if (key === 'phase') progress[key] = typeof next === 'string' ? next : INITIAL_PROGRESS[key];
    else if (key === 'currentQueryLabel') progress[key] = typeof next === 'string' ? next.slice(0, 200) : null;
    else if (key === 'currentQueryIndex') progress[key] = Number.isInteger(next) ? next : null;
    else if (key === 'cancellationRequested') progress[key] = next === true;
    else progress[key] = Number.isFinite(next) && next >= 0 ? next : INITIAL_PROGRESS[key];
  }
  return progress;
}

function isCancellation(error) {
  return !!error && (error.name === 'AbortError' || error.name === 'HuntCancelledError');
}

// Diagnostico del challenge, acotado a campos seguros. El detector ya entrega
// solo valores propios (id de señal, url sin query, extracto saneado); aqui se
// vuelve a recortar porque esto SI cruza hacia la UI.
function safeChallenge(value) {
  if (!value || typeof value !== 'object') return null;
  const text = (input, limit) => (typeof input === 'string' && input ? input.slice(0, limit) : undefined);
  const diagnostic = {
    source: text(value.source, 16) || 'unknown',
    signal: text(value.signal, 64) || 'unknown',
    at: text(value.at, 32) || null,
  };
  // La etapa SOLO puede ser una del vocabulario cerrado: mas abajo se traduce
  // a una frase fija que lee el usuario, asi que una etiqueta libre no puede
  // llegar hasta ahi.
  const stage = isKnownStage(value.stage) ? value.stage : undefined;
  const jobId = value.jobId == null ? undefined : String(value.jobId).slice(0, 32);
  const url = text(value.url, 200);
  const excerpt = text(value.excerpt, 80);
  if (stage) diagnostic.stage = stage;
  if (jobId) diagnostic.jobId = jobId;
  if (url) diagnostic.url = url;
  if (excerpt) diagnostic.excerpt = excerpt;
  return diagnostic;
}

function safeSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const discovery = value.discovery || {};
  const analysis = value.analysis || {};
  const persistence = value.persistence || {};
  return {
    runId: value.runId || null,
    stoppedByChallenge: value.stoppedByChallenge === true,
    challenge: safeChallenge(value.challenge),
    discovery: {
      queriesExecuted: discovery.queriesExecuted,
      rawResults: discovery.rawResults,
      uniqueResults: discovery.uniqueResults,
      duplicatesRemoved: discovery.duplicatesRemoved,
      newJobs: discovery.newJobs,
      existingJobs: discovery.existingJobs,
    },
    analysis: {
      requiringAnalysis: analysis.requiringAnalysis,
      alreadyAnalyzed: analysis.alreadyAnalyzed,
      processed: analysis.processed,
      analyzed: analysis.analyzed,
      failed: analysis.failed,
      skipped: analysis.skipped,
      target: analysis.target,
      stopReason: analysis.stopReason,
    },
    persistence: {
      created: persistence.created,
      updated: persistence.updated,
      unchanged: persistence.unchanged,
    },
  };
}

function safeError(error) {
  if (error && error.name === 'AuthenticationError') return { code: 'LOGIN_REQUIRED', message: 'Necesitás iniciar sesión en LinkedIn.' };
  if (error && error.name === 'SecurityChallengeError') {
    // Un challenge que aborta el run ANTES del bucle de detalles (por ejemplo
    // durante discovery) no pasa por el summary: su diagnostico viaja aqui.
    const challenge = safeChallenge(error.challengeDiagnostic);
    const result = { code: 'CHECKPOINT_REQUIRED', message: 'LinkedIn requiere una verificación manual.' };
    if (challenge) result.challenge = challenge;
    return result;
  }
  return { code: 'HUNT_FAILED', message: 'La búsqueda no pudo completarse.' };
}

function sanitizeDiagnosticText(value, limit) {
  if (typeof value !== 'string') return '';
  const sanitized = value
    .replace(/https?:\/\/[^\s)'"\]]+/gi, '[REDACTED_URL]')
    .replace(/\b(prompt|professionalText|preferencesText|profileSource|request\s*body)\b\s*[:=][\s\S]*/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(authorization|cookie|li_at|api[_-]?key|access[_-]?token|password|credential)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]');
  return sanitized.length > limit ? `${sanitized.slice(0, limit)}...[TRUNCATED]` : sanitized;
}

function safeDiagnostic(error, stage) {
  const rawName = error && typeof error.name === 'string' ? error.name : 'Error';
  return {
    stage: typeof stage === 'string' && stage ? stage : 'unknown',
    name: sanitizeDiagnosticText(rawName, 100) || 'Error',
    message: sanitizeDiagnosticText(error && error.message ? error.message : String(error), 1000),
    stack: sanitizeDiagnosticText(error && error.stack ? error.stack : '', 5000) || null,
  };
}

// Notificador de cierre por defecto. Se construye EN EL MOMENTO de notificar,
// no al crear el manager: cuando Job Hunter arranca sin configurar todavia,
// getUserConfig() lanza, y eso no puede impedir que el manager exista.
// Contrato: informativo puro, nunca rechaza, nunca altera el estado del run.
function defaultNotifyRunOutcome(input) {
  const { createRunOutcomeNotifier } = require('../notifications/runOutcome');
  const { getUserConfig, getNotificationSettings } = require('../config/userConfig');
  const notifier = createRunOutcomeNotifier({
    settings: getNotificationSettings(getUserConfig()),
    log: (message) => console.error('[notify] ' + message),
  });
  return notifier.notifyRunOutcome(input);
}

function createHuntRunManager(options = {}) {
  const huntRunner = options.huntRunner || ((huntOptions) => require('../hunt').runHunt(huntOptions));
  const notifyRunOutcome = options.notifyRunOutcome || defaultNotifyRunOutcome;
  const setupService = options.setupService;
  const sessionService = options.sessionService;
  const lock = options.acquireLock || acquireLock;
  const unlock = options.releaseLock || releaseLock;
  const now = options.clock || (() => new Date());
  const makeId = options.makeRunId || (() => `run_${crypto.randomBytes(8).toString('hex')}`);
  let current = { runId: null, status: 'IDLE', startedAt: null, finishedAt: null, summary: null, error: null, progress: safeProgress() };
  let accepting = true;
  let activePromise = null;
  let activeController = null;

  const snapshot = () => JSON.parse(JSON.stringify(current));

  async function start(huntOptions = {}) {
    let stage = 'persisted_session_verification';
    if (!accepting) throw operationalError('APP_SHUTTING_DOWN', 'Job Hunter se está cerrando.', 503);
    if (ACTIVE.has(current.status)) throw operationalError('HUNT_ALREADY_RUNNING', 'Ya hay una búsqueda en curso.');
    if (sessionService.isOpen()) throw operationalError('SESSION_WINDOW_OPEN', 'Cerrá la ventana manual de LinkedIn antes de buscar.');
    if (!setupService.getStatus().readyForHunt) throw operationalError('SETUP_REQUIRED', 'Completá la configuración antes de buscar.');
    let linkedIn;
    try {
      linkedIn = sessionService.verifyPersistedSession
        ? await sessionService.verifyPersistedSession()
        : await sessionService.getStatus();
    } catch (error) {
      const diagnostic = safeDiagnostic(error, stage);
      console.error(`[hunt-run] preflight-failure diagnostic=${JSON.stringify(diagnostic)}`);
      throw error;
    }
    if (linkedIn.state !== STATES.AUTHENTICATED) {
      const code = linkedIn.state === STATES.CHECKPOINT_REQUIRED ? 'CHECKPOINT_REQUIRED' : 'LOGIN_REQUIRED';
      throw operationalError(code, code === 'CHECKPOINT_REQUIRED' ? 'LinkedIn requiere una verificación manual.' : 'Necesitás iniciar sesión en LinkedIn.');
    }
    try { lock(); } catch (error) {
      if (error.code === 'LOCK_HELD') throw operationalError('HUNT_ALREADY_RUNNING', 'Ya hay una búsqueda en curso.');
      throw error;
    }
    activeController = new AbortController();
    current = { runId: makeId(), status: 'STARTING', startedAt: now().toISOString(), finishedAt: null, summary: null, error: null, progress: safeProgress({ phase: 'starting' }) };
    const response = snapshot();
    activePromise = Promise.resolve().then(async () => {
      current.status = 'RUNNING';
      console.log(`[hunt-run] started runId=${current.runId}`);
      // El summary CRUDO del pipeline se conserva solo aqui: safeSummary() es
      // el contrato con la UI y no debe crecer para alimentar una notificacion.
      let rawSummary = null;
      let outcome = null;
      try {
        const reportStage = (nextStage) => {
          if (typeof nextStage === 'string' && nextStage) {
            stage = nextStage;
            current.progress = safeProgress({ ...current.progress, phase: nextStage });
          }
        };
        const reportProgress = (nextProgress) => {
          if (nextProgress && typeof nextProgress === 'object') current.progress = safeProgress({ ...current.progress, ...nextProgress });
        };
        stage = 'collector_launch';
        rawSummary = await huntRunner({ ...huntOptions, reportStage, reportProgress, signal: activeController.signal });
        current.summary = safeSummary(rawSummary);
        current.status = activeController.signal.aborted ? 'CANCELLED' : 'COMPLETED';
        current.progress = safeProgress({ ...current.progress, phase: current.status.toLowerCase() });
        console.log(`[hunt-run] ${current.status.toLowerCase()} runId=${current.runId}`);
      } catch (error) {
        if (isCancellation(error) || activeController.signal.aborted) {
          current.status = 'CANCELLED';
          current.error = null;
          current.progress = safeProgress({ ...current.progress, phase: 'cancelled', cancellationRequested: true });
          console.log(`[hunt-run] cancelled runId=${current.runId}`);
        } else {
          current.error = safeError(error);
          current.status = 'FAILED';
          current.progress = safeProgress({ ...current.progress, phase: 'failed' });
          const diagnostic = safeDiagnostic(error, error && error.huntStage ? error.huntStage : stage);
          console.error(`[hunt-run] failure runId=${current.runId} diagnostic=${JSON.stringify(diagnostic)}`);
        }
      } finally {
        current.finishedAt = now().toISOString();
        try { unlock(); } catch (_) { console.error('[hunt-run] no se pudo liberar el lock limpiamente.'); }
        // Se captura el desenlace ANTES de ceder el control: a partir de aqui
        // otro run puede empezar y reemplazar `current`, asi que waitForRun
        // debe resolver con ESTE resultado, no con el que este vigente luego.
        outcome = { status: current.status, error: current.error, result: snapshot() };
        activePromise = null;
        activeController = null;
      }
      // Aviso de cierre: informativo y ajeno al resultado. Se emite con el
      // estado ya final y el lock ya liberado, y cualquier fallo se ignora:
      // una notificacion no puede convertir un hunt exitoso en fallido.
      try {
        await notifyRunOutcome({ status: outcome.status, summary: rawSummary, error: outcome.error });
      } catch (_) { console.error('[hunt-run] no se pudo notificar el cierre del hunt.'); }
      return outcome.result;
    });
    return response;
  }

  function stopAccepting() { accepting = false; }
  function cancel() {
    if (!ACTIVE.has(current.status) || !activeController) return snapshot();
    current.progress = safeProgress({ ...current.progress, cancellationRequested: true });
    if (!activeController.signal.aborted) activeController.abort();
    return snapshot();
  }
  function waitForIdle() { return activePromise || Promise.resolve(); }
  function waitForRun(runId) {
    if (!runId || current.runId !== runId) throw operationalError('HUNT_RUN_NOT_FOUND', 'La ejecución solicitada no está disponible.', 404);
    return activePromise ? activePromise.then((result) => JSON.parse(JSON.stringify(result))) : Promise.resolve(snapshot());
  }
  return { start, cancel, getStatus: snapshot, stopAccepting, waitForIdle, waitForRun };
}

module.exports = { createHuntRunManager, safeSummary, safeChallenge, safeProgress, safeError, safeDiagnostic, isCancellation };

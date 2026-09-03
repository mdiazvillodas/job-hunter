'use strict';

const crypto = require('crypto');
const { acquireLock, releaseLock } = require('../domain/huntLock');
const { STATES, operationalError } = require('../session/linkedinSessionService');

const ACTIVE = new Set(['STARTING', 'RUNNING']);

function safeSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const discovery = value.discovery || {};
  const analysis = value.analysis || {};
  const persistence = value.persistence || {};
  return {
    runId: value.runId || null,
    stoppedByChallenge: value.stoppedByChallenge === true,
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
  if (error && error.name === 'SecurityChallengeError') return { code: 'CHECKPOINT_REQUIRED', message: 'LinkedIn requiere una verificación manual.' };
  return { code: 'HUNT_FAILED', message: 'La búsqueda no pudo completarse.' };
}

function createHuntRunManager(options = {}) {
  const huntRunner = options.huntRunner || ((huntOptions) => require('../hunt').runHunt(huntOptions));
  const setupService = options.setupService;
  const sessionService = options.sessionService;
  const lock = options.acquireLock || acquireLock;
  const unlock = options.releaseLock || releaseLock;
  const now = options.clock || (() => new Date());
  const makeId = options.makeRunId || (() => `run_${crypto.randomBytes(8).toString('hex')}`);
  let current = { runId: null, status: 'IDLE', startedAt: null, finishedAt: null, summary: null, error: null };

  const snapshot = () => JSON.parse(JSON.stringify(current));

  async function start(huntOptions = {}) {
    if (ACTIVE.has(current.status)) throw operationalError('HUNT_ALREADY_RUNNING', 'Ya hay una búsqueda en curso.');
    if (sessionService.isOpen()) throw operationalError('SESSION_WINDOW_OPEN', 'Cerrá la ventana manual de LinkedIn antes de buscar.');
    if (!setupService.getStatus().readyForHunt) throw operationalError('SETUP_REQUIRED', 'Completá la configuración antes de buscar.');
    const linkedIn = await sessionService.getStatus();
    if (linkedIn.state !== STATES.AUTHENTICATED) {
      const code = linkedIn.state === STATES.CHECKPOINT_REQUIRED ? 'CHECKPOINT_REQUIRED' : 'LOGIN_REQUIRED';
      throw operationalError(code, code === 'CHECKPOINT_REQUIRED' ? 'LinkedIn requiere una verificación manual.' : 'Necesitás iniciar sesión en LinkedIn.');
    }
    try { lock(); } catch (error) {
      if (error.code === 'LOCK_HELD') throw operationalError('HUNT_ALREADY_RUNNING', 'Ya hay una búsqueda en curso.');
      throw error;
    }
    current = { runId: makeId(), status: 'STARTING', startedAt: now().toISOString(), finishedAt: null, summary: null, error: null };
    const response = snapshot();
    Promise.resolve().then(async () => {
      current.status = 'RUNNING';
      console.log(`[hunt-run] started runId=${current.runId}`);
      try {
        current.summary = safeSummary(await huntRunner(huntOptions));
        current.status = 'COMPLETED';
        console.log(`[hunt-run] completed runId=${current.runId}`);
      } catch (error) {
        current.error = safeError(error);
        current.status = 'FAILED';
      } finally {
        current.finishedAt = now().toISOString();
        unlock();
      }
    });
    return response;
  }

  return { start, getStatus: snapshot };
}

module.exports = { createHuntRunManager, safeSummary, safeError };

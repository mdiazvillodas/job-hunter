'use strict';

// Modelo de Job + transiciones de estado (puras). No persisten: eso lo hace jobService.
// Separacion conceptual clave:
//   - aiAnalysis  = resultado del OpenAI Job Analyzer (NO se toca al cambiar el estado del usuario).
//   - userState   = decisiones/acciones de Mariano (new/read/interested/discarded/applied/priority).
//   - feedback    = ultimo resumen de descarte (reasons + comment).
//   - feedbackEvents = historial completo de eventos (nunca se sobreescribe silenciosamente).

const { JOB_STATES, isValidReason } = require('./feedbackConfig');

// Estado del ANALISIS (independiente del userState). Idempotencia del pipeline.
const ANALYSIS_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

function nowIso() {
  return new Date().toISOString();
}

// Crea el registro persistible a partir de datos del collector + analyzer.
function createJobRecord(input = {}, options = {}) {
  const now = (options.clock || nowIso)();
  if (!input.jobId) {
    throw new Error('createJobRecord: jobId es obligatorio.');
  }
  return {
    jobId: String(input.jobId),
    title: input.title ?? null,
    company: input.company ?? null,
    location: input.location ?? null,
    url: input.url ?? null,
    employmentType: input.employmentType ?? null,
    workplaceType: input.workplaceType ?? null,
    seniority: input.seniority ?? null,
    easyApply: input.easyApply ?? null,
    description: input.description ?? null,

    matchedQueries: Array.isArray(input.matchedQueries) ? input.matchedQueries.slice() : [],
    matchedFamilies: Array.isArray(input.matchedFamilies) ? input.matchedFamilies.slice() : [],

    // Resultado del analyzer (opaco para esta capa). NUNCA se modifica desde userState/feedback.
    aiAnalysis: input.aiAnalysis ?? null,

    // Estado del analisis (independiente del userState). Un job nuevo entra 'pending'.
    analysisStatus: input.aiAnalysis ? ANALYSIS_STATUS.COMPLETED : ANALYSIS_STATUS.PENDING,
    analysisError: null,
    analysisAttemptedAt: null,
    analysisCompletedAt: input.aiAnalysis ? now : null,

    userState: {
      status: JOB_STATES.NEW,
      firstSeenAt: now,
      lastSeenAt: now,
      readAt: null,
      interestedAt: null,
      appliedAt: null,
      discardedAt: null,
      priorityAt: null,
    },

    // Ultimo resumen de descarte (conveniencia). El historial completo esta en feedbackEvents.
    feedback: {
      reasons: [],
      comment: null,
      createdAt: null,
    },

    feedbackEvents: [],
  };
}

function appendEvent(job, event) {
  job.feedbackEvents.push(event);
}

// --- Transiciones (mutan y devuelven el job). No bloquean re-transiciones. ---

function applyRead(job, options = {}) {
  const now = (options.clock || nowIso)();
  job.userState.status = JOB_STATES.READ;
  job.userState.readAt = now;
  job.userState.lastSeenAt = now;
  appendEvent(job, { type: JOB_STATES.READ, createdAt: now });
  return job;
}

function applyInterested(job, options = {}) {
  const now = (options.clock || nowIso)();
  job.userState.status = JOB_STATES.INTERESTED;
  job.userState.interestedAt = now;
  job.userState.lastSeenAt = now;
  appendEvent(job, { type: JOB_STATES.INTERESTED, comment: options.comment ?? null, createdAt: now });
  return job;
}

function applyPriority(job, options = {}) {
  const now = (options.clock || nowIso)();
  job.userState.status = JOB_STATES.PRIORITY;
  job.userState.priorityAt = now;
  job.userState.lastSeenAt = now;
  appendEvent(job, { type: JOB_STATES.PRIORITY, comment: options.comment ?? null, createdAt: now });
  return job;
}

function applyApplied(job, options = {}) {
  const now = (options.clock || nowIso)();
  job.userState.status = JOB_STATES.APPLIED;
  job.userState.appliedAt = now;
  job.userState.lastSeenAt = now;
  appendEvent(job, { type: JOB_STATES.APPLIED, comment: options.comment ?? null, createdAt: now });
  return job;
}

function applyDiscarded(job, options = {}) {
  const now = (options.clock || nowIso)();
  const reasons = Array.isArray(options.reasons) ? options.reasons : options.reason ? [options.reason] : [];
  const invalid = reasons.filter((r) => !isValidReason(r));
  if (invalid.length) {
    throw new Error(`applyDiscarded: motivos invalidos [${invalid.join(', ')}].`);
  }
  const comment = options.comment ?? null;

  job.userState.status = JOB_STATES.DISCARDED;
  job.userState.discardedAt = now;
  job.userState.lastSeenAt = now;

  // Resumen del ultimo descarte (se guarda EXACTAMENTE lo indicado; no se interpreta el comentario).
  job.feedback = { reasons: reasons.slice(), comment, createdAt: now };

  appendEvent(job, { type: JOB_STATES.DISCARDED, reasons: reasons.slice(), comment, createdAt: now });
  return job;
}

// --- Idempotencia / discovery (el collector vuelve a encontrar una oferta) ---

const DISCOVERY_FIELDS = ['title', 'company', 'location', 'url', 'employmentType', 'workplaceType', 'seniority', 'easyApply', 'description', 'descriptionLength'];

function unionInto(target, values) {
  let added = false;
  for (const v of values || []) {
    if (!target.includes(v)) { target.push(v); added = true; }
  }
  return added;
}

// Actualiza SOLO informacion de discovery + lastSeenAt. NO toca userState/feedback/feedbackEvents/
// aiAnalysis/analysisStatus/firstSeenAt. Rellena campos faltantes (no pisa datos ya conocidos).
// Devuelve { changed } (cambios significativos: matchedQueries/families o campos rellenados).
function mergeDiscovery(job, incoming = {}, options = {}) {
  const now = (options.clock || nowIso)();
  let changed = false;

  changed = unionInto(job.matchedQueries, incoming.matchedQueries) || changed;
  changed = unionInto(job.matchedFamilies, incoming.matchedFamilies) || changed;

  for (const f of DISCOVERY_FIELDS) {
    const cur = job[f];
    const inc = incoming[f];
    if ((cur === null || cur === undefined || cur === '') && inc !== null && inc !== undefined && inc !== '') {
      job[f] = inc;
      changed = true;
    }
  }

  job.userState.lastSeenAt = now; // siempre se actualiza (no cuenta como "changed")
  return { changed };
}

// Decision central: ¿este job debe enviarse a OpenAI? (evita re-analizar y re-cobrar).
function shouldAnalyzeJob(job) {
  return !!job && (job.aiAnalysis === null || job.aiAnalysis === undefined);
}

function markAnalysisProcessing(job, options = {}) {
  job.analysisStatus = ANALYSIS_STATUS.PROCESSING;
  job.analysisAttemptedAt = (options.clock || nowIso)();
  return job;
}

function setAnalysisResult(job, analysis, options = {}) {
  const now = (options.clock || nowIso)();
  job.aiAnalysis = analysis;
  job.analysisStatus = ANALYSIS_STATUS.COMPLETED;
  job.analysisCompletedAt = now;
  job.analysisError = null;
  return job;
}

function setAnalysisFailed(job, errorMessage, options = {}) {
  job.aiAnalysis = null;
  job.analysisStatus = ANALYSIS_STATUS.FAILED;
  job.analysisAttemptedAt = (options.clock || nowIso)();
  job.analysisError = errorMessage ? String(errorMessage).slice(0, 500) : 'unknown';
  return job;
}

module.exports = {
  createJobRecord,
  applyRead,
  applyInterested,
  applyPriority,
  applyApplied,
  applyDiscarded,
  mergeDiscovery,
  shouldAnalyzeJob,
  markAnalysisProcessing,
  setAnalysisResult,
  setAnalysisFailed,
  ANALYSIS_STATUS,
  nowIso,
};

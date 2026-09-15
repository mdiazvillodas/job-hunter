'use strict';

// Modelo de Job + transiciones de estado (puras). No persisten: eso lo hace jobService.
// Separacion conceptual clave:
//   - aiAnalysis  = resultado del OpenAI Job Analyzer (NO se toca al cambiar el estado del usuario).
//   - userState   = decisiones/acciones de Mariano (new/read/interested/discarded/applied/priority).
//   - feedback    = ultimo resumen de descarte (reasons + comment).
//   - feedbackEvents = historial completo de eventos (nunca se sobreescribe silenciosamente).
//   - availability = DISPONIBILIDAD DE LA OFERTA (eje independiente del userState). Que una
//     oferta ya no acepte postulaciones es un hecho del mercado, NO una decision de Mariano:
//     no escribe userState, ni feedback, ni feedbackEvents, por lo que no llega a learning
//     (learnedPreferences filtra ev.type === 'discarded') ni a calibration (lee userState).

const { JOB_STATES, isValidReason } = require('./feedbackConfig');
const { isDescriptionUsable, DESCRIPTION_INSUFFICIENT } = require('./descriptionQuality');

// Estado del ANALISIS (independiente del userState). Idempotencia del pipeline.
const ANALYSIS_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  STALE: 'stale',
  FAILED: 'failed',
});

// Disponibilidad de la OFERTA (independiente de la decision del usuario).
const AVAILABILITY = Object.freeze({
  OPEN: 'open',
  CLOSED: 'closed',
});

const AVAILABILITY_REASON = Object.freeze({
  APPLICATIONS_CLOSED: 'applications_closed',
});

function nowIso() {
  return new Date().toISOString();
}

// Los registros anteriores a este campo no lo tienen: ausente equivale a 'open'.
// Evita migrar el repositorio completo.
function availabilityOf(job) {
  return job && job.availability === AVAILABILITY.CLOSED ? AVAILABILITY.CLOSED : AVAILABILITY.OPEN;
}

function isApplicationsClosed(job) {
  return availabilityOf(job) === AVAILABILITY.CLOSED;
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

    // Disponibilidad de la oferta. Eje separado: NO es una decision del usuario.
    availability: AVAILABILITY.OPEN,
    availabilityReason: null,
    availabilityUpdatedAt: null,

    // Side effect informativo (push ntfy). No es feedback ni decision del usuario.
    // Se setea SOLO tras confirmar el envio; null = todavia notificable.
    highMatchNotifiedAt: null,
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

// Marca que la oferta ya no acepta postulaciones. NO es un descarte:
// deja userState, feedback, feedbackEvents, aiAnalysis y analysisStatus intactos.
function applyApplicationsClosed(job, options = {}) {
  const now = (options.clock || nowIso)();
  job.availability = AVAILABILITY.CLOSED;
  job.availabilityReason = AVAILABILITY_REASON.APPLICATIONS_CLOSED;
  job.availabilityUpdatedAt = now;
  return job;
}

// Deja constancia de que ya se envio la push de high match para este jobId.
// La marca es por jobId, no por ejecucion de analisis: un reanalisis posterior
// no vuelve a notificar. No toca userState, feedback ni availability.
function applyHighMatchNotified(job, options = {}) {
  job.highMatchNotifiedAt = (options.clock || nowIso)();
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

// Actualiza SOLO informacion de discovery + lastSeenAt. NO toca highMatchNotifiedAt/availability/userState/feedback/feedbackEvents/
// aiAnalysis/analysisStatus/firstSeenAt. Rellena campos faltantes; permite mejorar
// una descripcion insuficiente solo cuando el job todavia no tiene analisis.
// Devuelve { changed } (cambios significativos: matchedQueries/families o campos rellenados).
function mergeDiscovery(job, incoming = {}, options = {}) {
  const now = (options.clock || nowIso)();
  let changed = false;

  if (incoming.detailExtraction) {
    job.detailExtraction = incoming.detailExtraction;
    changed = true;
  }

  // Un pendiente con texto corto debe poder recuperar una descripcion valida.
  // No reemplazar evidencia de jobs ya analizados ni una descripcion utilizable.
  if (shouldAnalyzeJob(job) && !isDescriptionUsable(job.description) && isDescriptionUsable(incoming.description)) {
    job.description = incoming.description;
    job.descriptionLength = incoming.description.length;
    changed = true;
  }

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
  return !!job && (job.analysisStatus === ANALYSIS_STATUS.STALE || job.aiAnalysis === null || job.aiAnalysis === undefined);
}

function markAnalysisStale(job, options = {}) {
  if (!job.aiAnalysis) return job;
  if (job.analysisStatus === ANALYSIS_STATUS.STALE && job.analysisStaleReason === 'description_repaired') return job;
  job.analysisStatus = ANALYSIS_STATUS.STALE;
  job.analysisStaleReason = 'description_repaired';
  job.analysisStaleAt = (options.clock || nowIso)();
  return job;
}

function markAnalysisProcessing(job, options = {}) {
  // El analisis viejo sigue siendo stale mientras se intenta reemplazarlo.
  if (job.analysisStatus !== ANALYSIS_STATUS.STALE) job.analysisStatus = ANALYSIS_STATUS.PROCESSING;
  job.analysisAttemptedAt = (options.clock || nowIso)();
  return job;
}

function markDescriptionInsufficient(job) {
  if (job.analysisStatus === ANALYSIS_STATUS.STALE) {
    job.analysisError = DESCRIPTION_INSUFFICIENT;
    return job;
  }
  job.aiAnalysis = null;
  job.analysisStatus = ANALYSIS_STATUS.PENDING;
  job.analysisError = DESCRIPTION_INSUFFICIENT;
  job.analysisCompletedAt = null;
  return job;
}

function setAnalysisResult(job, analysis, options = {}) {
  const now = (options.clock || nowIso)();
  if (job.analysisStaleReason) {
    job.analysisReanalysisHistory = [...(job.analysisReanalysisHistory || []), {
      reason: job.analysisStaleReason, staleAt: job.analysisStaleAt,
      previousAnalysisCompletedAt: job.analysisCompletedAt, completedAt: now,
    }];
    job.analysisStaleReason = null;
    job.analysisStaleResolvedAt = now;
  }
  job.aiAnalysis = analysis;
  job.analysisStatus = ANALYSIS_STATUS.COMPLETED;
  job.analysisCompletedAt = now;
  job.analysisError = null;
  return job;
}

function setAnalysisFailed(job, errorMessage, options = {}) {
  if (job.analysisStatus !== ANALYSIS_STATUS.STALE) {
    job.aiAnalysis = null;
    job.analysisStatus = ANALYSIS_STATUS.FAILED;
  }
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
  applyApplicationsClosed,
  applyHighMatchNotified,
  availabilityOf,
  isApplicationsClosed,
  mergeDiscovery,
  shouldAnalyzeJob,
  markAnalysisProcessing,
  markAnalysisStale,
  markDescriptionInsufficient,
  setAnalysisResult,
  setAnalysisFailed,
  ANALYSIS_STATUS,
  AVAILABILITY,
  AVAILABILITY_REASON,
  nowIso,
};

'use strict';

// Logica de negocio del estado/feedback de ofertas. Depende de un repository (contrato),
// no de una implementacion concreta -> se puede pasar de LocalRepository a PostgresRepository.

const {
  createJobRecord,
  applyRead,
  applyInterested,
  applyPriority,
  applyApplied,
  applyDiscarded,
  applyApplicationsClosed,
  applyHighMatchNotified,
  mergeDiscovery,
  shouldAnalyzeJob,
  markAnalysisProcessing,
  markDescriptionInsufficient,
  setAnalysisResult,
  setAnalysisFailed,
} = require('../domain/jobRecord');
const { computeCalibrationSignal } = require('../domain/calibration');
const { selectExpiredJobs, protectionReason, TTL_DAYS } = require('../domain/retention');

function createJobService(repository, options = {}) {
  if (!repository || typeof repository.save !== 'function') {
    throw new Error('createJobService: repository invalido (falta el contrato).');
  }
  const clock = options.clock; // opcional, para tests deterministas

  function withClock(opts) {
    return clock ? { clock, ...opts } : opts;
  }

  // Crea un job (o lo devuelve si ya existe: no duplica por jobId).
  function createJob(input) {
    if (repository.has(input.jobId)) {
      return repository.get(input.jobId);
    }
    const job = createJobRecord(input, withClock({}));
    return repository.save(job);
  }

  // Upsert: si existe, refresca campos del listado/AI conservando userState + feedback + historial.
  function upsertJob(input) {
    const existing = repository.get(input.jobId);
    if (!existing) return createJob(input);
    const merged = {
      ...existing,
      title: input.title ?? existing.title,
      company: input.company ?? existing.company,
      location: input.location ?? existing.location,
      url: input.url ?? existing.url,
      employmentType: input.employmentType ?? existing.employmentType,
      workplaceType: input.workplaceType ?? existing.workplaceType,
      seniority: input.seniority ?? existing.seniority,
      easyApply: input.easyApply ?? existing.easyApply,
      description: input.description ?? existing.description,
      matchedQueries: input.matchedQueries ?? existing.matchedQueries,
      matchedFamilies: input.matchedFamilies ?? existing.matchedFamilies,
      aiAnalysis: input.aiAnalysis ?? existing.aiAnalysis,
      // userState, feedback y feedbackEvents se conservan intactos.
    };
    return repository.save(merged);
  }

  function getJob(jobId) {
    return repository.get(jobId);
  }

  function getAllJobs() {
    return repository.getAll();
  }

  function requireJob(jobId) {
    const job = repository.get(jobId);
    if (!job) throw new Error(`jobService: job ${jobId} no existe.`);
    return job;
  }

  function transition(jobId, applyFn, opts) {
    const job = requireJob(jobId);
    applyFn(job, withClock(opts || {}));
    return repository.save(job);
  }

  const markAsRead = (jobId) => transition(jobId, applyRead);
  const deferAnalysisForDescription = (jobId) => transition(jobId, markDescriptionInsufficient);
  const markAsInterested = (jobId, opts) => transition(jobId, applyInterested, opts);
  const markAsPriority = (jobId, opts) => transition(jobId, applyPriority, opts);
  const markAsApplied = (jobId, opts) => transition(jobId, applyApplied, opts);
  const markAsDiscarded = (jobId, feedback) => transition(jobId, applyDiscarded, feedback);
  // Disponibilidad de la oferta: NO es una decision del usuario ni genera feedback.
  const markApplicationsClosed = (jobId) => transition(jobId, applyApplicationsClosed);
  // Marca de notificacion push. Side effect informativo: no toca userState ni feedback.
  const markHighMatchNotified = (jobId) => transition(jobId, applyHighMatchNotified);

  // --- Retencion (TTL) ---
  // Borra las ofertas que llevan >= 7 dias en el sistema y NUNCA fueron abiertas.
  // La decision de QUE borrar vive en domain/retention (pura y testeable); aqui solo
  // se ejecuta el borrado por la capa de persistencia (repository.delete), que es la
  // unica que sabe como esta guardado un job. Nunca se toca el filesystem a mano.
  //
  // opts: { now?: Date|number|string, dryRun?: boolean }
  // dryRun=true calcula exactamente lo mismo pero NO borra: sirve para auditar antes.
  function cleanupExpiredJobs(opts = {}) {
    const now = opts.now !== undefined && opts.now !== null
      ? opts.now
      : (clock ? clock() : new Date().toISOString());
    const dryRun = opts.dryRun === true;

    const all = repository.getAll();
    const expired = selectExpiredJobs(all, now);

    let deleted = 0;
    const failed = [];
    if (!dryRun) {
      for (const job of expired) {
        try {
          if (repository.delete(job.jobId)) deleted += 1;
        } catch (e) {
          // Un job que no se puede borrar no debe tumbar la corrida ni el pipeline.
          failed.push({ jobId: job.jobId, error: e && e.message ? e.message : String(e) });
        }
      }
    }

    return {
      ttlDays: TTL_DAYS,
      now: typeof now === 'string' ? now : new Date(now).toISOString(),
      dryRun,
      scanned: all.length,
      eligible: expired.length,
      deleted,
      failed,
      jobIds: expired.map((j) => j.jobId),
    };
  }

  // Por que una oferta concreta esta protegida del TTL (o null si no lo esta).
  // Expuesto para auditoria/diagnostico; no lo usa el pipeline.
  function retentionProtectionReason(jobId) {
    return protectionReason(repository.get(jobId));
  }

  function getCalibration(jobId) {
    return computeCalibrationSignal(requireJob(jobId));
  }

  // --- Pipeline (idempotente): discovery + analisis ---

  // Crea el job si es nuevo; si existe, solo fusiona discovery (sin tocar userState/feedback/aiAnalysis).
  function ingestDiscovery(input) {
    if (!repository.has(input.jobId)) {
      const job = createJobRecord(input, withClock({}));
      repository.save(job);
      return { job, created: true, changed: true };
    }
    const job = repository.get(input.jobId);
    const { changed } = mergeDiscovery(job, input, withClock({}));
    repository.save(job);
    return { job, created: false, changed };
  }

  // Fusiona datos de detalle (description, etc.) en un job existente sin re-analizar.
  function updateDiscovery(jobId, incoming) {
    const job = requireJob(jobId);
    const { changed } = mergeDiscovery(job, incoming, withClock({}));
    repository.save(job);
    return { job, changed };
  }

  function applyAnalysisProcessing(jobId) {
    const job = requireJob(jobId);
    markAnalysisProcessing(job, withClock({}));
    return repository.save(job);
  }

  function applyAnalysisResult(jobId, analysis) {
    const job = requireJob(jobId);
    setAnalysisResult(job, analysis, withClock({}));
    return repository.save(job);
  }

  function applyAnalysisFailure(jobId, errorMessage) {
    const job = requireJob(jobId);
    setAnalysisFailed(job, errorMessage, withClock({}));
    return repository.save(job);
  }

  return {
    repository,
    createJob,
    upsertJob,
    getJob,
    getAllJobs,
    markAsRead,
    markAsInterested,
    markAsPriority,
    markAsApplied,
    markAsDiscarded,
    markApplicationsClosed,
    markHighMatchNotified,
    getCalibration,
    ingestDiscovery,
    updateDiscovery,
    applyAnalysisProcessing,
    deferAnalysisForDescription,
    applyAnalysisResult,
    applyAnalysisFailure,
    shouldAnalyzeJob,
    cleanupExpiredJobs,
    retentionProtectionReason,
  };
}

module.exports = {
  createJobService,
};

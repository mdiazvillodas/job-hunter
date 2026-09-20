'use strict';

// Orquestador PURO del pipeline end-to-end (Milestone 9).
// Dependencias inyectables (discover/fetchDetails/analyze) -> testeable sin browser ni OpenAI.
//   discover()        -> { jobs: uniqueJob[], discovery: {queriesExecuted,rawResults,uniqueResults,duplicatesRemoved} }
//   fetchDetails(job) -> detailedJob (con description...)   | throw (challenge/error)
//   analyze(job)      -> { analysis, usage, model, durationMs } | throw
//   notify(job)       -> { status } (opcional). Side effect informativo: SIEMPRE resuelve,
//                        nunca rechaza, y no puede afectar al resultado del analisis.
// analyze puede ser null: en ese caso NO se analiza nada (los candidatos quedan 'skipped', pending).

const { shouldAnalyzeJob } = require('../domain/jobRecord');
const { CHALLENGE_STAGES, isKnownStage } = require('../linkedin/challengeSignals');

function isChallenge(err) {
  return !!err && err.name === 'SecurityChallengeError';
}

// Extrae el diagnostico que el detector adjunto al error y le añade el contexto
// del pipeline. Solo campos acotados; nunca el error crudo ni la pagina.
// La etapa que trae el detector manda: sabe mejor que este bucle donde estaba.
function challengeDiagnostic(err, context = {}) {
  const source = err && err.challengeDiagnostic;
  if (!source || typeof source !== 'object') return null;
  const diagnostic = { ...source };
  if (!isKnownStage(diagnostic.stage)) delete diagnostic.stage;
  if (isKnownStage(context.stage) && !diagnostic.stage) diagnostic.stage = context.stage;
  if (context.jobId != null && diagnostic.jobId == null) diagnostic.jobId = String(context.jobId);
  return diagnostic;
}

function isCancellation(err) {
  return !!err && (err.name === 'AbortError' || err.name === 'HuntCancelledError');
}

function cancellationError() {
  const error = new Error('Hunt cancelled.');
  error.name = 'HuntCancelledError';
  return error;
}

function throwIfCancelled(signal) {
  if (signal && signal.aborted) throw cancellationError();
}

function newRunId() {
  return 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function compactJob(job) {
  const a = job.aiAnalysis || null;
  return {
    jobId: job.jobId,
    title: job.title || null,
    company: job.company || null,
    location: job.location || null,
    url: job.url || null,
    easyApply: job.easyApply === true,
    aiDecision: a ? a.decision : null,
    overallMatchScore: a ? a.overallMatchScore : null,
    analysisStatus: job.analysisStatus,
    analysisError: job.analysisError || null,
    userStatus: job.userState ? job.userState.status : null,
  };
}

async function runPipeline(deps) {
  const { jobService, discover, fetchDetails, analyze, analyzeLimit, analysisTarget = 20, signal, log, notify } = deps;
  const reportProgress = typeof deps.reportProgress === 'function' ? deps.reportProgress : () => {};
  const say = typeof log === 'function' ? log : () => {};
  const startMs = Date.now();
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const durations = { discoveryMs: 0, detailsMs: 0, analysisMs: 0, totalMs: 0 };
  const progress = (next) => reportProgress({ analysisTarget, ...next });

  // ---------- DISCOVERY ----------
  say('discovery:start');
  throwIfCancelled(signal);
  progress({ phase: 'discovery' });
  const d0 = Date.now();
  const discovered = await discover();
  durations.discoveryMs = Date.now() - d0;
  const uniqueJobs = (discovered && discovered.jobs) || [];
  const dstats = (discovered && discovered.discovery) || {};
  say(`discovery:done unique=${uniqueJobs.length}`);
  progress({ rawJobsDiscovered: dstats.rawResults || 0, uniqueJobsDiscovered: uniqueJobs.length });

  // ---------- PERSISTENCIA DE DISCOVERY (idempotente) ----------
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let newJobs = 0;
  let existingJobs = 0;
  for (const uj of uniqueJobs) {
    throwIfCancelled(signal);
    const existedBefore = !!jobService.getJob(uj.jobId);
    const r = jobService.ingestDiscovery(uj);
    if (r.created) { created += 1; newJobs += 1; }
    else { existingJobs += 1; if (r.changed) updated += 1; else unchanged += 1; }
    void existedBefore;
  }
  progress({ jobsPersisted: created + existingJobs });

  // ---------- SELECCION DE CANDIDATOS (analysis) ----------
  // Semantica de analyzeLimit: 0 = no analizar; N>0 = maximo N; ausente/invalido = sin limite.
  const configuredLimit = Number.isFinite(analyzeLimit) && analyzeLimit >= 0 ? analyzeLimit : 50;
  const limit = Math.min(configuredLimit, 50);
  const persisted = uniqueJobs.map((uj) => jobService.getJob(uj.jobId)).filter(Boolean);
  const analyzable = persisted.filter((j) => shouldAnalyzeJob(j));
  const alreadyAnalyzed = persisted.length - analyzable.length;
  // Se procesan hasta `limit` candidatos: se les extrae el detalle y, si hay analyzer, se analizan.
  // (Sin analyzer -por falta de key- igual se enriquece la description y quedan 'pending'.)
  const candidates = analyzable.slice(0, limit);

  // ---------- DETAILS + ANALYSIS ----------
  const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 };
  let model = null;
  let analyzed = 0;
  let failed = 0;
  let detailsFetched = 0;
  let stoppedByChallenge = false;
  // Diagnostico del challenge que detuvo el run: por que se detecto y donde.
  // Es lo unico que despues permite distinguir un checkpoint real de un falso
  // positivo sin tener la pagina delante.
  let challenge = null;
  let attempted = 0;
  let stopReason = null;
  const notifications = { eligible: 0, sent: 0, alreadyNotified: 0, failed: 0 };

  for (const cand of candidates) {
    throwIfCancelled(signal);
    if (analyzed >= analysisTarget) { stopReason = 'target_reached'; break; }
    // 1) detalle (LinkedIn) — solo si aun no tenemos description (idempotente / evita refetch).
    if (!cand.description) {
      try {
        progress({ phase: 'details', analysisAttempted: attempted, analysisCompleted: analyzed, analysisFailed: failed });
        const t = Date.now();
        const detailed = await fetchDetails(cand);
        durations.detailsMs += Date.now() - t;
        detailsFetched += 1;
        jobService.updateDiscovery(cand.jobId, detailed || {});
      } catch (err) {
        if (isCancellation(err) || (signal && signal.aborted)) throw cancellationError();
        if (isChallenge(err)) {
          stoppedByChallenge = true;
          challenge = challengeDiagnostic(err, { stage: CHALLENGE_STAGES.DETAIL, jobId: cand.jobId });
          say(`challenge:stop ${challenge ? challenge.signal : 'sin_diagnostico'}`);
          break;
        }
        jobService.applyAnalysisFailure(cand.jobId, 'detail: ' + (err.message || err));
        failed += 1;
        say(`detail:failed ${cand.jobId}`);
        continue;
      }
    }

    // 2) analisis (OpenAI) — si no hay analyzer, el job queda 'pending' (skipped).
    if (!analyze) continue;
    throwIfCancelled(signal);
    let analysisJustSucceeded = false;
    attempted += 1;
    progress({ phase: 'analysis', analysisAttempted: attempted, analysisCompleted: analyzed, analysisFailed: failed });
    try {
      const t = Date.now();
      const res = await analyze(jobService.getJob(cand.jobId));
      durations.analysisMs += Date.now() - t;
      throwIfCancelled(signal);
      jobService.applyAnalysisProcessing(cand.jobId);
      jobService.applyAnalysisResult(cand.jobId, res.analysis);
      analyzed += 1;
      progress({ phase: 'analysis', analysisAttempted: attempted, analysisCompleted: analyzed, analysisFailed: failed });
      model = res.model || model;
      if (res.usage) {
        usage.promptTokens += res.usage.prompt_tokens || 0;
        usage.completionTokens += res.usage.completion_tokens || 0;
        usage.totalTokens += res.usage.total_tokens || 0;
        const cached = res.usage.prompt_tokens_details && res.usage.prompt_tokens_details.cached_tokens;
        usage.cachedTokens += cached || 0;
      }
      analysisJustSucceeded = true;
      say(`analyzed ${cand.jobId} -> ${res.analysis.decision}`);
    } catch (err) {
      if (isCancellation(err) || (signal && signal.aborted)) throw cancellationError();
      // Un challenge NO es un analisis fallido: es LinkedIn cortandonos. Se
      // trata igual que en la fase de detalle -detiene el run y conserva el
      // diagnostico- en vez de marcar la oferta como fallida y seguir.
      if (isChallenge(err)) {
        stoppedByChallenge = true;
        challenge = challengeDiagnostic(err, { stage: CHALLENGE_STAGES.ANALYSIS, jobId: cand.jobId });
        say(`challenge:stop ${challenge ? challenge.signal : 'sin_diagnostico'}`);
        break;
      }
      jobService.applyAnalysisFailure(cand.jobId, err.message || String(err));
      failed += 1;
      progress({ phase: 'analysis', analysisAttempted: attempted, analysisCompleted: analyzed, analysisFailed: failed });
      say(`analysis:failed ${cand.jobId}`);
    }

    // 3) Notificacion push de high match. DELIBERADAMENTE fuera del try/catch
    // del analisis: si fallara ahi dentro, el catch marcaria como fallido un
    // analisis que fue exitoso. Solo entran analisis recien persistidos en ESTE
    // run, nunca un escaneo del repositorio. Un fallo aqui no afecta al hunt ni
    // se confunde con una cancelacion.
    if (analysisJustSucceeded && typeof notify === 'function') {
      try {
        const outcome = await notify(jobService.getJob(cand.jobId));
        const status = outcome && outcome.status;
        if (status && status !== 'below_threshold') notifications.eligible += 1;
        if (status === 'sent') notifications.sent += 1;
        else if (status === 'already_notified') notifications.alreadyNotified += 1;
        else if (status === 'failed') notifications.failed += 1;
      } catch (err) {
        // Blindaje extra: un notificador que incumpla el contrato tampoco rompe
        // el hunt ni se propaga como cancelacion.
        notifications.failed += 1;
        say(`notify:threw ${cand.jobId} ${err && err.message ? err.message : err}`);
      }
    }
  }

  if (!stopReason) {
    if (!analyze) stopReason = 'analysis_disabled';
    else if (analyzed >= analysisTarget) stopReason = 'target_reached';
    else stopReason = 'candidates_exhausted';
  }

  const skipped = analyzable.length - analyzed - failed;
  durations.totalMs = Date.now() - startMs;
  const finishedAt = new Date().toISOString();

  return {
    runId,
    startedAt,
    finishedAt,
    stoppedByChallenge,
    challenge,
    discovery: {
      queriesExecuted: dstats.queriesExecuted ?? null,
      rawResults: dstats.rawResults ?? null,
      uniqueResults: uniqueJobs.length,
      duplicatesRemoved: dstats.duplicatesRemoved ?? null,
      newJobs,
      existingJobs,
    },
    analysis: {
      requiringAnalysis: analyzable.length,
      alreadyAnalyzed,
      processed: analyzed + failed,
      analyzed,
      failed,
      skipped,
      detailsFetched,
      analysisEnabled: !!analyze,
      target: analysisTarget,
      stopReason,
    },
    persistence: { created, updated, unchanged },
    notifications,
    usageTotals: { ...usage, model },
    durations,
    jobs: uniqueJobs.map((uj) => compactJob(jobService.getJob(uj.jobId))),
  };
}

module.exports = { runPipeline, isChallenge, challengeDiagnostic, isCancellation, compactJob, throwIfCancelled, cancellationError };

'use strict';

// Orquestador PURO del pipeline end-to-end (Milestone 9).
// Dependencias inyectables (discover/fetchDetails/analyze) -> testeable sin browser ni OpenAI.
//   discover()        -> { jobs: uniqueJob[], discovery: {queriesExecuted,rawResults,uniqueResults,duplicatesRemoved} }
//   fetchDetails(job) -> detailedJob (con description...)   | throw (challenge/error)
//   analyze(job)      -> { analysis, usage, model, durationMs } | throw
//   notify(job)       -> { status } (opcional). Side effect informativo: SIEMPRE resuelve,
//                        nunca rechaza, y no puede afectar el resultado del analisis.
// analyze puede ser null: en ese caso NO se analiza nada (los candidatos quedan 'skipped', pending).

const { shouldAnalyzeJob } = require('../domain/jobRecord');
const { isDescriptionUsable } = require('../domain/descriptionQuality');

function isChallenge(err) {
  return !!err && ['SecurityChallengeError', 'AuthenticationError'].includes(err.name);
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
  const { jobService, discover, fetchDetails, analyze, analyzeLimit, log, notify } = deps;
  const say = typeof log === 'function' ? log : () => {};
  const startMs = Date.now();
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const durations = { discoveryMs: 0, detailsMs: 0, analysisMs: 0, totalMs: 0 };

  // ---------- DISCOVERY ----------
  say('discovery:start');
  const d0 = Date.now();
  const discovered = await discover();
  durations.discoveryMs = Date.now() - d0;
  const uniqueJobs = (discovered && discovered.jobs) || [];
  const dstats = (discovered && discovered.discovery) || {};
  say(`discovery:done unique=${uniqueJobs.length}`);

  // ---------- PERSISTENCIA DE DISCOVERY (idempotente) ----------
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let newJobs = 0;
  let existingJobs = 0;
  for (const uj of uniqueJobs) {
    const existedBefore = !!jobService.getJob(uj.jobId);
    const r = jobService.ingestDiscovery(uj);
    if (r.created) { created += 1; newJobs += 1; }
    else { existingJobs += 1; if (r.changed) updated += 1; else unchanged += 1; }
    void existedBefore;
  }

  // ---------- SELECCION DE CANDIDATOS (analysis) ----------
  // Semantica de analyzeLimit: 0 = no analizar; N>0 = maximo N; ausente/invalido = sin limite.
  const limit = Number.isFinite(analyzeLimit) && analyzeLimit >= 0 ? analyzeLimit : Infinity;
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
  // Intentos incluye excepciones/challenges. With/Without clasifican solo retornos
  // de fetch de ESTE run; no cuentan descripciones ya persistidas sin refetch.
  let detailFetchAttempts = 0;
  let detailsWithUsableDescription = 0;
  let detailsWithoutUsableDescription = 0;
  let skippedDueToMissingDescription = 0;
  let stoppedByChallenge = false;
  const notifications = { eligible: 0, sent: 0, alreadyNotified: 0, failed: 0 };
  const detailDiagnostics = [];

  for (const cand of candidates) {
    // 1) Reintentar detalle ausente/corto; conservar evidencia ya utilizable.
    if (!isDescriptionUsable(cand.description)) {
      try {
        const t = Date.now();
        detailFetchAttempts += 1;
        const detailed = await fetchDetails(cand);
        if (detailed && detailed.detailExtraction) detailDiagnostics.push(detailed.detailExtraction);
        durations.detailsMs += Date.now() - t;
        // Compatibilidad: retornos sin excepcion, NO descripciones validas.
        detailsFetched += 1;
        if (isDescriptionUsable(detailed && detailed.description)) detailsWithUsableDescription += 1;
        else detailsWithoutUsableDescription += 1;
        jobService.updateDiscovery(cand.jobId, detailed || {});
      } catch (err) {
        if (err.detailDiagnostics) {
          detailDiagnostics.push(err.detailDiagnostics);
          jobService.updateDiscovery(cand.jobId, { detailExtraction: err.detailDiagnostics });
        }
        if (isChallenge(err)) { stoppedByChallenge = true; say('challenge:stop'); break; }
        jobService.applyAnalysisFailure(cand.jobId, 'detail: ' + (err.message || err));
        failed += 1;
        say(`detail:failed ${cand.jobId}`);
        continue;
      }
    }

    // Gate sobre el dato persistido que recibira el analyzer, antes de processing/OpenAI.
    if (!isDescriptionUsable(jobService.getJob(cand.jobId).description)) {
      jobService.deferAnalysisForDescription(cand.jobId);
      skippedDueToMissingDescription += 1;
      say(`analysis:deferred ${cand.jobId} description_missing_or_insufficient`);
      continue;
    }

    // 2) analisis (OpenAI) — si no hay analyzer, el job queda 'pending' (skipped).
    if (!analyze) continue;
    jobService.applyAnalysisProcessing(cand.jobId);
    let analysisJustSucceeded = false;
    try {
      const t = Date.now();
      const res = await analyze(jobService.getJob(cand.jobId));
      durations.analysisMs += Date.now() - t;
      jobService.applyAnalysisResult(cand.jobId, res.analysis);
      analyzed += 1;
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
      jobService.applyAnalysisFailure(cand.jobId, err.message || String(err));
      failed += 1;
      say(`analysis:failed ${cand.jobId}`);
    }

    // 3) Notificacion push de high match. DELIBERADAMENTE fuera del try/catch del
    // analisis: si fallara ahi dentro, el catch marcaria como fallido un analisis
    // que en realidad fue exitoso. Solo entran analisis recién persistidos en ESTE
    // run, nunca un scan del repositorio. Un fallo aqui no afecta al hunt.
    if (analysisJustSucceeded && typeof notify === 'function') {
      try {
        const outcome = await notify(jobService.getJob(cand.jobId));
        const status = outcome && outcome.status;
        if (status && status !== 'below_threshold') notifications.eligible += 1;
        if (status === 'sent') notifications.sent += 1;
        else if (status === 'already_notified') notifications.alreadyNotified += 1;
        else if (status === 'failed') notifications.failed += 1;
      } catch (err) {
        // Blindaje extra: un notifier que incumpla el contrato tampoco rompe el hunt.
        notifications.failed += 1;
        say(`notify:threw ${cand.jobId} ${err && err.message ? err.message : err}`);
      }
    }
  }

  const skipped = analyzable.length - analyzed - failed;
  durations.totalMs = Date.now() - startMs;
  const finishedAt = new Date().toISOString();

  return {
    runId,
    startedAt,
    finishedAt,
    stoppedByChallenge,
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
      detailFetchAttempts,
      detailsWithUsableDescription,
      detailsWithoutUsableDescription,
      skippedDueToMissingDescription,
      detailExtractionCounts: detailDiagnostics.reduce((counts, d) => {
        counts[d.status] = (counts[d.status] || 0) + 1;
        return counts;
      }, {}),
      analysisEnabled: !!analyze,
    },
    persistence: { created, updated, unchanged },
    notifications,
    usageTotals: { ...usage, model },
    durations,
    detailDiagnostics,
    jobs: uniqueJobs.map((uj) => compactJob(jobService.getJob(uj.jobId))),
  };
}

module.exports = { runPipeline, isChallenge, compactJob };

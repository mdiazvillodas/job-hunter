'use strict';

// Orquestador PURO del pipeline end-to-end (Milestone 9).
// Dependencias inyectables (discover/fetchDetails/analyze) -> testeable sin browser ni OpenAI.
//   discover()        -> { jobs: uniqueJob[], discovery: {queriesExecuted,rawResults,uniqueResults,duplicatesRemoved} }
//   fetchDetails(job) -> detailedJob (con description...)   | throw (challenge/error)
//   analyze(job)      -> { analysis, usage, model, durationMs } | throw
// analyze puede ser null: en ese caso NO se analiza nada (los candidatos quedan 'skipped', pending).

const { shouldAnalyzeJob } = require('../domain/jobRecord');

function isChallenge(err) {
  return !!err && err.name === 'SecurityChallengeError';
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
  const { jobService, discover, fetchDetails, analyze, analyzeLimit, log } = deps;
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
  let stoppedByChallenge = false;

  for (const cand of candidates) {
    // 1) detalle (LinkedIn) — solo si aun no tenemos description (idempotente / evita refetch).
    if (!cand.description) {
      try {
        const t = Date.now();
        const detailed = await fetchDetails(cand);
        durations.detailsMs += Date.now() - t;
        detailsFetched += 1;
        jobService.updateDiscovery(cand.jobId, detailed || {});
      } catch (err) {
        if (isChallenge(err)) { stoppedByChallenge = true; say('challenge:stop'); break; }
        jobService.applyAnalysisFailure(cand.jobId, 'detail: ' + (err.message || err));
        failed += 1;
        say(`detail:failed ${cand.jobId}`);
        continue;
      }
    }

    // 2) analisis (OpenAI) — si no hay analyzer, el job queda 'pending' (skipped).
    if (!analyze) continue;
    jobService.applyAnalysisProcessing(cand.jobId);
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
      say(`analyzed ${cand.jobId} -> ${res.analysis.decision}`);
    } catch (err) {
      jobService.applyAnalysisFailure(cand.jobId, err.message || String(err));
      failed += 1;
      say(`analysis:failed ${cand.jobId}`);
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
      analysisEnabled: !!analyze,
    },
    persistence: { created, updated, unchanged },
    usageTotals: { ...usage, model },
    durations,
    jobs: uniqueJobs.map((uj) => compactJob(jobService.getJob(uj.jobId))),
  };
}

module.exports = { runPipeline, isChallenge, compactJob };

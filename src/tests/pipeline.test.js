'use strict';

// Tests del pipeline end-to-end (Milestone 9) con dependencias mockeadas (sin browser/OpenAI).
// Ejecutar: node src/tests/pipeline.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLocalRepository } = require('../data/jobRepository');
const { createJobService } = require('../services/jobService');
const { runPipeline } = require('../pipeline/pipeline');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }
function tmpSvc() { return createJobService(createLocalRepository({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'jh-pipe-')) })); }

function listing(id, over) {
  return { jobId: id, title: 'Role ' + id, company: 'Co ' + id, location: 'Barcelona', url: 'https://www.linkedin.com/jobs/view/' + id + '/',
    easyApply: true, matchedQueries: ['Head of Operations'], matchedFamilies: ['operations'], ...over };
}
function analysisOf(id) {
  return { decision: 'YES', overallMatchScore: 80, professionalFitScore: 85, interestFitScore: 70, cvFitScore: 78,
    roleFamily: 'operations', summary: 's', whyItFits: ['a'], transferableExperience: ['b'], literalMatches: ['c'],
    gaps: ['d'], criticalRequirementsUnmet: [], redFlags: [], recommendedCV: 'current_cv', cvAdjustments: ['e'], confidence: 60, reasoning: 'r' };
}
const okDetail = (job) => Promise.resolve({ ...job, description: 'Full description for ' + job.jobId + ' (See more expanded).', descriptionLength: 42, employmentType: 'Full-time', workplaceType: 'Hybrid', seniority: 'Director' });

function makeAnalyze(calls, opts = {}) {
  return (job) => {
    calls.push(job.jobId);
    if (opts.failFor && opts.failFor.includes(job.jobId)) return Promise.reject(new Error('OpenAI 500 for ' + job.jobId));
    return Promise.resolve({ analysis: analysisOf(job.jobId), model: 'test-model', durationMs: 1,
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 10 } } });
  };
}

async function run() {
  // ---------- New job ----------
  section('New job → analyze → persist');
  {
    const svc = tmpSvc();
    const calls = [];
    const s = await runPipeline({ jobService: svc, analyzeLimit: 5,
      discover: async () => ({ jobs: [listing('1')], discovery: { queriesExecuted: 1, rawResults: 1, duplicatesRemoved: 0 } }),
      fetchDetails: okDetail, analyze: makeAnalyze(calls) });
    const j = svc.getJob('1');
    ok('creado y analizado', s.discovery.newJobs === 1 && s.analysis.analyzed === 1);
    ok('aiAnalysis + completed', !!j.aiAnalysis && j.analysisStatus === 'completed');
    ok('detalle fusionado (description)', /Full description/.test(j.description));
    ok('userState inicial = new', j.userState.status === 'new');
    ok('analyze llamado 1 vez', calls.length === 1);
  }

  // ---------- Existing analyzed job → skip OpenAI ----------
  section('Existing analyzed job → skip OpenAI');
  {
    const svc = tmpSvc();
    svc.createJob(listing('1', { aiAnalysis: analysisOf('1') })); // ya completado
    const calls = [];
    const s = await runPipeline({ jobService: svc, analyzeLimit: 5,
      discover: async () => ({ jobs: [listing('1')], discovery: {} }), fetchDetails: okDetail, analyze: makeAnalyze(calls) });
    ok('no se re-analiza', calls.length === 0 && s.analysis.analyzed === 0);
    ok('already analyzed = 1', s.analysis.alreadyAnalyzed === 1);
    ok('existing job', s.discovery.existingJobs === 1 && s.discovery.newJobs === 0);
  }

  // ---------- Existing unanalyzed job → analyze ----------
  section('Existing unanalyzed (aiAnalysis=null) → analyze');
  {
    const svc = tmpSvc();
    svc.createJob(listing('1')); // sin aiAnalysis -> pending
    const calls = [];
    await runPipeline({ jobService: svc, analyzeLimit: 5,
      discover: async () => ({ jobs: [listing('1')], discovery: {} }), fetchDetails: okDetail, analyze: makeAnalyze(calls) });
    ok('pending se analiza', calls.length === 1 && svc.getJob('1').analysisStatus === 'completed');
  }

  // ---------- Existing job with user feedback → preserved ----------
  section('Existing job con feedback → preserva userState/feedback/history');
  {
    const svc = tmpSvc();
    svc.createJob(listing('1', { aiAnalysis: analysisOf('1') }));
    svc.markAsInterested('1');
    svc.markAsDiscarded('1', { reasons: ['too_product'], comment: 'PM otra vez' });
    const eventsBefore = svc.getJob('1').feedbackEvents.length;
    const firstSeen = svc.getJob('1').userState.firstSeenAt;
    await runPipeline({ jobService: svc, analyzeLimit: 5,
      discover: async () => ({ jobs: [listing('1', { matchedQueries: ['Operations Lead'] })], discovery: {} }), fetchDetails: okDetail, analyze: makeAnalyze([]) });
    const j = svc.getJob('1');
    ok('userState preservado (discarded)', j.userState.status === 'discarded');
    ok('feedback preservado', j.feedback.reasons[0] === 'too_product' && j.feedback.comment === 'PM otra vez');
    ok('history preservado', j.feedbackEvents.length === eventsBefore);
    ok('firstSeenAt inmutable', j.userState.firstSeenAt === firstSeen);
    ok('matchedQueries unificado (nueva query)', j.matchedQueries.includes('Head of Operations') && j.matchedQueries.includes('Operations Lead'));
  }

  // ---------- Duplicate (mismo jobId) → un registro ----------
  section('Duplicate jobId → un solo registro');
  {
    const svc = tmpSvc();
    const disc = async () => ({ jobs: [listing('1'), listing('1', { matchedQueries: ['Delivery Lead'] })], discovery: {} });
    // (multiSearch ya deduplica; aca probamos que ingerir el mismo id dos veces no duplica)
    await runPipeline({ jobService: svc, analyzeLimit: 0, discover: disc, fetchDetails: okDetail, analyze: null });
    ok('un solo registro', svc.getAllJobs().filter((j) => j.jobId === '1').length === 1);
    ok('queries unificadas', svc.getJob('1').matchedQueries.includes('Delivery Lead'));
  }

  // ---------- OpenAI failure → job preservado, failed ----------
  section('OpenAI failure → job preservado (analysisStatus=failed)');
  {
    const svc = tmpSvc();
    const calls = [];
    const s = await runPipeline({ jobService: svc, analyzeLimit: 5,
      discover: async () => ({ jobs: [listing('1')], discovery: {} }), fetchDetails: okDetail, analyze: makeAnalyze(calls, { failFor: ['1'] }) });
    const j = svc.getJob('1');
    ok('job no se pierde', !!j);
    ok('analysisStatus=failed', j.analysisStatus === 'failed' && j.aiAnalysis === null);
    ok('analysisError guardado', /OpenAI 500/.test(j.analysisError));
    ok('summary.failed=1', s.analysis.failed === 1);
  }

  // ---------- Resume ----------
  section('Resume → segunda corrida no reprocesa completados');
  {
    const svc = tmpSvc();
    const disc = async () => ({ jobs: [listing('1'), listing('2')], discovery: {} });
    const calls1 = [];
    const s1 = await runPipeline({ jobService: svc, analyzeLimit: 1, discover: disc, fetchDetails: okDetail, analyze: makeAnalyze(calls1) });
    ok('run1 analiza 1, skip 1', s1.analysis.analyzed === 1 && s1.analysis.skipped === 1);
    const calls2 = [];
    const s2 = await runPipeline({ jobService: svc, analyzeLimit: 5, discover: disc, fetchDetails: okDetail, analyze: makeAnalyze(calls2) });
    ok('run2 solo analiza el pendiente', calls2.length === 1 && !calls2.includes(calls1[0]));
    ok('run2 already analyzed = 1', s2.analysis.alreadyAnalyzed === 1);
    ok('ambos completados al final', svc.getJob('1').analysisStatus === 'completed' && svc.getJob('2').analysisStatus === 'completed');
  }

  // ---------- Challenge → stop ----------
  section('Challenge en detalle → pipeline stops');
  {
    const svc = tmpSvc();
    const challenge = () => { const e = new Error('checkpoint'); e.name = 'SecurityChallengeError'; return Promise.reject(e); };
    const s = await runPipeline({ jobService: svc, analyzeLimit: 5,
      discover: async () => ({ jobs: [listing('1'), listing('2')], discovery: {} }), fetchDetails: challenge, analyze: makeAnalyze([]) });
    ok('stoppedByChallenge', s.stoppedByChallenge === true);
    ok('discovery persistida pese al challenge', svc.getAllJobs().length === 2);
    ok('no se analizo nada', s.analysis.analyzed === 0);
  }

  // ---------- Usage aggregation ----------
  section('Usage totals agregados');
  {
    const svc = tmpSvc();
    const s = await runPipeline({ jobService: svc, analyzeLimit: 5,
      discover: async () => ({ jobs: [listing('1'), listing('2')], discovery: {} }), fetchDetails: okDetail, analyze: makeAnalyze([]) });
    ok('input tokens 200', s.usageTotals.promptTokens === 200);
    ok('output tokens 40', s.usageTotals.completionTokens === 40);
    ok('cached tokens 20', s.usageTotals.cachedTokens === 20);
  }

  // ---------- UI integration ----------
  section('UI integration (mismo repository/service)');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-pipe-ui-'));
    const svc = createJobService(createLocalRepository({ dir }));
    await runPipeline({ jobService: svc, analyzeLimit: 5,
      discover: async () => ({ jobs: [listing('1')], discovery: {} }), fetchDetails: okDetail, analyze: makeAnalyze([]) });
    // Un nuevo service sobre el mismo dir (como haria el server de la UI) ve el job.
    const uiSvc = createJobService(createLocalRepository({ dir }));
    ok('la UI ve el job creado por el pipeline', uiSvc.getAllJobs().some((j) => j.jobId === '1'));
  }

  // ---------- ANALYZE_LIMIT semantics ----------
  section('ANALYZE_LIMIT semantics (0 = none, N = max N)');
  {
    const disc = async () => ({ jobs: [listing('1'), listing('2'), listing('3')], discovery: {} });
    // 0 -> no analiza, no fetch de detalle, todos quedan pending
    const svc0 = tmpSvc();
    const calls0 = [];
    let details0 = 0;
    const s0 = await runPipeline({ jobService: svc0, analyzeLimit: 0, discover: disc,
      fetchDetails: (j) => { details0 += 1; return okDetail(j); }, analyze: makeAnalyze(calls0) });
    ok('ANALYZE_LIMIT=0 -> analyzed 0', s0.analysis.analyzed === 0 && calls0.length === 0);
    ok('ANALYZE_LIMIT=0 -> sin fetch de detalle', details0 === 0);
    ok('ANALYZE_LIMIT=0 -> todos pending/skipped', s0.analysis.skipped === 3 && svc0.getAllJobs().every((j) => j.analysisStatus === 'pending'));

    // 2 -> como maximo 2
    const svc2 = tmpSvc();
    const calls2 = [];
    const s2 = await runPipeline({ jobService: svc2, analyzeLimit: 2, discover: disc, fetchDetails: okDetail, analyze: makeAnalyze(calls2) });
    ok('ANALYZE_LIMIT=2 -> analiza 2, skip 1', s2.analysis.analyzed === 2 && calls2.length === 2 && s2.analysis.skipped === 1);
  }

  // ---------- v0.2 hunt execution contract ----------
  section('Target de análisis exitosos del run actual');
  {
    const jobs = Array.from({ length: 55 }, (_, index) => listing(String(index + 1)));
    const discover = async () => ({ jobs, discovery: { queriesExecuted: 10, rawResults: 58, duplicatesRemoved: 3 } });
    const svcDefault = tmpSvc(); const defaultCalls = [];
    const defaultRun = await runPipeline({ jobService: svcDefault, discover, fetchDetails: okDetail, analyze: makeAnalyze(defaultCalls), analyzeLimit: 50 });
    ok('target por defecto = 20', defaultRun.analysis.target === 20 && defaultRun.analysis.analyzed === 20 && defaultCalls.length === 20);
    ok('target alcanzado informa stop reason', defaultRun.analysis.stopReason === 'target_reached');

    const svcCustom = tmpSvc(); const customCalls = [];
    const customRun = await runPipeline({ jobService: svcCustom, discover, fetchDetails: okDetail, analyze: makeAnalyze(customCalls), analyzeLimit: 50, analysisTarget: 3 });
    ok('target custom detiene en 3 exitosos', customRun.analysis.analyzed === 3 && customCalls.length === 3);

    const svcFailures = tmpSvc(); const failureCalls = [];
    const failureRun = await runPipeline({ jobService: svcFailures,
      discover: async () => ({ jobs: jobs.slice(0, 5), discovery: {} }), fetchDetails: okDetail,
      analyze: makeAnalyze(failureCalls, { failFor: ['1', '2'] }), analyzeLimit: 50, analysisTarget: 3 });
    ok('fallos no cuentan para target', failureRun.analysis.analyzed === 3 && failureRun.analysis.failed === 2 && failureCalls.length === 5);

    const svcExhausted = tmpSvc();
    const exhausted = await runPipeline({ jobService: svcExhausted,
      discover: async () => ({ jobs: jobs.slice(0, 2), discovery: {} }), fetchDetails: okDetail,
      analyze: makeAnalyze([]), analyzeLimit: 50, analysisTarget: 5 });
    ok('agotamiento bajo target termina normalmente', exhausted.analysis.analyzed === 2 && exhausted.analysis.stopReason === 'candidates_exhausted');

    const svcPrevious = tmpSvc();
    svcPrevious.createJob(listing('old', { aiAnalysis: analysisOf('old') }));
    const previousCalls = [];
    const previous = await runPipeline({ jobService: svcPrevious,
      discover: async () => ({ jobs: [listing('old'), ...jobs.slice(0, 2)], discovery: {} }), fetchDetails: okDetail,
      analyze: makeAnalyze(previousCalls), analyzeLimit: 50, analysisTarget: 2 });
    ok('análisis de runs previos no cuentan', previous.analysis.alreadyAnalyzed === 1 && previous.analysis.analyzed === 2 && previousCalls.length === 2);

    const svcCeiling = tmpSvc(); const ceilingCalls = [];
    const ceiling = await runPipeline({ jobService: svcCeiling, discover, fetchDetails: okDetail,
      analyze: makeAnalyze(ceilingCalls, { failFor: jobs.map((job) => job.jobId) }), analyzeLimit: 999, analysisTarget: 50 });
    ok('ceiling absoluto conserva 50 candidatos', ceilingCalls.length === 50 && ceiling.analysis.failed === 50);
  }

  section('Progreso y cancelación cooperativa');
  {
    const progress = [];
    const svc = tmpSvc();
    await runPipeline({ jobService: svc,
      discover: async () => ({ jobs: [listing('1')], discovery: { rawResults: 2 } }), fetchDetails: okDetail,
      analyze: makeAnalyze([]), analysisTarget: 1, reportProgress: (value) => progress.push(value) });
    ok('progreso cubre discovery/análisis/target', progress.some((p) => p.phase === 'discovery' && p.analysisTarget === 1)
      && progress.some((p) => p.phase === 'analysis' && p.analysisCompleted === 1));

    const discoveryController = new AbortController(); discoveryController.abort(); let discoveryCalled = false;
    let discoveryCancelled = false;
    try { await runPipeline({ jobService: tmpSvc(), signal: discoveryController.signal, discover: async () => { discoveryCalled = true; return { jobs: [] }; } }); }
    catch (error) { discoveryCancelled = error.name === 'HuntCancelledError'; }
    ok('cancel durante discovery no inicia trabajo', discoveryCancelled && !discoveryCalled);

    const analysisController = new AbortController(); const partialSvc = tmpSvc(); let analysisCalls = 0;
    let analysisCancelled = false;
    try {
      await runPipeline({ jobService: partialSvc, signal: analysisController.signal,
        discover: async () => ({ jobs: [listing('1'), listing('2')], discovery: {} }), fetchDetails: okDetail,
        analysisTarget: 2, analyze: async () => {
          analysisCalls += 1;
          if (analysisCalls === 2) analysisController.abort();
          return { analysis: analysisOf(String(analysisCalls)), model: 'test' };
        } });
    } catch (error) { analysisCancelled = error.name === 'HuntCancelledError'; }
    ok('cancel durante analysis conserva resultado parcial', analysisCancelled && partialSvc.getJob('1').analysisStatus === 'completed');
    ok('cancel no deja processing ni inicia más análisis', analysisCalls === 2 && partialSvc.getJob('2').analysisStatus === 'pending');
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run();

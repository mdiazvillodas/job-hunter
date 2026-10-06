'use strict';

// Pipeline end-to-end (Milestone 9):
//   LinkedIn -> Multi Search + Global Dedup -> Details -> OpenAI Analyzer -> LocalRepository
//   [InfoJobs, si esta activado en Configuracion] -> mismo pipeline, despues de LinkedIn
// Un solo comando: npm run hunt  (real).  npm run hunt -- --debug   npm run hunt -- --dry-run
//
// Reutiliza la arquitectura existente. La UI (npm run ui) ve automaticamente lo persistido.

const config = require('./config');
const { collectJobDetails } = require('./linkedin/detailCollector');
const { SecurityChallengeError } = require('./linkedin/errors');
const { collectMultipleSearches } = require('./linkedin/multiSearch');
const { assertAuthenticatedSession } = require('./linkedin/session');
const { createLocalRepository } = require('./data/jobRepository');
const { createJobService } = require('./services/jobService');
const { getMatchingProfile } = require('./ai/marianoProfile');
const { analyzeJob } = require('./ai/jobAnalyzer');
const { runPipeline } = require('./pipeline/pipeline');
const { acquireLock, releaseLock } = require('./domain/huntLock');
const { OPERATION_TYPES, createOwner, newOperationId } = require('./domain/operationOwner');
const { getUserConfig, getNotificationSettings } = require('./config/userConfig');
const { createHighMatchNotifier } = require('./notifications/ntfy');
const { combineSummaries } = require('./pipeline/combineSummaries');
const { isCancellation } = require('./pipeline/pipeline');
const { isChromeNotFoundError } = require('./infojobs/chromeCheck');

function parseArgs(argv) {
  return { debug: argv.includes('--debug'), dryRun: argv.includes('--dry-run') };
}

// Mock transport para --dry-run (no llama a OpenAI). Analisis valido segun schema.
function mockTransport({ messages }) {
  return Promise.resolve({
    model: (process.env.OPENAI_MODEL || config.OPENAI_MODEL) + ' (MOCK)',
    usage: { prompt_tokens: Math.round(messages.reduce((a, m) => a + m.content.length, 0) / 4), completion_tokens: 200, total_tokens: 0 },
    choices: [{ message: { content: JSON.stringify({
      decision: 'MAYBE', overallMatchScore: 68, professionalFitScore: 72, interestFitScore: 60, cvFitScore: 78,
      roleFamily: 'operations', summary: '[MOCK dry-run] pipeline validation only.',
      whyItFits: ['[MOCK]'], transferableExperience: ['[MOCK]'], literalMatches: [], gaps: ['[MOCK]'],
      criticalRequirementsUnmet: [], redFlags: [], recommendedCV: 'current_cv', cvAdjustments: ['[MOCK]'],
      confidence: 50, reasoning: '[MOCK] no OpenAI call was made.',
      requirementAssessments: [{ requirement: '[MOCK]', classification: 'TRANSFERABLE_MATCH', note: '[MOCK]' }],
      coreCapabilityCoverage: [{ capability: '[MOCK]', rating: 'MODERATE', note: '[MOCK]' }],
    }) } }],
  });
}

function printDebugReport(s) {
  const L = (x) => console.error(x);
  L('\n========================================');
  L('JOB HUNTER RUN');
  L('========================================');
  L(`runId: ${s.runId} | stoppedByChallenge: ${s.stoppedByChallenge}`);
  L('\nDiscovery:');
  L(`  queries executed: ${s.discovery.queriesExecuted}`);
  L(`  raw jobs:         ${s.discovery.rawResults}`);
  L(`  unique jobs:      ${s.discovery.uniqueResults}`);
  L(`  duplicates:       ${s.discovery.duplicatesRemoved}`);
  L(`  new jobs:         ${s.discovery.newJobs}`);
  L(`  existing jobs:    ${s.discovery.existingJobs}`);
  L('\nAnalysis:');
  L(`  requiring analysis: ${s.analysis.requiringAnalysis}`);
  L(`  already analyzed:   ${s.analysis.alreadyAnalyzed}`);
  L(`  processed:          ${s.analysis.processed}`);
  L(`  analyzed:           ${s.analysis.analyzed}`);
  L(`  failed:             ${s.analysis.failed}`);
  L(`  skipped:            ${s.analysis.skipped}`);
  L(`  analysis enabled:   ${s.analysis.analysisEnabled}`);
  L('\nPersistence:');
  L(`  created:   ${s.persistence.created}`);
  L(`  updated:   ${s.persistence.updated}`);
  L(`  unchanged: ${s.persistence.unchanged}`);
  L('\nUsage:');
  L(`  input tokens:  ${s.usageTotals.promptTokens}`);
  L(`  output tokens: ${s.usageTotals.completionTokens}`);
  L(`  cached tokens: ${s.usageTotals.cachedTokens}`);
  L(`  total tokens:  ${s.usageTotals.totalTokens}`);
  L(`  model:         ${s.usageTotals.model || '—'}`);
  L('\nDuration (ms):');
  L(`  discovery: ${s.durations.discoveryMs}`);
  L(`  details:   ${s.durations.detailsMs}`);
  L(`  analysis:  ${s.durations.analysisMs}`);
  L(`  total:     ${s.durations.totalMs}`);
  L('\nFinal:');
  L(`  NEW JOBS:     ${s.discovery.newJobs}`);
  L(`  ANALYZED:     ${s.analysis.analyzed}`);
  L(`  FAILED:       ${s.analysis.failed}`);
  L(`  SKIPPED:      ${s.analysis.skipped}`);
  L(`  TOTAL UNIQUE: ${s.discovery.uniqueResults}`);
  L('========================================\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Lock compartido: impide dos operaciones simultaneas (hunt manual, trigger,
  // ventana manual, herramientas CLI) sobre el perfil persistente. El dueño se
  // fija aqui y es el mismo que se usa para liberar en el finally.
  const owner = createOwner(OPERATION_TYPES.HUNT, newOperationId('hunt_cli'));
  try {
    acquireLock(undefined, { owner });
  } catch (e) {
    if (e.code === 'LOCK_HELD') {
      console.error(
        `hunt_already_running: ya hay un hunt activo (pid ${e.info && e.info.pid}, desde ${e.info && e.info.startedAt}). No se inicia otro.`
      );
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  try {
    const summary = await runHunt(options);
    if (options.debug) printDebugReport(summary);
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    if (err instanceof SecurityChallengeError) {
      console.error(err.message);
      console.error('Pipeline detenido por un desafio de seguridad de LinkedIn. No se intenta evadir.');
    } else {
      console.error('Error en el pipeline: ' + (err.message || err));
    }
    console.error('Los jobs ya persistidos se conservan en el LocalRepository.');
    process.exitCode = 1;
  } finally {
    releaseLock(undefined, { owner });
  }
}

function getExecutionConfig() {
  return {
    BROWSER_PROFILE_DIR: config.BROWSER_PROFILE_DIR,
    LINKEDIN_FILTERS: config.LINKEDIN_FILTERS,
    ANALYZE_LIMIT: config.ANALYZE_LIMIT,
    TARGET_ANALYZED_JOBS: config.TARGET_ANALYZED_JOBS,
    CANDIDATE_NAME: config.CANDIDATE_NAME,
    MAX_PAGES_PER_SEARCH: config.MAX_PAGES_PER_SEARCH,
    MAX_RESULTS_PER_SEARCH: config.MAX_RESULTS_PER_SEARCH,
    activeQueries: config.getActiveSearchQueries(),
    // InfoJobs: apagado salvo que el usuario lo active en Configuracion.
    INFOJOBS: config.INFOJOBS_ENABLED
      ? { enabled: true, profileDir: config.INFOJOBS_BROWSER_PROFILE_DIR, filters: config.INFOJOBS_FILTERS }
      : { enabled: false },
  };
}

// Mensaje para el summary, la UI y la notificacion de cierre. Los errores de
// arranque del navegador tienen su propio texto para que se sepa que hacer.
function infoJobsErrorMessage(error) {
  const code = error && error.code;
  if (code === 'INFOJOBS_LAUNCHER_MISSING') return 'Falta el launcher de InfoJobs (src/infojobs/browser.js).';
  if (code === 'INFOJOBS_CHROME_MISSING') return 'InfoJobs necesita Google Chrome instalado en esta PC.';
  return 'La búsqueda en InfoJobs no pudo completarse.';
}

// Pipeline de InfoJobs. Corre DESPUES de LinkedIn, con su propio navegador y
// perfil, y queda aislado: un CAPTCHA o un error de InfoJobs se informa en el
// summary pero no convierte el hunt en fallido ni pierde lo de LinkedIn. Solo
// la cancelacion del usuario se propaga.
// Devuelve { summary } o { error, challenge }.
async function runInfoJobsHunt(deps) {
  const { options, infojobs, activeQueries, analyze, jobService, notify, stage, reportProgress,
    ANALYZE_LIMIT, TARGET_ANALYZED_JOBS, MAX_PAGES_PER_SEARCH, MAX_RESULTS_PER_SEARCH } = deps;
  // src/infojobs/browser.js solo tiene que exportar launchInfoJobsBrowser; si no
  // trae getInitialPage se usa el de LinkedIn (misma logica para cualquier context).
  const browserModule = deps.browser || require('./infojobs/browser');
  const launchInfoJobsBrowser = browserModule.launchInfoJobsBrowser;
  const getInitialPage = browserModule.getInitialPage || require('./linkedin/browser').getInitialPage;
  const { collectInfoJobsSearches } = deps.collector || require('./infojobs/collector');
  const { fetchInfoJobsDetail } = deps.detail || require('./infojobs/detail');
  const say = options.debug ? (m) => console.error('[hunt:infojobs] ' + m) : null;

  let context = null;
  try {
    stage('collector_launch');
    if (options.signal && options.signal.aborted) { const error = new Error('Hunt cancelled.'); error.name = 'HuntCancelledError'; throw error; }
    if (typeof launchInfoJobsBrowser !== 'function') {
      const error = new Error('src/infojobs/browser.js no exporta launchInfoJobsBrowser.');
      error.code = 'INFOJOBS_LAUNCHER_MISSING';
      throw error;
    }
    try {
      context = await launchInfoJobsBrowser(infojobs.profileDir);
    } catch (error) {
      if (isChromeNotFoundError(error)) error.code = 'INFOJOBS_CHROME_MISSING';
      throw error;
    }
    const page = await getInitialPage(context);
    const summary = await runPipeline({
      jobService,
      discover: async () => {
        stage('discovery');
        const scope = await collectInfoJobsSearches(page, activeQueries, infojobs.filters, {
          debug: options.debug,
          maxResultsPerSearch: MAX_RESULTS_PER_SEARCH,
          maxPagesPerSearch: MAX_PAGES_PER_SEARCH,
          signal: options.signal,
          reportProgress,
        });
        return {
          jobs: scope.jobs,
          discovery: {
            queriesExecuted: scope.metadata.searches.completed,
            rawResults: scope.metadata.results.rawResults,
            duplicatesRemoved: scope.metadata.results.duplicatesRemoved,
            perQuery: scope.perQuery,
          },
        };
      },
      fetchDetails: async (job) => {
        stage('detail_collection');
        // Pausa variable entre ofertas: ritmo de lectura de una persona.
        return fetchInfoJobsDetail(page, job, { pauseMs: 1000 + Math.floor(Math.random() * 1500) });
      },
      analyze: analyze && (async (job) => { stage('analysis'); return analyze(job); }),
      analyzeLimit: ANALYZE_LIMIT,
      analysisTarget: TARGET_ANALYZED_JOBS,
      targetQueries: activeQueries.map((q) => q.query),
      notify,
      signal: options.signal,
      reportProgress,
      log: say,
    });
    return { summary };
  } catch (error) {
    if (isCancellation(error) || (options.signal && options.signal.aborted)) throw error;
    const challenge = error && error.name === 'SecurityChallengeError';
    console.error('[InfoJobs] ' + (challenge
      ? 'Detenido por un CAPTCHA o bloqueo de InfoJobs. No se intenta evadir.'
      : 'Error en el pipeline: ' + (error && error.message ? error.message : error)));
    return {
      challenge: challenge ? (error.challengeDiagnostic || { source: 'unknown', signal: 'unknown' }) : null,
      error: challenge ? 'InfoJobs presentó un CAPTCHA o bloqueo.' : infoJobsErrorMessage(error),
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

// Con InfoJobs activo el progreso es UNO solo para todo el hunt: lo que reporta
// InfoJobs se suma a lo que ya hizo LinkedIn y el objetivo es el de ambas.
const CUMULATIVE_PROGRESS = ['rawJobsDiscovered', 'uniqueJobsDiscovered', 'jobsPersisted', 'analysisAttempted', 'analysisCompleted', 'analysisFailed', 'searchesCompleted', 'searchesTotal'];
function createProgressTracker(reportProgress, totalTarget) {
  let offset = {};
  let last = {};
  return {
    report: (next) => {
      if (!next || typeof next !== 'object') return;
      const merged = { ...next, analysisTarget: totalTarget };
      for (const key of CUMULATIVE_PROGRESS) {
        if (Number.isFinite(next[key])) {
          last[key] = next[key];
          merged[key] = next[key] + (offset[key] || 0);
        }
      }
      reportProgress(merged);
    },
    // Lo hecho hasta ahora pasa a ser la base de la siguiente plataforma.
    advance: () => {
      for (const key of CUMULATIVE_PROGRESS) offset[key] = (offset[key] || 0) + (last[key] || 0);
      last = {};
    },
  };
}

async function runHunt(options = {}, executionConfig = getExecutionConfig()) {
  const reportStage = typeof options.reportStage === 'function' ? options.reportStage : () => {};
  let currentStage = 'collector_launch';
  const stage = (name) => { currentStage = name; reportStage(name); };
  const { getInitialPage, launchLinkedInBrowser } = require('./linkedin/browser');
  const { BROWSER_PROFILE_DIR, LINKEDIN_FILTERS, ANALYZE_LIMIT, TARGET_ANALYZED_JOBS = 20, CANDIDATE_NAME, MAX_PAGES_PER_SEARCH, MAX_RESULTS_PER_SEARCH, activeQueries } = executionConfig;
  const infojobs = executionConfig.INFOJOBS && executionConfig.INFOJOBS.enabled ? executionConfig.INFOJOBS : null;
  const rawReportProgress = typeof options.reportProgress === 'function' ? options.reportProgress : () => {};
  // Cada plataforma tiene su propio cupo de analisis: una no le quita a la otra.
  const totalTarget = infojobs ? TARGET_ANALYZED_JOBS * 2 : TARGET_ANALYZED_JOBS;
  const progressTracker = infojobs ? createProgressTracker(rawReportProgress, totalTarget) : null;
  const reportProgress = progressTracker ? progressTracker.report : rawReportProgress;
  if (options.signal && options.signal.aborted) { const error = new Error('Hunt cancelled.'); error.name = 'HuntCancelledError'; throw error; }
  const repository = createLocalRepository();
  const jobService = createJobService(repository);

  const matchingProfile = getMatchingProfile();
  reportProgress({ phase: 'starting', searchesTotal: activeQueries.length, analysisTarget: totalTarget });

  // Decidir el modo de analisis.
  let analyze = null;
  if (options.dryRun) {
    analyze = (job) => analyzeJob(matchingProfile, job, { transport: mockTransport, candidateName: CANDIDATE_NAME, signal: options.signal });
    console.error('MODO --dry-run: no se llamara a OpenAI (mock).');
  } else if (process.env.OPENAI_API_KEY) {
    analyze = (job) => analyzeJob(matchingProfile, job, { candidateName: CANDIDATE_NAME, signal: options.signal }); // REAL
  } else {
    console.error('AVISO: OPENAI_API_KEY ausente. Se hara discovery + detail + persistencia,');
    console.error('       pero el analisis de OpenAI queda pendiente (jobs en analysisStatus=pending).');
  }

  stage('collector_launch');
  if (options.signal && options.signal.aborted) { const error = new Error('Hunt cancelled.'); error.name = 'HuntCancelledError'; throw error; }
  const context = await launchLinkedInBrowser(BROWSER_PROFILE_DIR);
  let searchResultsUrl = null;
  let failedStage = null;
  try {
    const page = await getInitialPage(context);
    stage('auth_assertion');
    await assertAuthenticatedSession(context, page);

    const discover = async () => {
      stage('discovery');
      const scope = await collectMultipleSearches(page, activeQueries, LINKEDIN_FILTERS, {
        debug: options.debug,
        maxResultsPerSearch: MAX_RESULTS_PER_SEARCH,
        maxPagesPerSearch: MAX_PAGES_PER_SEARCH,
        signal: options.signal,
        reportProgress,
      });
      searchResultsUrl = page.url();
      return {
        jobs: scope.jobs,
        discovery: {
          queriesExecuted: scope.metadata.searches.completed,
          rawResults: scope.metadata.results.rawResults,
          duplicatesRemoved: scope.metadata.results.duplicatesRemoved,
          // Desenlace de CADA query intentada. Sin esto, un hunt lanzado por
          // API solo deja "9 de 14" y no dice cuales fallaron ni por que.
          perQuery: scope.perQuery,
        },
      };
    };

    const fetchDetails = async (job) => {
      stage('detail_collection');
      if (options.signal && options.signal.aborted) { const error = new Error('Hunt cancelled.'); error.name = 'HuntCancelledError'; throw error; }
      const r = await collectJobDetails(page, [job], { limit: 1, searchResultsUrl, debug: options.debug });
      if (!r.details.length) throw new Error('no detail extracted');
      return r.details[0];
    };

    const analyzeWithStage = analyze && (async (job) => {
      stage('analysis');
      return analyze(job);
    });
    const persistenceMethods = new Set([
      'ingestDiscovery', 'updateDiscovery', 'applyAnalysisProcessing',
      'applyAnalysisResult', 'applyAnalysisFailure',
    ]);
    const stagedJobService = new Proxy(jobService, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (!persistenceMethods.has(property) || typeof value !== 'function') return value;
        return (...args) => { stage('persistence'); return value.apply(target, args); };
      },
    });

    // Notificador push. Si el usuario no lo activo devuelve {status:'disabled'}
    // por job y el hunt sigue igual. Nunca rechaza.
    const notifier = createHighMatchNotifier({
      settings: getNotificationSettings(getUserConfig()),
      markNotified: (jobId) => stagedJobService.markHighMatchNotified(jobId),
      log: (m) => console.error('[notify] ' + m),
    });
    if (notifier.config.enabled && notifier.config.configError) {
      console.error('[notify] notificaciones activadas pero mal configuradas: ' + notifier.config.configError);
    }

    const linkedinSummary = await runPipeline({
      jobService: stagedJobService,
      discover,
      fetchDetails,
      analyze: analyzeWithStage,
      analyzeLimit: ANALYZE_LIMIT,
      analysisTarget: TARGET_ANALYZED_JOBS,
      // Vocabulario del dominio del usuario: ordena los candidatos antes de
      // gastar el presupuesto de analisis. Sale de SU configuracion, no de una
      // lista global.
      targetQueries: activeQueries.map((q) => q.query),
      notify: (job) => notifier.notifyHighMatch(job),
      signal: options.signal,
      reportProgress,
      log: options.debug ? (m) => console.error('[hunt] ' + m) : null,
    });
    if (!infojobs) return linkedinSummary;

    // LinkedIn ya termino: su navegador se cierra antes de abrir el de InfoJobs.
    await context.close().catch(() => {});
    progressTracker.advance();
    const infojobsResult = await runInfoJobsHunt({
      options, infojobs, activeQueries, analyze, jobService: stagedJobService,
      notify: (job) => notifier.notifyHighMatch(job),
      stage, reportProgress,
      ANALYZE_LIMIT, TARGET_ANALYZED_JOBS, MAX_PAGES_PER_SEARCH, MAX_RESULTS_PER_SEARCH,
    });
    return combineSummaries(linkedinSummary, infojobsResult);
  } catch (error) {
    failedStage = currentStage;
    throw error;
  } finally {
    stage('cleanup');
    await context.close().catch(() => {});
    if (failedStage) reportStage(failedStage);
  }
}

function runCli(entry = main) {
  return Promise.resolve()
    .then(() => entry())
    .catch(() => {
      console.error('Error fatal inesperado al ejecutar Job Hunter.');
      process.exitCode = 1;
    });
}

if (require.main === module) runCli();

module.exports = { main, runHunt, runCli, getExecutionConfig, runInfoJobsHunt, createProgressTracker };

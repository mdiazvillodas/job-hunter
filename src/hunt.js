'use strict';

// Pipeline end-to-end (Milestone 9), por plataforma (LinkedIn, InfoJobs):
//   Plataforma -> Multi Search + Global Dedup -> Details -> OpenAI Analyzer -> LocalRepository
// Un solo comando: npm run hunt  (real).  npm run hunt -- --debug   npm run hunt -- --dry-run
// Solo una plataforma: npm run hunt -- --source=infojobs   (o SOURCES=linkedin en el entorno)
//
// Reutiliza la arquitectura existente. La UI (npm run ui) ve automaticamente lo persistido.

// Carga el .env local antes que cualquier modulo que lea process.env (config.js
// toma su snapshot al requerirse). El entorno del proceso tiene precedencia.
require('./env').loadProjectEnv();

const {
  BROWSER_PROFILE_DIR,
  LINKEDIN_FILTERS,
  INFOJOBS_FILTERS,
  OPENAI_MODEL,
  ANALYZE_LIMIT,
  INFOJOBS_ANALYZE_LIMIT,
  SOURCES: SOURCES_TO_RUN,
  MAX_PAGES_PER_SEARCH,
  MAX_RESULTS_PER_SEARCH,
  getActiveSearchQueries,
} = require('./config');
const { getInitialPage, launchLinkedInBrowser } = require('./linkedin/browser');
const { collectJobDetails } = require('./linkedin/detailCollector');
const { SecurityChallengeError } = require('./linkedin/errors');
const { collectMultipleSearches } = require('./linkedin/multiSearch');
const { assertAuthenticatedSession } = require('./linkedin/session');
const { createLocalRepository } = require('./data/jobRepository');
const { createJobService } = require('./services/jobService');
const { getMarianoMatchingProfile } = require('./ai/marianoProfile');
const { analyzeJob } = require('./ai/jobAnalyzer');
const { runPipeline } = require('./pipeline/pipeline');
const { combineSummaries } = require('./pipeline/combineSummaries');
const { collectInfoJobsSearches } = require('./infojobs/collector');
const { fetchInfoJobsDetail } = require('./infojobs/detail');
const { SOURCES, sourceLabel, parseSources } = require('./domain/sources');
const { acquireLock, releaseLock } = require('./domain/huntLock');
const { createHighMatchNotifier } = require('./notifications/ntfy');
const { createRunOutcomeNotifier } = require('./notifications/runOutcome');

function parseArgs(argv) {
  // --source=infojobs | --source=linkedin,infojobs  (pisa SOURCES del entorno para este run)
  const sourceArg = argv.find((a) => a.startsWith('--source='));
  return {
    debug: argv.includes('--debug'),
    dryRun: argv.includes('--dry-run'),
    sources: sourceArg ? parseSources(sourceArg.slice('--source='.length)) : null,
  };
}

// Mock transport para --dry-run (no llama a OpenAI). Analisis valido segun schema.
function mockTransport({ messages }) {
  return Promise.resolve({
    model: (process.env.OPENAI_MODEL || OPENAI_MODEL) + ' (MOCK)',
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
  for (const [id, src] of Object.entries(s.sources || {})) {
    const d = src.discovery || {};
    const a = src.analysis || {};
    L(`  [${src.label || id}] ${src.status} | unique=${d.uniqueResults ?? '—'} new=${d.newJobs ?? '—'} analyzed=${a.analyzed ?? '—'}${src.error ? ' | error: ' + src.error : ''}`);
  }
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
  L('\nNotifications:');
  L(`  eligible:         ${s.notifications.eligible}`);
  L(`  sent:             ${s.notifications.sent}`);
  L(`  already notified: ${s.notifications.alreadyNotified}`);
  L(`  failed:           ${s.notifications.failed}`);
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

  // Lock compartido: impide dos hunts simultaneos (manual + trigger) sobre ./browser-profile.
  try {
    acquireLock();
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
    await runHunt(options);
  } finally {
    releaseLock();
  }
}

// Construye discover/fetchDetails de UNA plataforma. Cada plataforma usa su propia
// pestaña del mismo navegador (mismo ./browser-profile, misma sesion).
async function buildSourceAdapters(source, context, options) {
  if (source === SOURCES.INFOJOBS) {
    const page = await context.newPage();
    const queries = getActiveSearchQueries(undefined, SOURCES.INFOJOBS);
    return {
      analyzeLimit: INFOJOBS_ANALYZE_LIMIT,
      discover: async () => {
        const scope = await collectInfoJobsSearches(page, queries, INFOJOBS_FILTERS, {
          debug: options.debug,
          maxResultsPerSearch: MAX_RESULTS_PER_SEARCH,
          maxPagesPerSearch: MAX_PAGES_PER_SEARCH,
        });
        return {
          jobs: scope.jobs,
          discovery: {
            queriesExecuted: scope.metadata.searches.completed,
            rawResults: scope.metadata.results.rawResults,
            duplicatesRemoved: scope.metadata.results.duplicatesRemoved,
          },
        };
      },
      // Pausa variable entre ofertas: ritmo de lectura humano.
      fetchDetails: (job) => fetchInfoJobsDetail(page, job, { pauseMs: 1000 + Math.floor(Math.random() * 1500) }),
    };
  }

  // LinkedIn: exactamente el flujo de siempre.
  const page = await getInitialPage(context);
  await assertAuthenticatedSession(context, page);
  const queries = getActiveSearchQueries(undefined, SOURCES.LINKEDIN);
  let searchResultsUrl = null;
  return {
    analyzeLimit: ANALYZE_LIMIT,
    discover: async () => {
      const scope = await collectMultipleSearches(page, queries, LINKEDIN_FILTERS, {
        debug: options.debug,
        maxResultsPerSearch: MAX_RESULTS_PER_SEARCH,
        maxPagesPerSearch: MAX_PAGES_PER_SEARCH,
      });
      searchResultsUrl = page.url();
      return {
        jobs: scope.jobs,
        discovery: {
          queriesExecuted: scope.metadata.searches.completed,
          rawResults: scope.metadata.results.rawResults,
          duplicatesRemoved: scope.metadata.results.duplicatesRemoved,
        },
      };
    },
    fetchDetails: async (job) => {
      const r = await collectJobDetails(page, [job], { limit: 1, searchResultsUrl, debug: options.debug });
      if (!r.details.length) throw new Error('no detail extracted');
      return r.details[0];
    },
  };
}

async function runHunt(options) {
  const repository = createLocalRepository(); // src/data/jobs
  const jobService = createJobService(repository);
  const matchingProfile = getMarianoMatchingProfile();
  const sources = options.sources || SOURCES_TO_RUN;
  const startMs = Date.now();
  const startedAt = new Date().toISOString();

  // Decidir el modo de analisis.
  let analyze = null;
  if (options.dryRun) {
    analyze = (job) => analyzeJob(matchingProfile, job, { transport: mockTransport });
    console.error('MODO --dry-run: no se llamara a OpenAI (mock).');
  } else if (process.env.OPENAI_API_KEY) {
    analyze = (job) => analyzeJob(matchingProfile, job, {}); // REAL
  } else {
    console.error('AVISO: OPENAI_API_KEY ausente. Se hara discovery + detail + persistencia,');
    console.error('       pero el analisis de OpenAI queda pendiente (jobs en analysisStatus=pending).');
  }

  // Notificador push. Si NTFY_ENABLED no es 'true' devuelve {status:'disabled'} por job
  // y el hunt sigue normal. Nunca rechaza.
  const notifier = createHighMatchNotifier({
    markNotified: (jobId) => jobService.markHighMatchNotified(jobId),
    log: (m) => console.error('[notify] ' + m),
  });
  if (notifier.config.enabled && notifier.config.configError) {
    console.error('[notify] ntfy habilitado pero mal configurado: ' + notifier.config.configError);
  }

  // Notificacion de CIERRE del hunt (terminado / interrumpido). Mismo contrato
  // defensivo: nunca rechaza y no cambia el exit code.
  const runNotifier = createRunOutcomeNotifier({
    log: (m) => console.error('[notify] ' + m),
  });

  const context = await launchLinkedInBrowser(BROWSER_PROFILE_DIR);
  const results = [];
  let retentionDone = false;

  // Cada plataforma corre aislada: un challenge o un error en una NO impide la otra.
  for (const source of sources) {
    const label = sourceLabel(source);
    if (options.debug) console.error(`\n######## ${label.toUpperCase()} ########`);
    try {
      const adapters = await buildSourceAdapters(source, context, options);
      const summary = await runPipeline({
        jobService,
        discover: adapters.discover,
        fetchDetails: adapters.fetchDetails,
        analyze,
        analyzeLimit: adapters.analyzeLimit,
        notify: (job) => notifier.notifyHighMatch(job),
        // Retencion: borra ofertas con >= 7 dias en el sistema que nunca se abrieron.
        // Se corre UNA vez por hunt (con la primera plataforma), sobre todo el repositorio.
        // --dry-run la simula (calcula los candidatos pero no borra), igual que hace
        // con el analisis: una corrida de prueba no debe tener efectos destructivos.
        cleanupRetention: retentionDone ? undefined : () => jobService.cleanupExpiredJobs({ dryRun: !!options.dryRun }),
        log: options.debug ? (m) => console.error(`[hunt:${source}] ` + m) : null,
      });
      retentionDone = true;
      results.push({ source, summary });
    } catch (err) {
      const challenge = err instanceof SecurityChallengeError || (err && err.name === 'AuthenticationError');
      console.error(`[${label}] ` + (err.message || err));
      console.error(challenge
        ? `[${label}] Detenido por un desafio de seguridad o de sesion. No se intenta evadir.`
        : `[${label}] Error en el pipeline.`);
      console.error(`[${label}] Los jobs ya persistidos se conservan en el LocalRepository.`);
      results.push({ source, error: err, challenge, challengeDiagnostic: err && err.challengeDiagnostic ? { platform: source, ...err.challengeDiagnostic } : null });
    }
  }

  await context.close().catch(() => {});

  const combined = combineSummaries(results, { startedAt, totalMs: Date.now() - startMs });

  // Ninguna plataforma produjo summary: mismo contrato de siempre (exit 1, sin JSON).
  if (!results.some((r) => r.summary)) {
    const allChallenged = results.length > 0 && results.every((r) => r.challenge);
    await runNotifier.notifyRunOutcome({ challenge: allChallenged, error: results[0] && results[0].error, summary: combined });
    process.exitCode = 1;
    return;
  }

  if (options.debug) printDebugReport(combined);
  // El JSON a stdout es el contrato con el trigger: se emite ANTES de cualquier
  // side effect de red, para que un fallo de ntfy no pueda perder el summary.
  console.log(JSON.stringify(combined, null, 2));

  // stoppedByChallenge NO se anuncia como 'terminado': el notifier lo clasifica
  // como interrumpido. El status del trigger para este run no cambia.
  await runNotifier.notifyRunOutcome({ summary: combined });
}

main();

'use strict';

// Pipeline end-to-end (Milestone 9):
//   LinkedIn -> Multi Search + Global Dedup -> Details -> OpenAI Analyzer -> LocalRepository
// Un solo comando: npm run hunt  (real).  npm run hunt -- --debug   npm run hunt -- --dry-run
//
// Reutiliza la arquitectura existente. La UI (npm run ui) ve automaticamente lo persistido.

const {
  BROWSER_PROFILE_DIR,
  LINKEDIN_FILTERS,
  OPENAI_MODEL,
  ANALYZE_LIMIT,
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
const { acquireLock, releaseLock } = require('./domain/huntLock');

function parseArgs(argv) {
  return { debug: argv.includes('--debug'), dryRun: argv.includes('--dry-run') };
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

async function runHunt(options) {
  const repository = createLocalRepository(); // src/data/jobs
  const jobService = createJobService(repository);

  const activeQueries = getActiveSearchQueries();
  const matchingProfile = getMarianoMatchingProfile();

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

  const context = await launchLinkedInBrowser(BROWSER_PROFILE_DIR);
  let summary;
  let searchResultsUrl = null;
  try {
    const page = await getInitialPage(context);
    await assertAuthenticatedSession(context, page);

    const discover = async () => {
      const scope = await collectMultipleSearches(page, activeQueries, LINKEDIN_FILTERS, {
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
    };

    const fetchDetails = async (job) => {
      const r = await collectJobDetails(page, [job], { limit: 1, searchResultsUrl, debug: options.debug });
      if (!r.details.length) throw new Error('no detail extracted');
      return r.details[0];
    };

    summary = await runPipeline({
      jobService,
      discover,
      fetchDetails,
      analyze,
      analyzeLimit: ANALYZE_LIMIT,
      log: options.debug ? (m) => console.error('[hunt] ' + m) : null,
    });
  } catch (err) {
    if (err instanceof SecurityChallengeError) {
      console.error(err.message);
      console.error('Pipeline detenido por un desafio de seguridad de LinkedIn. No se intenta evadir.');
      console.error('Los jobs ya persistidos se conservan en el LocalRepository.');
      await context.close().catch(() => {});
      process.exitCode = 1;
      return;
    }
    console.error('Error en el pipeline: ' + (err.message || err));
    console.error('Los jobs ya persistidos se conservan en el LocalRepository.');
    await context.close().catch(() => {});
    process.exitCode = 1;
    return;
  }

  await context.close().catch(() => {});

  if (options.debug) printDebugReport(summary);
  console.log(JSON.stringify(summary, null, 2));
}

main();

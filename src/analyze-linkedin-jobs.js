'use strict';

// Prueba de calibracion del OpenAI Job Analyzer (Milestone 6B).
//
// Flujo:
//  1. Ejecuta la busqueda actual con la ubicacion configurada + Full-time + Past week.
//  2. Toma las primeras ANALYZE_LIMIT (default 5) ofertas.
//  3. Abre sus detalles y obtiene la descripcion completa.
//  4. Pasa cada oferta al analyzer (OpenAI) y muestra el resultado estructurado.
//
// No procesa mas de ANALYZE_LIMIT. No modifica el comportamiento default del collector.
//
// Uso:
//   $env:OPENAI_API_KEY="..."; $env:ANALYZE_LIMIT=5; npm run analyze:linkedin -- --debug
//   npm run analyze:linkedin -- --debug --dry-run   (sin API key: usa un mock para validar el pipeline)

const config = require('./config');
const { collectJobDetails } = require('./linkedin/detailCollector');
const { SecurityChallengeError } = require('./linkedin/errors');
const { collectSearchScope } = require('./linkedin/searchScope');
const { assertAuthenticatedSession } = require('./linkedin/session');
const { getProfile, getMatchingProfile } = require('./ai/marianoProfile');
const { analyzeJob, MissingApiKeyError, AnalyzerError } = require('./ai/jobAnalyzer');

function parseArgs(argv) {
  return {
    debug: argv.includes('--debug'),
    dryRun: argv.includes('--dry-run'),
  };
}

// Perfil por defecto: el matching (condensado). USE_MATCHING_PROFILE=false fuerza el completo.
function selectProfile() {
  const useMatching = process.env.USE_MATCHING_PROFILE !== 'false';
  const profile = useMatching ? getMatchingProfile() : getProfile();
  const chars = JSON.stringify(profile).length;
  return { profile, kind: useMatching ? 'matching' : 'full', chars, approxTokens: Math.round(chars / 4) };
}

// Costo: NO se inventan precios. Se calculan solo si estan configurados por entorno
// (USD por 1M tokens): OPENAI_PRICE_INPUT_PER_1M / OPENAI_PRICE_OUTPUT_PER_1M
// (opcional OPENAI_PRICE_CACHED_INPUT_PER_1M para el tramo cacheado del input).
function computeCost(promptTokens, completionTokens, cachedTokens) {
  const inPrice = Number.parseFloat(process.env.OPENAI_PRICE_INPUT_PER_1M);
  const outPrice = Number.parseFloat(process.env.OPENAI_PRICE_OUTPUT_PER_1M);
  const cachedPrice = Number.parseFloat(process.env.OPENAI_PRICE_CACHED_INPUT_PER_1M);
  if (!Number.isFinite(inPrice) || !Number.isFinite(outPrice)) {
    return { available: false, note: 'requiere pricing configurado (OPENAI_PRICE_INPUT_PER_1M / OPENAI_PRICE_OUTPUT_PER_1M)' };
  }
  const cached = Number.isFinite(cachedPrice) ? cachedTokens || 0 : 0;
  const nonCachedInput = Math.max(0, promptTokens - cached);
  const cost =
    (nonCachedInput / 1e6) * inPrice +
    (cached / 1e6) * (Number.isFinite(cachedPrice) ? cachedPrice : inPrice) +
    (completionTokens / 1e6) * outPrice;
  return { available: true, usd: Number(cost.toFixed(6)) };
}

// Transporte mock para --dry-run: NO llama a OpenAI. Produce un analisis valido segun schema,
// derivado de forma heuristica de los datos de la oferta, solo para validar el pipeline y el formato.
function mockTransport({ messages, model }) {
  let job = {};
  try {
    const m = messages[1].content.match(/<job_data>\n([\s\S]*?)\n<\/job_data>/);
    job = m ? JSON.parse(m[1]) : {};
  } catch (e) {
    job = {};
  }
  const title = (job.title || '').toLowerCase();
  const families = Array.isArray(job.matchedFamilies) ? job.matchedFamilies : [];
  const strong = /operations|delivery|business|product|transformation|strategy/.test(title);
  const professional = strong ? 84 : 62;
  const interest = strong ? 78 : 60;
  const cv = 80;
  const overall = Math.round(professional * 0.5 + interest * 0.3 + cv * 0.2);
  const decision = overall >= 75 ? 'YES' : overall >= 60 ? 'MAYBE' : 'NO';

  const analysis = {
    decision,
    overallMatchScore: overall,
    professionalFitScore: professional,
    interestFitScore: interest,
    cvFitScore: cv,
    roleFamily: families[0] || 'operations',
    summary: `[MOCK] Heuristic evaluation for "${job.title || 'unknown role'}" at ${job.company || 'unknown company'}.`,
    whyItFits: strong
      ? ['[MOCK] Title aligns with target role families', '[MOCK] Cross-functional business+tech ownership']
      : ['[MOCK] Some transversal overlap'],
    transferableExperience: ['[MOCK] Scope/effort/budgeting on $1M+ projects', '[MOCK] Led delivery for large-scale clients'],
    literalMatches: strong ? ['[MOCK] Operations/Delivery responsibilities'] : [],
    gaps: ['[MOCK] Verify specific tooling requirements'],
    criticalRequirementsUnmet: [],
    redFlags: [],
    recommendedCV: 'current_cv',
    cvAdjustments: ['[MOCK] Emphasize scaling 20->300 and $1M+ negotiations'],
    confidence: 55,
    reasoning: '[MOCK] This is a dry-run result. No OpenAI call was made. Real results require OPENAI_API_KEY.',
    requirementAssessments: [{ requirement: '[MOCK]', classification: 'TRANSFERABLE_MATCH', note: '[MOCK]' }],
    coreCapabilityCoverage: [{ capability: '[MOCK]', rating: 'MODERATE', note: '[MOCK]' }],
  };

  return Promise.resolve({
    model: `${model} (MOCK)`,
    usage: { prompt_tokens: Math.round(messages.reduce((a, m2) => a + m2.content.length, 0) / 4), completion_tokens: 220, total_tokens: 0 },
    choices: [{ message: { content: JSON.stringify(analysis) } }],
  });
}

function printJobResult(index, totalCount, job, result) {
  const a = result.analysis;
  console.log(`\nJOB ${index}/${totalCount}`);
  console.log(`Title: ${job.title || '(sin titulo)'}`);
  console.log(`Company: ${job.company || '(sin company)'}`);
  console.log(`URL: ${job.url || ''}`);
  console.log(`Decision: ${a.decision}`);
  console.log(`Overall match: ${a.overallMatchScore}`);
  console.log(`Professional fit: ${a.professionalFitScore}`);
  console.log(`Interest fit: ${a.interestFitScore}`);
  console.log(`CV fit: ${a.cvFitScore}`);
  console.log(`Confidence: ${a.confidence}`);
  console.log(`Role family: ${a.roleFamily}`);
  console.log(`Summary: ${a.summary}`);
}

async function collectJobsWithDetails(options, executionConfig) {
  const { getInitialPage, launchLinkedInBrowser } = require('./linkedin/browser');
  const { BROWSER_PROFILE_DIR, LINKEDIN_FILTERS, ANALYZE_LIMIT, activeQueries } = executionConfig;
  const context = await launchLinkedInBrowser(BROWSER_PROFILE_DIR);
  try {
    const page = await getInitialPage(context);
    await assertAuthenticatedSession(context, page);

    const primary = activeQueries[0];

    // Una sola busqueda para la calibracion (rapida y suficiente para 5 ofertas).
    const scope = await collectSearchScope(page, primary.query, LINKEDIN_FILTERS, {
      debug: options.debug,
      maxResults: ANALYZE_LIMIT,
      maxPages: 2,
    });

    const searchResultsUrl = page.url();
    const detailResult = await collectJobDetails(page, scope.jobs, {
      debug: options.debug,
      limit: ANALYZE_LIMIT,
      searchResultsUrl,
    });

    // En una unica busqueda no hay matchedQueries/matchedFamilies globales:
    // se anota la query/familia que efectivamente encontro estas ofertas.
    const jobs = detailResult.details.map((job) => ({
      ...job,
      matchedQueries: job.matchedQueries && job.matchedQueries.length ? job.matchedQueries : [primary.query],
      matchedFamilies: job.matchedFamilies && job.matchedFamilies.length ? job.matchedFamilies : [primary.family],
    }));

    return { jobs, query: primary.query, filtersActive: scope.metadata.filtersActive };
  } finally {
    // El navegador ya no es necesario durante el analisis con OpenAI.
    await context.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const transport = options.dryRun ? mockTransport : undefined;
  const executionConfig = {
    BROWSER_PROFILE_DIR: config.BROWSER_PROFILE_DIR,
    LINKEDIN_FILTERS: config.LINKEDIN_FILTERS,
    OPENAI_MODEL: config.OPENAI_MODEL,
    ANALYZE_LIMIT: config.ANALYZE_LIMIT,
    CANDIDATE_NAME: config.CANDIDATE_NAME,
    activeQueries: config.getActiveSearchQueries(),
  };
  const { LINKEDIN_FILTERS, OPENAI_MODEL, ANALYZE_LIMIT, CANDIDATE_NAME } = executionConfig;

  if (options.dryRun) {
    console.error('MODO --dry-run: no se llamara a OpenAI. Se usa un mock para validar el pipeline.');
  }

  let collected;
  try {
    collected = await collectJobsWithDetails(options, executionConfig);
  } catch (error) {
    if (error instanceof SecurityChallengeError) {
      console.error(error.message);
      console.error('Se detiene la prueba por un desafio de seguridad de LinkedIn. No se intenta evadir.');
      process.exitCode = 1;
      return;
    }
    console.error(`Error obteniendo ofertas del collector: ${error.message || error}`);
    process.exitCode = 1;
    return;
  }

  const jobs = collected.jobs.slice(0, ANALYZE_LIMIT);
  if (!jobs.length) {
    console.error('No se obtuvieron ofertas para analizar.');
    process.exitCode = 1;
    return;
  }

  const selected = selectProfile();
  const profile = selected.profile;
  if (options.debug) {
    console.error(`[debug] profile: ${selected.kind} (~${selected.approxTokens} tokens, ${selected.chars} chars)`);
  }

  const analyses = [];
  const debugEvents = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalCachedTokens = 0;

  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    try {
      const result = await analyzeJob(profile, job, { transport, debug: options.debug, candidateName: CANDIDATE_NAME });
      analyses.push({
        jobId: job.jobId,
        url: job.url,
        title: job.title,
        company: job.company,
        matchedQueries: job.matchedQueries,
        matchedFamilies: job.matchedFamilies,
        model: result.model,
        durationMs: result.durationMs,
        usage: result.usage,
        rawOutput: result.raw,
        analysis: result.analysis,
      });

      if (result.usage) {
        totalPromptTokens += result.usage.prompt_tokens || 0;
        totalCompletionTokens += result.usage.completion_tokens || 0;
        totalTokens += result.usage.total_tokens || 0;
        const cached = result.usage.prompt_tokens_details && result.usage.prompt_tokens_details.cached_tokens;
        totalCachedTokens += cached || 0;
      }

      printJobResult(i + 1, jobs.length, job, result);

      if (options.debug) {
        const dbg = {
          jobId: job.jobId,
          title: job.title,
          company: job.company,
          profile: selected.kind,
          profileApproxTokens: selected.approxTokens,
          model: result.model,
          durationMs: result.durationMs,
          approxInputChars: result.approxInputChars,
          decision: result.analysis.decision,
          scores: {
            overall: result.analysis.overallMatchScore,
            professional: result.analysis.professionalFitScore,
            interest: result.analysis.interestFitScore,
            cv: result.analysis.cvFitScore,
            confidence: result.analysis.confidence,
          },
          usage: result.usage,
        };
        debugEvents.push(dbg);
        console.error(`[debug] ${JSON.stringify(dbg)}`);
      }
    } catch (error) {
      if (error instanceof MissingApiKeyError) {
        console.error(`\n${error.message}`);
        console.error('Sugerencia: definí OPENAI_API_KEY, o ejecutá con --dry-run para validar el pipeline sin OpenAI.');
        process.exitCode = 1;
        return;
      }
      const label = error instanceof AnalyzerError ? 'AnalyzerError' : 'Error';
      console.error(`\n[${label}] jobId=${job.jobId}: ${error.message || error}`);
      analyses.push({ jobId: job.jobId, url: job.url, title: job.title, company: job.company, error: error.message || String(error) });
      if (options.debug) {
        console.error(`[debug] ${JSON.stringify({ jobId: job.jobId, error: error.message || String(error) })}`);
      }
    }
  }

  const cost = computeCost(totalPromptTokens, totalCompletionTokens, totalCachedTokens);
  const analyzedOk = analyses.filter((a) => a.analysis).length;

  const output = {
    query: collected.query,
    filters: {
      location: LINKEDIN_FILTERS.location,
      employmentType: LINKEDIN_FILTERS.employmentType,
      datePosted: LINKEDIN_FILTERS.datePosted,
    },
    model: OPENAI_MODEL,
    profile: selected.kind,
    profileApproxTokens: selected.approxTokens,
    dryRun: Boolean(options.dryRun),
    analyzed: analyses.length,
    usageTotals: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      cachedTokens: totalCachedTokens,
      totalTokens,
      avgPromptTokensPerJob: analyzedOk ? Math.round(totalPromptTokens / analyzedOk) : 0,
      avgCompletionTokensPerJob: analyzedOk ? Math.round(totalCompletionTokens / analyzedOk) : 0,
    },
    cost,
    analyses,
  };

  console.log('\n=== FULL RESULT (JSON) ===');
  console.log(JSON.stringify(output, null, 2));

  printCalibrationReport(output);

  if (options.debug) {
    console.error(
      `\n[debug] resumen: analizadas=${analyzedOk}/${analyses.length} profile=${selected.kind} promptTokens=${totalPromptTokens} completionTokens=${totalCompletionTokens} cachedTokens=${totalCachedTokens} totalTokens=${totalTokens}`
    );
  }
}

function printCalibrationReport(output) {
  console.log('\n=== CALIBRATION REPORT ===');
  console.log(`model: ${output.model} | profile: ${output.profile} (~${output.profileApproxTokens} tokens)`);
  console.log(
    `tokens: input=${output.usageTotals.promptTokens} output=${output.usageTotals.completionTokens} cached=${output.usageTotals.cachedTokens} total=${output.usageTotals.totalTokens}`
  );
  console.log(
    `avg/job: input≈${output.usageTotals.avgPromptTokensPerJob} output≈${output.usageTotals.avgCompletionTokensPerJob}`
  );
  console.log(`cost: ${output.cost.available ? '$' + output.cost.usd + ' USD' : output.cost.note}`);

  const header = '| # | Job | Company | Decision | Overall | Professional | Interest | CV | Confidence |';
  const sep = '|---|-----|---------|----------|---------|--------------|----------|----|-----------|';
  console.log('\n' + header);
  console.log(sep);
  output.analyses.forEach((a, i) => {
    if (!a.analysis) {
      console.log(`| ${i + 1} | ${a.title || ''} | ${a.company || ''} | ERROR | - | - | - | - | - |`);
      return;
    }
    const x = a.analysis;
    const t = (a.title || '').slice(0, 34);
    const c = (a.company || '').slice(0, 20);
    console.log(
      `| ${i + 1} | ${t} | ${c} | ${x.decision} | ${x.overallMatchScore} | ${x.professionalFitScore} | ${x.interestFitScore} | ${x.cvFitScore} | ${x.confidence} |`
    );
  });

  output.analyses.forEach((a, i) => {
    console.log(`\n--- JOB ${i + 1}: ${a.title || ''} @ ${a.company || ''} ---`);
    if (a.error) {
      console.log(`  ERROR: ${a.error}`);
      return;
    }
    const x = a.analysis;
    const fmt = (arr) => (arr && arr.length ? arr.map((s) => `\n    - ${s}`).join('') : ' (none)');
    console.log(`  roleFamily: ${x.roleFamily}`);
    console.log(`  whyItFits:${fmt(x.whyItFits)}`);
    console.log(`  transferableExperience:${fmt(x.transferableExperience)}`);
    console.log(`  gaps:${fmt(x.gaps)}`);
    console.log(`  criticalRequirementsUnmet:${fmt(x.criticalRequirementsUnmet)}`);
    console.log(`  redFlags:${fmt(x.redFlags)}`);
    console.log(`  reasoning: ${x.reasoning}`);
  });
}

if (require.main === module) main();

module.exports = { main, collectJobsWithDetails };

'use strict';

// Collector de InfoJobs con Playwright: el equivalente de src/linkedin/multiSearch.js.
//
// Mismo contrato de salida que collectMultipleSearches, para que hunt.js y el
// pipeline traten igual a las dos plataformas:
//   { metadata: { filters, searches:{total,completed}, results:{rawResults,uniqueResults,duplicatesRemoved} },
//     perQuery: [...], jobs: [{ jobId, source, title, company, location, url, easyApply, matchedQueries, matchedFamilies }] }
//
// Flujo por query: abrir la URL de busqueda con los filtros -> comprobar challenge ->
// scroll para hidratar tarjetas -> extraer -> siguiente pagina (?page=N) hasta los
// mismos limites que LinkedIn (MAX_RESULTS_PER_SEARCH / MAX_PAGES_PER_SEARCH).
// Ante un CAPTCHA se detiene (SecurityChallengeError). No lo resuelve ni lo evade.
// Respeta options.signal (cancelacion del hunt) entre queries y entre paginas.

const { SOURCES } = require('../domain/sources');
const { buildSearchUrl, canonicalOfferUrl, toJobId, verifyFiltersInUrl } = require('./urls');
const { detectInfoJobsChallenge } = require('./challenge');
const { extractSearchCardsDom } = require('./extract');
const { CHALLENGE_STAGES } = require('../linkedin/challengeSignals');
const { throwIfCancelled } = require('../pipeline/pipeline');

const COOKIE_BUTTONS = [
  '#didomi-notice-agree-button',
  'button#onetrust-accept-btn-handler',
  'button:has-text("Aceptar y cerrar")',
  'button:has-text("Aceptar todo")',
];

function log(debug, line) {
  if (debug) console.error(line);
}

// Pausa con algo de variacion entre navegaciones: ritmo de una persona, no de un bot.
function politePause(page, options = {}) {
  const min = Number.isFinite(options.minDelayMs) ? options.minDelayMs : 1500;
  const max = Number.isFinite(options.maxDelayMs) ? options.maxDelayMs : 3500;
  return page.waitForTimeout(min + Math.floor(Math.random() * Math.max(0, max - min)));
}

async function dismissCookieBanner(page) {
  for (const selector of COOKIE_BUTTONS) {
    const button = page.locator(selector).first();
    if (await button.isVisible({ timeout: 800 }).catch(() => false)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(500);
      return true;
    }
  }
  return false;
}

async function hydrateResults(page) {
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, 1400).catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

async function openSearchPage(page, query, filters, pageNumber, options) {
  await page.goto(buildSearchUrl(query, filters, pageNumber), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await detectInfoJobsChallenge(page, { stage: CHALLENGE_STAGES.DISCOVERY });
  if (!options.cookiesHandled) options.cookiesHandled = await dismissCookieBanner(page);
  await hydrateResults(page);
  await detectInfoJobsChallenge(page, { stage: CHALLENGE_STAGES.DISCOVERY });
}

// Recorre la paginacion de UNA query. Devuelve jobs unicos de la query + metadata.
async function collectQuery(page, query, filters, options = {}) {
  const maxResults = options.maxResults > 0 ? options.maxResults : null;
  const maxPages = options.maxPages > 0 ? options.maxPages : null;
  const unique = new Map();
  let rawResults = 0;
  let pagesVisited = 0;
  let skippedPartTime = 0;
  let stopReason = null;
  let filtersActive = null;

  for (let pageNumber = 1; ; pageNumber += 1) {
    throwIfCancelled(options.signal);
    if (pageNumber > 1) await politePause(page, options);
    await openSearchPage(page, query, filters, pageNumber, options);
    pagesVisited += 1;
    if (!filtersActive) filtersActive = verifyFiltersInUrl(page.url(), filters);

    const extracted = await page.evaluate(extractSearchCardsDom);
    rawResults += extracted.jobs.length;

    let newIds = 0;
    for (const card of extracted.jobs) {
      const jobId = toJobId(card.offerId);
      if (!jobId || unique.has(jobId)) continue;
      // Mismo filtro que LinkedIn (Full-time): una tarjeta que dice jornada parcial no entra.
      if (card.partTime && /full-time/i.test(filters.employmentType || '')) {
        skippedPartTime += 1;
        continue;
      }
      if (maxResults && unique.size >= maxResults) break;
      unique.set(jobId, {
        jobId,
        source: SOURCES.INFOJOBS,
        title: card.title,
        company: card.company,
        location: card.location,
        workplaceType: card.workplaceType || null,
        url: canonicalOfferUrl(card.href),
        easyApply: null, // concepto de LinkedIn: en InfoJobs no existe.
      });
      newIds += 1;
    }

    if (typeof options.onPageProcessed === 'function') {
      options.onPageProcessed({ page: pageNumber, detectedResults: extracted.jobs.length, newJobIds: newIds, accumulatedUnique: unique.size });
    }

    if (maxResults && unique.size >= maxResults) { stopReason = 'max_results_reached'; break; }
    if (maxPages && pagesVisited >= maxPages) { stopReason = 'max_pages_reached'; break; }
    // Sin tarjetas o sin ninguna oferta nueva: se acabaron los resultados (InfoJobs
    // repite la ultima pagina si se pide una que no existe).
    if (!extracted.jobs.length) { stopReason = pageNumber === 1 ? 'no_results' : 'no_next_page'; break; }
    if (!newIds) { stopReason = 'no_new_results'; break; }
  }

  return {
    jobs: Array.from(unique.values()),
    metadata: { query, pagesVisited, rawResults, uniqueResults: unique.size, skippedPartTime, stopReason, filtersActive },
  };
}

function mergeJob(globalMap, job, query, family) {
  if (!globalMap.has(job.jobId)) {
    globalMap.set(job.jobId, { ...job, matchedQueries: new Set(), matchedFamilies: new Set() });
  }
  const record = globalMap.get(job.jobId);
  record.matchedQueries.add(query);
  record.matchedFamilies.add(family);
  for (const field of ['title', 'company', 'location', 'workplaceType', 'url']) {
    if (!record[field] && job[field]) record[field] = job[field];
  }
}

async function collectInfoJobsSearches(page, activeQueries, filters, options = {}) {
  const debug = Boolean(options.debug);
  const globalMap = new Map();
  const perQuery = [];
  const scopeOptions = {
    maxResults: options.maxResultsPerSearch,
    maxPages: options.maxPagesPerSearch,
    minDelayMs: options.minDelayMs,
    maxDelayMs: options.maxDelayMs,
    cookiesHandled: false,
    signal: options.signal,
  };
  const reportProgress = typeof options.reportProgress === 'function' ? options.reportProgress : () => {};
  let rawResults = 0;
  let completed = 0;

  for (let i = 0; i < activeQueries.length; i += 1) {
    const { query, family } = activeQueries[i];
    throwIfCancelled(options.signal);
    log(debug, `\n=== INFOJOBS QUERY ${i + 1}/${activeQueries.length} ===\n${query}  [familia: ${family}]`);
    reportProgress({ phase: 'discovery', currentQueryIndex: i, currentQueryLabel: query, searchesTotal: activeQueries.length, searchesCompleted: completed });
    if (i > 0) await politePause(page, scopeOptions);

    const result = await collectQuery(page, query, filters, {
      ...scopeOptions,
      onPageProcessed: (info) => log(debug, `Pagina ${info.page}: resultados=${info.detectedResults} nuevos=${info.newJobIds} acumulado=${info.accumulatedUnique}`),
    });
    scopeOptions.cookiesHandled = true;

    for (const job of result.jobs) {
      rawResults += 1;
      mergeJob(globalMap, job, query, family);
    }
    perQuery.push({ family, status: 'completed', uniqueContribution: result.jobs.length, ...result.metadata });
    completed += 1;
    reportProgress({ phase: 'discovery', searchesTotal: activeQueries.length, searchesCompleted: completed });
    log(debug, `-- done: unique=${result.metadata.uniqueResults} pages=${result.metadata.pagesVisited} stop=${result.metadata.stopReason}`);
  }

  const jobs = Array.from(globalMap.values()).map((r) => ({
    ...r,
    matchedQueries: Array.from(r.matchedQueries),
    matchedFamilies: Array.from(r.matchedFamilies),
  }));

  return {
    metadata: {
      filters: { location: filters.location, employmentType: filters.employmentType, datePosted: filters.datePosted },
      searches: { total: activeQueries.length, completed },
      results: { rawResults, uniqueResults: jobs.length, duplicatesRemoved: rawResults - jobs.length },
    },
    perQuery,
    jobs,
  };
}

module.exports = {
  collectInfoJobsSearches,
  collectQuery,
  dismissCookieBanner,
};

const {
  initializeSearchWithFilters,
  changeSearchQuery,
  collectCurrentSearch,
} = require('./searchScope');

// Campos de la tarjeta que conservamos y que, si faltan en una busqueda,
// intentamos completar desde otra busqueda que si los tenga.
const CARD_FIELDS = ['title', 'company', 'location', 'url', 'easyApply'];

function log(debug, line) {
  if (debug) console.error(line);
}

function fmtDuration(ms) {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}m ${s}s`;
}

// Fusiona un job en el mapa global deduplicando por jobId (fallback url).
// No pierde de que query/familia vino: acumula matchedQueries y matchedFamilies.
function mergeJob(globalMap, job, query, family) {
  const key = job.jobId || job.url;
  if (!key) return;

  if (!globalMap.has(key)) {
    globalMap.set(key, {
      jobId: job.jobId,
      title: job.title,
      company: job.company,
      location: job.location,
      url: job.url,
      easyApply: job.easyApply,
      matchedQueries: new Set(),
      matchedFamilies: new Set(),
    });
  }

  const record = globalMap.get(key);
  record.matchedQueries.add(query);
  record.matchedFamilies.add(family);

  for (const field of CARD_FIELDS) {
    const current = record[field];
    if ((current === null || current === undefined || current === '') && job[field] != null) {
      record[field] = job[field];
    }
  }
}

async function collectMultipleSearches(page, activeQueries, filters, options = {}) {
  const debug = Boolean(options.debug);
  const globalMap = new Map();
  const perQuery = [];
  let rawResults = 0;
  let completed = 0;

  const total = activeQueries.length;
  const runStart = Date.now();
  const scopeOptions = {
    debug,
    maxResults: options.maxResultsPerSearch,
    maxPages: options.maxPagesPerSearch,
  };

  for (let i = 0; i < activeQueries.length; i += 1) {
    const { query, family } = activeQueries[i];
    const queryStart = Date.now();

    log(debug, `\n=== QUERY ${i + 1}/${total} ===`);
    log(debug, `${query}  [familia: ${family}]`);
    log(debug, '');

    // --- Fase 1: preparar la busqueda ---
    let filtersInitMs = 0;
    let searchExecutionMs = 0;

    if (i === 0) {
      // Los filtros se aplican UNA sola vez, en la primera query.
      const t0 = Date.now();
      await initializeSearchWithFilters(page, query, filters, scopeOptions);
      filtersInitMs = Date.now() - t0;
      log(debug, `Filters initialization: ${fmtDuration(filtersInitMs)}`);
      log(debug, `Search execution: included in init`);
    } else {
      // Solo se cambia el keyword; los filtros activos se reutilizan.
      const t0 = Date.now();
      let changed = await changeSearchQuery(page, query, scopeOptions);
      if (!changed) {
        // Un reintento antes de arriesgar heredar el keyword anterior.
        changed = await changeSearchQuery(page, query, scopeOptions);
      }
      searchExecutionMs = Date.now() - t0;
      log(debug, `Filters initialization: reused`);
      log(debug, `Search execution: ${fmtDuration(searchExecutionMs)}${changed ? '' : ' (WARN: keyword no confirmado)'}`);

      if (!changed) {
        // No se pudo confirmar el nuevo keyword: no recolectamos para no heredar resultados.
        perQuery.push({
          query,
          family,
          rawResults: 0,
          uniqueResults: 0,
          pagesVisited: 0,
          stopReason: 'query_change_failed',
          filtersActive: null,
        });
        log(debug, `Pagination: skipped`);
        log(debug, `Total query duration: ${fmtDuration(Date.now() - queryStart)}`);
        continue;
      }
    }

    // --- Fase 2: paginacion + extraccion (reutiliza Search Scope) ---
    const onPageProcessed = (info) => {
      log(debug, `\nPagina ${info.page}`);
      log(debug, `- resultados: ${info.detectedResults}`);
      log(debug, `- nuevos jobs: ${info.newJobIds}`);
      log(debug, `- acumulado (query): ${info.accumulatedUnique}`);
      log(debug, `- next: ${info.nextFound ? 'si' : 'no'}`);
    };

    const paginationStart = Date.now();
    const scope = await collectCurrentSearch(page, query, filters, {
      ...scopeOptions,
      onPageProcessed,
    });
    const paginationMs = Date.now() - paginationStart;

    for (const job of scope.jobs) {
      rawResults += 1;
      mergeJob(globalMap, job, query, family);
    }

    perQuery.push({
      query,
      family,
      rawResults: scope.metadata.rawResults,
      uniqueResults: scope.metadata.uniqueResults,
      pagesVisited: scope.metadata.pagesVisited,
      stopReason: scope.metadata.stopReason,
      filtersActive: scope.metadata.filtersActive,
    });
    completed += 1;

    log(debug, `\nPagination: ${fmtDuration(paginationMs)}`);
    log(debug, `Total query duration: ${fmtDuration(Date.now() - queryStart)}`);
    log(
      debug,
      `-- query ${i + 1}/${total} done: raw=${scope.metadata.rawResults} unique=${scope.metadata.uniqueResults} pages=${scope.metadata.pagesVisited} stop=${scope.metadata.stopReason}`
    );
  }

  const totalDurationMs = Date.now() - runStart;

  const jobs = Array.from(globalMap.values()).map((record) => ({
    jobId: record.jobId,
    title: record.title,
    company: record.company,
    location: record.location,
    url: record.url,
    easyApply: record.easyApply,
    matchedQueries: Array.from(record.matchedQueries),
    matchedFamilies: Array.from(record.matchedFamilies),
  }));

  const uniqueResults = jobs.length;
  const duplicatesRemoved = rawResults - uniqueResults;

  if (debug) {
    log(debug, '\nSEARCH SUMMARY');
    log(debug, '----------------------------');
    log(debug, `Queries executed: ${completed}/${total}`);
    log(debug, `Raw results: ${rawResults}`);
    log(debug, `Unique jobs: ${uniqueResults}`);
    log(debug, `Duplicates removed: ${duplicatesRemoved}`);
    log(debug, `Total duration: ${fmtDuration(totalDurationMs)}`);
    log(debug, '----------------------------');
    for (const s of perQuery) {
      log(
        debug,
        `- ${s.query} [${s.family}] :: raw=${s.rawResults} unique=${s.uniqueResults} pages=${s.pagesVisited} stop=${s.stopReason}`
      );
    }
  }

  return {
    metadata: {
      filters: {
        location: filters.location,
        employmentType: filters.employmentType,
        datePosted: filters.datePosted,
      },
      searches: { total, completed },
      results: { rawResults, uniqueResults, duplicatesRemoved },
    },
    perQuery,
    jobs,
  };
}

module.exports = {
  collectMultipleSearches,
};

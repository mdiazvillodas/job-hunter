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

function throwIfCancelled(signal) {
  if (!signal || !signal.aborted) return;
  const error = new Error('Hunt cancelled.');
  error.name = 'HuntCancelledError';
  throw error;
}

// Desenlace de CADA query intentada. Se registra siempre, tambien cuando la
// query no llego a ejecutarse: "9 de 14" sin decir cuales ni por que no es un
// diagnostico, y era lo unico que sobrevivia fuera del log de debug.
const QUERY_STATUS = Object.freeze({
  COMPLETED: 'completed',
  CHANGE_FAILED: 'query_change_failed',
  CHALLENGE: 'challenge',
  FAILED: 'failed',
});

function queryOutcome(fields) {
  return {
    query: fields.query,
    family: fields.family,
    status: fields.status,
    rawResults: fields.rawResults == null ? 0 : fields.rawResults,
    uniqueResults: fields.uniqueResults == null ? 0 : fields.uniqueResults,
    // Jobs que ESTA query aporto al conjunto global (no los que ya estaban).
    uniqueContribution: fields.uniqueContribution == null ? 0 : fields.uniqueContribution,
    pagesVisited: fields.pagesVisited == null ? 0 : fields.pagesVisited,
    attempts: fields.attempts == null ? 0 : fields.attempts,
    confirmedBy: fields.confirmedBy == null ? null : fields.confirmedBy,
    failureReason: fields.failureReason == null ? null : fields.failureReason,
    stopReason: fields.stopReason == null ? null : fields.stopReason,
    filtersActive: fields.filtersActive == null ? null : fields.filtersActive,
    startedAt: fields.startedAt,
    completedAt: new Date().toISOString(),
  };
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
  let rawJobsDiscovered = 0;
  let completed = 0;

  // Seams de inyeccion: por defecto son las implementaciones reales. Permiten
  // testear la orquestacion (reintentos, registro por query, dedup) sin abrir
  // un navegador ni tocar LinkedIn.
  const changeQuery = options.changeSearchQueryImpl || changeSearchQuery;
  const initializeSearch = options.initializeSearchWithFiltersImpl || initializeSearchWithFilters;
  const collectSearch = options.collectCurrentSearchImpl || collectCurrentSearch;

  const total = activeQueries.length;
  const reportProgress = typeof options.reportProgress === 'function' ? options.reportProgress : () => {};
  const runStart = Date.now();
  const scopeOptions = {
    debug,
    maxResults: options.maxResultsPerSearch,
    maxPages: options.maxPagesPerSearch,
    signal: options.signal,
  };

  for (let i = 0; i < activeQueries.length; i += 1) {
    throwIfCancelled(options.signal);
    const { query, family, familyLabel } = activeQueries[i];
    reportProgress({ phase: 'discovery', searchesCompleted: completed, searchesTotal: total, currentQueryIndex: i + 1, currentQueryLabel: familyLabel || family });
    const queryStart = Date.now();
    const queryStartedAt = new Date().toISOString();

    log(debug, `\n=== QUERY ${i + 1}/${total} ===`);
    log(debug, `${query}  [familia: ${family}]`);
    log(debug, '');

    // Resultado de la transicion de keyword, para el registro por query.
    // Declarados fuera del try: el catch tambien los reporta.
    let attempts = 1;
    let confirmedBy = 'initial_navigation';

    try {
    // --- Fase 1: preparar la busqueda ---
    let filtersInitMs = 0;
    let searchExecutionMs = 0;

    if (i === 0) {
      // Los filtros se aplican UNA sola vez, en la primera query.
      const t0 = Date.now();
      await initializeSearch(page, query, filters, scopeOptions);
      filtersInitMs = Date.now() - t0;
      log(debug, `Filters initialization: ${fmtDuration(filtersInitMs)}`);
      log(debug, `Search execution: included in init`);
    } else {
      // Solo se cambia el keyword; los filtros activos se reutilizan.
      // El reintento acotado vive dentro de changeSearchQuery, que ademas
      // termina en una navegacion por URL determinista.
      const t0 = Date.now();
      const transition = await changeQuery(page, query, scopeOptions);
      searchExecutionMs = Date.now() - t0;
      attempts = transition.attempts;
      confirmedBy = transition.confirmedBy;
      log(debug, `Filters initialization: reused`);
      log(debug, `Search execution: ${fmtDuration(searchExecutionMs)} (intentos: ${attempts}${transition.changed ? ', confirmado por ' + confirmedBy : ', WARN: keyword no confirmado'})`);

      if (!transition.changed) {
        // No se pudo confirmar el nuevo keyword: no se recolecta NADA, para no
        // heredar los resultados de la query anterior.
        perQuery.push(queryOutcome({
          query, family, status: QUERY_STATUS.CHANGE_FAILED, startedAt: queryStartedAt,
          attempts, failureReason: transition.failureReason, stopReason: 'query_change_failed',
        }));
        log(debug, `Pagination: skipped (${transition.failureReason})`);
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
    const scope = await collectSearch(page, query, filters, {
      ...scopeOptions,
      onPageProcessed,
    });
    throwIfCancelled(options.signal);
    const paginationMs = Date.now() - paginationStart;
    rawJobsDiscovered += scope.metadata.rawResults;

    const uniqueBefore = globalMap.size;
    for (const job of scope.jobs) {
      rawResults += 1;
      mergeJob(globalMap, job, query, family);
    }

    perQuery.push(queryOutcome({
      query,
      family,
      status: QUERY_STATUS.COMPLETED,
      rawResults: scope.metadata.rawResults,
      uniqueResults: scope.metadata.uniqueResults,
      uniqueContribution: globalMap.size - uniqueBefore,
      pagesVisited: scope.metadata.pagesVisited,
      attempts,
      confirmedBy,
      stopReason: scope.metadata.stopReason,
      filtersActive: scope.metadata.filtersActive,
      startedAt: queryStartedAt,
    }));
    completed += 1;
    reportProgress({
      phase: 'discovery', searchesCompleted: completed, searchesTotal: total,
      rawJobsDiscovered, uniqueJobsDiscovered: globalMap.size,
      currentQueryIndex: i + 1, currentQueryLabel: familyLabel || family,
    });

    log(debug, `\nPagination: ${fmtDuration(paginationMs)}`);
    log(debug, `Total query duration: ${fmtDuration(Date.now() - queryStart)}`);
    log(
      debug,
      `-- query ${i + 1}/${total} done: raw=${scope.metadata.rawResults} unique=${scope.metadata.uniqueResults} pages=${scope.metadata.pagesVisited} stop=${scope.metadata.stopReason}`
    );
    } catch (error) {
      // Un challenge o un fallo inesperado detienen el run (se relanza tal
      // cual), pero antes queda registrado EN QUE query ocurrio. La lista
      // parcial viaja con el error para que el diagnostico no se pierda.
      if (error && error.name === 'HuntCancelledError') throw error;
      const isChallenge = error && error.name === 'SecurityChallengeError';
      perQuery.push(queryOutcome({
        query, family,
        status: isChallenge ? QUERY_STATUS.CHALLENGE : QUERY_STATUS.FAILED,
        attempts, confirmedBy,
        failureReason: (error && error.message ? String(error.message) : 'unknown').slice(0, 200),
        startedAt: queryStartedAt,
      }));
      error.searches = perQuery;
      throw error;
    }
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
  throwIfCancelled,
};

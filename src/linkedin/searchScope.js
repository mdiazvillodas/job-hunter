const { detectSecurityChallenge } = require('./session');
const { CHALLENGE_STAGES } = require('./challengeSignals');

// Filtros, cambio de query y paginacion: todo es fase de busqueda.
const CHALLENGE_CONTEXT = { stage: CHALLENGE_STAGES.DISCOVERY };

const {
  openJobsSearch,
  waitForJobResults,
  collectCurrentPageJobs,
} = require('./jobsCollector');

function throwIfCancelled(signal) {
  if (!signal || !signal.aborted) return;
  const error = new Error('Hunt cancelled.');
  error.name = 'HuntCancelledError';
  throw error;
}

// --- Mapeo de etiquetas legibles -> ids reales del DOM de LinkedIn ---
// (verificados inspeccionando el modal "All filters" de la UI real)
const DATE_POSTED_IDS = {
  'any time': 'advanced-filter-timePostedRange-',
  'past month': 'advanced-filter-timePostedRange-r2592000',
  'past week': 'advanced-filter-timePostedRange-r604800',
  'ultima semana': 'advanced-filter-timePostedRange-r604800',
  'past 24 hours': 'advanced-filter-timePostedRange-r86400',
};

const JOB_TYPE_IDS = {
  'full-time': 'advanced-filter-jobType-F',
  'jornada completa': 'advanced-filter-jobType-F',
  'part-time': 'advanced-filter-jobType-P',
  contract: 'advanced-filter-jobType-C',
  temporary: 'advanced-filter-jobType-T',
  volunteer: 'advanced-filter-jobType-V',
  internship: 'advanced-filter-jobType-I',
  other: 'advanced-filter-jobType-O',
};

function debugLog(options, event) {
  if (options && options.debug) {
    console.error(JSON.stringify({ scope: 'searchScope', ...event }));
  }
}

const LOCATION_INPUT_SELECTORS = [
  'input[id^="jobs-search-box-location-id-"][role="combobox"]',
  'input[autocomplete="address-level2"][role="combobox"]',
  'input[role="combobox"][aria-label="City, state, or zip code"]',
  'input[role="combobox"][aria-label="Ciudad, provincia/estado o código postal"]',
];

const KEYWORD_INPUT_SELECTORS = [
  'input[id^="jobs-search-box-keyword-id-"][role="combobox"]',
  'input[autocomplete="organization-title"][role="combobox"]',
  'input[role="combobox"][aria-label="Search by title, skill, or company"]',
  'input[role="combobox"][aria-label="Busca por cargo, aptitud o empresa"]',
];

const ALL_FILTERS_BUTTON_SELECTORS = [
  'button.search-reusables__all-filters-pill-button',
  'button[aria-label="Show all filters. Clicking this button displays all available filter options."]',
  'button[aria-label="Mostrar todos los filtros. Al hacer clic en este botón, se muestran todas las opciones de filtros disponibles."]',
  'button:has-text("All filters")',
  'button:has-text("Todos los filtros")',
];

const SHOW_RESULTS_BUTTON_SELECTORS = [
  'button.search-reusables__secondary-filters-show-results-button',
  'button[aria-label="Apply current filters to show results"]',
  'button[aria-label="Aplicar los filtros actuales para mostrar resultados"]',
  'button:has-text("Show results")',
  'button:has-text("Mostrar resultados")',
];

async function resolveSearchInput(page, selectors, description) {
  try {
    await page.locator(selectors.join(', ')).first().waitFor({ state: 'visible', timeout: 15000 });
    for (const selector of selectors) {
      const candidate = page.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  } catch (_) {
    // Se reemplaza el timeout dependiente del selector por un error estable y accionable.
  }
  const error = new Error(`LinkedIn search ${description} input was not found.`);
  error.name = 'LinkedInSelectorError';
  throw error;
}

function getLocationInput(page) {
  return resolveSearchInput(page, LOCATION_INPUT_SELECTORS, 'location');
}

function getKeywordInput(page) {
  return resolveSearchInput(page, KEYWORD_INPUT_SELECTORS, 'keyword');
}

async function resolveFilterButton(scope, selectors, description) {
  try {
    await scope.locator(selectors.join(', ')).first().waitFor({ state: 'visible', timeout: 15000 });
    for (const selector of selectors) {
      const candidate = scope.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  } catch (_) {
    // Se reemplaza el timeout dependiente del selector por un error estable y accionable.
  }
  const error = new Error(`LinkedIn ${description} button was not found.`);
  error.name = 'LinkedInSelectorError';
  throw error;
}

function getAllFiltersButton(page) {
  return resolveFilterButton(page, ALL_FILTERS_BUTTON_SELECTORS, 'all filters');
}

function getShowResultsButton(modal) {
  return resolveFilterButton(modal, SHOW_RESULTS_BUTTON_SELECTORS, 'show results');
}

// Click robusto sobre un input de filtro: prefiere el <label for> visible, con fallback a check().
async function clickFilterOption(page, inputId) {
  const labels = page.locator(`label[for="${inputId}"]`);
  const count = await labels.count();
  for (let i = 0; i < count; i += 1) {
    const label = labels.nth(i);
    if (await label.isVisible().catch(() => false)) {
      await label.click();
      return true;
    }
  }
  const input = page.locator(`#${inputId}`).first();
  if (await input.count()) {
    await input.check({ force: true }).catch(() => {});
    return true;
  }
  return false;
}

// Aplica la localizacion usando el typeahead del buscador (no se asume geoId ni parametro de URL).
async function applyLocationFilter(page, location, options) {
  const input = await getLocationInput(page);
  await input.click();
  await input.fill('');
  await input.type(location, { delay: 60 });
  await page.waitForTimeout(1500);

  const suggestion = page
    .locator('.basic-typeahead__selectable, [role="option"]')
    .filter({ hasText: new RegExp(location, 'i') })
    .first();

  let picked = false;
  if (await suggestion.count()) {
    await suggestion.click().catch(() => {});
    picked = true;
  } else {
    await input.press('Enter');
  }

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await detectSecurityChallenge(page, CHALLENGE_CONTEXT);
  debugLog(options, { event: 'location_applied', location, pickedSuggestion: picked });
}

// Aplica Date posted + Employment type mediante el modal "All filters" (una sola confirmacion).
async function applyModalFilters(page, filters, options) {
  const datePostedId = DATE_POSTED_IDS[String(filters.datePosted || '').toLowerCase()];
  const jobTypeId = JOB_TYPE_IDS[String(filters.employmentType || '').toLowerCase()];

  const allFiltersButton = await getAllFiltersButton(page);
  await allFiltersButton.click();

  const modal = page.locator('.artdeco-modal, [role="dialog"]').first();
  await modal.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(800);

  let datePostedSelected = false;
  let employmentSelected = false;

  if (datePostedId) {
    datePostedSelected = await clickFilterOption(page, datePostedId);
  }
  if (jobTypeId) {
    employmentSelected = await clickFilterOption(page, jobTypeId);
  }

  const showResults = await getShowResultsButton(modal);
  await showResults.click();

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await detectSecurityChallenge(page, CHALLENGE_CONTEXT);

  debugLog(options, {
    event: 'modal_filters_applied',
    datePosted: filters.datePosted,
    datePostedSelected,
    employmentType: filters.employmentType,
    employmentSelected,
  });

  return { datePostedSelected, employmentSelected };
}

// Verifica, a partir de la URL real que LinkedIn genera, que los filtros quedaron activos.
async function verifyFiltersActive(page, filters) {
  const url = page.url();
  const datePostedId = DATE_POSTED_IDS[String(filters.datePosted || '').toLowerCase()] || '';
  const tprCode = (datePostedId.match(/timePostedRange-(r\d+)/) || [])[1];
  const jobTypeCode = (JOB_TYPE_IDS[String(filters.employmentType || '').toLowerCase()] || '').split('-').pop();

  // LinkedIn resuelve la localizacion a un geoId (no conserva el texto en la URL),
  // por eso se considera activa si hay geoId o si el texto aparece en la URL.
  const locationActive = filters.location
    ? /[?&]geoId=\d+/.test(url) || new RegExp(filters.location, 'i').test(decodeURIComponent(url))
    : null;

  return {
    url,
    datePostedActive: tprCode ? url.includes(`f_TPR=${tprCode}`) : null,
    employmentTypeActive: jobTypeCode ? new RegExp(`f_JT=[^&]*${jobTypeCode}`).test(url) : null,
    locationActive,
  };
}

async function getActivePageNumber(page) {
  return page.evaluate(() => {
    const active = document.querySelector('.jobs-search-pagination__indicator-button--active');
    return active ? active.innerText.trim() : null;
  });
}

async function getFirstCardId(page) {
  return page.evaluate(() => {
    const card = document.querySelector('li[data-occludable-job-id]');
    return card ? card.getAttribute('data-occludable-job-id') : null;
  });
}

// Devuelve el estado real del boton "siguiente pagina".
async function inspectNextButton(page) {
  const next = page.locator('button.jobs-search-pagination__button--next').first();
  const exists = (await next.count()) > 0;
  if (!exists) return { exists: false, enabled: false, locator: next };
  const disabledAttr = await next.getAttribute('disabled');
  const ariaDisabled = await next.getAttribute('aria-disabled');
  const enabled = disabledAttr === null && ariaDisabled !== 'true' && (await next.isEnabled().catch(() => false));
  return { exists: true, enabled, locator: next };
}

// Avanza a la siguiente pagina y espera a que los resultados realmente cambien.
async function goToNextPage(page, nextLocator) {
  const prevActive = await getActivePageNumber(page);
  const prevFirstId = await getFirstCardId(page);

  await nextLocator.scrollIntoViewIfNeeded().catch(() => {});
  await nextLocator.click();

  const changed = await page
    .waitForFunction(
      ({ prevActive: pa, prevFirstId: pf }) => {
        const active = document.querySelector('.jobs-search-pagination__indicator-button--active');
        const activeText = active ? active.innerText.trim() : null;
        const firstCard = document.querySelector('li[data-occludable-job-id]');
        const firstId = firstCard ? firstCard.getAttribute('data-occludable-job-id') : null;
        const activeChanged = pa !== null && activeText !== null && activeText !== pa;
        const firstChanged = pf !== null && firstId !== null && firstId !== pf;
        return activeChanged || firstChanged;
      },
      { prevActive, prevFirstId },
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await waitForJobResults(page).catch(() => {});
  await page.waitForTimeout(600);
  return changed;
}

// Abre LinkedIn Jobs con la primera query y aplica los filtros por UI UNA sola vez.
// Deja la pagina en el estado de resultados filtrados. Devuelve la verificacion de filtros.
async function initializeSearchWithFilters(page, query, filters, options = {}) {
  throwIfCancelled(options.signal);
  await openJobsSearch(page, query);
  throwIfCancelled(options.signal);
  await waitForJobResults(page);

  if (filters.location) {
    await applyLocationFilter(page, filters.location, options);
    await waitForJobResults(page).catch(() => {});
  }
  await applyModalFilters(page, filters, options);
  await waitForJobResults(page).catch(() => {});

  const filtersActive = await verifyFiltersActive(page, filters);
  debugLog(options, { event: 'filters_verified', ...filtersActive });
  return { filtersActive };
}

// Cambia SOLAMENTE el keyword de busqueda reutilizando el buscador (los filtros activos
// -location, employment type, date posted- se conservan; verificado contra la UI real).
// Espera de forma robusta a que LinkedIn refleje el nuevo keyword antes de continuar.
async function changeSearchQuery(page, query, options = {}) {
  throwIfCancelled(options.signal);
  const kw = await getKeywordInput(page);

  const prevFirstId = await getFirstCardId(page);
  await kw.click();
  await kw.press('Control+a');
  await kw.press('Delete');
  await kw.type(query, { delay: 40 });
  await kw.press('Enter');

  // Gate principal: el parametro keywords de la URL pasa a ser EXACTAMENTE la nueva query.
  // (evita falsos positivos por substrings; ademas se acepta cambio de la primera tarjeta)
  const changed = await page
    .waitForFunction(
      ({ qDecoded, prev }) => {
        const m = location.href.match(/keywords=([^&]*)/);
        let kwMatch = false;
        if (m) {
          try {
            kwMatch = decodeURIComponent(m[1].replace(/\+/g, '%20')) === qDecoded;
          } catch (e) {
            kwMatch = false;
          }
        }
        const first = document.querySelector('li[data-occludable-job-id]')?.getAttribute('data-occludable-job-id') || null;
        const firstChanged = prev && first && first !== prev;
        return kwMatch && (firstChanged || true);
      },
      { qDecoded: query, prev: prevFirstId },
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await waitForJobResults(page).catch(() => {});
  await page.waitForTimeout(800);
  await detectSecurityChallenge(page, CHALLENGE_CONTEXT);
  throwIfCancelled(options.signal);

  debugLog(options, { event: 'query_changed', query, changed });
  return changed;
}

// Recorre la paginacion de la busqueda ACTUAL (filtros ya aplicados) y devuelve
// los jobs deduplicados dentro de la busqueda mas metadata y diagnosticos.
async function collectCurrentSearch(page, query, filters, options = {}) {
  const maxResults = Number.isFinite(options.maxResults) && options.maxResults > 0 ? options.maxResults : null;
  const maxPages = Number.isFinite(options.maxPages) && options.maxPages > 0 ? options.maxPages : null;

  // Los filtros son verificables en cada busqueda (deben persistir entre queries).
  const filtersActive = await verifyFiltersActive(page, filters);

  const uniqueJobs = new Map();
  const pageDiagnostics = [];
  let pagesVisited = 0;
  let rawResults = 0;
  let limitReached = false;
  let stopReason = null;

  while (true) {
    throwIfCancelled(options.signal);
    pagesVisited += 1;

    const pageResult = await collectCurrentPageJobs(page, options);
    throwIfCancelled(options.signal);
    await detectSecurityChallenge(page, CHALLENGE_CONTEXT);
    rawResults += pageResult.jobs.length;

    let newIds = 0;
    for (const job of pageResult.jobs) {
      const key = job.jobId || job.url;
      if (!key || uniqueJobs.has(key)) continue;
      if (maxResults && uniqueJobs.size >= maxResults) {
        limitReached = true;
        break;
      }
      uniqueJobs.set(key, {
        jobId: job.jobId,
        title: job.title,
        company: job.company,
        location: job.location,
        url: job.url,
        easyApply: job.easyApply,
      });
      newIds += 1;
    }

    // Si la pagina completo el cupo exacto de resultados unicos, no visitamos una pagina extra.
    if (maxResults && uniqueJobs.size >= maxResults) {
      limitReached = true;
    }

    const next = await inspectNextButton(page);
    const activePage = await getActivePageNumber(page);

    const pageInfo = {
      page: activePage || pagesVisited,
      detectedResults: pageResult.jobs.length,
      newJobIds: newIds,
      accumulatedUnique: uniqueJobs.size,
      nextFound: next.exists && next.enabled,
    };

    // Si un consumidor (p.ej. multiSearch) provee un logger de pagina, se usa ese
    // formato; si no, se emite el diagnostico JSON estandar de --debug.
    if (typeof options.onPageProcessed === 'function') {
      options.onPageProcessed(pageInfo);
    } else {
      debugLog(options, { event: 'page_processed', ...pageInfo });
    }

    pageDiagnostics.push({
      page: activePage || pagesVisited,
      detectedResults: pageResult.jobs.length,
      newJobIds: newIds,
      accumulatedUnique: uniqueJobs.size,
      nextFound: next.exists && next.enabled,
    });

    if (limitReached) {
      stopReason = 'max_results_reached';
      break;
    }
    if (maxPages && pagesVisited >= maxPages) {
      stopReason = 'max_pages_reached';
      break;
    }
    if (!next.exists || !next.enabled) {
      stopReason = 'no_next_page';
      break;
    }

    const advanced = await goToNextPage(page, next.locator);
    throwIfCancelled(options.signal);
    await detectSecurityChallenge(page, CHALLENGE_CONTEXT);
    if (!advanced) {
      stopReason = 'page_did_not_change';
      debugLog(options, { event: 'page_change_failed', afterPage: activePage || pagesVisited });
      break;
    }
    debugLog(options, { event: 'page_changed', toPage: await getActivePageNumber(page) });
  }

  debugLog(options, { event: 'finished', stopReason, pagesVisited, uniqueResults: uniqueJobs.size });

  const jobs = Array.from(uniqueJobs.values());

  return {
    metadata: {
      query,
      filters: {
        location: filters.location,
        employmentType: filters.employmentType,
        datePosted: filters.datePosted,
      },
      pagesVisited,
      rawResults,
      uniqueResults: jobs.length,
      limitReached,
      stopReason,
      filtersActive,
    },
    jobs,
    diagnostics: pageDiagnostics,
  };
}

// Compatibilidad: busqueda unica autocontenida (inicializa filtros + recorre paginacion).
async function collectSearchScope(page, query, filters, options = {}) {
  await initializeSearchWithFilters(page, query, filters, options);
  return collectCurrentSearch(page, query, filters, options);
}

module.exports = {
  collectSearchScope,
  initializeSearchWithFilters,
  changeSearchQuery,
  collectCurrentSearch,
  getLocationInput,
  getKeywordInput,
  applyLocationFilter,
  applyModalFilters,
  getAllFiltersButton,
  getShowResultsButton,
  LOCATION_INPUT_SELECTORS,
  KEYWORD_INPUT_SELECTORS,
  ALL_FILTERS_BUTTON_SELECTORS,
  SHOW_RESULTS_BUTTON_SELECTORS,
  throwIfCancelled,
};

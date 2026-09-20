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

// --- Coincidencia de ubicacion: configurada (humana) vs resuelta (localizada) ---
//
// LinkedIn devuelve la ubicacion YA LOCALIZADA al idioma de la cuenta: lo que el
// usuario configura como "Barcelona, spain" se convierte en "Barcelona, Cataluña,
// España". Comparar literalmente las dos cadenas no puede funcionar, asi que se
// compara por TOKENS normalizados.
//
// LIMITACIONES DELIBERADAS (no es un traductor):
//   - Solo se exige el PRIMER token significativo de la ubicacion configurada (la
//     localidad). El pais no se comprueba, porque "spain" nunca casara con
//     "España" sin un diccionario de traduccion, y aqui no se quiere uno.
//   - Si la ubicacion configurada es un pais suelto ("España"), ese pais ES la
//     localidad y se comprueba como tal.
//   - La comparacion es por palabra completa, nunca por substring: "Barcelona"
//     no puede darse por bueno con "Barceloneta".
function normalizeLocationText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function locationSegments(value) {
  return String(value === null || value === undefined ? '' : value)
    .split(',')
    .map((segment) => normalizeLocationText(segment))
    .filter(Boolean);
}

// El token de localidad es el primer segmento significativo de lo configurado.
function configuredLocalityToken(location) {
  const segments = locationSegments(location);
  return segments.length ? segments[0] : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Palabra completa sobre texto ya normalizado: evita falsos positivos por
// substring (Barceloneta, MadridSomething, ParisSomething...).
function containsLocalityToken(token, candidate) {
  const haystack = normalizeLocationText(candidate);
  if (!token || !haystack) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(token)}(?![\\p{L}\\p{N}])`, 'u').test(haystack);
}

// True solo si el valor observado corresponde a la localidad configurada.
function matchesConfiguredLocality(location, candidate) {
  return containsLocalityToken(configuredLocalityToken(location), candidate);
}

// Ranking determinista de una sugerencia del typeahead frente a lo configurado:
//   0 -> la localidad ES el primer segmento (opcion a nivel de ciudad)
//   1 -> la localidad aparece como palabra completa mas adelante (p.ej. un codigo
//        postal: "08001, Barcelona, Catalonia, Spain")
//   null -> no corresponde a la localidad configurada
function rankLocationCandidate(location, candidateText) {
  const token = configuredLocalityToken(location);
  if (!token) return null;
  const segments = locationSegments(candidateText);
  if (!segments.length) return null;
  if (segments[0] === token) return 0;
  return containsLocalityToken(token, candidateText) ? 1 : null;
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

// Opciones del typeahead de ubicacion. Se mantienen ambos selectores: el
// estructural de LinkedIn y el accesible (role=option), que es el estable.
const LOCATION_SUGGESTION_SELECTOR = '.basic-typeahead__selectable, [role="option"]';
// Cota dura: el typeahead devuelve ~5 opciones; nunca se recorre una lista larga.
const MAX_LOCATION_SUGGESTIONS = 12;

// Como quedo resuelta la ubicacion. Solo una eleccion EXPLICITA de la
// autocompletacion es evidencia de que LinkedIn resolvio la ubicacion: tras un
// Enter a ciegas el control conserva el texto que nosotros escribimos, asi que
// releerlo no probaria nada.
const LOCATION_RESOLUTION = Object.freeze({
  AUTOCOMPLETE_SELECTION: 'AUTOCOMPLETE_SELECTION',
  TYPED_FALLBACK: 'TYPED_FALLBACK',
});

// Como se resolvio la ubicacion en ESTA pagina. Va en un WeakMap y no en el
// contrato de las funciones porque la verificacion se repite en cada busqueda
// (los filtros persisten entre cambios de keyword) y no debe cambiar ninguna
// firma publica. No retiene la pagina: es debil a proposito.
const LOCATION_RESOLUTIONS = new WeakMap();

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

// LinkedIn colapsa keyword + ubicacion en una sola barra unificada: el combobox
// de ubicacion SIGUE en el DOM y el selector sigue casando, pero su contenedor
// (.jobs-search-box__input--location) queda en display:none hasta que la barra se
// activa. Por eso getLocationInput, que exige un elemento VISIBLE, fallaba.
//
// Se expande SOLO si hace falta, y se usa el combobox de keyword -que si esta
// visible- como disparador, en vez de depender del id efimero de Ember.
// No se relaja el contrato de resolveSearchInput: se arregla el estado de la
// pagina antes de pedirle un elemento visible.
async function ensureSearchBoxExpandedForLocation(page, options) {
  const location = page.locator(LOCATION_INPUT_SELECTORS.join(', ')).first();

  if (await location.isVisible().catch(() => false)) {
    debugLog(options, { event: 'search_box_already_expanded' });
    return { activated: false, visible: true };
  }

  // Ausente del DOM: no es un problema de barra colapsada. Se deja que
  // getLocationInput produzca su LinkedInSelectorError estable.
  if (!(await location.count().catch(() => 0))) {
    debugLog(options, { event: 'search_box_location_absent' });
    return { activated: false, visible: false };
  }

  const keyword = await getKeywordInput(page);
  await keyword.click();
  const visible = await location
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);

  debugLog(options, { event: 'search_box_expanded', visible });
  return { activated: true, visible };
}

// Elige la sugerencia del typeahead que corresponde a la localidad configurada.
// Sustituye al antiguo filtro por texto literal, que no podia casar con la
// version localizada que devuelve LinkedIn.
async function pickLocationSuggestion(page, location) {
  const suggestions = page.locator(LOCATION_SUGGESTION_SELECTOR);
  const total = await suggestions.count().catch(() => 0);
  if (!total) return null;

  let best = null;
  const limit = Math.min(total, MAX_LOCATION_SUGGESTIONS);
  for (let i = 0; i < limit; i += 1) {
    const candidate = suggestions.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = await candidate.innerText().catch(() => '');
    const rank = rankLocationCandidate(location, text);
    if (rank === null) continue;
    if (!best || rank < best.rank) best = { rank, index: i, text, locator: candidate };
    if (best.rank === 0) break; // ya es la opcion a nivel de ciudad mejor rankeada
  }
  return best;
}

// Relee el valor REAL del control de ubicacion. Se hace por DOM y no con
// inputValue() porque el control vuelve a quedar oculto cuando la barra se
// colapsa, y esta lectura tiene que seguir funcionando en cada verificacion.
async function readSelectedLocationValue(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  return page
    .evaluate((selector) => {
      const el = document.querySelector(selector);
      return el && typeof el.value === 'string' ? el.value : null;
    }, LOCATION_INPUT_SELECTORS.join(', '))
    .catch(() => null);
}

// Aplica la localizacion usando el typeahead del buscador (no se asume geoId ni parametro de URL).
async function applyLocationFilter(page, location, options) {
  // Una aplicacion nueva invalida lo que se supiera de la anterior: si esta
  // falla a medias, no puede quedar viva la evidencia de la busqueda previa.
  LOCATION_RESOLUTIONS.delete(page);

  await ensureSearchBoxExpandedForLocation(page, options);

  const input = await getLocationInput(page);
  await input.click();
  await input.fill('');
  await input.type(location, { delay: 60 });
  await page.waitForTimeout(1500);

  const suggestion = await pickLocationSuggestion(page, location);

  let resolution = LOCATION_RESOLUTION.TYPED_FALLBACK;
  if (suggestion) {
    await suggestion.locator.click();
    resolution = LOCATION_RESOLUTION.AUTOCOMPLETE_SELECTION;
  } else {
    // Ultimo recurso conservador: se conserva el Enter para no quedarse sin
    // ninguna accion, pero por si solo NUNCA da la ubicacion por verificada.
    await input.press('Enter');
  }
  LOCATION_RESOLUTIONS.set(page, resolution);

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await detectSecurityChallenge(page, CHALLENGE_CONTEXT);

  const selectedLocation = await readSelectedLocationValue(page);
  debugLog(options, {
    event: 'location_applied',
    location,
    resolution,
    suggestionRank: suggestion ? suggestion.rank : null,
    selectedMatchesConfigured: matchesConfiguredLocality(location, selectedLocation),
  });

  return { resolution, selectedLocation };
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

// Verifica que los filtros quedaron activos.
//
// Date posted y employment type se leen de la URL, que LinkedIn si codifica.
//
// La UBICACION no: LinkedIn no emite ningun parametro `location`, solo un geoId
// opaco. Y un geoId cualquiera NO prueba nada, porque un ambito de pais entero
// ("España", que ademas es el valor por defecto del control) tambien tiene
// geoId valido. Por eso la ubicacion se verifica contra el ESTADO REAL del
// control, y el geoId queda como evidencia de apoyo, nunca como el verificador.
//
// Se exige ademas que la ubicacion se haya resuelto por una eleccion EXPLICITA
// del typeahead: tras un Enter a ciegas el control conserva el texto que
// escribimos nosotros, asi que releerlo seria comprobar nuestro propio input.
async function verifyFiltersActive(page, filters) {
  const url = page.url();
  const datePostedId = DATE_POSTED_IDS[String(filters.datePosted || '').toLowerCase()] || '';
  const tprCode = (datePostedId.match(/timePostedRange-(r\d+)/) || [])[1];
  const jobTypeCode = (JOB_TYPE_IDS[String(filters.employmentType || '').toLowerCase()] || '').split('-').pop();

  let locationActive = null;
  let selectedLocation = null;
  let locationResolution = null;
  if (filters.location) {
    selectedLocation = await readSelectedLocationValue(page);
    locationResolution = LOCATION_RESOLUTIONS.get(page) || null;
    locationActive =
      locationResolution === LOCATION_RESOLUTION.AUTOCOMPLETE_SELECTION
      && matchesConfiguredLocality(filters.location, selectedLocation);
  }

  return {
    url,
    datePostedActive: tprCode ? url.includes(`f_TPR=${tprCode}`) : null,
    employmentTypeActive: jobTypeCode ? new RegExp(`f_JT=[^&]*${jobTypeCode}`).test(url) : null,
    locationActive,
    // Evidencia observada, no decisoria.
    selectedLocation,
    locationResolution,
    locationGeoId: (url.match(/[?&]geoId=(\d+)/) || [])[1] || null,
    locationFromAutocompleteOrigin: /origin=JOB_SEARCH_PAGE_LOCATION_AUTOCOMPLETE/.test(url),
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
  verifyFiltersActive,
  ensureSearchBoxExpandedForLocation,
  pickLocationSuggestion,
  readSelectedLocationValue,
  normalizeLocationText,
  locationSegments,
  configuredLocalityToken,
  matchesConfiguredLocality,
  rankLocationCandidate,
  getAllFiltersButton,
  getShowResultsButton,
  LOCATION_RESOLUTION,
  LOCATION_SUGGESTION_SELECTOR,
  LOCATION_INPUT_SELECTORS,
  KEYWORD_INPUT_SELECTORS,
  ALL_FILTERS_BUTTON_SELECTORS,
  SHOW_RESULTS_BUTTON_SELECTORS,
  throwIfCancelled,
};

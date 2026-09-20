'use strict';

// Fuente de mercado de LinkedIn para Market Discovery (MD3b): SOLO LECTURA.
//
// Ejecuta UNA busqueda acotada y devuelve evidencia estructurada de ESA busqueda.
// No decide nada, no clasifica, no expande semillas, no escribe en el estado de
// Hunter y no abre ni cierra el navegador: la vida del navegador y la propiedad
// de la operacion pertenecen al futuro run de Market Discovery (ver MD3a).
//
// Reutiliza las primitivas existentes de LinkedIn sin modificarlas:
//   initializeSearchWithFilters -> navegacion nueva + filtros por UI + verificacion
//   collectCurrentSearch        -> paginacion acotada + dedupe intra-busqueda
//
// Cada busqueda parte de una navegacion nueva (openJobsSearch), NO de
// changeSearchQuery, asi que la atribucion por busqueda no depende de la
// sincronizacion de tarjetas entre queries consecutivas.

const { SCHEMA_VERSION, assert } = require('./domain');
const { OPERATION_TYPES } = require('../domain/operationOwner');

// Presupuesto de Market Discovery. NO es el de Hunter (25 resultados / 2 paginas).
const MD_MAX_PAGES = 1;
const MD_MAX_RESULTS = 10;

const STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',
  INTERRUPTED: 'INTERRUPTED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
});
// Un filtro pedido que no se puede confirmar NUNCA se presenta como verificado.
const SCOPE = Object.freeze({
  VERIFIED: 'VERIFIED',
  UNVERIFIED: 'UNVERIFIED',
  NOT_REQUESTED: 'NOT_REQUESTED',
});
const SUPPORTED_FILTERS = Object.freeze(['location', 'employmentType', 'datePosted']);
const LANGUAGE_PATTERN = /^(und|[a-z]{2,3}(?:-[A-Za-z]{2,4})?)$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isCancellation(error) {
  return !!error && (error.name === 'AbortError' || error.name === 'HuntCancelledError');
}
function throwIfCancelled(signal) {
  if (!signal || !signal.aborted) return;
  const error = new Error('Market Discovery search cancelled.');
  error.name = 'HuntCancelledError';
  throw error;
}

// La propiedad la establece el run, no la busqueda: el adaptador solo EXIGE que
// quien llama ya sea dueño como MARKET_DISCOVERY. Nunca adquiere ni libera.
function assertMarketDiscoveryOwner(owner) {
  assert(owner && typeof owner === 'object', 'market discovery owner required');
  assert(owner.operationType === OPERATION_TYPES.MARKET_DISCOVERY, 'MARKET_DISCOVERY ownership required');
  assert(typeof owner.operationId === 'string' && ID_PATTERN.test(owner.operationId), 'owner operationId required');
  assert(Number.isInteger(owner.pid) && owner.pid > 0, 'owner pid required');
  return owner;
}

// Falla cerrado: un limite mayor al presupuesto de MD3b es un error, nunca una
// busqueda silenciosamente mas amplia.
function resolveLimits(limits = {}) {
  assert(limits && typeof limits === 'object' && !Array.isArray(limits), 'limits must be an object');
  const maxPages = limits.maxPages === undefined ? MD_MAX_PAGES : limits.maxPages;
  const maxResults = limits.maxResults === undefined ? MD_MAX_RESULTS : limits.maxResults;
  assert(Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= MD_MAX_PAGES, `maxPages must be 1..${MD_MAX_PAGES}`);
  assert(Number.isInteger(maxResults) && maxResults >= 1 && maxResults <= MD_MAX_RESULTS, `maxResults must be 1..${MD_MAX_RESULTS}`);
  return { maxPages, maxResults };
}

// Identidad de la busqueda: de que semilla/familia salio, que se ejecuto y en que
// idioma se expreso la QUERY. El idioma de la query no dice nada del idioma de
// las ofertas devueltas: son conceptos distintos y no se mezclan.
function normalizeSearchIdentity(request) {
  assert(request && typeof request === 'object', 'search identity required');
  const { searchId, familyId, seedExpression, query, queryLanguage } = request;
  assert(typeof searchId === 'string' && ID_PATTERN.test(searchId), 'searchId required');
  assert(typeof query === 'string' && query.trim(), 'query required');
  assert(familyId === null || familyId === undefined || /^family-[a-f0-9]{16}$/.test(familyId), 'familyId must be a seed family id');
  const language = queryLanguage === undefined || queryLanguage === null ? 'und' : queryLanguage;
  assert(typeof language === 'string' && LANGUAGE_PATTERN.test(language), 'queryLanguage must be a language tag or und');
  return {
    searchId,
    familyId: familyId || null,
    seedExpression: typeof seedExpression === 'string' && seedExpression.trim() ? seedExpression : null,
    query: query.trim(),
    queryLanguage: language,
  };
}

// Solo los filtros que el collector existente ya sabe aplicar y verificar.
// No se inventan filtros de seniority, modalidad ni idioma.
function normalizeFilters(filters = {}) {
  assert(filters && typeof filters === 'object' && !Array.isArray(filters), 'filters must be an object');
  for (const key of Object.keys(filters)) {
    assert(SUPPORTED_FILTERS.includes(key), `unsupported market discovery filter: ${key}`);
  }
  const value = (input) => (typeof input === 'string' && input.trim() ? input.trim() : null);
  return { location: value(filters.location), employmentType: value(filters.employmentType), datePosted: value(filters.datePosted) };
}

// Pedido vs observado. `null` del verificador significa "no se pudo confirmar",
// y eso se reporta como UNVERIFIED, no como aplicado.
function toObservedScope(requested, filtersActive) {
  const state = (wanted, verified) => {
    if (!wanted) return SCOPE.NOT_REQUESTED;
    return verified === true ? SCOPE.VERIFIED : SCOPE.UNVERIFIED;
  };
  const active = filtersActive || {};
  return {
    location: state(requested.location, active.locationActive),
    employmentType: state(requested.employmentType, active.employmentTypeActive),
    datePosted: state(requested.datePosted, active.datePostedActive),
    // La URL observada por el verificador NO se propaga: es un diagnostico
    // con parametros de sesion que no debe salir de la capa de LinkedIn.
    verifiedAgainstUrl: Boolean(active.url),
  };
}

// Diagnostico de interrupcion acotado: sin URL, sin extracto, sin selectores.
function toSafeChallenge(code, diagnostic) {
  const text = (value, limit) => (typeof value === 'string' && value ? value.slice(0, limit) : null);
  const source = diagnostic && typeof diagnostic === 'object' ? diagnostic : {};
  return {
    code,
    source: text(source.source, 16) || 'unknown',
    signal: text(source.signal, 64) || 'unknown',
    stage: text(source.stage, 32) || null,
    at: text(source.at, 32) || new Date().toISOString(),
  };
}

function toResults(identity, jobs) {
  return (Array.isArray(jobs) ? jobs : []).map((job, index) => ({
    // Atribucion exacta: todo resultado sabe de que busqueda y de que familia salio.
    searchId: identity.searchId,
    familyId: identity.familyId,
    query: identity.query,
    position: index + 1,
    jobId: job && job.jobId ? String(job.jobId) : null,
    url: job && job.url ? String(job.url) : null,
    title: job && job.title ? String(job.title) : null,
    company: job && job.company ? String(job.company) : null,
    location: job && job.location ? String(job.location) : null,
    easyApply: job ? job.easyApply === true : false,
  }));
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

function createLinkedinMarketSource(options = {}) {
  const initializeSearch = options.initializeSearch
    || ((page, query, filters, opts) => require('../linkedin/searchScope').initializeSearchWithFilters(page, query, filters, opts));
  const collectSearch = options.collectSearch
    || ((page, query, filters, opts) => require('../linkedin/searchScope').collectCurrentSearch(page, query, filters, opts));
  const clock = options.clock || (() => new Date());

  async function search(request = {}) {
    assertMarketDiscoveryOwner(request.owner);
    const identity = normalizeSearchIdentity(request.search);
    const limits = resolveLimits(request.limits);
    const requestedFilters = normalizeFilters(request.filters);
    assert(request.page && typeof request.page === 'object', 'an authenticated page is required');
    const signal = request.signal;
    const startedAt = clock().toISOString();

    const requestedScope = { ...requestedFilters, maxPages: limits.maxPages, maxResults: limits.maxResults };
    const base = {
      schemaVersion: SCHEMA_VERSION,
      operationType: OPERATION_TYPES.MARKET_DISCOVERY,
      operationId: request.owner.operationId,
      search: identity,
      requestedScope,
      startedAt,
    };
    const empty = { rawCards: 0, uniqueResults: 0, duplicatesWithinSearch: 0, pagesVisited: 0, limitReached: false };
    const unknownScope = toObservedScope(requestedFilters, null);

    // Nunca se ensancha el presupuesto: esto es exactamente lo que ve el collector.
    const scopeOptions = { maxPages: limits.maxPages, maxResults: limits.maxResults, signal };

    try {
      throwIfCancelled(signal);
      await initializeSearch(request.page, identity.query, requestedFilters, scopeOptions);
      throwIfCancelled(signal);
      const scope = await collectSearch(request.page, identity.query, requestedFilters, scopeOptions);
      throwIfCancelled(signal);
      const metadata = (scope && scope.metadata) || {};
      const results = toResults(identity, scope && scope.jobs);
      const rawCards = Number.isFinite(metadata.rawResults) ? metadata.rawResults : results.length;
      return deepFreeze({
        ...base,
        status: STATUS.COMPLETED,
        partial: false,
        observedScope: toObservedScope(requestedFilters, metadata.filtersActive),
        results,
        metrics: {
          rawCards,
          uniqueResults: results.length,
          duplicatesWithinSearch: Math.max(0, rawCards - results.length),
          pagesVisited: Number.isFinite(metadata.pagesVisited) ? metadata.pagesVisited : 0,
          limitReached: metadata.limitReached === true,
        },
        stopReason: typeof metadata.stopReason === 'string' && metadata.stopReason ? metadata.stopReason : 'completed',
        challenge: null,
        finishedAt: clock().toISOString(),
      });
    } catch (error) {
      // Una busqueda interrumpida NUNCA se reporta como completada.
      if (isCancellation(error)) {
        return deepFreeze({ ...base, status: STATUS.CANCELLED, partial: false, observedScope: unknownScope,
          results: [], metrics: empty, stopReason: 'cancelled', challenge: null, finishedAt: clock().toISOString() });
      }
      if (error && error.name === 'SecurityChallengeError') {
        return deepFreeze({ ...base, status: STATUS.INTERRUPTED, partial: false, observedScope: unknownScope,
          results: [], metrics: empty, stopReason: 'checkpoint_required',
          challenge: toSafeChallenge('CHECKPOINT_REQUIRED', error.challengeDiagnostic), finishedAt: clock().toISOString() });
      }
      if (error && error.name === 'AuthenticationError') {
        return deepFreeze({ ...base, status: STATUS.INTERRUPTED, partial: false, observedScope: unknownScope,
          results: [], metrics: empty, stopReason: 'login_required',
          challenge: toSafeChallenge('LOGIN_REQUIRED', null), finishedAt: clock().toISOString() });
      }
      // Fallo ordinario: se reporta el hecho, no el detalle. El mensaje, el stack
      // y los selectores de LinkedIn se quedan fuera del contrato.
      return deepFreeze({ ...base, status: STATUS.FAILED, partial: false, observedScope: unknownScope,
        results: [], metrics: empty, stopReason: 'source_failed', challenge: null, finishedAt: clock().toISOString() });
    }
  }

  return { search };
}

module.exports = {
  createLinkedinMarketSource,
  assertMarketDiscoveryOwner,
  resolveLimits,
  normalizeSearchIdentity,
  normalizeFilters,
  toObservedScope,
  MD_MAX_PAGES,
  MD_MAX_RESULTS,
  STATUS,
  SCOPE,
  SUPPORTED_FILTERS,
};

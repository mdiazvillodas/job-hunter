'use strict';

// MD5 — contrato de presupuesto y politica de la exploracion acotada.
//
// TODOS los limites de Market Discovery viven aqui: el motor no contiene numeros
// magicos. Los topes son DUROS: pedir mas falla cerrado, nunca ensancha en silencio.

const { assert, freeze } = require('./domain');
const { MD_MAX_PAGES, MD_MAX_RESULTS } = require('./linkedinMarketSource');

const STOP_REASONS = Object.freeze({
  COMPLETED: 'COMPLETED',
  SATURATED: 'SATURATED',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  CANCELLED: 'CANCELLED',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  CHECKPOINT_REQUIRED: 'CHECKPOINT_REQUIRED',
  SOURCE_FAILED: 'SOURCE_FAILED',
  SEMANTIC_FAILED: 'SEMANTIC_FAILED',
  TIME_LIMIT: 'TIME_LIMIT',
  // La busqueda se ejecuto pero LinkedIn no confirmo la ubicacion pedida: no se
  // explora un mercado distinto del configurado.
  SCOPE_NOT_VERIFIED: 'SCOPE_NOT_VERIFIED',
  // Demasiados detalles de oferta fallaron seguidos: se corta en vez de seguir
  // evaluando a ciegas solo con titulos.
  DETAIL_FAILED: 'DETAIL_FAILED',
});
// Solo COMPLETED es un final normal; todo lo demas deja evidencia parcial.
const TERMINAL_OK = Object.freeze([STOP_REASONS.COMPLETED, STOP_REASONS.SATURATED]);

const HARD_CAPS = Object.freeze({
  maxFamilies: 6,
  maxSearches: 10,
  maxInitialSearches: 6,
  maxExpansionSearches: 4,
  maxUniquePostings: 100,
  maxEvaluations: 60,
  initialEvaluationReserve: 36,
  expansionEvaluationReserve: 24,
  maxExpansionDepth: 1,
  maxDurationMs: 45 * 60 * 1000,
  maxSourceFailures: 2,
  maxSemanticFailures: 3,
  // Un detalle por candidato evaluado como maximo: nunca mas que evaluaciones.
  maxDetailFetches: 60,
  maxDetailFailures: 5,
});

const DEFAULT_BUDGET = Object.freeze({ ...HARD_CAPS });

// Politica de saturacion y de expansion. Constantes explicitas, no heuristicas.
const POLICY = Object.freeze({
  // Dos busquedas COMPLETADAS consecutivas con >80% de solapamiento y sin
  // evidencia compatible nueva => saturado.
  saturationOverlapRatio: 0.8,
  saturationConsecutiveSearches: 2,
  // Un termino necesita evidencia de al menos 2 ofertas distintas...
  minExpansionPostings: 2,
  // ...y de 2 empresas distintas, SOLO si al menos 2 de esas ofertas declaran empresa.
  minExpansionCompanies: 2,
  // El buscador de MD3b ya impone estos topes; el motor nunca pide mas.
  searchLimits: Object.freeze({ maxPages: MD_MAX_PAGES, maxResults: MD_MAX_RESULTS }),
});

const NUMERIC_KEYS = Object.keys(HARD_CAPS);

function resolveBudget(overrides = {}) {
  assert(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'budget must be an object');
  for (const key of Object.keys(overrides)) assert(NUMERIC_KEYS.includes(key), `unknown budget key: ${key}`);
  const budget = {};
  for (const key of NUMERIC_KEYS) {
    let fallback = DEFAULT_BUDGET[key];
    // El detalle solo sirve para evaluar: si el llamador baja las evaluaciones,
    // el tope de detalles baja con ellas sin tener que declararlo.
    if (key === 'maxDetailFetches') {
      const evaluations = overrides.maxEvaluations === undefined ? DEFAULT_BUDGET.maxEvaluations : overrides.maxEvaluations;
      if (Number.isInteger(evaluations)) fallback = Math.min(fallback, evaluations);
    }
    const value = overrides[key] === undefined ? fallback : overrides[key];
    assert(Number.isInteger(value) && value >= 0, `${key} must be a non-negative integer`);
    assert(value <= HARD_CAPS[key], `${key} must not exceed ${HARD_CAPS[key]}`);
    budget[key] = value;
  }
  // Coherencia interna: las reservas no pueden prometer mas evaluaciones que el total,
  // ni las fases mas busquedas que el total.
  assert(budget.maxInitialSearches + budget.maxExpansionSearches <= budget.maxSearches,
    'initial + expansion searches must not exceed maxSearches');
  assert(budget.initialEvaluationReserve + budget.expansionEvaluationReserve <= budget.maxEvaluations,
    'evaluation reserves must not exceed maxEvaluations');
  // El detalle solo existe para alimentar una evaluacion: no puede haber mas
  // aperturas de oferta que evaluaciones semanticas.
  assert(budget.maxDetailFetches <= budget.maxEvaluations,
    'maxDetailFetches must not exceed maxEvaluations');
  return freeze(budget);
}

module.exports = { STOP_REASONS, TERMINAL_OK, HARD_CAPS, DEFAULT_BUDGET, POLICY, resolveBudget };

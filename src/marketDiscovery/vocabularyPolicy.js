'use strict';

// MD6 — politica de vocabulario y de uso como query.
//
// Todos los umbrales viven aqui y estan VERSIONADOS: son un punto de calibracion,
// no una verdad. Cambiar un umbral cambia policyVersion y, con ella, la identidad
// de la propuesta.
//
// Dos estados SEPARADOS a proposito:
//   - estado de VOCABULARIO: que dice el mercado (PROMOTED / WATCH / REJECTED)
//   - estado de USO COMO QUERY: si esa expresion sirve como busqueda de LinkedIn
// Una frase puede ser vocabulario legitimo y aun asi ser una mala query.

const { normalize } = require('./domain');

const POLICY_VERSION = 1;

const VOCABULARY_STATES = Object.freeze({ PROMOTED: 'PROMOTED', WATCH: 'WATCH', REJECTED: 'REJECTED' });
const QUERY_TEST_STATES = Object.freeze({ TESTED_POSITIVE: 'TESTED_POSITIVE', TESTED_NEGATIVE: 'TESTED_NEGATIVE', UNTESTED: 'UNTESTED' });
const QUERY_USE = Object.freeze({ ELIGIBLE: 'ELIGIBLE', INELIGIBLE: 'INELIGIBLE' });

const PROMOTION = Object.freeze({
  // Umbral de evidencia por defecto, NO una verdad magica.
  minDistinctPostings: 3,
  minDistinctCompanies: 2,
  // La regla de empresas solo se aplica si hay datos de empresa suficientes.
  minPostingsWithCompanyToRequireCompanies: 2,
});

const QUERY_TEST = Object.freeze({
  minSample: 5,
  minCompatibleRatio: 0.6,
  minIncrementalCompatible: 2,
});

const PORTFOLIO = Object.freeze({ targetMin: 8, targetMax: 12, hardMax: 15 });

// Lista PEQUEÑA y versionada de palabras de nivel/funcion, en es/en. No contiene
// terminos de dominio: no decide que profesion es buena, solo que una palabra
// suelta de este tipo no funciona por si sola como busqueda de mercado.
const GENERIC_TOKENS = new Set([
  'senior', 'junior', 'principal', 'lead', 'head', 'chief', 'general', 'assistant', 'associate',
  'manager', 'director', 'coordinator', 'specialist', 'analyst', 'consultant', 'officer', 'executive',
  'project', 'technical', 'operations', 'management',
  'jefe', 'gestor', 'gestora', 'responsable', 'tecnico', 'tecnica', 'proyecto', 'proyectos',
  'coordinador', 'coordinadora', 'especialista', 'director a', 'adjunto', 'auxiliar',
]);
// Una palabra suelta compartida por varias expresiones observadas es, EN ESTA
// MUESTRA, un componente generico y no un concepto por si mismo.
const SHARED_TOKEN_TERMS = 2;

function tokensOf(text) { return normalize(text).split(' ').filter(Boolean); }

// Genericidad determinista: por lista corta de nivel/funcion, o por evidencia de
// que el token se repite como componente de otras expresiones de la muestra.
function assessGenericity(normalized, allNormalizedTerms) {
  const tokens = tokensOf(normalized);
  if (tokens.length === 0) return { generic: true, reason: 'empty expression' };
  if (tokens.length > 1) return { generic: false, reason: null };
  const token = tokens[0];
  if (GENERIC_TOKENS.has(token)) return { generic: true, reason: 'single generic level or function word' };
  const sharedWith = allNormalizedTerms.filter((other) => other !== normalized && tokensOf(other).includes(token)).length;
  if (sharedWith >= SHARED_TOKEN_TERMS) {
    return { generic: true, reason: `single word shared as a component of ${sharedWith} other observed expressions` };
  }
  return { generic: false, reason: null };
}

// Un termino choca con una exclusion explicita del perfil cuando una contiene a la otra.
function conflictsWithExclusions(normalized, exclusionTexts) {
  return exclusionTexts.some((text) => text === normalized || text.includes(normalized) || normalized.includes(text));
}

// Estado de VOCABULARIO. La evidencia escasa es WATCH, nunca REJECTED:
// REJECTED exige una razon afirmativa.
function classifyVocabulary(term) {
  if (term.conflictsWithExclusion) {
    return { state: VOCABULARY_STATES.REJECTED, reason: 'matches an explicit profile exclusion' };
  }
  if (term.distinctPostings < PROMOTION.minDistinctPostings) {
    return { state: VOCABULARY_STATES.WATCH, reason: `supported by ${term.distinctPostings} of ${PROMOTION.minDistinctPostings} required distinct compatible postings` };
  }
  const companyRequired = term.postingsWithCompany >= PROMOTION.minPostingsWithCompanyToRequireCompanies;
  if (companyRequired && term.distinctCompanies < PROMOTION.minDistinctCompanies) {
    return { state: VOCABULARY_STATES.WATCH, reason: `evidence concentrated in ${term.distinctCompanies} company(ies)` };
  }
  return {
    state: VOCABULARY_STATES.PROMOTED,
    reason: companyRequired
      ? `${term.distinctPostings} distinct compatible postings across ${term.distinctCompanies} companies`
      : `${term.distinctPostings} distinct compatible postings (company data unavailable)`,
  };
}

// Metricas de una query REALMENTE ejecutada en el ledger. No se fabrica nada
// para terminos no probados.
function evaluateQueryTest(metrics) {
  if (!metrics) return { state: QUERY_TEST_STATES.UNTESTED, reason: 'not executed in this exploration' };
  const { sample, compatible, incrementalCompatible } = metrics;
  const ratio = sample > 0 ? compatible / sample : 0;
  if (sample < QUERY_TEST.minSample) {
    return { state: QUERY_TEST_STATES.TESTED_NEGATIVE, reason: `sample of ${sample} below ${QUERY_TEST.minSample}`, ratio, inconclusive: true };
  }
  if (ratio < QUERY_TEST.minCompatibleRatio) {
    return { state: QUERY_TEST_STATES.TESTED_NEGATIVE, reason: `${Math.round(ratio * 100)}% compatible, below ${Math.round(QUERY_TEST.minCompatibleRatio * 100)}%`, ratio, noisy: true };
  }
  if (incrementalCompatible < QUERY_TEST.minIncrementalCompatible) {
    return { state: QUERY_TEST_STATES.TESTED_NEGATIVE, reason: `${incrementalCompatible} incremental compatible postings, below ${QUERY_TEST.minIncrementalCompatible}`, ratio, redundant: true };
  }
  return { state: QUERY_TEST_STATES.TESTED_POSITIVE, reason: `${sample} postings, ${Math.round(ratio * 100)}% compatible, ${incrementalCompatible} incremental`, ratio };
}

module.exports = {
  POLICY_VERSION, VOCABULARY_STATES, QUERY_TEST_STATES, QUERY_USE,
  PROMOTION, QUERY_TEST, PORTFOLIO, GENERIC_TOKENS, SHARED_TOKEN_TERMS,
  tokensOf, assessGenericity, conflictsWithExclusions, classifyVocabulary, evaluateQueryTest,
};

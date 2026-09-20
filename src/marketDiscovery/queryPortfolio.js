'use strict';

// MD6 — de un ledger de exploracion (MD5) a: estado de vocabulario, candidatos de
// busqueda y un portafolio propuesto.
//
// Transformacion PURA y determinista: sin LinkedIn, sin OpenAI, sin navegador, sin
// propiedad de operacion, sin escritura. NO aplica nada: produce una PROPUESTA.
// Cambiar las queries de Hunter es decision del usuario en un checkpoint posterior.

const { hash, freeze, normalize, assert } = require('./domain');
const {
  POLICY_VERSION, VOCABULARY_STATES, QUERY_TEST_STATES, QUERY_USE,
  PROMOTION, QUERY_TEST, PORTFOLIO,
  assessGenericity, conflictsWithExclusions, classifyVocabulary, evaluateQueryTest,
} = require('./vocabularyPolicy');

const SCHEMA_VERSION = 1;
const CANDIDATE_SOURCES = Object.freeze({
  SEED: 'SEED_EXPRESSION',
  ROLE_TITLE: 'PROMOTED_ROLE_TITLE',
  COMBINATION: 'OBSERVED_COMBINATION',
  EXPANSION: 'TESTED_EXPANSION_TERM',
});
// Estado factual de una query de Hunter frente a ESTA muestra. Nunca un juicio.
const CURRENT_QUERY_STATUS = Object.freeze({
  KEEP: 'KEEP',
  REVIEW: 'REVIEW',
  NOT_SUPPORTED_BY_THIS_SAMPLE: 'NOT_SUPPORTED_BY_THIS_SAMPLE',
});

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// Normalizacion de queries de Hunter, alineada con la del editor de busquedas
// (comparacion insensible a mayusculas), reforzada con la normalizacion de MD.
function normalizeCurrentQueries(input) {
  if (input === undefined || input === null) return null;
  const rows = Array.isArray(input) ? input : (input && Array.isArray(input.queryGroups)
    ? input.queryGroups.flatMap((group) => (group.queries || []).map((item) => ({
      query: typeof item === 'string' ? item : item && item.query, family: group.family || null, enabled: typeof item === 'object' && item ? item.enabled !== false : true,
    })))
    : null);
  assert(Array.isArray(rows), 'currentQueries must be a list or a queryGroups object');
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const text = typeof row === 'string' ? row : (row && typeof row.query === 'string' ? row.query : null);
    if (!text || !text.trim()) continue;
    const normalized = normalize(text);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({
      query: text.trim(), normalized,
      family: typeof row === 'object' && row && typeof row.family === 'string' ? row.family : null,
      enabled: typeof row === 'object' && row ? row.enabled !== false : true,
    });
  }
  return out;
}

function buildQueryPortfolio(input = {}) {
  const ledger = input.exploration;
  assert(ledger && typeof ledger === 'object' && Array.isArray(ledger.observations), 'an exploration ledger is required');
  const profile = input.profile || {};
  const currentQueries = normalizeCurrentQueries(input.currentQueries);
  const target = { ...PORTFOLIO, ...(input.portfolio || {}) };
  assert(target.targetMin <= target.targetMax && target.targetMax <= PORTFOLIO.hardMax, 'invalid portfolio targets');

  const warnings = [];
  if (ledger.partial) warnings.push(`exploration was partial (${ledger.stopReason}); evidence is incomplete`);

  const postingsByKey = new Map((ledger.postings || []).map((posting) => [posting.postingKey, posting]));
  const compatibleKeys = new Set((ledger.postings || []).filter((posting) => posting.classification === 'COMPATIBLE').map((posting) => posting.postingKey));
  const searchesById = new Map((ledger.searches || []).map((entry) => [entry.searchId, entry]));
  const familyExpression = new Map((ledger.families || []).map((family) => [family.familyId, family.expression]));
  const exclusionTexts = (Array.isArray(profile.exclusions) ? profile.exclusions : [])
    .map((fact) => normalize(fact && fact.text)).filter(Boolean);

  // ---------------------------------------------------------------- vocabulario
  // Solo observaciones ancladas, promocionables y de ofertas COMPATIBLE.
  const grouped = new Map();
  for (const observation of ledger.observations || []) {
    if (observation.promotable !== true) continue;
    if (!compatibleKeys.has(observation.postingKey)) continue;
    const key = observation.normalized;
    if (!key) continue;
    if (!grouped.has(key)) {
      grouped.set(key, {
        normalized: key, variants: [], types: [], postingKeys: [], companies: [], familyIds: [],
        searchIds: [], sourceFields: [], initialEvidence: 0, expansionEvidence: 0, observations: 0,
      });
    }
    const term = grouped.get(key);
    term.observations += 1;
    if (!term.variants.includes(observation.expression)) term.variants.push(observation.expression);
    if (!term.types.includes(observation.type)) term.types.push(observation.type);
    // Una oferta cuenta UNA vez por mucho que se mencione dentro de ella.
    if (!term.postingKeys.includes(observation.postingKey)) term.postingKeys.push(observation.postingKey);
    if (observation.company && !term.companies.includes(observation.company)) term.companies.push(observation.company);
    if (!term.sourceFields.includes(observation.sourceField)) term.sourceFields.push(observation.sourceField);
    for (const familyId of observation.familyIds || []) if (!term.familyIds.includes(familyId)) term.familyIds.push(familyId);
    for (const searchId of observation.searchIds || []) if (!term.searchIds.includes(searchId)) term.searchIds.push(searchId);
    if (observation.depth === 0) term.initialEvidence += 1; else term.expansionEvidence += 1;
  }

  const allNormalized = [...grouped.keys()];
  const vocabulary = [...grouped.values()].map((term) => {
    const postingsWithCompany = term.postingKeys.filter((key) => {
      const posting = postingsByKey.get(key);
      return posting && posting.company;
    }).length;
    const enriched = {
      ...term,
      distinctPostings: term.postingKeys.length,
      distinctCompanies: term.companies.length,
      distinctFamilies: term.familyIds.length,
      postingsWithCompany,
      conflictsWithExclusion: conflictsWithExclusions(term.normalized, exclusionTexts),
      // El idioma NO se infiere: MD4 nunca lo afirma de una oferta y la query
      // que la encontro no lo prueba. Se deja explicitamente no evidenciado.
      language: null,
      languageEvidence: 'not evidenced by the sample',
    };
    const classified = classifyVocabulary(enriched);
    const generic = assessGenericity(term.normalized, allNormalized);
    return { ...enriched, state: classified.state, stateReason: classified.reason, generic: generic.generic, genericReason: generic.reason };
  }).sort((a, b) => b.distinctPostings - a.distinctPostings || b.distinctCompanies - a.distinctCompanies || a.normalized.localeCompare(b.normalized, 'en'));
  const vocabularyByNormalized = new Map(vocabulary.map((term) => [term.normalized, term]));

  // ------------------------------------------------- evidencia de query probada
  // Toda busqueda COMPLETADA del ledger es un test controlado, sea semilla o expansion.
  const testsByNormalizedQuery = new Map();
  for (const entry of ledger.searches || []) {
    if (entry.status !== 'COMPLETED') continue;
    const unique = [...new Set(entry.resultKeys || [])];
    const evaluated = unique.filter((key) => postingsByKey.has(key) && postingsByKey.get(key).evaluated);
    const tally = { COMPATIBLE: 0, UNCERTAIN: 0, OUT_OF_SCOPE: 0 };
    let incremental = 0;
    for (const key of evaluated) {
      const posting = postingsByKey.get(key);
      if (tally[posting.classification] !== undefined) tally[posting.classification] += 1;
      if (posting.classification === 'COMPATIBLE' && posting.firstSearchId === entry.searchId) incremental += 1;
    }
    const metrics = {
      searchId: entry.searchId, depth: entry.depth, sample: evaluated.length,
      uniquePostings: unique.length, compatible: tally.COMPATIBLE, uncertain: tally.UNCERTAIN,
      outOfScope: tally.OUT_OF_SCOPE,
      compatibilityRatio: evaluated.length ? tally.COMPATIBLE / evaluated.length : 0,
      incrementalCompatible: incremental,
      overlapWithKnown: unique.length - (entry.newPostingKeys || []).length,
    };
    testsByNormalizedQuery.set(normalize(entry.query), metrics);
  }

  // -------------------------------------------------------------- candidatos
  const candidates = new Map();
  function addCandidate(expression, source, extra = {}) {
    const normalized = normalize(expression);
    if (!normalized) return null;
    // Duplicado normalizado exacto: un solo candidato, con todas sus procedencias.
    if (candidates.has(normalized)) {
      const existing = candidates.get(normalized);
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return existing;
    }
    const covered = new Set(extra.covers || []);
    const test = testsByNormalizedQuery.get(normalized) || null;
    const verdict = evaluateQueryTest(test);
    const term = vocabularyByNormalized.get(normalized) || null;
    const generic = term ? { generic: term.generic, reason: term.genericReason } : assessGenericity(normalized, allNormalized);
    const conflicts = conflictsWithExclusions(normalized, exclusionTexts);
    let use = QUERY_USE.ELIGIBLE;
    let useReason = 'supported by compatible evidence in this sample';
    if (conflicts) { use = QUERY_USE.INELIGIBLE; useReason = 'matches an explicit profile exclusion'; }
    else if (generic.generic) { use = QUERY_USE.INELIGIBLE; useReason = `too generic to stand alone as a query: ${generic.reason}`; }
    else if (verdict.noisy) { use = QUERY_USE.INELIGIBLE; useReason = `tested and noisy: ${verdict.reason}`; }
    const candidate = {
      expression, normalized, sources: [source],
      familyIds: [...new Set(extra.familyIds || [])],
      covers: [...covered].sort(),
      distinctCompanies: extra.distinctCompanies === undefined ? (term ? term.distinctCompanies : 0) : extra.distinctCompanies,
      support: covered.size,
      vocabularyState: term ? term.state : null,
      testState: verdict.state, testReason: verdict.reason, test,
      queryUse: use, queryUseReason: useReason,
      components: extra.components || null,
      coveredSet: covered,
    };
    candidates.set(normalized, candidate);
    return candidate;
  }

  // 1) Expresiones semilla realmente ejecutadas.
  for (const family of ledger.families || []) {
    const covers = [...compatibleKeys].filter((key) => (postingsByKey.get(key).familyIds || []).includes(family.familyId));
    addCandidate(family.expression, CANDIDATE_SOURCES.SEED, { covers, familyIds: [family.familyId], distinctCompanies: new Set(covers.map((key) => postingsByKey.get(key).company).filter(Boolean)).size });
  }
  // 2) ROLE_TITLE promovidos. 4) terminos de expansion realmente ejecutados.
  for (const term of vocabulary) {
    const isExpansionQuery = testsByNormalizedQuery.has(term.normalized);
    if (term.state !== VOCABULARY_STATES.PROMOTED && !isExpansionQuery) continue;
    if (!term.types.includes('ROLE_TITLE') && !isExpansionQuery) continue;
    addCandidate(term.variants[0], isExpansionQuery ? CANDIDATE_SOURCES.EXPANSION : CANDIDATE_SOURCES.ROLE_TITLE, {
      covers: term.postingKeys.filter((key) => compatibleKeys.has(key)), familyIds: term.familyIds, distinctCompanies: term.distinctCompanies,
    });
  }
  // 3) Combinaciones rol + discriminador SOLO si ambas se observaron en la MISMA
  // oferta compatible. Nunca se inventa una combinacion.
  const promotedRoles = vocabulary.filter((term) => term.state === VOCABULARY_STATES.PROMOTED && term.types.includes('ROLE_TITLE') && !term.generic);
  const promotedDiscriminators = vocabulary.filter((term) => term.state === VOCABULARY_STATES.PROMOTED && term.types.includes('DISCRIMINATOR') && !term.generic);
  for (const role of promotedRoles) {
    for (const discriminator of promotedDiscriminators) {
      if (role.normalized === discriminator.normalized) continue;
      const shared = role.postingKeys.filter((key) => discriminator.postingKeys.includes(key) && compatibleKeys.has(key));
      if (shared.length < PROMOTION.minDistinctPostings) continue;
      addCandidate(`${role.variants[0]} ${discriminator.variants[0]}`, CANDIDATE_SOURCES.COMBINATION, {
        covers: shared, familyIds: [...new Set([...role.familyIds, ...discriminator.familyIds])],
        distinctCompanies: new Set(shared.map((key) => postingsByKey.get(key).company).filter(Boolean)).size,
        components: [role.normalized, discriminator.normalized],
      });
    }
  }

  // ------------------------------------- seleccion greedy por cobertura marginal
  const pool = [...candidates.values()].filter((candidate) => candidate.queryUse === QUERY_USE.ELIGIBLE);
  const ineligible = [...candidates.values()].filter((candidate) => candidate.queryUse !== QUERY_USE.ELIGIBLE);
  const selected = [];
  const coveredKeys = new Set();
  const representedFamilies = new Set();

  while (selected.length < target.targetMax) {
    const scored = pool
      .filter((candidate) => !candidate.selected)
      .map((candidate) => {
        const fresh = [...candidate.coveredSet].filter((key) => !coveredKeys.has(key));
        const addsNewFamily = candidate.familyIds.some((familyId) => !representedFamilies.has(familyId));
        const overlap = coveredKeys.size ? jaccard(candidate.coveredSet, coveredKeys) : 0;
        return { candidate, newCovered: fresh.length, fresh, addsNewFamily, overlap };
      })
      .filter((entry) => entry.newCovered > 0);
    if (!scored.length) break;
    // DIVERSIDAD: si alguna familia evidenciada aun no esta representada y aporta
    // cobertura nueva, tiene su oportunidad ANTES de otra variante redundante de
    // una familia ya cubierta. Es una oportunidad, no una cuota fija.
    const diversityTier = scored.filter((entry) => entry.addsNewFamily);
    const tier = diversityTier.length ? diversityTier : scored;
    tier.sort((a, b) => {
      const testedA = a.candidate.testState === QUERY_TEST_STATES.TESTED_POSITIVE ? 0 : 1;
      const testedB = b.candidate.testState === QUERY_TEST_STATES.TESTED_POSITIVE ? 0 : 1;
      return testedA - testedB
        || b.newCovered - a.newCovered
        || a.overlap - b.overlap
        || b.candidate.distinctCompanies - a.candidate.distinctCompanies
        || b.candidate.support - a.candidate.support
        || a.candidate.normalized.localeCompare(b.candidate.normalized, 'en');
    });
    const winner = tier[0];
    winner.candidate.selected = true;
    for (const key of winner.fresh) coveredKeys.add(key);
    for (const familyId of winner.candidate.familyIds) representedFamilies.add(familyId);
    selected.push({
      expression: winner.candidate.expression,
      normalized: winner.candidate.normalized,
      provenance: [...winner.candidate.sources],
      components: winner.candidate.components,
      status: winner.candidate.testState,
      statusReason: winner.candidate.testReason,
      test: winner.candidate.test,
      vocabularyState: winner.candidate.vocabularyState,
      supportingCompatiblePostings: [...winner.candidate.coveredSet].sort(),
      distinctCompanies: winner.candidate.distinctCompanies,
      families: winner.candidate.familyIds.map((familyId) => ({ familyId, expression: familyExpression.get(familyId) || null })),
      incrementalCoverageAtSelection: winner.newCovered,
      overlapAtSelection: Number(winner.overlap.toFixed(4)),
      introducedNewFamily: winner.addsNewFamily,
      whySelected: `${winner.newCovered} compatible posting(s) not covered by earlier selections`
        + (winner.addsNewFamily ? ', and it represents a family not yet covered' : '')
        + (winner.candidate.testState === QUERY_TEST_STATES.TESTED_POSITIVE ? `, with positive test evidence (${winner.candidate.testReason})` : ''),
    });
  }
  assert(selected.length <= PORTFOLIO.hardMax, 'portfolio exceeded the hard maximum');
  if (selected.length < target.targetMin) {
    warnings.push(`only ${selected.length} defensible quer(ies); evidence does not support the target of ${target.targetMin}`);
  }

  const unselected = [...pool.filter((candidate) => !candidate.selected), ...ineligible].map((candidate) => {
    const remaining = [...candidate.coveredSet].filter((key) => !coveredKeys.has(key));
    let best = null;
    for (const chosen of selected) {
      const overlap = jaccard(candidate.coveredSet, new Set(chosen.supportingCompatiblePostings));
      if (!best || overlap > best.overlap) best = { normalized: chosen.normalized, overlap: Number(overlap.toFixed(4)) };
    }
    const reason = candidate.queryUse !== QUERY_USE.ELIGIBLE ? candidate.queryUseReason
      : remaining.length === 0 ? 'every compatible posting it covers is already covered by a selected query'
        : `beyond the portfolio target of ${target.targetMax}`;
    return {
      expression: candidate.expression, normalized: candidate.normalized, provenance: [...candidate.sources],
      queryUse: candidate.queryUse, vocabularyState: candidate.vocabularyState,
      status: candidate.testState, statusReason: candidate.testReason,
      support: candidate.support, remainingIncrementalCoverage: remaining.length,
      redundantWith: best, reason,
    };
  }).sort((a, b) => b.support - a.support || a.normalized.localeCompare(b.normalized, 'en'));

  // --------------------------------------------- comparacion con queries actuales
  let comparison = null;
  if (currentQueries) {
    comparison = currentQueries.map((current) => {
      const test = testsByNormalizedQuery.get(current.normalized) || null;
      const verdict = evaluateQueryTest(test);
      const proposed = selected.some((entry) => entry.normalized === current.normalized);
      // La AUSENCIA de una query en esta muestra no es evidencia de fracaso.
      const status = test
        ? (verdict.state === QUERY_TEST_STATES.TESTED_POSITIVE ? CURRENT_QUERY_STATUS.KEEP : CURRENT_QUERY_STATUS.REVIEW)
        : CURRENT_QUERY_STATUS.NOT_SUPPORTED_BY_THIS_SAMPLE;
      return {
        query: current.query, normalized: current.normalized, family: current.family, enabled: current.enabled,
        status, alsoProposed: proposed, test, testState: verdict.state,
        note: test
          ? `executed in this exploration: ${verdict.reason}`
          : 'not executed in this bounded exploration; this sample says nothing about it',
      };
    });
  }

  const evidenceCoverage = {
    compatiblePostings: compatibleKeys.size,
    coveredByPortfolio: coveredKeys.size,
    uncoveredCompatiblePostings: [...compatibleKeys].filter((key) => !coveredKeys.has(key)).sort(),
    familiesRepresented: [...representedFamilies].sort(),
    familiesWithCompatibleEvidence: [...new Set([...compatibleKeys].flatMap((key) => postingsByKey.get(key).familyIds || []))].sort(),
  };

  const sourceExploration = {
    operationId: ledger.operationId || null, status: ledger.status || null,
    partial: ledger.partial === true, hash: hash(ledger),
  };
  const identityInput = {
    schemaVersion: SCHEMA_VERSION, policyVersion: POLICY_VERSION, exploration: sourceExploration.hash,
    targets: { targetMin: target.targetMin, targetMax: target.targetMax, hardMax: PORTFOLIO.hardMax },
    selected: selected.map((entry) => entry.normalized),
  };

  return freeze({
    schemaVersion: SCHEMA_VERSION,
    policy: {
      version: POLICY_VERSION, promotion: { ...PROMOTION }, queryTest: { ...QUERY_TEST },
      portfolio: { targetMin: target.targetMin, targetMax: target.targetMax, hardMax: PORTFOLIO.hardMax },
    },
    sourceExploration,
    proposalId: hash(identityInput),
    applied: false,
    vocabulary: vocabulary.map((term) => ({
      normalized: term.normalized, variants: term.variants, types: term.types,
      state: term.state, stateReason: term.stateReason,
      distinctPostings: term.distinctPostings, distinctCompanies: term.distinctCompanies, distinctFamilies: term.distinctFamilies,
      postingsWithCompany: term.postingsWithCompany, observations: term.observations,
      initialEvidence: term.initialEvidence, expansionEvidence: term.expansionEvidence,
      sourceFields: term.sourceFields, postingKeys: [...term.postingKeys].sort(), searchIds: [...term.searchIds].sort(),
      familyIds: [...term.familyIds].sort(), companies: [...term.companies].sort(),
      generic: term.generic, genericReason: term.genericReason,
      language: term.language, languageEvidence: term.languageEvidence,
    })),
    queryCandidates: [...candidates.values()].map((candidate) => ({
      expression: candidate.expression, normalized: candidate.normalized, provenance: [...candidate.sources],
      queryUse: candidate.queryUse, queryUseReason: candidate.queryUseReason,
      status: candidate.testState, statusReason: candidate.testReason, support: candidate.support,
      familyIds: [...candidate.familyIds], components: candidate.components,
    })).sort((a, b) => b.support - a.support || a.normalized.localeCompare(b.normalized, 'en')),
    selectedQueries: selected,
    unselectedCandidates: unselected,
    currentQueryComparison: comparison,
    evidenceCoverage,
    warnings,
  });
}

module.exports = { buildQueryPortfolio, normalizeCurrentQueries, CANDIDATE_SOURCES, CURRENT_QUERY_STATUS, SCHEMA_VERSION };

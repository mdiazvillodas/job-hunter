'use strict';

const { SCHEMA_VERSION, MAX_SEEDS, normalize, hash, freeze, validateProfile, validateSeeds } = require('./domain');

// Level-only terms. Role-defining words (lead, project, technical, head, chief,
// staff...) are deliberately NOT stripped: they change the concept, not the level.
const LEVEL_MODIFIERS = new Set(['senior', 'sr', 'snr', 'junior', 'jr', 'jnr', 'principal']);
// Lower rank is explored first. Explicit targets outrank inferred evidence.
const CATEGORY_RANK = { 'explicit-target': 0, desired: 1, 'desired-domain': 2, 'demonstrated-domain': 3, demonstrated: 4 };
const SELECTION_PRIORITY = Object.freeze(['evidence category', 'distinct evidence count', 'supporting expressions',
  'profile order', 'stable family id']);

function tokens(text) { return normalize(text).split(' ').filter(Boolean); }

// Canonical concept of an expression. Level stripping can never empty a supported
// target: it falls back to the unstripped tokens, then to the expression itself.
function concept(text) {
  const all = tokens(text);
  const stripped = all.filter(token => !LEVEL_MODIFIERS.has(token));
  const unique = [...new Set(stripped.length ? stripped : all)].sort();
  return unique.length ? unique : [String(text).trim().toLowerCase()];
}
// Families merge only on an identical canonical concept. Equality is an
// equivalence relation, so no third expression can bridge two distinct concepts.
function familyKey(text) { return concept(text).join(' '); }

function buildSeed(family, rank) {
  const facts = family.facts.slice().sort((a, b) => tokens(a.text).length - tokens(b.text).length
    || a.text.length - b.text.length || a.text.localeCompare(b.text, 'en'));
  const first = facts[0];
  return { schemaVersion: SCHEMA_VERSION, status: 'HYPOTHESIS', expression: first.text, normalizedExpression: normalize(first.text),
    familyId: family.familyId, family: first.family || first.text,
    language: facts.every(f => f.language === first.language) ? first.language : 'und',
    context: [], evidence: [...new Set(facts.flatMap(f => f.evidence))], sources: [...new Set(facts.flatMap(f => f.sources))].sort(),
    evidenceCategory: first.category, support: facts.length, rank,
    reason: 'Priority ' + rank + ' by ' + first.category + ', ' + new Set(facts.flatMap(f => f.evidence)).size
      + ' evidence item(s) and ' + facts.length + ' supporting expression(s). Level and word-order variants share this'
      + ' family; a materially different concept does not.' };
}

// Deterministic, explainable ordering. The family id is only a last-resort
// tie-breaker: it never decides which families survive the cap.
function rankFamilies(profile) {
  validateProfile(profile);
  // Explicit targets lead. Evidenced capabilities are a fallback, not six arbitrary CV keywords.
  const candidates = profile.targetResponsibilities.length ? profile.targetResponsibilities : profile.demonstratedCapabilities;
  const families = new Map();
  candidates.forEach((fact, order) => {
    const key = familyKey(fact.text);
    const family = families.get(key);
    if (family) family.facts.push(fact);
    else families.set(key, { key, order, familyId: 'family-' + hash(key).slice(0, 16), facts: [fact] });
  });
  return [...families.values()]
    .map(family => ({ ...family, evidence: new Set(family.facts.flatMap(f => f.evidence)).size,
      categoryRank: CATEGORY_RANK[family.facts[0].category] ?? CATEGORY_RANK.demonstrated }))
    .sort((a, b) => a.categoryRank - b.categoryRank || b.evidence - a.evidence || b.facts.length - a.facts.length
      || a.order - b.order || a.familyId.localeCompare(b.familyId));
}

// Seeds plus the truncation diagnostics a later phase needs. Nothing is silently dropped.
function generateSeedPlan(profile) {
  const ranked = rankFamilies(profile);
  const seeds = validateSeeds(ranked.slice(0, MAX_SEEDS).map((family, index) => buildSeed(family, index + 1)));
  const omittedFamilies = ranked.slice(MAX_SEEDS).map((family, index) => {
    const rank = MAX_SEEDS + index + 1;
    return { familyId: family.familyId, expression: buildSeed(family, rank).expression, rank,
      reason: 'Considered and ranked, but beyond the ' + MAX_SEEDS + '-family checkpoint limit.' };
  });
  return freeze({ seeds, familiesConsidered: ranked.length, familiesSelected: seeds.length,
    truncated: omittedFamilies.length > 0, omittedFamilies, priority: [...SELECTION_PRIORITY] });
}

function generateSeeds(profile) { return generateSeedPlan(profile).seeds; }
module.exports = { generateSeeds, generateSeedPlan, MAX_SEEDS };

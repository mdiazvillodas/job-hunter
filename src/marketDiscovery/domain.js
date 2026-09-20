'use strict';

const crypto = require('crypto');
const SCHEMA_VERSION = 1;
const MAX_SEEDS = 6;
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function normalize(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function assert(condition, message) { if (!condition) throw new Error('MARKET_DISCOVERY_INVALID: ' + message); }
function keys(value, allowed, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), label);
  assert(Object.keys(value).every(key => allowed.includes(key)), label + ' unexpected field');
}
function strings(value, label) { assert(Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim()), label); }
function validateProfile(profile) {
  assert(profile && profile.schemaVersion === SCHEMA_VERSION, 'profile version');
  keys(profile, ['schemaVersion', 'demonstratedCapabilities', 'targetResponsibilities', 'desiredDirection', 'exclusions', 'market', 'seniority', 'domains', 'workplacePreference', 'unknowns', 'provenance'], 'profile');
  for (const field of ['demonstratedCapabilities', 'targetResponsibilities', 'desiredDirection', 'exclusions', 'domains', 'unknowns']) {
    assert(Array.isArray(profile[field]), field);
  }
  for (const field of ['market', 'seniority', 'workplacePreference', 'provenance']) assert(profile[field] && typeof profile[field] === 'object', field);
  for (const fact of [...profile.demonstratedCapabilities, ...profile.targetResponsibilities, ...profile.desiredDirection, ...profile.exclusions, ...profile.domains]) {
    keys(fact, ['text', 'family', 'evidence', 'category', 'sources', 'language'], 'fact');
    assert(typeof fact.text === 'string' && fact.text.trim() && Array.isArray(fact.sources) && fact.sources.length, 'fact provenance');
    assert(Array.isArray(fact.evidence), 'fact evidence');
    strings(fact.evidence, 'evidence'); strings(fact.sources, 'sources');
    assert(['demonstrated', 'explicit-target', 'desired', 'explicit-exclusion', 'demonstrated-domain', 'desired-domain'].includes(fact.category), 'fact category');
    assert(typeof fact.language === 'string' && /^(und|[a-z]{2,3}(?:-[A-Za-z]{2,4})?)$/.test(fact.language), 'fact language');
  }
  assert(profile.demonstratedCapabilities.every(f => f.evidence.length > 0), 'capability requires evidence');
  assert(profile.exclusions.every(f => f.category === 'explicit-exclusion'), 'exclusion category');
  assert(profile.demonstratedCapabilities.every(f => f.category === 'demonstrated'), 'demonstrated category');
  keys(profile.market, ['locations', 'languages', 'sources'], 'market');
  strings(profile.market.locations, 'locations'); strings(profile.market.languages, 'languages'); strings(profile.market.sources, 'market sources');
  keys(profile.seniority, ['level', 'evidence', 'sources'], 'seniority');
  assert(typeof profile.seniority.level === 'string', 'seniority level'); strings(profile.seniority.evidence, 'seniority evidence'); strings(profile.seniority.sources, 'seniority sources');
  keys(profile.workplacePreference, ['values', 'enforcement', 'sources'], 'workplace');
  strings(profile.workplacePreference.values, 'workplace values'); strings(profile.workplacePreference.sources, 'workplace sources');
  assert(profile.workplacePreference.enforcement === 'unspecified', 'workplace enforcement');
  strings(profile.unknowns, 'unknowns');
  keys(profile.provenance, ['derivationVersion', 'inputHashes'], 'provenance');
  assert(profile.provenance.derivationVersion === 1, 'derivation version');
  keys(profile.provenance.inputHashes, ['profile', 'matchingProfile', 'careerContext', 'search'], 'input hashes');
  assert(Object.keys(profile.provenance.inputHashes).length === 4 && Object.values(profile.provenance.inputHashes).every(v => /^[a-f0-9]{64}$/.test(v)), 'input hashes');
  return profile;
}
function validateSeeds(seeds) {
  assert(Array.isArray(seeds) && seeds.length <= MAX_SEEDS, 'at most six seeds');
  const families = new Set();
  seeds.forEach((seed, index) => {
    keys(seed, ['schemaVersion', 'status', 'expression', 'normalizedExpression', 'familyId', 'family', 'language', 'context', 'evidence', 'sources', 'evidenceCategory', 'support', 'rank', 'reason'], 'seed');
    assert(seed.schemaVersion === SCHEMA_VERSION && seed.status === 'HYPOTHESIS', 'seed version/status');
    assert(typeof seed.expression === 'string' && seed.expression.trim(), 'seed expression');
    assert(seed.normalizedExpression === normalize(seed.expression), 'normalized expression');
    assert(typeof seed.familyId === 'string' && /^family-[a-f0-9]{16}$/.test(seed.familyId), 'family identity');
    assert(!families.has(seed.familyId), 'duplicate family'); families.add(seed.familyId);
    assert(Array.isArray(seed.sources) && seed.sources.length && Array.isArray(seed.evidence), 'seed evidence');
    assert(typeof seed.language === 'string' && typeof seed.reason === 'string', 'seed metadata');
    // Selection order is explicit and contiguous, so a reader can tell why a seed ranked where it did.
    assert(Number.isInteger(seed.support) && seed.support > 0, 'seed support');
    assert(Number.isInteger(seed.rank) && seed.rank === index + 1, 'seed rank order');
    strings(seed.sources, 'seed sources'); strings(seed.evidence, 'seed evidence'); strings(seed.context, 'seed context');
  });
  return seeds;
}
module.exports = { SCHEMA_VERSION, MAX_SEEDS, hash, freeze, normalize, assert, keys, validateProfile, validateSeeds };

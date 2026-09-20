'use strict';

const { SCHEMA_VERSION, hash, freeze, validateProfile } = require('./domain');

// Nobiliary/connective particles carry no identifying power on their own and are
// ordinary words elsewhere, so a name component matching one is never redacted.
const NAME_PARTICLES = new Set(['del', 'van', 'von', 'der', 'den', 'dos', 'das', 'bin', 'ibn', 'abu', 'the', 'and']);
// Components shorter than this are only redacted when they are the whole known name.
const MIN_COMPONENT = 3;
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A known full name, plus each meaningful component of it. Longest first so the
// full name wins the alternation and a single pass never rescans its own output.
function identityTerms(identities) {
  const terms = new Set();
  for (const identity of identities) {
    const full = String(identity).trim();
    if (!full) continue;
    terms.add(full);
    for (const part of full.split(/[\s.,;:]+/).filter(Boolean)) {
      if (part.length >= MIN_COMPONENT && !NAME_PARTICLES.has(part.toLowerCase())) terms.add(part);
    }
  }
  return [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

// Pure projection: no IO, model calls, profession taxonomy or preference learning.
function deriveProfile(inputs) {
  const { profile = {}, matchingProfile = {}, careerContext = {}, config = {} } = inputs;
  const terms = identityTerms([config.identity && config.identity.name, profile.meta && profile.meta.person,
    matchingProfile.meta && matchingProfile.meta.person, careerContext.meta && careerContext.meta.person].filter(Boolean));
  // Unicode-aware word boundaries: a known name is redacted as a whole word only,
  // so ordinary professional vocabulary that merely starts with it is left intact.
  const identityPattern = terms.length
    ? new RegExp('(?<![\\p{L}\\p{N}_])(?:' + terms.map(escapeRegExp).join('|') + ')(?![\\p{L}\\p{N}_])', 'giu')
    : null;
  const clean = value => {
    let text = typeof value === 'string' ? value : '';
    // Contact shapes first: an address is redacted whole instead of being split by a name match.
    text = text.replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[\w-]+/gi, '[contact]').replace(/\+?\d[\d ()-]{7,}\d/g, '[contact]');
    if (identityPattern) text = text.replace(identityPattern, '[person]');
    return text.trim();
  };
  const strings = value => (Array.isArray(value) ? value : []).map(clean).filter(Boolean);
  const facts = (items, source, category) => (Array.isArray(items) ? items : []).flatMap((item, i) => {
    const text = clean(typeof item === 'string' ? item : item && (item.statement || item.text || item.name));
    return text ? [{ text, evidence: strings(item && item.evidence), category, sources: [source + '/' + i],
      language: item && typeof item.language === 'string' && /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(item.language) ? item.language : 'und' }] : [];
  });
  const demonstratedCapabilities = facts(profile.capabilities, 'profile/capabilities', 'demonstrated').filter(f => f.evidence.length);
  // Structured matching capability buckets are deliberately not used as role families.
  const extraCapabilities = facts(careerContext.capabilityModel && careerContext.capabilityModel.capabilities,
    'careerContext/capabilityModel/capabilities', 'demonstrated').filter(f => f.evidence.length);
  const dedupe = list => {
    const map = new Map();
    for (const fact of list) {
      const key = fact.category + ':' + fact.text;
      const prior = map.get(key);
      if (!prior) map.set(key, fact);
      else {
        prior.evidence = [...new Set([...prior.evidence, ...fact.evidence])];
        prior.sources = [...new Set([...prior.sources, ...fact.sources])];
        if (prior.language !== fact.language) prior.language = 'und';
      }
    }
    return [...map.values()];
  };
  const roles = [];
  const matchingRoles = matchingProfile.targetRoles && matchingProfile.targetRoles.primary;
  const roleSource = Array.isArray(matchingRoles) && matchingRoles.length ? 'matchingProfile' : 'careerContext';
  const groups = (roleSource === 'matchingProfile' ? matchingRoles : careerContext.targetRoles && careerContext.targetRoles.primary) || [];
  groups.forEach((group, i) => strings(group.roles).forEach((text, j) => roles.push({ text, family: clean(group.roleFamily),
    category: 'explicit-target', evidence: strings(group.evidence), sources: [roleSource + '/targetRoles/primary/' + i + '/roles/' + j],
    language: typeof group.language === 'string' && /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(group.language) ? group.language : 'und' })));
  // Each projected array owns its facts: no output value shares a reference with another.
  const copies = list => list.map(fact => ({ ...fact, evidence: [...fact.evidence], sources: [...fact.sources] }));
  const targetResponsibilities = dedupe([...copies(roles), ...facts(profile.targetResponsibilities, 'profile/targetResponsibilities', 'explicit-target'),
    ...facts(careerContext.targetResponsibilities, 'careerContext/targetResponsibilities', 'explicit-target')]);
  const preferences = matchingProfile.careerPreferences || {};
  const desiredDirection = dedupe([...copies(roles), ...facts(preferences.explicit || profile.preferences,
    preferences.explicit ? 'matchingProfile/careerPreferences/explicit' : 'profile/preferences', 'desired')]);
  const exclusions = dedupe([...facts(matchingProfile.roleTypesToAvoid, 'matchingProfile/roleTypesToAvoid', 'explicit-exclusion'),
    ...facts(preferences.avoidAsPrimaryDirection, 'matchingProfile/careerPreferences/avoidAsPrimaryDirection', 'explicit-exclusion'),
    ...facts(careerContext.careerPreferencesToAvoid, 'careerContext/careerPreferencesToAvoid', 'explicit-exclusion')]);
  const domains = dedupe([...facts(profile.industries, 'profile/industries', 'demonstrated-domain').filter(f => f.evidence.length),
    ...facts(profile.domains, 'profile/domains', 'demonstrated-domain').filter(f => f.evidence.length),
    ...facts(matchingProfile.targetDomains, 'matchingProfile/targetDomains', 'desired-domain')]);
  const search = config.search || {};
  const seniority = profile.seniority || matchingProfile.seniority || {};
  const model = {
    schemaVersion: SCHEMA_VERSION,
    demonstratedCapabilities: dedupe([...demonstratedCapabilities, ...extraCapabilities]),
    targetResponsibilities, desiredDirection, exclusions,
    market: { locations: strings(search.locations), languages: strings(search.languages), sources: ['config/search'] },
    seniority: { level: clean(seniority.assessedLevel), evidence: strings(seniority.evidence), sources: [profile.seniority ? 'profile/seniority' : 'matchingProfile/seniority'] },
    domains,
    workplacePreference: { values: strings(search.modalities), enforcement: 'unspecified', sources: ['config/search/modalities'] },
    unknowns: [...new Set([...strings(profile.unknowns), ...strings(matchingProfile.unknowns), ...strings(careerContext.unknowns),
      ...(!domains.length ? ['No structured, evidenced domain information available.'] : []),
      ...(!search.languages || !search.languages.length ? ['Search language is unspecified; no language inferred from geography.'] : [])])],
    provenance: { derivationVersion: 1, inputHashes: { profile: hash(profile), matchingProfile: hash(matchingProfile), careerContext: hash(careerContext),
      search: hash(search) } },
  };
  return freeze(validateProfile(model));
}

// Read only through the existing readers; importing this module does not read user data.
function deriveCurrentProfile() {
  const readers = require('../ai/marianoProfile');
  return deriveProfile({ profile: readers.getProfile(), matchingProfile: readers.getMatchingProfile(),
    careerContext: readers.getCareerContext(), config: require('../config/userConfig').getUserConfig() });
}
module.exports = { deriveProfile, deriveCurrentProfile };

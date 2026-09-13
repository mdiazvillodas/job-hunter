'use strict';

function normalizeFact(value) {
  return typeof value === 'string' ? value.trim().normalize('NFC').toLowerCase() : '';
}

function buildProfileFactRegistry(careerContext, profile) {
  const entries = [];
  const byNormalizedScope = new Map();
  const counters = { EXP: 0, CAP: 0, PREF: 0, UNK: 0 };
  function add(prefix, kind, text, scope = 'professional', metadata = {}) {
    const normalized = normalizeFact(text);
    if (!normalized) return;
    const key = `${scope}:${normalized}`;
    const existing = byNormalizedScope.get(key);
    if (existing) {
      if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
      return;
    }
    counters[prefix] += 1;
    const entry = { id: `${prefix}_${String(counters[prefix]).padStart(3, '0')}`, kind, kinds: [kind], text, ...metadata };
    entries.push(entry);
    byNormalizedScope.set(key, entry);
  }
  const addEvidenceItems = (items, prefix, kind) => items.forEach((item) => {
    add(prefix, kind, item.statement);
    item.evidence.forEach((text) => add(prefix, kind, text));
  });
  addEvidenceItems(careerContext.experienceContext, 'EXP', 'experience');
  addEvidenceItems(profile.experience, 'EXP', 'experience');
  careerContext.capabilityModel.capabilities.forEach((item) => item.evidence.forEach((text) => add('CAP', 'capability', text)));
  profile.capabilities.forEach((item) => item.evidence.forEach((text) => add('CAP', 'capability', text)));
  careerContext.careerPreferences
    .forEach((text) => add('PREF', 'preference', text, 'preference:career-positive', { preferenceType: 'career_positive' }));
  (careerContext.careerPreferencesToAvoid || [])
    .forEach((text) => add('PREF', 'preference', text, 'preference:career-negative', { preferenceType: 'career_negative' }));
  careerContext.workEnvironment.preferences
    .forEach((text) => add('PREF', 'preference', text, 'preference:work-environment', { preferenceType: 'work_environment' }));
  [...careerContext.unknowns, ...profile.unknowns].forEach((text) => add('UNK', 'unknown', text, 'unknown'));
  return {
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    capabilityEvidenceIds: entries.filter((entry) => entry.kinds.includes('experience') || entry.kinds.includes('capability')).map((entry) => entry.id),
    experienceEvidenceIds: entries.filter((entry) => entry.kinds.includes('experience')).map((entry) => entry.id),
    preferenceIds: entries.filter((entry) => entry.kind === 'preference').map((entry) => entry.id),
    positiveCareerPreferenceIds: entries.filter((entry) => entry.preferenceType === 'career_positive').map((entry) => entry.id),
    negativeCareerPreferenceIds: entries.filter((entry) => entry.preferenceType === 'career_negative').map((entry) => entry.id),
    workEnvironmentPreferenceIds: entries.filter((entry) => entry.preferenceType === 'work_environment').map((entry) => entry.id),
  };
}

function hydrateRefs(refs, registry, allowedIds, label) {
  const allowed = new Set(allowedIds);
  const seen = new Set();
  const texts = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.trim() || !registry.byId.has(ref) || !allowed.has(ref)) {
      const error = new Error(`${label} contiene una referencia de evidencia inválida.`);
      error.code = 'INCONSISTENT_PROFILE_ARTIFACTS'; error.statusCode = 502;
      throw error;
    }
    if (seen.has(ref)) continue;
    seen.add(ref);
    texts.push(registry.byId.get(ref).text);
  }
  return texts;
}

module.exports = { normalizeFact, buildProfileFactRegistry, hydrateRefs };

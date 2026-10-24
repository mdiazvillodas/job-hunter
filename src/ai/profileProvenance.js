'use strict';
const crypto = require('crypto');
const { section, sections } = require('./simpleProfile');
// Source units are whole records/sections, never keyword snippets. No semantic judgments.
function profileUnits(profile) {
  const units = [];
  const add = (reference, value, label) => {
    if (value != null && (typeof value !== 'string' || value.trim()))
      units.push({ reference, label, content: JSON.parse(JSON.stringify(value)) });
  };
  if (Object.hasOwn(profile, 'candidateDocument')) {
    ['profession', 'experience', 'capabilities'].forEach((name, i) =>
      add('/' + name, section(profile.candidateDocument, sections[i]), sections[i]));
    return units;
  }
  for (const name of ['experience', 'capabilities', 'languages', 'methodologies', 'education']) {
    const value = profile[name];
    const entries = (base, data) => {
      if (Array.isArray(data) && data.length && data.every(x => x && typeof x === 'object' && !Array.isArray(x)))
        data.forEach((item, index) => add(base + '/' + index, item, name));
      else if (data != null) add(base, data, name);
    };
    if (name === 'capabilities' && value && !Array.isArray(value) && typeof value === 'object')
      Object.entries(value).forEach(([key, data]) => entries('/capabilities/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), data));
    else entries('/' + name, value);
  }
  return units;
}
function attachProfileProvenance(analysis, profile) {
  const units = new Map(profileUnits(profile).map(unit => [unit.reference, unit]));
  return { ...analysis, profileProvenance: {
    version: 1,
    profileHash: crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
    // Save the source at analysis time; later profile edits must not silently change it.
    requirements: (analysis.requirementAssessments || []).map(item => ({
      reference: typeof item.profileReference === 'string' ? item.profileReference : null,
      source: units.get(item.profileReference) || null,
    })),
  } };
}
module.exports = { profileUnits, attachProfileProvenance };

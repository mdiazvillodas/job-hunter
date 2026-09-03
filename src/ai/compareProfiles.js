'use strict';

// Compara el perfil completo vs el matching profile condensado (Milestone 6A.1).
// Muestra caracteres, tokens aproximados y reduccion. Valida copias independientes/no mutables.
//
// Uso: node src/ai/compareProfiles.js

const { getProfile, getMatchingProfile } = require('./marianoProfile');

// Aproximacion habitual para modelos OpenAI: ~4 caracteres por token.
function approxTokens(str) {
  return Math.round(str.length / 4);
}

function sizeOf(obj) {
  const compact = JSON.stringify(obj);
  const pretty = JSON.stringify(obj, null, 2);
  return {
    chars: compact.length,
    prettyChars: pretty.length,
    approxTokens: approxTokens(compact),
    kb: (Buffer.byteLength(compact, 'utf8') / 1024).toFixed(1),
  };
}

function topLevelKeys(obj) {
  return Object.keys(obj);
}

function main() {
  const full = getProfile();
  const matching = getMatchingProfile();

  const fullSize = sizeOf(full);
  const matchingSize = sizeOf(matching);

  const charsReduction = (100 * (1 - matchingSize.chars / fullSize.chars)).toFixed(1);
  const tokenReduction = (100 * (1 - matchingSize.approxTokens / fullSize.approxTokens)).toFixed(1);

  console.log('=== PROFILE SIZE COMPARISON ===');
  console.log(`Full profile     : ${fullSize.chars} chars (${fullSize.kb} KB) | ~${fullSize.approxTokens} tokens`);
  console.log(`Matching profile : ${matchingSize.chars} chars (${matchingSize.kb} KB) | ~${matchingSize.approxTokens} tokens`);
  console.log(`Reduction        : ${charsReduction}% chars | ~${tokenReduction}% tokens`);
  console.log(`Approx tokens saved per job: ~${fullSize.approxTokens - matchingSize.approxTokens}`);

  console.log('\n=== TOP-LEVEL KEYS ===');
  const fullKeys = topLevelKeys(full);
  const matchingKeys = topLevelKeys(matching);
  console.log('full     :', fullKeys.join(', '));
  console.log('matching :', matchingKeys.join(', '));
  const removed = fullKeys.filter((k) => !matchingKeys.includes(k));
  const added = matchingKeys.filter((k) => !fullKeys.includes(k));
  console.log('present in full but not in matching:', removed.length ? removed.join(', ') : '(none)');
  console.log('present in matching but not in full:', added.length ? added.join(', ') : '(none)');

  console.log('\n=== IMMUTABILITY / INDEPENDENCE ===');
  const a = getProfile();
  a.positioning.headline = 'MUTATED';
  const fullIndependent = getProfile().positioning.headline !== 'MUTATED';

  const m = getMatchingProfile();
  m.positioning.headline = 'MUTATED';
  const matchingIndependent = getMatchingProfile().positioning.headline !== 'MUTATED';

  const crossIndependent = getProfile() !== getMatchingProfile();
  console.log('getProfile() devuelve copia no mutable:', fullIndependent ? 'OK' : 'FAIL');
  console.log('getMatchingProfile() devuelve copia no mutable:', matchingIndependent ? 'OK' : 'FAIL');
  console.log('ambas son objetos independientes entre si:', crossIndependent ? 'OK' : 'FAIL');

  console.log('\n=== MATCHING PROFILE REQUIRED SECTIONS ===');
  const required = [
    'positioning',
    'targetRoles',
    'experience',
    'capabilities',
    'seniority',
    'transferability',
    'workEnvironmentFit',
    'roleTypesToAvoid',
    'evaluationPrinciples',
    'learnedPreferences',
  ];
  const missing = required.filter((k) => !(k in matching));
  console.log('secciones requeridas presentes:', missing.length ? 'FALTAN ' + missing.join(', ') : 'OK (todas)');
  console.log('learnedPreferences vacio:', Array.isArray(matching.learnedPreferences) && matching.learnedPreferences.length === 0 ? 'OK' : 'FAIL');
  console.log('capability categories:', Object.keys(matching.capabilities).join(', '));
  console.log('targetRoles primary:', matching.targetRoles.primary.map((r) => r.roleFamily).join(', '));
  console.log('targetRoles secondary/exploratory:', matching.targetRoles.secondaryExploratory.map((r) => r.roleFamily).join(', '));
  console.log('experience entries:', matching.experience.map((e) => e.company).join(', '));
}

main();

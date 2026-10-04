'use strict';

// P0 regression checks for profile ground truth and deterministic prompt rules.
// No browser, OpenAI call, hunt, or persisted job data is used.

const { getMarianoProfile, getMarianoMatchingProfile } = require('../ai/marianoProfile');
const { buildSystemPrompt, buildUserPrompt } = require('../ai/jobAnalyzer');

let passed = 0;
let failed = 0;

function ok(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${name}`);
  }
}

const full = getMarianoProfile();
const matching = getMarianoMatchingProfile();
const prompt = buildSystemPrompt(matching);
const lower = prompt.toLowerCase();

console.log('\n### P0 ground truth');

for (const [name, profile] of [['canonical', full], ['matching', matching]]) {
  const english = profile.languages && profile.languages.find((x) => x.language === 'English');
  const agile = profile.methodologies && profile.methodologies.find((x) => x.methodology === 'Agile');
  ok(`${name}: English C1 is documented`, !!english && english.level === 'C1');
  ok(`${name}: professional English evidence is documented`, !!english && /meetings/i.test(english.evidence) && /presentations/i.test(english.evidence) && /stakeholders/i.test(english.evidence));
  ok(`${name}: English certification remains absent`, !!english && /^No formal language certification documented/i.test(english.formalCertification));
  ok(`${name}: Agile professional experience is documented`, !!agile && agile.experience === 'Worked professionally in projects/environments using Agile methodologies.');
  ok(`${name}: Agile certification remains absent`, !!agile && /^No formal Agile certification documented/i.test(agile.formalCertification));
}

console.log('\n### P0 ground truth: education, Spanish, English (matching profile = analyzer input)');

// El analyzer de produccion (hunt.js) pasa SOLO el matching profile, verbatim.
// Estos hechos objetivos tienen que llegar ahi sin ambiguedad.
const edu = matching.education || [];
const sysEng = edu.find((e) => /systems engineering/i.test(e.field || e.credential || ''));
const frontEnd = edu.find((e) => /front-?end/i.test(e.credential || e.field || ''));
const spanish = (matching.languages || []).find((x) => x.language === 'Spanish');
const englishM = (matching.languages || []).find((x) => x.language === 'English');

ok('matching: profile exposes an education section', Array.isArray(matching.education) && matching.education.length >= 2);

ok('matching: Systems Engineering at Universidad Abierta Interamericana', !!sysEng && sysEng.institution === 'Universidad Abierta Interamericana');
ok('matching: Systems Engineering is studies/incomplete', !!sysEng && /incomplete|studies/i.test(sysEng.status));
ok('matching: Systems Engineering awarded NO degree', !!sysEng && sysEng.degreeAwarded === false);
ok('matching: Systems Engineering cannot be read as a completed degree', !!sysEng && /not completed/i.test(sysEng.statement) && /no university degree was awarded/i.test(sysEng.statement));
ok('matching: Systems Engineering is never labelled bachelor/engineering degree', !!sysEng && !/\b(bachelor'?s degree in|holds a|graduated)\b/i.test(sysEng.statement) && /must NOT be read as a Bachelor/i.test(sysEng.statement));

ok('matching: Front-End diploma at Universidad Tecnologica Nacional', !!frontEnd && frontEnd.institution === 'Universidad Tecnológica Nacional');
ok('matching: Front-End diploma is completed', !!frontEnd && frontEnd.status === 'completed');
ok('matching: Front-End diploma is not inflated into a university degree', !!frontEnd && frontEnd.degreeAwarded === false && /not be presented as a university degree/i.test(frontEnd.statement));

ok('matching: Spanish is documented as Native', !!spanish && spanish.level === 'Native');
ok('matching: Spanish carries no negative boundary or certification claim', !!spanish && !('boundary' in spanish) && !('formalCertification' in spanish));

ok('matching: English level stays C1 (not C2/native)', !!englishM && englishM.level === 'C1' && !/\b(c2|native)\b/i.test(englishM.level + ' ' + englishM.proficiency));
ok('matching: English proficiency is professional/fluent', !!englishM && /fluent professional working proficiency/i.test(englishM.proficiency));
const satisfiesText = ((englishM && englishM.satisfiesRequirements) || '').toLowerCase();
ok('matching: English C1 explicitly satisfies B2/C1/fluent/advanced/high level/professional',
  ['b2', 'c1', 'fluent', 'advanced', 'high level', 'professional working proficiency'].every((w) => satisfiesText.includes(w)));
ok('matching: none of those levels may be a gap', !!englishM && /may be classified as NOT_EVIDENCED or as a gap|None of these may be classified/i.test(englishM.satisfiesRequirements));
ok('matching: missing certification matters ONLY for a named formal certificate', !!englishM && /ONLY when a job explicitly requires a named formal certificate/i.test(englishM.formalCertification));
ok('matching: missing certification never lowers the C1 level', !!englishM && /never lowers the documented C1 level/i.test(englishM.formalCertification));
ok('matching: historical usage is subordinated to the level', !!englishM && !('boundary' in englishM) && /does NOT reduce the documented C1 level/i.test(englishM.historicalContext || ''));

ok('matching: learnedPreferences is still empty', Array.isArray(matching.learnedPreferences) && matching.learnedPreferences.length === 0);

console.log('\n### P0 prompt contains the corrected ground truth (built locally, no OpenAI)');

ok('prompt: Systems Engineering studies are present', lower.includes('systems engineering studies, not completed'));
ok('prompt: no university degree was awarded', lower.includes('no university degree was awarded'));
ok('prompt: Universidad Abierta Interamericana is present', prompt.includes('Universidad Abierta Interamericana'));
ok('prompt: Front-End diploma is present and completed', prompt.includes('Front-End Development Diploma') && prompt.includes('Universidad Tecnológica Nacional') && lower.includes('"status":"completed"'));
ok('prompt: Spanish Native is present', /"language"\s*:\s*"Spanish"[\s\S]{0,80}"level"\s*:\s*"Native"/.test(prompt));
ok('prompt: English C1 is present', /"language"\s*:\s*"English"[\s\S]{0,60}"level"\s*:\s*"C1"/.test(prompt));
ok('prompt: proficiency vs formal certification is distinguished', lower.includes('only when a job explicitly requires a named formal certificate'));

console.log('\n### P0 prompt scenarios');

// A. English C1 covers B2/professional/fluent/C1 level requirements.
ok('A: English C1 covers B2 and professional/fluent English', lower.includes('satisfies english b2, professional english, fluent english, and english c1'));

// B. Language proficiency and a named formal certificate are separate requirements.
ok('B: IELTS/Cambridge certification remains separate', lower.includes('does not satisfy a separately required formal language certificate such as ielts or cambridge'));

// C-D. Agile experience is positive evidence; certification remains separate.
ok('C: Agile experience is not negated by missing certification', lower.includes('missing pmp, prince2, scrum, agile or other certification must not make project-management or agile experience a gap'));
ok('D: required Scrum/Agile certification can remain unmet', lower.includes('experience does not satisfy an explicitly required formal certification'));

// E-F. PMP ground truth stays absent while mandatory and preferred semantics differ.
ok('E: mandatory certification may be a real gap', lower.includes('only explicit required / mandatory / must-have / minimum requirements can become clear_gap or critical_gap'));
ok('F: preferred/valued PMP cannot become a hard gap', lower.includes('preferred / valued / desirable / ideally / nice-to-have / plus / advantage / strong advantage') && lower.includes('must never by themselves become clear_gap, critical_gap'));
ok('F: preferred items cannot enter criticalRequirementsUnmet', prompt.includes('criticalRequirementsUnmet') && lower.includes('secondary can sell weakness only'));

// G. The rule applies to any preferred industry, tool, or certification item.
ok('G: preferred rule is general rather than credential-specific', lower.includes('items must never by themselves') && lower.includes('never reinterpret them as mandatory'));

// H. A qualification alternative must be evaluated as a complete clause.
ok('H: degree or equivalent experience is not a hard degree gap', lower.includes('degree or equivalent professional experience') && lower.includes('must not become a hard gap'));

// Ensure job data remains data-only and no scenario needs a real model call.
const userPrompt = buildUserPrompt({ jobId: 'p0-test', title: 'Test', description: 'English B2 required.' });
ok('scenario job remains isolated as untrusted job data', userPrompt.includes('<job_data>') && userPrompt.includes('English B2 required.'));

console.log('\n### CV/profile parity ground truth');

const matchingText = JSON.stringify(matching);
const fullText = JSON.stringify(full);
for (const [name, profileText] of [['canonical', fullText], ['matching', matchingText]]) {
  ok(`${name}: roadmap ownership preserves owner alignment`, /roadmap/i.test(profileText) && /company owners\/leadership/i.test(profileText) && /unilaterally/i.test(profileText));
  ok(`${name}: USD 1M+ budgeting and contract evidence`, /USD 1M/i.test(profileText) && /budget/i.test(profileText) && /payment milestones/i.test(profileText));
  ok(`${name}: leadership through three Project Managers`, /three parallel projects/i.test(profileText) && /Project Managers/i.test(profileText));
  ok(`${name}: does not invent PM direct reports`, /not (?:claimed|a claim).*direct reports/i.test(profileText) || /no organizational direct-report/i.test(profileText));
  ok(`${name}: contract signing authority is scoped`, /sign(?:ed|ing).*contract/i.test(profileText) && /documented scope|USD 1M/i.test(profileText));
  ok(`${name}: payment processors are coordination, not negotiation`, /payment-processor coordination|coordinate with payment processors/i.test(profileText) && /no significant commercial negotiation/i.test(profileText));
  ok(`${name}: deployed AI automation evidence`, /self-hosted/i.test(profileText) && /Docker/i.test(profileText) && /n8n/i.test(profileText) && /PostgreSQL/i.test(profileText) && /Claude API/i.test(profileText));
  ok(`${name}: AI initiative retains documented metrics`, /400 videos/i.test(profileText) && /155 unique channels|155 channels/i.test(profileText) && /30 relevant partnership candidates|30 candidates/i.test(profileText) && /two minutes/i.test(profileText));
  ok(`${name}: remains outside AI Engineer positioning`, /not AI Engineer positioning/i.test(profileText));
  ok(`${name}: operating model and performance capabilities`, /operating-model/i.test(profileText) && /performance management/i.test(profileText) && /operational reliability/i.test(profileText) && /bottleneck/i.test(profileText));
  ok(`${name}: team design and final-stage hiring`, /team design/i.test(profileText) && /final-stage hiring/i.test(profileText));
}

ok('matching: PMP and PRINCE2 remain undocumented', /no PMP, PRINCE2 or Agile certification documented/i.test(matchingText));
ok('matching: Agile experience remains separate from certification', /work professionally in projects\/environments using Agile methodologies/i.test(matchingText) && /No formal Agile certification documented/i.test(matchingText));

console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : `${failed} FAIL`} (${passed} passed, ${failed} failed) ===`);
process.exitCode = failed === 0 ? 0 : 1;

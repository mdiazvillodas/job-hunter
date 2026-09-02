'use strict';

// Validacion de la arquitectura de perfiles del Job Hunter (post Career Context).
// No ejecuta llamadas reales a OpenAI (usa un transporte mock).
//
// Uso: node src/ai/validateArchitecture.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  getMarianoProfile,
  getMarianoMatchingProfile,
  getMarianoCareerContext,
} = require('./marianoProfile');
const { analyzeJob, buildSystemPrompt, isCareerContext } = require('./jobAnalyzer');

const CAREER_CONTEXT_PATH = path.join(__dirname, 'marianoCareerContext.json');

let failures = 0;
function check(name, ok, detail) {
  const status = ok ? 'OK' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`[${status}] ${name}${detail ? ' — ' + detail : ''}`);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const SAMPLE_JOB = {
  jobId: '999',
  url: 'https://www.linkedin.com/jobs/view/999/',
  title: 'Head of Operations',
  company: 'Sample',
  location: 'Barcelona, Spain (Hybrid)',
  employmentType: 'Full-time',
  workplaceType: 'Hybrid',
  seniority: 'Director',
  easyApply: true,
  description: 'Sample description as data.',
  matchedQueries: ['Head of Operations'],
  matchedFamilies: ['operations'],
};

// Transporte mock (sin OpenAI) que devuelve un analisis valido segun schema.
function mockTransport() {
  return Promise.resolve({
    model: 'mock',
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    choices: [
      {
        message: {
          content: JSON.stringify({
            decision: 'MAYBE',
            overallMatchScore: 70,
            professionalFitScore: 75,
            interestFitScore: 65,
            cvFitScore: 80,
            roleFamily: 'operations',
            summary: 's',
            whyItFits: ['a'],
            transferableExperience: ['b'],
            literalMatches: ['c'],
            gaps: ['d'],
            criticalRequirementsUnmet: [],
            redFlags: [],
            recommendedCV: 'current_cv',
            cvAdjustments: ['e'],
            confidence: 60,
            reasoning: 'r',
            requirementAssessments: [{ requirement: 'x', classification: 'DIRECT_MATCH', note: 'n' }],
            coreCapabilityCoverage: [{ capability: 'x', rating: 'STRONG', note: 'n' }],
          }),
        },
      },
    ],
  });
}

async function main() {
  console.log('=== ARCHITECTURE VALIDATION ===\n');

  // 1) Career Context existe + JSON valido
  const exists = fs.existsSync(CAREER_CONTEXT_PATH);
  check('marianoCareerContext.json existe', exists);
  let context = null;
  try {
    context = getMarianoCareerContext();
    check('marianoCareerContext.json es JSON valido y cargable', !!context);
  } catch (e) {
    check('marianoCareerContext.json es JSON valido y cargable', false, e.message);
  }

  // 2) Contiene las secciones principales
  const mainSections = [
    'meta',
    'professionalIdentity',
    'careerNarrative',
    'experienceContext',
    'capabilityModel',
    'targetRoles',
    'roleFitCriteria',
    'workEnvironment',
    'seniorityInterpretation',
    'transferabilityRules',
    'decisionPhilosophy',
    'careerPreferences',
    'evaluationPriorities',
    'sourceHierarchy',
  ];
  const missing = context ? mainSections.filter((s) => !(s in context)) : mainSections;
  check('career context contiene las secciones principales', missing.length === 0, missing.length ? 'faltan: ' + missing.join(', ') : '');

  // 3) No se modifica durante la ejecucion del analyzer
  const hashBefore = sha256(CAREER_CONTEXT_PATH);
  const matching = getMarianoMatchingProfile();
  await analyzeJob(matching, SAMPLE_JOB, { transport: mockTransport });
  const hashAfter = sha256(CAREER_CONTEXT_PATH);
  check('career context NO se modifica durante la ejecucion', hashBefore === hashAfter);

  // 4) Independencia / no mutabilidad
  const c1 = getMarianoCareerContext();
  c1.professionalIdentity.positioning = 'MUTATED';
  check('getMarianoCareerContext() devuelve copia no mutable', getMarianoCareerContext().professionalIdentity.positioning !== 'MUTATED');

  const m1 = getMarianoMatchingProfile();
  m1.positioning.headline = 'MUTATED';
  check('getMarianoMatchingProfile() sigue independiente y no mutable', getMarianoMatchingProfile().positioning.headline !== 'MUTATED');

  check('career context y matching profile son objetos distintos', getMarianoCareerContext() !== getMarianoMatchingProfile());

  // 5) El analyzer usa el matching profile (y rechaza el career context)
  const okMatching = await analyzeJob(matching, SAMPLE_JOB, { transport: mockTransport })
    .then((r) => r.analysis.decision === 'MAYBE')
    .catch(() => false);
  check('analyzer funciona con el matching profile', okMatching);

  check('isCareerContext detecta el career context', isCareerContext(getMarianoCareerContext()) === true);
  check('isCareerContext NO marca el matching profile', isCareerContext(getMarianoMatchingProfile()) === false);
  check('isCareerContext NO marca el full profile', isCareerContext(getMarianoProfile()) === false);

  let rejected = false;
  try {
    await analyzeJob(getMarianoCareerContext(), SAMPLE_JOB, { transport: mockTransport });
  } catch (e) {
    rejected = /career context/i.test(e.message);
  }
  check('analyzer RECHAZA recibir el career context', rejected);

  // 6) El analyzer NO carga el career context completo dentro del prompt
  const sys = buildSystemPrompt(matching);
  // Marcadores EXCLUSIVOS del career context (no del matching profile).
  const contextMarkers = ['Master professional context', 'sourceHierarchy', 'capabilityModel', 'professionalIdentity', 'feedbackLearning', 'Arquitecto operativo'];
  const leaked = contextMarkers.filter((mrk) => sys.includes(mrk));
  check('el SYSTEM prompt (matching) NO contiene el career context', leaked.length === 0, leaked.length ? 'fugas: ' + leaked.join(', ') : '');

  // 7) Cambios A–E aplicados al matching profile (grounded en el career context)
  console.log('\n--- matching profile: cambios A–E ---');
  const mp = getMarianoMatchingProfile();
  const flat = JSON.stringify(mp).toLowerCase();

  // A — careerPreferences
  check('A: careerPreferences existe', !!mp.careerPreferences && Array.isArray(mp.careerPreferences.explicit) && mp.careerPreferences.explicit.length > 0);
  check('A: careerPreferences.avoidAsPrimaryDirection existe', Array.isArray(mp.careerPreferences && mp.careerPreferences.avoidAsPrimaryDirection) && mp.careerPreferences.avoidAsPrimaryDirection.length > 0);

  // B — roleTypesToAvoid nuevos criterios
  const avoidText = JSON.stringify(mp.roleTypesToAvoid).toLowerCase();
  const bCriteria = ['sales', 'administrative project management', 'repetitive', 'autonomy'];
  const bMissing = bCriteria.filter((c) => !avoidText.includes(c));
  check('B: roleTypesToAvoid incluye los nuevos criterios (sales / admin PM / repetitive / autonomy)', bMissing.length === 0, bMissing.length ? 'faltan: ' + bMissing.join(', ') : '');
  check('B: roleTypesToAvoid conserva las categorias previas', avoidText.includes('ic software engineer') && avoidText.includes('industrial'));

  // C — commercial caveat
  const commercial = mp.capabilities.commercial;
  const hasCaveat = commercial && typeof commercial.caveat === 'string' && /not the primary professional destination|purely commercial|sales-driven/i.test(commercial.caveat);
  check('C: capabilities.commercial contiene el caveat', !!hasCaveat);
  check('C: commercial distingue capability vs interest', !!(commercial && /capability/i.test(JSON.stringify(commercial)) && /interest/i.test(JSON.stringify(commercial))));
  check('C: commercial conserva las capacidades reales (no se infravalora)', !!(commercial && Array.isArray(commercial.capabilities) && commercial.capabilities.length >= 2));

  // D — decision philosophy: canDo / wantsToDo / canSell
  const dp = mp.decisionPhilosophy;
  check('D: decisionPhilosophy con canDo/wantsToDo/canSell', !!(dp && dp.canDo && dp.wantsToDo && dp.canSell));
  check('D: mapping professionalFit=canDo, interestFit=wantsToDo, cvFit=canSell', !!(dp && dp.scoreMapping && /canDo/i.test(dp.scoreMapping.professionalFitScore) && /wantsToDo/i.test(dp.scoreMapping.interestFitScore) && /canSell/i.test(dp.scoreMapping.cvFitScore)));
  check('D: canSell aclara que NO es capacidad de ventas', !!(dp && /not sales ability/i.test(dp.canSell)));
  check('D: overall no es promedio simple si contradice la logica', !!(dp && /not.*average/i.test(dp.overallGuidance)));

  // E — positioning: archetype, notPositionedAs, careerThread
  check('E: positioning.professionalArchetype existe', !!(mp.positioning && mp.positioning.professionalArchetype));
  check('E: positioning.notPositionedAs existe', Array.isArray(mp.positioning && mp.positioning.notPositionedAs) && mp.positioning.notPositionedAs.length > 0);
  check('E: positioning.careerThread (diversidad de titulos != falta de especializacion)', !!(mp.positioning && /diversity of job titles/i.test(mp.positioning.careerThread)));

  // Estructura primary vs secondary/exploratory
  check('targetRoles primary y secondary/exploratory diferenciados', Array.isArray(mp.targetRoles.primary) && Array.isArray(mp.targetRoles.secondaryExploratory));
  const primaryFams = mp.targetRoles.primary.map((r) => r.roleFamily);
  check('primary son las 4 familias principales', ['Business Operations', 'Operations', 'Delivery', 'Product Operations'].every((f) => primaryFams.includes(f)));
  const secFams = mp.targetRoles.secondaryExploratory.map((r) => r.roleFamily);
  check('secondary/exploratory incluye Strategy/Transformation, IT Leadership, Customer Operations', secFams.some((f) => /Strategy/.test(f)) && secFams.some((f) => /IT Leadership/.test(f)) && secFams.some((f) => /Customer Operations/.test(f)));

  // learnedPreferences sigue vacio
  check('learnedPreferences sigue vacio []', Array.isArray(mp.learnedPreferences) && mp.learnedPreferences.length === 0);

  // Transferability intacta (4 niveles + ausencia de keyword)
  check('transferability conserva los 4 niveles', mp.transferability.classificationLevels.length === 4);
  check('transferability conserva "absence of keyword != absence of capability"', /absence of a keyword/i.test(mp.transferability.principle));

  // Matching profile sigue JSON valido (si cargo, es valido)
  check('matching profile es JSON valido', !!flat);

  console.log(`\n=== RESULT: ${failures === 0 ? 'ALL OK' : failures + ' FAIL(S)'} ===`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();

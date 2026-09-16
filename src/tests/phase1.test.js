'use strict';

// Fase 1: configuracion y despersonalizacion. Todo usa fixtures temporales y transporte mock.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { PROJECT_ROOT } = require('../runtime');
const { loadUserConfig, toPublicUserConfig } = require('../config/userConfig');
const { buildSystemPrompt, analyzeJob, defaultTransport, JOB_ANALYSIS_SCHEMA } = require('../ai/jobAnalyzer');

let passed = 0;
let failed = 0;
function ok(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' - ' + detail : ''}`); }
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jh-phase1-')); }

function fixtureConfig() {
  return {
    identity: { name: 'Alex Example', linkedinUrl: 'https://www.linkedin.com/in/alex-example/' },
    search: {
      locations: ['Example City', 'Future City'],
      modalities: ['hybrid', 'remote'],
      queryGroups: [
        { family: 'operations', label: 'Operations', enabled: true, priority: 1, queries: [
          { query: 'Example Operations Lead', enabled: true },
          { query: 'Disabled Example Role', enabled: false },
        ] },
      ],
    },
  };
}

function runNode(source, env = {}) {
  return spawnSync(process.execPath, ['-e', source], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function run() {
  const missingRoot = tempDir();
  const safeImports = [
    ['./src/config', 'config.js'],
    ['./src/hunt', 'hunt.js'],
    ['./src/collect-linkedin-jobs', 'collect-linkedin-jobs.js'],
    ['./src/analyze-linkedin-jobs', 'analyze-linkedin-jobs.js'],
  ];
  for (const [modulePath, label] of safeImports) {
    const imported = runNode(`require(${JSON.stringify(modulePath)}); process.stdout.write('imported');`, { JOB_HUNTER_DATA_DIR: missingRoot });
    ok(`${label} importa sin user.json`, imported.status === 0 && imported.stdout === 'imported', imported.stderr);
  }

  const missing = runNode(`
    const u = require('./src/config/userConfig');
    let result = { imported: true };
    try { u.getUserConfig(); } catch (error) { result.error = { name: error.name, code: error.code, message: error.message }; }
    process.stdout.write(JSON.stringify(result));
  `, { JOB_HUNTER_DATA_DIR: missingRoot });
  const missingResult = JSON.parse(missing.stdout);
  ok('userConfig importa sin user.json', missing.status === 0 && missingResult.imported);
  ok('userConfig faltante produce CONFIGURATION_REQUIRED', missingResult.error && missingResult.error.code === 'CONFIGURATION_REQUIRED' && !/MODULE_NOT_FOUND/.test(missingResult.error.message));

  const requiredOnUse = runNode(`
    const config = require('./src/config');
    try { void config.LINKEDIN_FILTERS; } catch (error) { process.stdout.write(JSON.stringify({ code: error.code, name: error.name })); }
  `, { JOB_HUNTER_DATA_DIR: missingRoot });
  const requiredOnUseResult = JSON.parse(requiredOnUse.stdout);
  ok('config requerida al pedir una propiedad de ejecucion', requiredOnUseResult.code === 'CONFIGURATION_REQUIRED' && requiredOnUseResult.name === 'ConfigurationRequiredError');

  const { getActiveSearchQueries } = require('../config');
  const enabledCases = [
    { family: 'true', label: 'true', enabled: true, priority: 1, queries: [{ query: 'active', enabled: true }, { query: 'false', enabled: false }, { query: 'missing' }, { query: 'falsy', enabled: 0 }] },
    { family: 'false', label: 'false', enabled: false, priority: 2, queries: [{ query: 'hidden', enabled: true }] },
    { family: 'missing', label: 'missing', priority: 3, queries: [{ query: 'hidden missing group', enabled: true }] },
    { family: 'falsy', label: 'falsy', enabled: 0, priority: 4, queries: [{ query: 'hidden falsy group', enabled: true }] },
  ];
  const enabledResults = getActiveSearchQueries(enabledCases);
  ok('enabled=true permanece activo', enabledResults.map((item) => item.query).join(',') === 'active');
  ok('enabled=false permanece inactivo', !enabledResults.some((item) => item.query === 'false' || item.query === 'hidden'));
  ok('enabled ausente/falsy permanece inactivo', !enabledResults.some((item) => /missing|falsy/.test(item.query)));

  const configRoot = tempDir();
  const configFile = path.join(configRoot, 'user.json');
  fs.writeFileSync(configFile, JSON.stringify(fixtureConfig()), 'utf8');
  const loaded = loadUserConfig(configFile);
  ok('userConfig valido carga identidad', loaded.identity.name === 'Alex Example');
  ok('modalities se almacena sin alterar collector', loaded.search.modalities.join(',') === 'hybrid,remote');
  ok('config existente migra target a 20', loaded.search.targetAnalyzedJobs === 20);
  for (const target of [1, 50]) {
    const boundary = fixtureConfig(); boundary.search.targetAnalyzedJobs = target;
    ok(`target ${target} es válido`, loadUserConfig((() => { const file = path.join(tempDir(), 'user.json'); fs.writeFileSync(file, JSON.stringify(boundary)); return file; })()).search.targetAnalyzedJobs === target);
  }
  for (const target of [0, 51, 1.5, '20']) {
    const invalidTarget = fixtureConfig(); invalidTarget.search.targetAnalyzedJobs = target;
    let rejected = false;
    try { require('../config/userConfig').validateUserConfig(invalidTarget); } catch (error) { rejected = error.code === 'CONFIGURATION_REQUIRED'; }
    ok(`target inválido ${JSON.stringify(target)} se rechaza`, rejected);
  }

  const runtimeRoot = tempDir();
  fs.mkdirSync(path.join(runtimeRoot, 'config'));
  fs.writeFileSync(path.join(runtimeRoot, 'config', 'user.json'), JSON.stringify(fixtureConfig()), 'utf8');
  const configured = runNode(`
    const c = require('./src/config');
    process.stdout.write(JSON.stringify({ location: c.LINKEDIN_FILTERS.location, queries: c.getActiveSearchQueries(), first: c.LINKEDIN_SEARCH_QUERY }));
  `, { JOB_HUNTER_DATA_DIR: runtimeRoot });
  const configuredResult = JSON.parse(configured.stdout);
  ok('search location primaria es configurable', configuredResult.location === 'Example City');
  ok('search queries son configurables y respetan enabled', configuredResult.queries.length === 1 && configuredResult.first === 'Example Operations Lead');

  const profileRoot = tempDir();
  fs.mkdirSync(path.join(profileRoot, 'profile'));
  const profiles = {
    'profile.json': { meta: { person: 'Alex Example' }, positioning: { headline: 'Example' } },
    'matchingProfile.json': { meta: { person: 'Alex Example' }, positioning: { headline: 'Example' }, learnedPreferences: [] },
    'careerContext.json': { meta: { person: 'Alex Example' }, professionalIdentity: { positioning: 'Example' } },
  };
  for (const [name, value] of Object.entries(profiles)) fs.writeFileSync(path.join(profileRoot, 'profile', name), JSON.stringify(value), 'utf8');
  const profileCheck = runNode(`
    const p = require('./src/ai/marianoProfile');
    process.stdout.write(JSON.stringify({ generic: p.getProfile(), matching: p.getMatchingProfile(), context: p.getCareerContext(), aliases: p.getProfile === p.getMarianoProfile && p.getMatchingProfile === p.getMarianoMatchingProfile && p.getCareerContext === p.getMarianoCareerContext }));
  `, { JOB_HUNTER_DATA_DIR: profileRoot });
  const profileResult = JSON.parse(profileCheck.stdout);
  ok('APIs genericas cargan las tres estructuras', profileResult.generic.meta.person === 'Alex Example' && profileResult.matching.meta.person === 'Alex Example' && profileResult.context.meta.person === 'Alex Example');
  ok('aliases legacy conservan compatibilidad', profileResult.aliases === true);

  const matchingProfile = profiles['matchingProfile.json'];
  const prompt = buildSystemPrompt(matchingProfile, { candidateName: 'Alex Example' });
  ok('prompt usa identidad inyectada y no la identidad anterior', prompt.includes('Alex Example') && !/Mariano(?: D[ií]az Villodas)?/i.test(prompt));
  ok('prompt conserva taxonomia original', ['DIRECT_MATCH', 'TRANSFERABLE_MATCH', 'SCALE_STRETCH', 'NOT_EVIDENCED', 'CLEAR_GAP', 'CRITICAL_GAP'].every((v) => prompt.includes(v)));
  ok('prompt conserva CAN DO / WANT TO DO / CAN SELL', /CAN DO/.test(prompt) && /WANT TO DO/.test(prompt) && /CAN SELL/.test(prompt));
  ok('prompt conserva missing evidence, ownership y credible next step', /missing evidence as evidence of absence/i.test(prompt) && /OWNERSHIP WEIGHTS HEAVILY/.test(prompt) && /credible NEXT STEP/i.test(prompt));

  const expectedKeys = ['requirementAssessments','coreCapabilityCoverage','decision','overallMatchScore','professionalFitScore','interestFitScore','cvFitScore','roleFamily','summary','whyItFits','transferableExperience','literalMatches','gaps','criticalRequirementsUnmet','redFlags','recommendedCV','cvAdjustments','confidence','reasoning'];
  ok('schema de salida conserva campos y orden', JSON.stringify(JOB_ANALYSIS_SCHEMA.required) === JSON.stringify(expectedKeys));

  const expectedAnalysis = {
    requirementAssessments: [{ requirement: 'Operations', classification: 'DIRECT_MATCH', note: 'Documented' }],
    coreCapabilityCoverage: [{ capability: 'Operations', rating: 'STRONG', note: 'Documented' }],
    decision: 'YES', overallMatchScore: 84, professionalFitScore: 86, interestFitScore: 82, cvFitScore: 80,
    roleFamily: 'operations', summary: 'Example', whyItFits: ['Evidence'], transferableExperience: [], literalMatches: ['Operations'],
    gaps: [], criticalRequirementsUnmet: [], redFlags: [], recommendedCV: 'current_cv', cvAdjustments: [], confidence: 88, reasoning: 'Example reasoning',
  };
  let capturedMessages;
  const result = await analyzeJob(matchingProfile, { jobId: '1', title: 'Example role' }, {
    candidateName: 'Alex Example',
    transport: async ({ messages }) => { capturedMessages = messages; return { model: 'mock', choices: [{ message: { content: JSON.stringify(expectedAnalysis) } }] }; },
  });
  ok('mocked analysis conserva parsing y schema', JSON.stringify(result.analysis) === JSON.stringify(expectedAnalysis));
  ok('candidateName llega a system y user prompts', capturedMessages.every((message) => message.content.includes('Alex Example')));

  let transportOptions;
  await analyzeJob(matchingProfile, { jobId: '2', title: 'Example role' }, {
    transport: async (options) => { transportOptions = options; return { model: 'mock', choices: [{ message: { content: JSON.stringify(expectedAnalysis) } }] }; },
    timeoutMs: 1234,
  });
  ok('analyzer propaga signal y request timeout', transportOptions.timeoutMs === 1234 && 'signal' in transportOptions);

  const originalFetch = global.fetch;
  try {
    global.fetch = async (_url, options) => ({ ok: true, text: async () => JSON.stringify({ model: 'mock', choices: [] }), requestSignal: options.signal });
    const normalBody = await defaultTransport({ apiKey: 'fake', model: 'mock', messages: [], timeoutMs: 100 });
    ok('OpenAI transport normal completa', normalBody.model === 'mock');

    global.fetch = (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
    });
    const cancelledController = new AbortController();
    const cancelledRequest = defaultTransport({ apiKey: 'fake', model: 'mock', messages: [], signal: cancelledController.signal, timeoutMs: 100 });
    cancelledController.abort();
    let cancellationName;
    try { await cancelledRequest; } catch (error) { cancellationName = error.name; }
    ok('OpenAI transport respeta cancelación', cancellationName === 'AbortError');

    let timeoutCode;
    try { await defaultTransport({ apiKey: 'fake', model: 'mock', messages: [], timeoutMs: 1 }); } catch (error) { timeoutCode = error.code; }
    ok('OpenAI transport aplica timeout acotado', timeoutCode === 'OPENAI_TIMEOUT');
  } finally { global.fetch = originalFetch; }

  const publicConfig = toPublicUserConfig(loaded);
  const html = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'ui', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'ui', 'public', 'app.js'), 'utf8');
  const uiServer = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'ui', 'server.js'), 'utf8');
  ok('UI obtiene LinkedIn URL desde configuracion publica', publicConfig.linkedinUrl === loaded.identity.linkedinUrl && /\/api\/user-config/.test(app) && /toPublicUserConfig\(getUserConfig\(\)\)/.test(uiServer));
  ok('UI no contiene URL o identidad personal hardcodeada', !/mdiazvillodas|Mariano D[ií]az Villodas/i.test(html + app));

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((error) => { console.error(error); process.exitCode = 1; });

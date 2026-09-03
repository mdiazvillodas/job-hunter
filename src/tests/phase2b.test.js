'use strict';

// Fase 2B: profile builder local. Sólo usa transporte OpenAI mock, loopback y archivos temporales.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSetupService } = require('../setup/setupService');
const { buildProfileSystemPrompt, generateProfiles, defaultTransport, ProfileBuilderError } = require('../ai/profileBuilder');
const { analyzeJob } = require('../ai/jobAnalyzer');
const { createLocalRepository } = require('../data/jobRepository');
const { createJobService } = require('../services/jobService');
const { startServer } = require('../ui/server');

let passed = 0;
let failed = 0;
function ok(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' - ' + detail : ''}`); }
}

function candidateOutput(name = 'Taylor Example') {
  return {
    careerContext: {
      meta: { person: name, purpose: 'Master professional context and source of truth' },
      professionalIdentity: { positioning: 'Operations leader', evidence: ['Led documented operations work', 'Owned cross-functional delivery'] },
      careerNarrative: 'Experienced operations professional with documented responsibility across delivery, stakeholders, process improvement and team coordination.',
      experienceContext: [{ statement: 'Operations delivery', evidence: ['Led documented cross-functional work'] }],
      capabilityModel: { capabilities: [{ statement: 'Operations', evidence: ['Led documented operations work'] }, { statement: 'Delivery', evidence: ['Owned cross-functional delivery'] }] },
      targetRoles: { primary: [{ roleFamily: 'Operations', roles: ['Operations Manager'], relevance: 'Directly supported', evidence: ['Operations ownership'] }], aspirational: [] },
      roleFitCriteria: ['Operational ownership', 'Cross-functional scope'],
      workEnvironment: { preferences: ['Hybrid'], evidence: ['User stated hybrid preference'] },
      seniorityInterpretation: { level: 'Manager', evidence: ['Documented operational ownership'] },
      transferabilityRules: ['Classify adjacent capabilities only when evidence supports them'],
      decisionPhilosophy: ['Missing evidence is not evidence of absence'], careerPreferences: ['Hybrid work'],
      evaluationPriorities: ['Ownership', 'Demonstrated capability'], sourceHierarchy: ['User-supplied professional information'],
      unknowns: ['Budget ownership not evidenced', 'Team size not evidenced'],
    },
    profile: {
      meta: { person: name },
      positioning: { headline: 'Operations Leader', centralPositioning: { statement: 'Operations professional focused on delivery and cross-functional execution.', evidence: ['Operations ownership'] } },
      experience: [{ statement: 'Operations delivery', evidence: ['Led documented cross-functional work'] }],
      capabilities: [{ statement: 'Operations', evidence: ['Led documented operations work'] }, { statement: 'Delivery', evidence: ['Owned cross-functional delivery'] }],
      targetRoles: { families: [{ family: 'Operations', relevance: 'Directly supported' }] },
      seniority: { assessedLevel: 'Manager', evidence: ['Documented operational ownership', 'Documented cross-functional responsibility'] },
      preferences: ['Hybrid work'], unknowns: ['Budget ownership', 'Exact team size'],
      evaluationPrinciples: ['Do not invent missing facts', 'Missing evidence does not mean absence'],
    },
    matchingProfile: {
      meta: { person: name, purpose: 'Condensed job matching profile' },
      positioning: { headline: 'Operations Leader', professionalArchetype: 'Operations leader', notPositionedAs: ['Pure sales specialist'], careerThread: 'Operations and delivery ownership' },
      targetRoles: { primary: [{ roleFamily: 'Operations', roles: ['Operations Manager'], relevance: 'Directly supported', evidence: ['Operations ownership'] }], secondaryExploratory: [] },
      capabilities: {
        operations: { capabilities: ['Operations'], evidence: ['Led documented operations work'], caveat: '' },
        delivery: { capabilities: ['Delivery'], evidence: ['Owned cross-functional delivery'], caveat: '' },
        strategy: { capabilities: [], evidence: [], caveat: 'Not evidenced' },
        productOperations: { capabilities: [], evidence: [], caveat: 'Not evidenced' },
        commercial: { capabilities: [], evidence: [], caveat: 'Capability not evidenced and not assumed as an interest' },
      },
      experienceHighlights: [{ statement: 'Operations delivery', evidence: ['Led documented cross-functional work'] }],
      seniority: { assessedLevel: 'Manager', evidence: ['Documented operational ownership'] },
      careerPreferences: { explicit: ['Hybrid work'], avoidAsPrimaryDirection: [] }, roleTypesToAvoid: [],
      decisionPhilosophy: { canDo: 'Evaluate evidenced capability', wantsToDo: 'Use explicit preferences only', canSell: 'Assess evidence presentation; this is not sales ability', scoreMapping: { professionalFitScore: 'canDo', interestFitScore: 'wantsToDo', cvFitScore: 'canSell' }, overallGuidance: 'Overall is not a simple average when evidence conflicts' },
      transferability: { classificationLevels: ['DIRECT', 'TRANSFERABLE', 'NOT_EVIDENCED', 'GAP'], principle: 'Absence of a keyword is not absence of capability' },
      workEnvironmentFit: { preferred: ['Hybrid'], acceptable: [], avoid: [], evidence: ['User stated hybrid preference'] },
      evaluationPrinciples: ['Evidence only'], learnedPreferences: [], unknowns: ['Budget ownership'],
    },
    summary: {
      positioning: 'Operations Leader', targetRoles: ['Operations Manager'], capabilities: ['Operations', 'Delivery'],
      experience: ['Operations delivery'], seniority: 'Manager', strengths: ['Operations'],
      notEvidenced: ['Budget ownership'], preferences: ['Hybrid'], rolesToAvoid: [],
    },
  };
}

function mockBody(output = candidateOutput()) {
  return { model: 'mock-profile-model', choices: [{ message: { content: JSON.stringify(output) } }] };
}

function validUserInput() {
  return { name: 'Taylor Example', linkedinUrl: 'https://www.linkedin.com/in/taylor-example/', location: 'Example City', queries: ['Operations Manager'], modalities: ['hybrid'] };
}

function professionalText() {
  return 'Taylor has led operations delivery, process improvements, and cross-functional stakeholder coordination for several documented initiatives.';
}

function request(server, method, pathname, body) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, method, path: pathname, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function rejectsCode(action, code) {
  try { await action(); return false; } catch (error) { return error && error.code === code; }
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-phase2b-'));
  const userConfigPath = path.join(root, 'config', 'user.json');
  const envPath = path.join(root, '.env');
  const profileDir = path.join(root, 'profile');
  let capturedTransport;
  const transport = async (input) => { capturedTransport = input; return mockBody(); };

  const noConfig = createSetupService({ userConfigPath, envPath, profileDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: transport });
  ok('generate requiere user config válida', await rejectsCode(() => noConfig.generateProfileDraft({ professionalText: professionalText() }), 'USER_CONFIG_REQUIRED'));
  noConfig.saveUserConfig(validUserInput());

  const noKey = createSetupService({ userConfigPath, envPath, profileDir, processEnv: {}, profileTransport: transport });
  ok('generate requiere API key configurada', await rejectsCode(() => noKey.generateProfileDraft({ professionalText: professionalText() }), 'OPENAI_API_KEY_REQUIRED'));
  const service = createSetupService({ userConfigPath, envPath, profileDir, processEnv: { OPENAI_API_KEY: 'fake-key', OPENAI_MODEL: 'fallback-model', OPENAI_PROFILE_MODEL: 'profile-model' }, profileTransport: transport });
  ok('professionalText vacío falla', await rejectsCode(() => service.generateProfileDraft({ professionalText: '' }), 'PROFESSIONAL_TEXT_REQUIRED'));
  ok('readyForHunt false antes de confirmar sin perfiles', service.getStatus().readyForHunt === false);

  const prompt = buildProfileSystemPrompt('Taylor Example').toLowerCase();
  const promptConcepts = ['only supplied user information', 'do not invent facts', 'evidence from interpretation', 'missing evidence does not mean absence', 'one particular vacancy', 'preserve unknowns', 'careercontext first', 'condensed representation'];
  ok('prompt contiene todos los principios obligatorios', promptConcepts.every((concept) => prompt.includes(concept)));

  const oldProfiles = { careerContext: { old: 'career' }, profile: { old: 'profile' }, matchingProfile: { old: 'matching' } };
  fs.mkdirSync(profileDir, { recursive: true });
  for (const [name, value] of Object.entries(oldProfiles)) fs.writeFileSync(path.join(profileDir, `${name}.json`), JSON.stringify(value), 'utf8');

  const original = professionalText();
  const draft = await service.generateProfileDraft({ professionalText: original, preferencesText: 'Hybrid work is preferred.' });
  ok('transport OpenAI es inyectable y mocked', capturedTransport && capturedTransport.model === 'profile-model');
  ok('request al transport no incluye secretos innecesarios', Object.keys(capturedTransport).sort().join(',') === 'apiKey,messages,model,schema' && !JSON.stringify(capturedTransport.messages).includes('fake-key'));
  ok('structured response válida produce draft completo', ['careerContext', 'profile', 'matchingProfile', 'summary', 'metadata'].every((key) => draft[key]));
  ok('profile conserva contrato de getProfileSummary', !!draft.profile.positioning.centralPositioning.statement && draft.profile.targetRoles.families.every((item) => item.family && item.relevance));
  ok('careerContext conserva invariantes de validateArchitecture', ['meta', 'professionalIdentity', 'careerNarrative', 'experienceContext', 'capabilityModel', 'targetRoles', 'roleFitCriteria', 'workEnvironment', 'seniorityInterpretation', 'transferabilityRules', 'decisionPhilosophy', 'careerPreferences', 'evaluationPriorities', 'sourceHierarchy'].every((key) => key in draft.careerContext));
  ok('matchingProfile conserva invariantes de validateArchitecture', ['decisionPhilosophy', 'transferability', 'workEnvironmentFit', 'careerPreferences'].every((key) => key in draft.matchingProfile) && draft.matchingProfile.transferability.classificationLevels.length === 4 && /absence of a keyword/i.test(draft.matchingProfile.transferability.principle) && draft.matchingProfile.decisionPhilosophy.canDo && draft.matchingProfile.decisionPhilosophy.wantsToDo && /not sales ability/i.test(draft.matchingProfile.decisionPhilosophy.canSell));
  ok('targetRoles mantiene primary y secondaryExploratory', Array.isArray(draft.matchingProfile.targetRoles.primary) && Array.isArray(draft.matchingProfile.targetRoles.secondaryExploratory));
  ok('capabilities mantiene dominios ricos incluido commercial', !Array.isArray(draft.matchingProfile.capabilities) && ['operations', 'delivery', 'strategy', 'productOperations', 'commercial'].every((key) => draft.matchingProfile.capabilities[key]));
  ok('matchingProfile válido no se rechaza por longitud JSON', JSON.stringify(draft.matchingProfile).length > JSON.stringify(draft.profile).length);
  ok('search queries no se envían al Profile Builder', !JSON.stringify(capturedTransport.messages).includes('Operations Manager'));
  ok('preferencias no se convierten en experiencia', !JSON.stringify(draft.profile.experience).includes('Hybrid') && !JSON.stringify(draft.matchingProfile.experienceHighlights).includes('Hybrid'));
  const mockAnalysis = { requirementAssessments: [], coreCapabilityCoverage: [], decision: 'MAYBE', overallMatchScore: 50, professionalFitScore: 50, interestFitScore: 50, cvFitScore: 50, roleFamily: 'operations', summary: 's', whyItFits: [], transferableExperience: [], literalMatches: [], gaps: [], criticalRequirementsUnmet: [], redFlags: [], recommendedCV: 'current_cv', cvAdjustments: [], confidence: 50, reasoning: 'r' };
  const analyzed = await analyzeJob(draft.matchingProfile, { jobId: '1', title: 'Example' }, { candidateName: 'Taylor Example', transport: async () => ({ model: 'mock', choices: [{ message: { content: JSON.stringify(mockAnalysis) } }] }) });
  ok('analyzer acepta matchingProfile generado sin cambios', analyzed.analysis.decision === 'MAYBE');
  const draftText = fs.readFileSync(service.paths.draftPath, 'utf8');
  ok('draft no contiene API key', !draftText.includes('fake-key'));
  ok('draft no contiene professionalText original completo', !draftText.includes(original));
  ok('draft no contiene preferencesText original completo', !draftText.includes('Hybrid work is preferred.'));
  ok('draft vive dentro del runtime esperado', path.dirname(service.paths.draftPath) === profileDir && fs.existsSync(service.paths.draftPath));
  ok('generate no modifica perfiles confirmados', Object.entries(oldProfiles).every(([name, value]) => fs.readFileSync(path.join(profileDir, `${name}.json`), 'utf8') === JSON.stringify(value)));
  ok('status profileDraft funciona', service.getStatus().profileDraft === true && service.getStatus().profileDraftValid === true);
  ok('perfiles confirmados existentes siguen activos durante regeneración', service.getStatus().readyForHunt === true);
  const failedGenerateService = createSetupService({ userConfigPath, envPath, profileDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: async () => { throw new Error('simulated generation failure'); } });
  await rejectsCode(() => failedGenerateService.generateProfileDraft({ professionalText: original }), 'OPENAI_REQUEST_FAILED');
  ok('generate fallido conserva draft válido anterior', fs.readFileSync(service.paths.draftPath, 'utf8') === draftText);

  ok('root array se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: async () => mockBody([]) }), 'INVALID_PROFILE_RESPONSE'));
  ok('root null se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: async () => mockBody(null) }), 'INVALID_PROFILE_RESPONSE'));
  ok('respuesta incompleta se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: async () => mockBody({ careerContext: {} }) }), 'INCOMPLETE_PROFILE_RESPONSE'));
  ok('candidate name inconsistente se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: async () => mockBody(candidateOutput('Another Person')) }), 'INCONSISTENT_CANDIDATE_NAME'));
  const nameVariant = await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: async () => mockBody(candidateOutput(' TAYLOR EXAMPLE ')) });
  ok('case/whitespace se normaliza y persiste nombre canónico', [nameVariant.careerContext.meta.person, nameVariant.profile.meta.person, nameVariant.matchingProfile.meta.person].every((name) => name === 'Taylor Example'));
  const extra = candidateOutput(); extra.profile.extra = true;
  ok('property extra se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: async () => mockBody(extra) }), 'INVALID_PROFILE_RESPONSE'));
  const emptyProfile = candidateOutput(); emptyProfile.profile.positioning.headline = ''; emptyProfile.profile.experience = []; emptyProfile.profile.capabilities = []; emptyProfile.profile.targetRoles.families = []; emptyProfile.summary.positioning = '';
  ok('profile vacío/inútil se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: async () => mockBody(emptyProfile) }), 'EMPTY_PROFILE'));
  const emptyMatching = candidateOutput(); emptyMatching.matchingProfile.positioning.headline = ''; emptyMatching.matchingProfile.experienceHighlights = []; Object.values(emptyMatching.matchingProfile.capabilities).forEach((domain) => { domain.capabilities = []; domain.evidence = []; }); emptyMatching.summary.positioning = emptyMatching.profile.positioning.headline; emptyMatching.summary.capabilities = [];
  ok('matchingProfile vacío/inútil se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: async () => mockBody(emptyMatching) }), 'EMPTY_MATCHING_PROFILE'));

  const noDraftDir = path.join(root, 'no-draft-profile');
  const noDraft = createSetupService({ userConfigPath, envPath, profileDir: noDraftDir, processEnv: { OPENAI_API_KEY: 'fake-key' } });
  ok('confirm sin draft falla controladamente', await rejectsCode(() => Promise.resolve().then(() => noDraft.confirmProfileDraft()), 'PROFILE_DRAFT_REQUIRED'));
  fs.mkdirSync(noDraftDir, { recursive: true });
  fs.writeFileSync(noDraft.paths.draftPath, '{broken', 'utf8');
  const corruptStatus = noDraft.getStatus();
  ok('draft corrupto queda visible pero inválido en status', corruptStatus.profileDraft === true && corruptStatus.profileDraftValid === false);
  noDraft.deleteProfileDraft();

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"secret provider detail"}}' });
    ok('auth error se clasifica sin detalle raw', await rejectsCode(() => defaultTransport({ apiKey: 'fake-key', model: 'mock', messages: [] }), 'OPENAI_AUTH_ERROR'));
    global.fetch = async () => ({ ok: false, status: 429, text: async () => '{"error":{"message":"rate detail"}}' });
    ok('rate limit se clasifica', await rejectsCode(() => defaultTransport({ apiKey: 'fake-key', model: 'mock', messages: [] }), 'OPENAI_RATE_LIMIT'));
    global.fetch = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    ok('timeout aborta el transport y se clasifica', await rejectsCode(() => defaultTransport({ apiKey: 'fake-key', model: 'mock', messages: [], timeoutMs: 1 }), 'OPENAI_TIMEOUT'));
  } finally { global.fetch = originalFetch; }
  ok('provider content malformado se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: async () => ({ choices: [{ message: { content: '{bad' } }] }) }), 'INVALID_PROFILE_RESPONSE'));

  const repository = createLocalRepository({ dir: path.join(root, 'jobs') });
  const server = startServer({ port: 0, setupService: service, jobService: createJobService(repository), repository });
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const draftResponse = await request(server, 'GET', '/api/setup/profile/draft');
    ok('GET draft devuelve información segura', draftResponse.status === 200 && !draftResponse.text.includes('fake-key') && !draftResponse.text.includes(original));
    const openAiFailureService = createSetupService({ userConfigPath, envPath, profileDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: async () => { throw new Error(original + ' fake-key'); } });
    const errorServer = startServer({ port: 0, setupService: openAiFailureService, jobService: createJobService(repository), repository });
    await new Promise((resolve) => errorServer.once('listening', resolve));
    let failedResponse;
    const originalConsoleError = console.error;
    const errorLogs = [];
    console.error = (...args) => { errorLogs.push(args.join(' ')); };
    try { failedResponse = await request(errorServer, 'POST', '/api/setup/profile/generate', { professionalText: original }); }
    finally { console.error = originalConsoleError; await new Promise((resolve) => errorServer.close(resolve)); }
    ok('error OpenAI simulado devuelve respuesta segura', failedResponse.status === 502 && !failedResponse.text.includes('fake-key') && !failedResponse.text.includes(original));
    ok('error OpenAI simulado no filtra secretos en console.error', !errorLogs.join('\n').includes('fake-key') && !errorLogs.join('\n').includes(original));
  } finally { await new Promise((resolve) => server.close(resolve)); }

  const deleteDir = path.join(root, 'delete-profile');
  fs.mkdirSync(deleteDir, { recursive: true });
  for (const [name, value] of Object.entries(oldProfiles)) fs.writeFileSync(path.join(deleteDir, `${name}.json`), JSON.stringify(value), 'utf8');
  const deleteService = createSetupService({ userConfigPath, profileDir: deleteDir, draftPath: path.join(deleteDir, 'draft.json'), processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: transport });
  await deleteService.generateProfileDraft({ professionalText: original });
  deleteService.deleteProfileDraft();
  ok('DELETE draft no borra perfiles confirmados', Object.keys(oldProfiles).every((name) => fs.existsSync(path.join(deleteDir, `${name}.json`))) && !fs.existsSync(deleteService.paths.draftPath));

  await service.generateProfileDraft({ professionalText: original });
  const oldProfilesIntact = () => Object.entries(oldProfiles).every(([name, value]) => fs.readFileSync(path.join(profileDir, `${name}.json`), 'utf8') === JSON.stringify(value));
  let writeCount = 0;
  const stageWriteFs = { ...fs, writeFileSync(...args) { writeCount += 1; if (writeCount === 2) throw new Error('simulated staging write failure'); return fs.writeFileSync(...args); } };
  const stageWriteService = createSetupService({ userConfigPath, envPath, profileDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: transport, profileFileSystem: stageWriteFs });
  let stageWriteFailed = false;
  try { stageWriteService.confirmProfileDraft(); } catch (_) { stageWriteFailed = true; }
  ok('staging write #2 failure conserva tres perfiles anteriores', stageWriteFailed && oldProfilesIntact() && fs.existsSync(service.paths.draftPath));

  let stageReadCount = 0;
  const stageValidationFs = { ...fs, readFileSync(...args) { stageReadCount += 1; if (stageReadCount === 3) return '[]'; return fs.readFileSync(...args); } };
  const stageValidationService = createSetupService({ userConfigPath, envPath, profileDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: transport, profileFileSystem: stageValidationFs });
  let stageValidationFailed = false;
  try { stageValidationService.confirmProfileDraft(); } catch (_) { stageValidationFailed = true; }
  ok('staging validation #3 failure conserva tres perfiles anteriores', stageValidationFailed && oldProfilesIntact() && fs.existsSync(service.paths.draftPath));

  let renameCount = 0;
  const failingFs = { ...fs, renameSync(from, to) { renameCount += 1; if (renameCount === 5) throw new Error('simulated promotion failure'); return fs.renameSync(from, to); } };
  const failingConfirm = createSetupService({ userConfigPath, envPath, profileDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: transport, profileFileSystem: failingFs });
  let confirmFailed = false;
  try { failingConfirm.confirmProfileDraft(); } catch (_) { confirmFailed = true; }
  ok('fallo simulado durante confirm activa rollback', confirmFailed);
  ok('promotion #2 failure restaura tres perfiles anteriores', oldProfilesIntact());
  ok('confirm usa archivos staging/backup y conserva draft tras fallo', renameCount >= 5 && fs.existsSync(service.paths.draftPath));

  let thirdPromotionRename = 0;
  const thirdPromotionFs = { ...fs, renameSync(from, to) { thirdPromotionRename += 1; if (thirdPromotionRename === 6) throw new Error('simulated third promotion failure'); return fs.renameSync(from, to); } };
  const thirdPromotionService = createSetupService({ userConfigPath, envPath, profileDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: transport, profileFileSystem: thirdPromotionFs });
  let thirdPromotionFailed = false;
  try { thirdPromotionService.confirmProfileDraft(); } catch (_) { thirdPromotionFailed = true; }
  ok('promotion #3 failure restaura tres perfiles anteriores', thirdPromotionFailed && oldProfilesIntact() && fs.existsSync(service.paths.draftPath));

  const emptyTargetsDir = path.join(root, 'empty-targets');
  const emptyTargetsService = createSetupService({ userConfigPath, envPath, profileDir: emptyTargetsDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: transport });
  await emptyTargetsService.generateProfileDraft({ professionalText: original });
  let emptyRenameCount = 0;
  const emptyFailFs = { ...fs, renameSync(from, to) { emptyRenameCount += 1; if (emptyRenameCount === 2) throw new Error('simulated promotion without backups'); return fs.renameSync(from, to); } };
  const emptyFailService = createSetupService({ userConfigPath, envPath, profileDir: emptyTargetsDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: transport, profileFileSystem: emptyFailFs });
  let emptyFailed = false;
  try { emptyFailService.confirmProfileDraft(); } catch (_) { emptyFailed = true; }
  ok('rollback sin targets previos elimina cualquier promoción parcial', emptyFailed && ['careerContext', 'profile', 'matchingProfile'].every((name) => !fs.existsSync(path.join(emptyTargetsDir, `${name}.json`))) && fs.existsSync(emptyTargetsService.paths.draftPath));

  service.confirmProfileDraft();
  ok('confirm válido crea los tres perfiles', ['careerContext', 'profile', 'matchingProfile'].every((name) => fs.existsSync(path.join(profileDir, `${name}.json`))));
  ok('perfiles existentes sólo cambian al confirmar', JSON.parse(fs.readFileSync(path.join(profileDir, 'profile.json'), 'utf8')).meta.person === 'Taylor Example');
  ok('successful confirm elimina draft', !fs.existsSync(service.paths.draftPath));
  ok('readyForHunt true tras confirmar fixture válido', service.getStatus().readyForHunt === true && service.getStatus().profileDraft === false && service.getStatus().profileDraftValid === false);
  const summaryCheck = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./src/ai/marianoProfile').getProfileSummary()))"], { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', env: { ...process.env, JOB_HUNTER_DATA_DIR: root } });
  const generatedSummary = summaryCheck.status === 0 ? JSON.parse(summaryCheck.stdout) : null;
  ok('profile generado funciona con getProfileSummary()', generatedSummary && generatedSummary.person === 'Taylor Example' && generatedSummary.headline === 'Operations Leader' && generatedSummary.centralPositioning && generatedSummary.targetFamilies[0].family === 'Operations' && generatedSummary.seniority === 'Manager' && generatedSummary.experienceCount === 1 && generatedSummary.evaluationPrincipleCount === 2, summaryCheck.stderr);

  const protectedImports = fs.readFileSync(path.join(__dirname, '..', 'ai', 'profileBuilder.js'), 'utf8');
  ok('profile builder no usa LinkedIn, Chromium ni hunt', !/require\([^)]*(linkedin|playwright|hunt)|chromium\./i.test(protectedImports));

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((error) => { console.error(error && error.name ? error.name : 'Error'); process.exitCode = 1; });

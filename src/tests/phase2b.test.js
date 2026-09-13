'use strict';

// Fase 2B: profile builder local. Sólo usa transporte OpenAI mock, loopback y archivos temporales.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSetupService } = require('../setup/setupService');
const { buildProfileSystemPrompt, generateProfiles, defaultTransport, ProfileBuilderError, validateProfileDraft, validateMatchingArchitecture, MATCHING_TRANSFERABILITY, MATCHING_PURPOSE, MATCHING_DECISION_PHILOSOPHY } = require('../ai/profileBuilder');
const { buildProfileFactRegistry, normalizeFact } = require('../ai/profileFactRegistry');
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
      careerPreferencesToAvoid: [],
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

function mockTransport(output = candidateOutput()) {
  return async ({ stage }) => {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return mockBody(output);
    if (stage === 'stage1') return mockBody({ careerContext: output.careerContext, profile: output.profile });
    const registry = buildProfileFactRegistry(output.careerContext, output.profile);
    const refFor = (text) => {
      const entry = registry.entries.find((item) => normalizeFact(item.text) === normalizeFact(text));
      return entry ? entry.id : 'UNKNOWN_REF';
    };
    const source = output.matchingProfile;
    const matchingSynthesis = {
      positioning: JSON.parse(JSON.stringify(source.positioning)),
      capabilities: JSON.parse(JSON.stringify(source.capabilities)),
      experienceHighlights: JSON.parse(JSON.stringify(source.experienceHighlights)),
      preferenceClassification: {
        avoidAsPrimaryDirectionRefs: source.careerPreferences.avoidAsPrimaryDirection.map(refFor),
        acceptableWorkEnvironmentRefs: source.workEnvironmentFit.acceptable.map(refFor),
        avoidWorkEnvironmentRefs: source.workEnvironmentFit.avoid.map(refFor),
        roleTypesToAvoidRefs: source.roleTypesToAvoid.map(refFor),
      },
    };
    for (const domain of Object.values(matchingSynthesis.capabilities)) {
      domain.evidenceRefs = domain.evidence.map(refFor); delete domain.evidence;
    }
    for (const item of matchingSynthesis.experienceHighlights) {
      item.evidenceRefs = item.evidence.map(refFor); delete item.evidence;
    }
    return mockBody({ matchingSynthesis });
  };
}

function mutateStage2Transport(mutator, output = candidateOutput()) {
  const base = mockTransport(output);
  return async (input) => {
    const body = await base(input);
    if (input.stage !== 'stage2') return body;
    const value = JSON.parse(body.choices[0].message.content);
    mutator(value, input);
    return mockBody(value);
  };
}

function validUserInput() {
  return { name: 'Taylor Example', linkedinUrl: 'https://www.linkedin.com/in/taylor-example/', location: 'Example City', queries: ['Operations Manager'], modalities: ['hybrid'] };
}

function professionalText() {
  return 'Taylor has led operations delivery, process improvements, and cross-functional stakeholder coordination for several documented initiatives.';
}

function matchingArchitecture(mapping = {}) {
  const matching = JSON.parse(JSON.stringify(candidateOutput().matchingProfile));
  Object.assign(matching.decisionPhilosophy.scoreMapping, mapping);
  return matching;
}

function architectureIsValid(matching) {
  try { validateMatchingArchitecture(matching); return true; } catch (_) { return false; }
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
  const baseTransport = mockTransport();
  const transportCalls = [];
  const transport = async (input) => { capturedTransport = input; transportCalls.push(input); return baseTransport(input); };

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
  const verbatimDestinations = ['matchingprofile.targetroles', 'matchingprofile experience highlight evidence', 'capability evidence', 'summary.targetroles', 'summary.capabilities', 'summary.experience', 'summary.strengths', 'summary.preferences', 'summary.notevidenced', 'summary.rolestoavoid', 'summary.seniority', 'summary.positioning', 'canonical candidate name'];
  ok('prompt cubre destinos cross-artifact con reuse literal', prompt.includes('cross-artifact verbatim reuse') && verbatimDestinations.every((field) => prompt.includes(field)));
  ok('prompt prohíbe rewording de facts canónicos', ['translate', 'paraphrase', 'expand', 'shorten', 'merge', 'reorder wording', 'add qualifiers'].every((rule) => prompt.includes(rule)));
  ok('prompt aclara labels y highlights sintetizados con evidence literal', prompt.includes('capability labels and experience highlight statements may be concise synthesized descriptions') && prompt.includes('each must be grounded by its evidence'));
  ok('prompt permite experience facts y excluye preferencias como evidencia profesional', prompt.includes('professional experience statements/evidence') && prompt.includes('preferences, desired future work, interests and aspirations are not evidence of capability or experience'));


  ok('scoreMapping con labels originales válido', architectureIsValid(matchingArchitecture({ professionalFitScore: 'CAN DO', interestFitScore: 'WANTS TO DO', cvFitScore: 'CAN SELL' })));
  ok('scoreMapping con prosa descriptiva sin tokens válido', architectureIsValid(matchingArchitecture({ professionalFitScore: 'Evaluates demonstrated ability to perform the responsibilities.', interestFitScore: "Measures alignment with the candidate's stated career preferences.", cvFitScore: 'Measures how convincingly the available evidence can be presented.' })));
  ok('scoreMapping con prosa equivalente en español válido', architectureIsValid(matchingArchitecture({ professionalFitScore: 'Evalúa la capacidad demostrada para cumplir las responsabilidades.', interestFitScore: 'Mide la afinidad con las preferencias profesionales declaradas.', cvFitScore: 'Mide cuán convincentemente puede presentarse la evidencia disponible.' })));
  for (const field of ['professionalFitScore', 'interestFitScore', 'cvFitScore']) { const emptyMapping = matchingArchitecture(); emptyMapping.decisionPhilosophy.scoreMapping[field] = ' '; ok(`scoreMapping ${field} vacío inválido`, !architectureIsValid(emptyMapping)); }
  const alternativePhilosophy = matchingArchitecture(); Object.assign(alternativePhilosophy.decisionPhilosophy, { canDo: 'Judge demonstrated capability and credible adjacency', wantsToDo: 'Respect only preferences the person actually stated', canSell: 'Consider whether the evidence can be presented credibly', overallGuidance: 'Resolve conflicting dimensions with evidence-aware judgment' });
  ok('decision philosophy con prosa alternativa válida', architectureIsValid(alternativePhilosophy));
  const spanishPhilosophy = matchingArchitecture(); Object.assign(spanishPhilosophy.decisionPhilosophy, { canDo: 'Evalúa capacidades demostradas y transferibles', wantsToDo: 'Respeta únicamente preferencias expresas', canSell: 'Evalúa si la evidencia puede presentarse de forma creíble', overallGuidance: 'Resuelve dimensiones en conflicto según la evidencia' });
  ok('decision philosophy con prosa en español válida', architectureIsValid(spanishPhilosophy));
  for (const field of ['canDo', 'wantsToDo', 'canSell', 'overallGuidance']) { const emptyDescription = matchingArchitecture(); emptyDescription.decisionPhilosophy[field] = ' '; ok(`decision philosophy ${field} vacía inválida`, !architectureIsValid(emptyDescription)); }
  for (const field of ['canDo', 'wantsToDo', 'canSell', 'overallGuidance']) { const neutralWording = matchingArchitecture(); neutralWording.decisionPhilosophy[field] = 'Not evidenced'; ok(`decision philosophy ${field} no depende de wording literal`, architectureIsValid(neutralWording)); }
  ok('transferability con wording exacto en inglés válido', architectureIsValid(matchingArchitecture()));
  const equivalentTransferability = matchingArchitecture(); equivalentTransferability.transferability.principle = 'Missing keywords do not prove missing capability';
  ok('transferability equivalente sin frase literal válido', architectureIsValid(equivalentTransferability));
  const spanishTransferability = matchingArchitecture(); spanishTransferability.transferability.principle = 'Que no aparezca una palabra clave no implica que falte la capacidad';
  ok('transferability equivalente en español válido', architectureIsValid(spanishTransferability));
  const emptyTransferability = matchingArchitecture(); emptyTransferability.transferability.principle = ' ';
  ok('transferability principle vacío inválido', !architectureIsValid(emptyTransferability));
  const threeTransferabilityLevels = matchingArchitecture(); threeTransferabilityLevels.transferability.classificationLevels.pop();
  ok('transferability con tres niveles inválido', !architectureIsValid(threeTransferabilityLevels));
  const fiveTransferabilityLevels = matchingArchitecture(); fiveTransferabilityLevels.transferability.classificationLevels.push('EXTRA');
  ok('transferability con cinco niveles inválido', !architectureIsValid(fiveTransferabilityLevels));
  const wrongTransferabilityLevels = matchingArchitecture(); wrongTransferabilityLevels.transferability.classificationLevels = ['A', 'B', 'C', 'D'];
  ok('transferability exige los cuatro labels canónicos', !architectureIsValid(wrongTransferabilityLevels));
  const invalidLearnedPreferences = matchingArchitecture(); invalidLearnedPreferences.learnedPreferences.push('inferred preference');
  ok('learnedPreferences conserva validación', !architectureIsValid(invalidLearnedPreferences));

  const oldProfiles = { careerContext: { old: 'career' }, profile: { old: 'profile' }, matchingProfile: { old: 'matching', learnedPreferences: [{ key: 'legacy-feedback-state' }] } };
  fs.mkdirSync(profileDir, { recursive: true });
  for (const [name, value] of Object.entries(oldProfiles)) fs.writeFileSync(path.join(profileDir, `${name}.json`), JSON.stringify(value), 'utf8');

  const original = professionalText();
  const draft = await service.generateProfileDraft({ professionalText: original, preferencesText: 'Hybrid work is preferred.' });
  ok('transport OpenAI es inyectable y mocked', capturedTransport && capturedTransport.model === 'profile-model');
  ok('flujo two-stage llama Stage 1 antes de Stage 2', transportCalls.length === 2 && transportCalls[0].stage === 'stage1' && transportCalls[1].stage === 'stage2');
  ok('Stage 1 exige preferencias negativas canónicas separadas', transportCalls[0].schema.properties.careerContext.required.includes('careerPreferencesToAvoid') && JSON.stringify(transportCalls[0].messages).includes('careerPreferencesToAvoid'));
  const stage2Properties = transportCalls[1].schema.properties;
  const synthesisProperties = stage2Properties.matchingSynthesis.properties;
  ok('schema interno Stage 2 contiene sólo matchingSynthesis', Object.keys(stage2Properties).join(',') === 'matchingSynthesis');
  ok('matchingSynthesis contiene sólo campos model-owned', Object.keys(synthesisProperties).sort().join(',') === 'capabilities,experienceHighlights,positioning,preferenceClassification');
  ok('schema interno Stage 2 excluye campos application-owned', ['meta', 'targetRoles', 'seniority', 'careerPreferences', 'workEnvironmentFit', 'decisionPhilosophy', 'transferability', 'evaluationPrinciples', 'learnedPreferences', 'unknowns', 'summary'].every((field) => !(field in synthesisProperties) && !(field in stage2Properties)));
  ok('Stage 2 prompt limita preferencias a refs de clasificación', JSON.stringify(transportCalls[1].messages).includes('Preference refs classify') && JSON.stringify(transportCalls[1].messages).includes('never professional evidence'));
  ok('prompts internos no asignan learnedPreferences a OpenAI', transportCalls.every((call) => !JSON.stringify(call.messages).includes('learnedPreferences')));
  ok('request al transport no incluye secretos innecesarios', transportCalls.every((call) => Object.keys(call).sort().join(',') === 'apiKey,messages,model,schema,schemaName,stage' && !JSON.stringify(call.messages).includes('fake-key')));
  ok('structured response válida produce draft completo', ['careerContext', 'profile', 'matchingProfile', 'summary', 'metadata'].every((key) => draft[key]));
  ok('profile conserva contrato de getProfileSummary', !!draft.profile.positioning.centralPositioning.statement && draft.profile.targetRoles.families.every((item) => item.family && item.relevance));
  ok('careerContext conserva invariantes de validateArchitecture', ['meta', 'professionalIdentity', 'careerNarrative', 'experienceContext', 'capabilityModel', 'targetRoles', 'roleFitCriteria', 'workEnvironment', 'seniorityInterpretation', 'transferabilityRules', 'decisionPhilosophy', 'careerPreferences', 'evaluationPriorities', 'sourceHierarchy'].every((key) => key in draft.careerContext));
  ok('matchingProfile conserva invariantes de validateArchitecture', ['decisionPhilosophy', 'transferability', 'workEnvironmentFit', 'careerPreferences'].every((key) => key in draft.matchingProfile) && draft.matchingProfile.transferability.classificationLevels.length === 4 && /absence of a keyword/i.test(draft.matchingProfile.transferability.principle) && draft.matchingProfile.decisionPhilosophy.canDo && draft.matchingProfile.decisionPhilosophy.wantsToDo && /not sales ability/i.test(draft.matchingProfile.decisionPhilosophy.canSell));
  ok('two-stage inyecta transferability canónica exacta', JSON.stringify(draft.matchingProfile.transferability) === JSON.stringify(MATCHING_TRANSFERABILITY));
  ok('two-stage inyecta learnedPreferences vacío', Array.isArray(draft.matchingProfile.learnedPreferences) && draft.matchingProfile.learnedPreferences.length === 0);
  ok('targetRoles mantiene primary y secondaryExploratory', Array.isArray(draft.matchingProfile.targetRoles.primary) && Array.isArray(draft.matchingProfile.targetRoles.secondaryExploratory));
  ok('capabilities mantiene dominios ricos incluido commercial', !Array.isArray(draft.matchingProfile.capabilities) && ['operations', 'delivery', 'strategy', 'productOperations', 'commercial'].every((key) => draft.matchingProfile.capabilities[key]));
  ok('matchingProfile válido no se rechaza por longitud JSON', JSON.stringify(draft.matchingProfile).length > JSON.stringify(draft.profile).length);
  ok('search queries no se envían como input al Profile Builder', !JSON.stringify(transportCalls[0].messages).includes('Operations Manager'));
  ok('preferencias no se convierten en experiencia', !JSON.stringify(draft.profile.experience).includes('Hybrid') && !JSON.stringify(draft.matchingProfile.experienceHighlights).includes('Hybrid'));
  const mockAnalysis = { requirementAssessments: [], coreCapabilityCoverage: [], decision: 'MAYBE', overallMatchScore: 50, professionalFitScore: 50, interestFitScore: 50, cvFitScore: 50, roleFamily: 'operations', summary: 's', whyItFits: [], transferableExperience: [], literalMatches: [], gaps: [], criticalRequirementsUnmet: [], redFlags: [], recommendedCV: 'current_cv', cvAdjustments: [], confidence: 50, reasoning: 'r' };
  const analyzed = await analyzeJob(draft.matchingProfile, { jobId: '1', title: 'Example' }, { candidateName: 'Taylor Example', transport: async () => ({ model: 'mock', choices: [{ message: { content: JSON.stringify(mockAnalysis) } }] }) });
  ok('analyzer acepta matchingProfile generado sin cambios', analyzed.analysis.decision === 'MAYBE');
  const draftText = fs.readFileSync(service.paths.draftPath, 'utf8');
  ok('draft persistido contiene transferability canónica', JSON.stringify(JSON.parse(draftText).matchingProfile.transferability) === JSON.stringify(MATCHING_TRANSFERABILITY));
  ok('draft persistido contiene learnedPreferences vacío', Array.isArray(JSON.parse(draftText).matchingProfile.learnedPreferences) && JSON.parse(draftText).matchingProfile.learnedPreferences.length === 0);
  ok('draft no contiene API key', !draftText.includes('fake-key'));
  ok('draft no contiene professionalText original completo', !draftText.includes(original));
  ok('draft no contiene preferencesText original completo', !draftText.includes('Hybrid work is preferred.'));
  ok('draft vive dentro del runtime esperado', path.dirname(service.paths.draftPath) === profileDir && fs.existsSync(service.paths.draftPath));
  ok('generate no modifica perfiles confirmados', Object.entries(oldProfiles).every(([name, value]) => fs.readFileSync(path.join(profileDir, `${name}.json`), 'utf8') === JSON.stringify(value)));
  ok('regeneración no migra ni copia learnedPreferences confirmado', JSON.parse(fs.readFileSync(path.join(profileDir, 'matchingProfile.json'), 'utf8')).learnedPreferences[0].key === 'legacy-feedback-state' && draft.matchingProfile.learnedPreferences.length === 0);
  ok('status profileDraft funciona', service.getStatus().profileDraft === true && service.getStatus().profileDraftValid === true);
  ok('perfiles confirmados existentes siguen activos durante regeneración', service.getStatus().readyForHunt === true);
  const failedGenerateService = createSetupService({ userConfigPath, envPath, profileDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: async () => { throw new Error('simulated generation failure'); } });
  await rejectsCode(() => failedGenerateService.generateProfileDraft({ professionalText: original }), 'OPENAI_REQUEST_FAILED');
  ok('generate fallido conserva draft válido anterior', fs.readFileSync(service.paths.draftPath, 'utf8') === draftText);

  const registryA = buildProfileFactRegistry(candidateOutput().careerContext, candidateOutput().profile);
  const registryB = buildProfileFactRegistry(candidateOutput().careerContext, candidateOutput().profile);
  ok('registry genera IDs determinísticos y orden estable', JSON.stringify(registryA.entries) === JSON.stringify(registryB.entries) && registryA.entries[0].id === 'EXP_001');
  ok('registry deduplica facts normalizados', registryA.entries.filter((item) => normalizeFact(item.text) === normalizeFact('Operations delivery')).length === 1);
  ok('registry conserva namespaces tipados', registryA.entries.some((item) => /^EXP_/.test(item.id) && item.kinds.includes('experience')) && registryA.entries.some((item) => /^CAP_/.test(item.id) && item.kinds.includes('capability')) && registryA.entries.some((item) => /^PREF_/.test(item.id) && item.kinds.includes('preference')));
  ok('preferencias no integran allowlist profesional', registryA.entries.filter((item) => item.kinds.includes('preference')).every((item) => !registryA.capabilityEvidenceIds.includes(item.id) && !registryA.experienceEvidenceIds.includes(item.id)));
  const preferenceRegistryInput = candidateOutput(); preferenceRegistryInput.careerContext.careerPreferences = ['Hybrid work', ' hybrid work ']; preferenceRegistryInput.careerContext.careerPreferencesToAvoid = ['No sales', ' no sales ']; preferenceRegistryInput.careerContext.workEnvironment.preferences = ['Autonomous team', 'no sales']; preferenceRegistryInput.profile.preferences.push('Profile-only preference');
  const preferenceRegistry = buildProfileFactRegistry(preferenceRegistryInput.careerContext, preferenceRegistryInput.profile);
  ok('PREF IDs son determinísticos, estables y deduplicados por tipo', preferenceRegistry.preferenceIds.join('|') === 'PREF_001|PREF_002|PREF_003|PREF_004' && preferenceRegistry.preferenceIds.map((id) => preferenceRegistry.byId.get(id).text).join('|') === 'Hybrid work|No sales|Autonomous team|no sales');
  ok('registry PREF usa sólo fuentes autoritativas Stage 1', !preferenceRegistry.entries.some((entry) => entry.text === 'Profile-only preference'));
  ok('registry PREF conserva polaridad y origen', preferenceRegistry.positiveCareerPreferenceIds.join('|') === 'PREF_001' && preferenceRegistry.negativeCareerPreferenceIds.join('|') === 'PREF_002' && preferenceRegistry.workEnvironmentPreferenceIds.join('|') === 'PREF_003|PREF_004');
  ok('hydration elimina refs y wrapper interno del draft final', !JSON.stringify(draft).includes('evidenceRefs') && !JSON.stringify(draft).includes('matchingSynthesis') && !/\b(?:EXP|CAP|PREF|UNK)_\d{3}\b/.test(JSON.stringify(draft)));
  ok('hydration conserva evidencia canónica exacta', draft.matchingProfile.capabilities.operations.evidence[0] === 'Led documented operations work' && draft.matchingProfile.experienceHighlights[0].evidence[0] === 'Led documented cross-functional work');

  let stage1FailureCalls = 0;
  await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: async () => { stage1FailureCalls += 1; throw new Error('stage 1 failed'); } }), 'OPENAI_REQUEST_FAILED');
  ok('fallo Stage 1 impide Stage 2', stage1FailureCalls === 1);
  let stage2FailureCalls = 0;
  const successfulStage1 = mockTransport();
  await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: async (input) => { stage2FailureCalls += 1; if (input.stage === 'stage2') throw new Error('stage 2 failed'); return successfulStage1(input); } }), 'OPENAI_REQUEST_FAILED');
  ok('fallo Stage 2 no devuelve draft', stage2FailureCalls === 2);
  ok('Stage 2 no puede suministrar ni sobrescribir transferability', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis.transferability = { classificationLevels: ['A'], principle: 'Override' }; }) }), 'INVALID_PROFILE_RESPONSE'));
  ok('Stage 2 no puede suministrar ni sobrescribir learnedPreferences', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis.learnedPreferences = ['model preference']; }) }), 'INVALID_PROFILE_RESPONSE'));
  const forbiddenStage2Fields = ['meta', 'targetRoles', 'seniority', 'careerPreferences', 'workEnvironmentFit', 'decisionPhilosophy', 'evaluationPrinciples', 'unknowns', 'summary'];
  ok('Stage 2 rechaza todos los campos application-owned', (await Promise.all(forbiddenStage2Fields.map((field) => rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis[field] = {}; }) }), 'INVALID_PROFILE_RESPONSE')))).every(Boolean));
  const alternateRules = candidateOutput(); alternateRules.careerContext.transferabilityRules = ['Generated unrelated rule', 'Another Stage 1 rule'];
  const alternateRulesDraft = await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(alternateRules) });
  ok('careerContext.transferabilityRules no controla matching taxonomy', JSON.stringify(alternateRulesDraft.matchingProfile.transferability) === JSON.stringify(MATCHING_TRANSFERABILITY));
  ok('registry no contiene transferability', registryA.entries.every((entry) => !/transferab/i.test(entry.id) && !/transferab/i.test(entry.kind)));
  ok('registry no contiene learnedPreferences', registryA.entries.every((entry) => !/learned/i.test(entry.id) && !/learned/i.test(entry.kind)));
  ok('ref desconocida falla determinísticamente', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis.capabilities.operations.evidenceRefs = ['EXP_999']; }) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  ok('ref vacía falla determinísticamente', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis.capabilities.operations.evidenceRefs = ['']; }) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  const preferenceRef = registryA.entries.find((item) => item.kinds.includes('preference')).id;
  ok('ref de preferencia como capability evidence falla', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis.capabilities.operations.evidenceRefs = [preferenceRef]; }) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  const capabilityOnlyRef = registryA.entries.find((item) => item.kinds.includes('capability') && !item.kinds.includes('experience')).id;
  ok('ref sólo capability como highlight evidence falla', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis.experienceHighlights[0].evidenceRefs = [capabilityOnlyRef]; }) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  const duplicateRefsDraft = await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { const ref = value.matchingSynthesis.capabilities.operations.evidenceRefs[0]; value.matchingSynthesis.capabilities.operations.evidenceRefs = [ref, ref]; }) });
  ok('refs duplicadas se deduplican preservando primera aparición', duplicateRefsDraft.matchingProfile.capabilities.operations.evidence.length === 1 && duplicateRefsDraft.matchingProfile.capabilities.operations.evidence[0] === 'Led documented operations work');
  const referenceRegression = candidateOutput();
  referenceRegression.careerContext.experienceContext[0] = { statement: 'Experience coordinating architects, engineering teams, contractors and suppliers.', evidence: ['Led documented cross-functional work'] };
  referenceRegression.profile.experience[0] = JSON.parse(JSON.stringify(referenceRegression.careerContext.experienceContext[0]));
  referenceRegression.matchingProfile.capabilities.operations.capabilities = ['Supplier coordination'];
  referenceRegression.matchingProfile.capabilities.operations.evidence = ['Experience coordinating architects, engineering teams, contractors and suppliers.'];
  referenceRegression.matchingProfile.experienceHighlights[0].evidence = ['Experience coordinating architects, engineering teams, contractors and suppliers.'];
  referenceRegression.summary.capabilities = ['Supplier coordination', 'Delivery'];
  referenceRegression.summary.experience = [referenceRegression.matchingProfile.experienceHighlights[0].statement];
  const referenceRegressionDraft = await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(referenceRegression) });
  ok('regresión real usa ref e hidrata fact canónico completo', referenceRegressionDraft.matchingProfile.capabilities.operations.evidence[0] === referenceRegression.careerContext.experienceContext[0].statement);
  const invalidRefDir = path.join(root, 'invalid-ref-profile');
  const invalidRefService = createSetupService({ userConfigPath, envPath, profileDir: invalidRefDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: mutateStage2Transport((value) => { value.matchingSynthesis.capabilities.operations.evidenceRefs = ['EXP_999']; }) });
  ok('invalid ref no persiste draft parcial', await rejectsCode(() => invalidRefService.generateProfileDraft({ professionalText: original }), 'INCONSISTENT_PROFILE_ARTIFACTS') && !fs.existsSync(invalidRefService.paths.draftPath));

  ok('root array se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport([]) }), 'INVALID_PROFILE_RESPONSE'));
  ok('root null se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(null) }), 'INVALID_PROFILE_RESPONSE'));
  ok('respuesta incompleta se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport({ careerContext: {} }) }), 'INVALID_PROFILE_RESPONSE'));
  ok('candidate name inconsistente se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(candidateOutput('Another Person')) }), 'INCONSISTENT_CANDIDATE_NAME'));
  const nameVariant = await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(candidateOutput(' TAYLOR EXAMPLE ')) });
  ok('case/whitespace se normaliza y persiste nombre canónico', [nameVariant.careerContext.meta.person, nameVariant.profile.meta.person, nameVariant.matchingProfile.meta.person].every((name) => name === 'Taylor Example'));
  const extra = candidateOutput(); extra.profile.extra = true;
  ok('property extra se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(extra) }), 'INVALID_PROFILE_RESPONSE'));
  ok('campo model-owned obligatorio ausente se rechaza por schema', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { delete value.matchingSynthesis.positioning; }) }), 'INVALID_PROFILE_RESPONSE'));
  const corruptedExternal = JSON.parse(JSON.stringify(draft)); delete corruptedExternal.matchingProfile.decisionPhilosophy.scoreMapping.cvFitScore;
  ok('schema externo conserva scoreMapping obligatorio', await rejectsCode(() => Promise.resolve().then(() => validateProfileDraft(corruptedExternal, 'Taylor Example')), 'INVALID_PROFILE_RESPONSE'));
  ok('modelo no puede inyectar matchingProfile externo', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingProfile = candidateOutput().matchingProfile; }) }), 'INVALID_PROFILE_RESPONSE'));
  const synthesizedCapability = candidateOutput(); synthesizedCapability.matchingProfile.capabilities.operations.capabilities = ['Cost control and construction follow-up']; synthesizedCapability.summary.capabilities = ['Cost control and construction follow-up', 'Delivery'];
  ok('matching capability evidence desde capability evidence pasa', await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(synthesizedCapability) }).then(() => true, () => false));
  const multipleSynthesizedCapabilities = candidateOutput(); multipleSynthesizedCapabilities.matchingProfile.capabilities.operations.capabilities = ['Operational coordination', 'Process delivery']; multipleSynthesizedCapabilities.summary.capabilities = ['Operational coordination', 'Process delivery', 'Delivery'];
  ok('múltiples capabilities sintetizadas con evidence upstream pasan', await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(multipleSynthesizedCapabilities) }).then(() => true, () => false));
  const emptyCapabilityLabel = candidateOutput(); emptyCapabilityLabel.matchingProfile.capabilities.operations.capabilities = ['']; emptyCapabilityLabel.summary.capabilities = ['Delivery'];
  ok('matching capability label vacío falla', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(emptyCapabilityLabel) }), 'INVALID_PROFILE_ARCHITECTURE'));
  const ungroundedCapability = candidateOutput(); ungroundedCapability.matchingProfile.capabilities.operations.capabilities = ['Synthesized capability']; ungroundedCapability.matchingProfile.capabilities.operations.evidence = [];
  ok('matching capability sin evidence falla', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(ungroundedCapability) }), 'INVALID_PROFILE_ARCHITECTURE'));
  const foreignCapabilityEvidence = candidateOutput(); foreignCapabilityEvidence.matchingProfile.capabilities.operations.capabilities = ['Synthesized capability']; foreignCapabilityEvidence.matchingProfile.capabilities.operations.evidence = ['Foreign evidence'];
  ok('matching capability con evidence inventada sigue fallando', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(foreignCapabilityEvidence) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  const experienceGroundedCapability = candidateOutput(); experienceGroundedCapability.matchingProfile.capabilities.operations.capabilities = ['Project delivery coordination']; experienceGroundedCapability.matchingProfile.capabilities.operations.evidence = ['Operations delivery']; experienceGroundedCapability.summary.capabilities = ['Project delivery coordination', 'Delivery'];
  ok('matching capability evidence desde experience statement pasa', await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(experienceGroundedCapability) }).then(() => true, () => false));
  const experienceEvidenceGroundedCapability = candidateOutput(); experienceEvidenceGroundedCapability.matchingProfile.capabilities.operations.capabilities = ['Cross-functional execution']; experienceEvidenceGroundedCapability.matchingProfile.capabilities.operations.evidence = ['Led documented cross-functional work']; experienceEvidenceGroundedCapability.summary.capabilities = ['Cross-functional execution', 'Delivery'];
  ok('matching capability evidence desde experience evidence pasa', await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(experienceEvidenceGroundedCapability) }).then(() => true, () => false));
  const preferenceAsCapabilityEvidence = candidateOutput(); preferenceAsCapabilityEvidence.matchingProfile.capabilities.operations.capabilities = ['Work environment flexibility']; preferenceAsCapabilityEvidence.matchingProfile.capabilities.operations.evidence = ['Hybrid work'];
  ok('career preference sigue excluida de capability evidence', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(preferenceAsCapabilityEvidence) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  const synthesizedHighlight = candidateOutput(); synthesizedHighlight.matchingProfile.experienceHighlights[0].statement = 'Managed concurrent projects and coordinated a team'; synthesizedHighlight.summary.experience = ['Managed concurrent projects and coordinated a team'];
  ok('experience highlight sintetizado con evidence literal pasa', await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(synthesizedHighlight) }).then(() => true, () => false));
  const multipleSynthesizedHighlights = candidateOutput(); multipleSynthesizedHighlights.matchingProfile.experienceHighlights = [{ statement: 'Coordinated complex delivery', evidence: ['Led documented cross-functional work'] }, { statement: 'Owned operational outcomes', evidence: ['Operations delivery'] }]; multipleSynthesizedHighlights.summary.experience = ['Coordinated complex delivery', 'Owned operational outcomes'];
  ok('múltiples experience highlights sintetizados con grounding pasan', await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(multipleSynthesizedHighlights) }).then(() => true, () => false));
  const emptyHighlight = candidateOutput(); emptyHighlight.matchingProfile.experienceHighlights[0].statement = ' ';
  ok('experience highlight statement vacío falla', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(emptyHighlight) }), 'INVALID_PROFILE_ARCHITECTURE'));
  const inventedHighlightEvidence = candidateOutput(); inventedHighlightEvidence.matchingProfile.experienceHighlights[0].statement = 'Concise grounded presentation'; inventedHighlightEvidence.matchingProfile.experienceHighlights[0].evidence = ['Invented professional evidence'];
  ok('experience highlight evidence inventada falla', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(inventedHighlightEvidence) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  const preferenceAsHighlightEvidence = candidateOutput(); preferenceAsHighlightEvidence.matchingProfile.experienceHighlights[0].statement = 'Preferred work environment'; preferenceAsHighlightEvidence.matchingProfile.experienceHighlights[0].evidence = ['Hybrid work'];
  ok('career preference sigue excluida de highlight evidence', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(preferenceAsHighlightEvidence) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  const canonicalOwnership = candidateOutput();
  canonicalOwnership.careerContext.targetRoles.primary.push({ roleFamily: ' operations ', roles: ['Operations Manager', 'Chief of Operations'], relevance: 'Ignored duplicate relevance', evidence: ['Ignored duplicate evidence'] });
  canonicalOwnership.careerContext.targetRoles.aspirational.push({ roleFamily: 'Strategy', roles: ['Strategy Manager', ' strategy manager '], relevance: 'Exploratory', evidence: ['Career aspiration'] });
  canonicalOwnership.careerContext.careerPreferences = ['Hybrid work', ' hybrid work '];
  canonicalOwnership.careerContext.careerPreferencesToAvoid = ['No pure sales', ' no pure sales '];
  canonicalOwnership.careerContext.workEnvironment.preferences = ['Hybrid', 'Autonomous teams', ' hybrid '];
  canonicalOwnership.careerContext.workEnvironment.evidence = ['User stated hybrid preference', 'Direct preference statement', ' user stated hybrid preference '];
  canonicalOwnership.careerContext.unknowns = ['Budget ownership not evidenced', 'Team size not evidenced'];
  canonicalOwnership.profile.unknowns = ['Budget ownership not evidenced', 'Exact team size'];
  canonicalOwnership.matchingProfile.careerPreferences.avoidAsPrimaryDirection = ['No pure sales'];
  canonicalOwnership.matchingProfile.workEnvironmentFit.acceptable = ['Hybrid'];
  canonicalOwnership.matchingProfile.workEnvironmentFit.avoid = [];
  canonicalOwnership.matchingProfile.roleTypesToAvoid = ['No pure sales'];
  const ownedDraft = await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(canonicalOwnership) });
  ok('target roles se proyectan con orden, buckets y dedupe estables', ownedDraft.matchingProfile.targetRoles.primary.length === 1 && ownedDraft.matchingProfile.targetRoles.primary[0].roleFamily === 'Operations' && ownedDraft.matchingProfile.targetRoles.primary[0].roles.join('|') === 'Operations Manager|Chief of Operations' && ownedDraft.matchingProfile.targetRoles.secondaryExploratory[0].roleFamily === 'Strategy' && ownedDraft.matchingProfile.targetRoles.secondaryExploratory[0].roles.length === 1);
  ok('seniority se proyecta como copia fresca exacta', JSON.stringify(ownedDraft.matchingProfile.seniority) === JSON.stringify(canonicalOwnership.profile.seniority) && ownedDraft.matchingProfile.seniority !== canonicalOwnership.profile.seniority);
  ok('preferencias explícitas positivas se proyectan sin mezclar negativas', ownedDraft.matchingProfile.careerPreferences.explicit.join('|') === 'Hybrid work');
  ok('work environment preferred/evidence se proyecta con dedupe estable', ownedDraft.matchingProfile.workEnvironmentFit.preferred.join('|') === 'Hybrid|Autonomous teams' && ownedDraft.matchingProfile.workEnvironmentFit.evidence.join('|') === 'User stated hybrid preference|Direct preference statement');
  ok('clasificación de preferencias se hidrata por tipo PREF', ownedDraft.matchingProfile.careerPreferences.avoidAsPrimaryDirection[0] === 'No pure sales' && ownedDraft.matchingProfile.workEnvironmentFit.acceptable[0] === 'Hybrid' && ownedDraft.matchingProfile.workEnvironmentFit.avoid.length === 0 && ownedDraft.matchingProfile.roleTypesToAvoid[0] === 'No pure sales');
  ok('unknowns se unen sin omisión y con dedupe estable', ownedDraft.matchingProfile.unknowns.join('|') === 'Budget ownership not evidenced|Team size not evidenced|Exact team size');
  ok('meta y filosofía son configuración determinística', ownedDraft.matchingProfile.meta.person === 'Taylor Example' && ownedDraft.matchingProfile.meta.purpose === MATCHING_PURPOSE && JSON.stringify(ownedDraft.matchingProfile.decisionPhilosophy) === JSON.stringify(MATCHING_DECISION_PHILOSOPHY));
  ok('evaluationPrinciples se proyecta desde profile', JSON.stringify(ownedDraft.matchingProfile.evaluationPrinciples) === JSON.stringify(canonicalOwnership.profile.evaluationPrinciples));
  ok('summary completo se construye determinísticamente', ownedDraft.summary.positioning === canonicalOwnership.profile.positioning.headline && ownedDraft.summary.seniority === canonicalOwnership.profile.seniority.assessedLevel && ownedDraft.summary.experience[0] === canonicalOwnership.matchingProfile.experienceHighlights[0].statement && ownedDraft.summary.strengths.join('|') === 'Operations|Delivery' && ownedDraft.summary.notEvidenced.join('|') === ownedDraft.matchingProfile.unknowns.join('|') && ownedDraft.summary.rolesToAvoid[0] === 'No pure sales');
  ok('summary targetRoles deriva del matching final', ownedDraft.summary.targetRoles.join('|') === 'Operations|Operations Manager|Chief of Operations|Strategy|Strategy Manager');
  ok('summary capabilities deriva de labels sintetizados', ownedDraft.summary.capabilities.join('|') === 'Operations|Delivery');
  ok('summary experience deriva de highlight statements', ownedDraft.summary.experience.join('|') === 'Operations delivery');
  ok('summary strengths deriva de profile capabilities', ownedDraft.summary.strengths.join('|') === 'Operations|Delivery');
  ok('summary notEvidenced deriva de unknowns finales', ownedDraft.summary.notEvidenced.join('|') === 'Budget ownership not evidenced|Team size not evidenced|Exact team size');
  ok('summary rolesToAvoid deriva de clasificación hidratada', ownedDraft.summary.rolesToAvoid.join('|') === 'No pure sales');
  ok('summary preferences conserva orden contractual', ownedDraft.summary.preferences.join('|') === 'Hybrid work|No pure sales|Hybrid|Autonomous teams');
  ok('paráfrasis model-owned de campos application-owned no sobrevive', ownedDraft.matchingProfile.targetRoles.primary[0].roles[0] === 'Operations Manager' && ownedDraft.matchingProfile.careerPreferences.explicit[0] === 'Hybrid work' && ownedDraft.summary.positioning === 'Operations Leader');
  const realNegativeCase = candidateOutput();
  realNegativeCase.careerContext.careerPreferences = ['Posiciones senior en arquitectura retail y gestión técnica de proyectos'];
  realNegativeCase.careerContext.careerPreferencesToAvoid = ['No busco posiciones exclusivamente de delineación', 'No busco puestos centrados únicamente en operaciones generales'];
  realNegativeCase.matchingProfile.careerPreferences.avoidAsPrimaryDirection = ['No busco puestos centrados únicamente en operaciones generales'];
  realNegativeCase.matchingProfile.roleTypesToAvoid = ['No busco posiciones exclusivamente de delineación'];
  const realNegativeDraft = await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(realNegativeCase) });
  ok('regresión real preserva delineación como role type evitado', realNegativeDraft.matchingProfile.roleTypesToAvoid[0] === 'No busco posiciones exclusivamente de delineación');
  ok('regresión real preserva operaciones generales como dirección evitada', realNegativeDraft.matchingProfile.careerPreferences.avoidAsPrimaryDirection[0] === 'No busco puestos centrados únicamente en operaciones generales');
  ok('preferencias negativas no se convierten en evidencia profesional', !JSON.stringify(realNegativeDraft.matchingProfile.capabilities).includes('exclusivamente de delineación') && !JSON.stringify(realNegativeDraft.matchingProfile.experienceHighlights).includes('operaciones generales'));
  ok('preferencia negativa explícita no puede omitirse de ambos buckets', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis.preferenceClassification.avoidAsPrimaryDirectionRefs = []; value.matchingSynthesis.preferenceClassification.roleTypesToAvoidRefs = []; }, realNegativeCase) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  const noNegativeCase = candidateOutput();
  const noNegativeDraft = await generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(noNegativeCase) });
  ok('sin fuente negativa no se inventan evitaciones', noNegativeDraft.matchingProfile.careerPreferences.avoidAsPrimaryDirection.length === 0 && noNegativeDraft.matchingProfile.roleTypesToAvoid.length === 0);
  const wrongPreferenceRef = registryA.capabilityEvidenceIds[0];
  ok('ref profesional como clasificación de preferencia falla', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis.preferenceClassification.avoidAsPrimaryDirectionRefs = [wrongPreferenceRef]; }) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  const positivePreferenceRef = registryA.positiveCareerPreferenceIds[0];
  const workPreferenceRef = registryA.workEnvironmentPreferenceIds[0];
  ok('preferencia positiva no puede usarse como dirección negativa', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis.preferenceClassification.avoidAsPrimaryDirectionRefs = [positivePreferenceRef]; }) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  ok('preferencia de entorno no puede usarse como role type evitado', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis.preferenceClassification.roleTypesToAvoidRefs = [workPreferenceRef]; }) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  ok('ref de preferencia desconocida falla', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mutateStage2Transport((value) => { value.matchingSynthesis.preferenceClassification.avoidAsPrimaryDirectionRefs = ['PREF_999']; }) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  const invalidPreferenceService = createSetupService({ userConfigPath, envPath, profileDir, processEnv: { OPENAI_API_KEY: 'fake-key' }, profileTransport: mutateStage2Transport((value) => { value.matchingSynthesis.preferenceClassification.avoidAsPrimaryDirectionRefs = ['PREF_999']; }) });
  ok('preference ref inválida conserva el draft anterior', await rejectsCode(() => invalidPreferenceService.generateProfileDraft({ professionalText: original }), 'INCONSISTENT_PROFILE_ARTIFACTS') && fs.readFileSync(service.paths.draftPath, 'utf8') === draftText);
  const foreignCapability = candidateOutput(); foreignCapability.matchingProfile.capabilities.operations.evidence = ['Demonstrated operational leadership'];
  ok('matching capability evidence sin fuente falla', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(foreignCapability) }), 'INCONSISTENT_PROFILE_ARTIFACTS'));
  const emptyProfile = candidateOutput(); emptyProfile.profile.positioning.headline = ''; emptyProfile.profile.experience = []; emptyProfile.profile.capabilities = []; emptyProfile.profile.targetRoles.families = []; emptyProfile.summary.positioning = '';
  ok('profile vacío/inútil se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(emptyProfile) }), 'EMPTY_PROFILE'));
  const emptyMatching = candidateOutput(); emptyMatching.matchingProfile.positioning.headline = ''; emptyMatching.matchingProfile.experienceHighlights = []; Object.values(emptyMatching.matchingProfile.capabilities).forEach((domain) => { domain.capabilities = []; domain.evidence = []; }); emptyMatching.summary.positioning = emptyMatching.profile.positioning.headline; emptyMatching.summary.capabilities = [];
  ok('matchingProfile vacío/inútil se rechaza', await rejectsCode(() => generateProfiles({ professionalText: original }, { candidateName: 'Taylor Example', apiKey: 'x', transport: mockTransport(emptyMatching) }), 'EMPTY_MATCHING_PROFILE'));

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

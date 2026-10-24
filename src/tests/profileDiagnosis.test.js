'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { diagnose, sections } = require('../ai/simpleProfile');
const fixtures = require('../../docs/validation-pilot/fixtures.json');
const markdown = values => sections.map((s, i) => '## ' + s + '\n' + (values[i] || '')).join('\n\n');
const sufficient = 'Perfil suficientemente documentado';
const noNumbers = markdown([
  'Arquitecta edilicia especializada en reformas residenciales.',
  'En prácticas de un estudio preparé planos de viviendas con AutoCAD y registré mediciones en visitas de obra bajo supervisión.',
  'AutoCAD para plantas y secciones de viviendas. Mediciones con cinta métrica durante visitas de obra.',
  'Jornada parcial presencial. Ubicación: Barcelona.',
  'Busco un puesto junior de arquitecta para reformas de viviendas.'
]);
const seniorGeneric = markdown([
  'Arquitecto senior con amplia experiencia.',
  'Lideré proyectos estratégicos y equipos de alto rendimiento. Gestioné resultados excelentes.',
  'Uso muchas herramientas relevantes del sector.',
  'Busco buenas condiciones y oportunidades.',
  'Quiero seguir creciendo profesionalmente.'
]);

test('encabezados vacíos: cinco carencias y preguntas concretas', () => {
  const d = diagnose(markdown([]));
  assert.notEqual(d.status, sufficient);
  assert.deepEqual(d.missing, sections);
  assert.equal(d.questions.length, 5);
  assert(d.questions.every(q => q.section && q.question.includes('¿')));
});
test('A8 superficial con todos los encabezados: no se aprueba por formato', () => {
  const d = diagnose(fixtures.profiles.superficial);
  assert.notEqual(d.status, sufficient);
  for (const name of sections.slice(1)) assert(d.missing.includes(name));
  assert(d.questions.some(q => /entregable/.test(q.question)));
  assert(d.questions.some(q => /herramienta/.test(q.question)));
});
test('junior con prácticas documentadas: suficiente sin dirección ni gran experiencia', () => {
  assert.equal(diagnose(fixtures.profiles.junior_synthetic).status, sufficient);
  assert.equal(diagnose(noNumbers).status, sufficient);
  assert.equal(diagnose(noNumbers.replace('En prácticas de un estudio preparé', 'Sin experiencia laboral, preparé')).status, sufficient);
});
test('senior genérico: antigüedad y liderazgo no sustituyen evidencia', () => {
  const d = diagnose(seniorGeneric);
  assert.notEqual(d.status, sufficient);
  assert(d.missing.includes(sections[1]));
  assert(d.missing.includes(sections[2]));
});
test('arquitectura edilicia: responsabilidades y herramientas contextualizadas', () => {
  const d = diagnose(noNumbers);
  assert.equal(d.status, sufficient);
  assert.deepEqual(d.missing, []);
  assert.deepEqual(d.questions, []);
});
test('documentación profesional suficiente sin métricas, presupuestos o resultados numéricos', () => {
  assert(!/\d/.test(noNumbers));
  assert(!/presupuesto|lider|dirig|resultado/i.test(noNumbers));
  assert.equal(diagnose(noNumbers).status, sufficient);
});
test('prosa larga, repetición y decoración Markdown no ganan suficiencia', () => {
  const repeated = fixtures.profiles.superficial.replace('Trabajo en proyectos.', 'Trabajo en proyectos. '.repeat(100));
  assert.deepEqual(diagnose(repeated).missing, diagnose(fixtures.profiles.superficial).missing);
  assert.deepEqual(diagnose('<!-- ' + noNumbers + ' -->\n' + markdown([])).missing, sections);
  assert.equal(diagnose(noNumbers.replaceAll('## ', '## ').replaceAll('AutoCAD', '**AutoCAD**')).status, sufficient);
  assert.equal(diagnose(noNumbers.replace('En prácticas', '### Prácticas\nEn prácticas')).status, sufficient);
});
test('herramientas sin contexto y tareas negadas no acreditan información', () => {
  const list = noNumbers.replace(/## Capacidades y herramientas[\s\S]*?(?=## Preferencias)/, '## Capacidades y herramientas\nRevit, Navisworks.\n\n');
  assert(diagnose(list).missing.includes(sections[2]));
  const negated = noNumbers.replace(/## Experiencia y responsabilidades[\s\S]*?(?=## Capacidades)/, '## Experiencia y responsabilidades\nNo preparé planos ni registré mediciones de viviendas.\n\n');
  assert(diagnose(negated).missing.includes(sections[1]));
});
test('otras profesiones y métodos manuales: no depende de una marca de software', () => {
  const admin = markdown([
    'Administrativa de contabilidad en comercio.',
    'Revisé facturas y preparé conciliaciones bancarias en el comercio familiar.',
    'Hoja de cálculo para conciliaciones y revisión de facturas.',
    'No tengo restricciones de modalidad. Jornada completa.',
    'Busco un puesto de auxiliar contable.'
  ]);
  assert.equal(diagnose(admin).status, sufficient);
});
test('preferencias pendientes: diagnóstico utilizable, sin bloqueo', () => {
  const pending = noNumbers.replace(/## Preferencias y restricciones[\s\S]*?(?=## Objetivos)/, '## Preferencias y restricciones\nPendiente\n\n');
  const d = diagnose(pending);
  assert.equal(d.status, 'Perfil utilizable con información pendiente');
  assert.deepEqual(d.missing, [sections[3]]);
  assert(d.advice.includes('Podés seguir buscando'));
});
test('guardar y releer un perfil superficial sigue permitido', () => {
  const tempRoot = path.resolve(__dirname, '../../private-baseline');
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'hunter-diagnosis-'));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ai/simpleProfile.js'), 'utf8'), {
    module, Buffer, __dirname: dir, require: n => n === './profileDiagnosis' ? require('../ai/profileDiagnosis') : require(n)
  });
  const d = module.exports.save(fixtures.profiles.superficial);
  assert.notEqual(d.status, sufficient);
  assert.equal(module.exports.read(), fixtures.profiles.superficial);
  assert.equal(module.exports.profile().candidateDocument, fixtures.profiles.superficial);
});
test('perfil superficial: discovery, análisis simulado y persistencia no se bloquean', async () => {
  const { createLocalRepository } = require('../data/jobRepository');
  const { createJobService } = require('../services/jobService');
  const { runPipeline } = require('../pipeline/pipeline');
  const { analyzeJob, JOB_ANALYSIS_SCHEMA } = require('../ai/jobAnalyzer');
  const dir = fs.mkdtempSync(path.resolve(__dirname, '../../private-baseline/diagnosis-pipeline-'));
  const repo = createLocalRepository({ dir });
  const candidateDocument = fixtures.profiles.superficial;
  const profile = { candidateDocument, informationQuality: diagnose(candidateDocument) };
  const reply = Object.fromEntries(Object.entries(JOB_ANALYSIS_SCHEMA.properties).map(([key, schema]) =>
    [key, schema.enum ? schema.enum[0] : schema.type === 'array' ? [] : schema.type === 'integer' ? 40 : 'Respuesta simulada']));
  reply.decision = 'MAYBE';
  let calls = 0;
  const job = { ...fixtures.jobs.building, url: 'https://example.invalid/pilot' };
  const summary = await runPipeline({
    jobService: createJobService(repo), analyzeLimit: 1,
    discover: async () => ({ jobs: [job], discovery: {} }),
    fetchDetails: async j => ({ ...j, description: job.description }),
    analyze: j => analyzeJob(profile, j, { transport: async () => {
      calls++;
      return { choices: [{ message: { content: JSON.stringify(reply) } }] };
    } })
  });
  assert.equal(calls, 1);
  assert.equal(summary.analysis.analyzed, 1);
  assert.equal(repo.get(job.jobId).aiAnalysis.decision, 'MAYBE');
});
test('la UI muestra las preguntas como texto y admite el perfil original sin preguntas', () => {
  function node(){return {children:[],textContent:'',append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;}};}
  const elements = { text: node(), status: node(), save: node(), file: node(), diagnosis: node() };
  const content=n=>n.textContent+n.children.map(content).join(' ');
  const context = vm.createContext({ window: { SessionApi: { request: () => new Promise(() => {}) } }, document: { getElementById: id => elements[id], createElement: () => node() }, fetch: () => new Promise(() => {}) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/public/profile.js'), 'utf8'), context);
  context.d = diagnose(fixtures.profiles.superficial);
  vm.runInContext('show(d)', context);
  for (const item of context.d.questions) assert(content(elements.diagnosis).includes(item.question));
  context.d = { status: 'Perfil original preservado', missing: [] };
  vm.runInContext('show(d)', context);
  assert(content(elements.diagnosis).includes('Perfil original preservado'));
});

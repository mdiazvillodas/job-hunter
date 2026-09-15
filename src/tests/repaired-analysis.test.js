'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createJobService } = require('../services/jobService');
const { shouldAnalyzeJob, markAnalysisStale } = require('../domain/jobRecord');
const { runPipeline } = require('../pipeline/pipeline');
const { parseReanalysisArgs, selectRepairedJobs, reanalyzeRepaired, migrateRepairedSample } = require('../repair/repairedAnalysis');
const L = require('../ui/jobListLogic');

const good = 'description '.repeat(40);
function job(id = '1', overrides = {}) {
  return { jobId: id, title: 'Role', description: good, aiAnalysis: { decision: 'YES', overallMatchScore: 90, summary: 'OLD_ANALYSIS' },
    analysisStatus: 'stale', analysisStaleReason: 'description_repaired', analysisStaleAt: '2026-09-09T12:00:00Z',
    analysisCompletedAt: '2026-09-08T12:00:00Z', analysisAttemptedAt: '2026-09-08T11:00:00Z',
    matchedQueries: [], matchedFamilies: [], userState: { status: 'interested', firstSeenAt: '2026-09-01T00:00:00Z' },
    feedback: { reasons: [], comment: 'keep' }, feedbackEvents: [{ type: 'interested' }],
    descriptionRepair: { attempts: [{ recovered: true, previousLength: 0, extractedLength: good.length, attemptedAt: '2026-09-09T11:00:00Z' }] }, ...overrides };
}
function repo(jobs) {
  const map = new Map(jobs.map(j => [j.jobId, structuredClone(j)]));
  return { has: id => map.has(id), getAll: () => structuredClone([...map.values()]),
    get: id => structuredClone(map.get(id)), save: j => { map.set(j.jobId, structuredClone(j)); return j; } };
}
const result = { analysis: { decision: 'MAYBE', overallMatchScore: 65 } };

test('CLI dry-run por defecto, limit e IDs repetibles', () => {
  assert.equal(parseReanalysisArgs([]).dryRun, true);
  const options = parseReanalysisArgs(['--dry-run', '--limit', '1', '--job-id', '2', '--job-id', '3']);
  assert.deepEqual(selectRepairedJobs([job('1'), job('2'), job('3')], options).jobs.map(j => j.jobId), ['2']);
  assert.equal(parseReanalysisArgs(['--limit', '2']).dryRun, false);
  for (const args of [['--analyzed-only'], ['--limit', '0'], ['--limit', '1.5'], ['--job-id', 'bad'], ['--unknown']]) assert.throws(() => parseReanalysisArgs(args));
});
test('eligibilidad distingue pending, stale y completed', () => {
  assert.equal(shouldAnalyzeJob(job()), true);
  assert.equal(shouldAnalyzeJob(job('2', { analysisStatus: 'completed', analysisStaleReason: null })), false);
  assert.equal(shouldAnalyzeJob(job('3', { analysisStatus: 'pending', aiAnalysis: null })), true);
  const selection = selectRepairedJobs([job(), job('2', { description: null }), job('3', { analysisStatus: 'completed' }), job('4', { analysisStaleReason: 'another_reason' })], {});
  assert.deepEqual(selection.jobs.map(j => j.jobId), ['1']);
});
test('dry-run no escritura ni analyzer', async () => {
  const repository = repo([job()]); const before = repository.getAll();
  repository.save = () => assert.fail('dry-run writes');
  const summary = await reanalyzeRepaired({ jobService: createJobService(repository), options: { dryRun: true }, analyze: () => assert.fail('dry-run API') });
  assert.equal(summary.selected, 1); assert.equal(summary.analyzed, 0);
  assert.deepEqual(repository.getAll(), before);
});
test('reananalysis exitoso reemplaza resultado y conserva trazabilidad/feedback', async () => {
  const original = job(); const repository = repo([original]); const svc = createJobService(repository);
  const summary = await reanalyzeRepaired({ jobService: svc, options: { limit: 1 }, analyze: async input => {
    assert.equal(input.description, good); assert.equal(svc.getJob('1').analysisStatus, 'stale'); return result;
  } });
  const updated = svc.getJob('1');
  assert.equal(summary.analyzed, 1); assert.equal(updated.analysisStatus, 'completed');
  assert.deepEqual(updated.aiAnalysis, result.analysis); assert.equal(updated.analysisStaleReason, null);
  assert.equal(updated.analysisReanalysisHistory[0].previousAnalysisCompletedAt, original.analysisCompletedAt);
  assert.equal(updated.analysisReanalysisHistory[0].reason, 'description_repaired');
  assert.ok(updated.analysisStaleResolvedAt);
  for (const key of ['userState', 'feedback', 'feedbackEvents', 'descriptionRepair', 'analysisStaleAt']) assert.deepEqual(updated[key], original[key]);
  assert.equal(selectRepairedJobs([updated], {}).jobs.length, 0);
});
test('fallo del analyzer conserva analisis viejo y estado stale', async () => {
  const original = job(); const repository = repo([original]);
  const summary = await reanalyzeRepaired({ jobService: createJobService(repository), options: { limit: 1 }, analyze: async () => { throw new Error('API unavailable'); } });
  const after = repository.get('1');
  assert.equal(summary.failed, 1); assert.equal(after.analysisStatus, 'stale');
  assert.deepEqual(after.aiAnalysis, original.aiAnalysis);
  assert.equal(after.analysisCompletedAt, original.analysisCompletedAt);
  assert.equal(after.analysisError, 'API unavailable');
});
test('stale insuficiente no llama analyzer, tampoco en pipeline normal', async () => {
  const original = job('1', { description: 'short' }); const repository = repo([original]); const svc = createJobService(repository);
  await reanalyzeRepaired({ jobService: svc, options: { limit: 1 }, analyze: () => assert.fail('insufficient') });
  const summary = await runPipeline({ jobService: svc, discover: async () => ({ jobs: [{ jobId: '1' }] }),
    fetchDetails: async () => ({ description: null }), analyze: () => assert.fail('P0'), analyzeLimit: 1 });
  assert.equal(summary.analysis.skippedDueToMissingDescription, 1);
  assert.equal(svc.getJob('1').analysisStatus, 'stale');
  assert.deepEqual(svc.getJob('1').aiAnalysis, original.aiAnalysis);
  assert.equal(svc.getJob('1').analysisCompletedAt, original.analysisCompletedAt);
});
test('completed vigente no se reanaliza', async () => {
  const original = job('1', { analysisStatus: 'completed', analysisStaleReason: null }); const repository = repo([original]);
  const summary = await reanalyzeRepaired({ jobService: createJobService(repository), options: { limit: 1 }, analyze: () => assert.fail('completed') });
  assert.equal(summary.selected, 0); assert.deepEqual(repository.get('1'), original);
});
test('limit y job-id restringen llamadas reales simuladas', async () => {
  const repository = repo([job('1'), job('2'), job('3')]); const calls = [];
  await reanalyzeRepaired({ jobService: createJobService(repository), options: parseReanalysisArgs(['--limit', '1', '--job-id', '2', '--job-id', '3']),
    analyze: async j => { calls.push(j.jobId); return result; } });
  assert.deepEqual(calls, ['2']); assert.equal(repository.get('1').analysisStatus, 'stale'); assert.equal(repository.get('3').analysisStatus, 'stale');
});
test('migracion solo del informe, idempotente, conserva timestamps historicos', () => {
  const original = job('1', { analysisStatus: 'completed', analysisStaleReason: undefined, analysisStaleAt: undefined });
  const repository = repo([original, job('2', { analysisStatus: 'completed' })]);
  const report = { recovered: 1, jobs: [{ jobId: '1', diagnostics: { status: 'description_extracted' } }] };
  const summary = migrateRepairedSample(repository, report, { clock: () => '2026-09-09T13:00:00Z' });
  assert.equal(summary.migrated, 1); assert.equal(repository.get('2').analysisStatus, 'completed');
  assert.equal(repository.get('1').analysisStatus, 'stale');
  for (const key of ['aiAnalysis', 'userState', 'feedbackEvents', 'analysisCompletedAt', 'analysisAttemptedAt']) assert.deepEqual(repository.get('1')[key], original[key]);
  assert.equal(migrateRepairedSample(repository, report).migrated, 0);
});
test('migracion prevalida el lote, sin escrituras parciales ante datos invalidos', () => {
  const repository = repo([job('1', { analysisStatus: 'completed' }), job('2', { descriptionRepair: null })]); const before = repository.getAll();
  assert.throws(() => migrateRepairedSample(repository, { recovered: 2, jobs: ['1', '2'].map(jobId => ({ jobId, diagnostics: { status: 'description_extracted' } })) }));
  assert.deepEqual(repository.getAll(), before);
});
test('marcar stale no inventa analisis en jobs pending', () => {
  const original = job('1', { analysisStatus: 'pending', aiAnalysis: null });
  assert.deepEqual(markAnalysisStale(structuredClone(original)), original);
});
test('UI excluye scores/decisiones stale de filtros y orden vigente', () => {
  const stale = job(); const current = job('2', { analysisStatus: 'completed', aiAnalysis: { overallMatchScore: 60, decision: 'MAYBE' } });
  assert.equal(L.listItemView(stale).overall, null); assert.equal(L.listItemView(stale).analysisStale, true);
  assert.deepEqual(L.filterJobs([stale], { minScore: 80 }), []);
  assert.deepEqual(L.filterJobs([stale], { aiDecision: 'YES' }), []);
  assert.equal(L.sortJobs([stale, current], 'overall')[0].jobId, '2');
});
test('UI real renderiza aviso stale y no muestra score/reasoning anterior', () => {
  const elements = new Map();
  const context = { window: { JobListLogic: L }, document: { addEventListener() {}, getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', querySelectorAll: () => [] }); return elements.get(id);
  } } };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/public/app.js'), 'utf8'), context);
  context.renderDetail(job(), null);
  const html = elements.get('detailContent').innerHTML;
  assert.match(html, /Análisis pendiente de actualización tras recuperar la descripción/);
  assert.doesNotMatch(html, /OLD_ANALYSIS|class="val">90</);
  assert.match(context.jobItemHtml(job()), /IA pendiente de actualización/);
  context.renderDetail(job('2', { analysisStatus: 'completed' }), null);
  assert.match(elements.get('detailContent').innerHTML, /OLD_ANALYSIS/);
  assert.match(elements.get('detailContent').innerHTML, /class="val">90</);
});

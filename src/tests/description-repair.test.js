'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRepairArgs, selectRepairJobs, validDirectJobUrl, repairDescriptions } = require('../repair/descriptionRepair');
const good = 'Evidence '.repeat(50);
const makeJob = (id, description = null) => ({ jobId: id, url: `https://www.linkedin.com/jobs/view/${id}/`, description,
  descriptionLength: (description || '').length, aiAnalysis: { decision: 'YES', overallMatchScore: 90 },
  analysisStatus: 'completed', analysisCompletedAt: 'old', analysisError: null, userState: { status: 'interested' }, feedbackEvents: ['keep'] });
function repo(jobs) {
  const map = new Map(jobs.map(j => [j.jobId, structuredClone(j)]));
  return { getAll: () => structuredClone([...map.values()]), get: id => structuredClone(map.get(id)), save: j => map.set(j.jobId, structuredClone(j)) };
}

test('CLI segura y argumentos estrictos', () => {
  assert.equal(parseRepairArgs([]).dryRun, true);
  assert.equal(parseRepairArgs(['--limit', '10']).dryRun, false);
  assert.deepEqual(parseRepairArgs(['--dry-run', '--limit', '2', '--job-id', '123', '--job-id', '456', '--analyzed-only']), {
    dryRun: true, limit: 2, jobIds: ['123', '456'], analyzedOnly: true,
  });
  for (const args of [['--limit', '0'], ['--limit', '-1'], ['--limit', '2abc'], ['--job-id'], ['--unknown']]) assert.throws(() => parseRepairArgs(args));
});
test('seleccion solo insuficientes, limite, ID y analizados opcional', () => {
  const jobs = [makeJob('1'), makeJob('2', good), { ...makeJob('3'), aiAnalysis: null }];
  assert.equal(selectRepairJobs(jobs, {}).jobs.length, 2);
  assert.equal(selectRepairJobs(jobs, { analyzedOnly: true }).jobs.length, 1);
  assert.equal(selectRepairJobs(jobs, { jobIds: ['2'] }).jobs.length, 0);
  assert.equal(selectRepairJobs(jobs, { limit: 1 }).jobs.length, 1);
});
test('dry-run no fetch, browser ni escritura', async () => {
  const repository = repo([makeJob('1')]); const before = repository.getAll();
  repository.save = () => assert.fail('dry-run no escribe');
  const summary = await repairDescriptions({ repository, options: { dryRun: true }, fetchDetail: () => assert.fail('dry-run no fetch') });
  assert.equal(summary.attempted, 0); assert.equal(summary.selected, 1);
  assert.deepEqual(repository.getAll(), before);
});
test('repair actualiza solo descripcion y metadata; preserva analisis y feedback', async () => {
  const original = makeJob('1', 'short'); const repository = repo([original]);
  const summary = await repairDescriptions({ repository, options: { limit: 1 }, fetchDetail: async job => {
    assert.equal(job.url, original.url);
    return { detail: { description: good, title: 'do not overwrite', detailExtraction: { status: 'description_extracted' } } };
  } });
  const after = repository.get('1');
  assert.equal(after.description, good); assert.equal(after.descriptionLength, good.length);
  for (const [key, value] of Object.entries(original)) if (!['description', 'descriptionLength', 'analysisStatus'].includes(key)) assert.deepEqual(after[key], value);
  assert.equal(after.analysisStatus, 'stale');
  assert.equal(after.analysisStaleReason, 'description_repaired');
  assert.ok(after.analysisStaleAt);
  assert.equal(summary.recovered, 1); assert.equal(after.descriptionRepair.attempts.length, 1);
});
test('fallo y texto corto no destruyen informacion; intentos quedan registrados', async () => {
  const original = makeJob('1', 'existing short'); const repository = repo([original]);
  for (let i = 0; i < 2; i++) await repairDescriptions({ repository, options: { limit: 1 }, fetchDetail: async () => {
    if (!i) throw new Error('network'); return { detail: { description: 'x' } };
  } });
  const after = repository.get('1');
  for (const [key, value] of Object.entries(original)) assert.deepEqual(after[key], value);
  assert.equal(after.descriptionRepair.attempts.length, 2);
  assert.equal(after.descriptionRepair.attempts[0].diagnostics.status, 'detail_fetch_error');
  assert.equal(after.descriptionRepair.attempts[1].diagnostics.status, 'description_too_short');
});
test('auth/challenge detiene el lote y conserva el analisis', async () => {
  const repository = repo([makeJob('1'), makeJob('2')]); let calls = 0;
  const summary = await repairDescriptions({ repository, options: { limit: 10 }, fetchDetail: async () => {
    calls++; const e = new Error('checkpoint'); e.name = 'SecurityChallengeError'; throw e;
  } });
  assert.equal(calls, 1); assert.equal(summary.stoppedByChallenge, true);
  assert.equal(repository.get('1').aiAnalysis.overallMatchScore, 90);
  assert.equal(repository.get('2').descriptionRepair, undefined);
});
test('URLs invalidas o de otro job no navegan', async () => {
  for (const url of ['https://evil.example/jobs/view/1/', 'https://www.linkedin.com/jobs/view/2/', 'https://www.linkedin.com/feed/']) {
    const job = { ...makeJob('1'), url }; assert.equal(validDirectJobUrl(job), false);
    const summary = await repairDescriptions({ repository: repo([job]), options: { limit: 1 }, fetchDetail: () => assert.fail('invalid URL') });
    assert.equal(summary.attempted, 0); assert.equal(summary.jobs[0].diagnostics.status, 'invalid_job_url');
  }
});

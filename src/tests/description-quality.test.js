'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isDescriptionUsable, DESCRIPTION_INSUFFICIENT } = require('../domain/descriptionQuality');
const { shouldAnalyzeJob } = require('../domain/jobRecord');
const { createJobService } = require('../services/jobService');
const { runPipeline } = require('../pipeline/pipeline');
const { analyzeJob, buildSystemPrompt } = require('../ai/jobAnalyzer');

// Repositorio aislado con copias como los JSON reales: ninguna escritura a disco/red.
function service() {
  const records = new Map();
  return createJobService({
    has: id => records.has(id),
    get: id => structuredClone(records.get(id) || null),
    save: job => { records.set(job.jobId, structuredClone(job)); return job; },
    getAll: () => structuredClone([...records.values()]),
  });
}
const good = 'a'.repeat(300);
const result = { analysis: { decision: 'YES', overallMatchScore: 80 } };
const discover = async () => ({ jobs: [{ jobId: 'test' }] });
const invalid = [undefined, null, '', ' \n\t ', 'a'.repeat(299), `  ${'a'.repeat(299)}  `, 300, {}];

for (const [i, value] of invalid.entries()) {
  test(`evidencia insuficiente ${i}: rechaza y difiere sin analyzer`, async () => {
    assert.equal(isDescriptionUsable(value), false);
    const svc = service();
    const summary = await runPipeline({ jobService: svc, discover, analyzeLimit: 1,
      fetchDetails: async () => ({ description: value }),
      analyze: async () => assert.fail('No debe llamarse al analyzer'),
    });
    const job = svc.getJob('test');
    assert.equal(job.analysisStatus, 'pending');
    assert.equal(job.analysisError, DESCRIPTION_INSUFFICIENT);
    assert.equal(job.aiAnalysis, null);
    assert.equal(job.analysisAttemptedAt, null);
    assert.equal(job.analysisCompletedAt, null);
    assert.equal(shouldAnalyzeJob(job), true);
    assert.equal(summary.analysis.analyzed, 0);
    assert.equal(summary.analysis.failed, 0);
    assert.equal(summary.analysis.skipped, 1);
    assert.equal(summary.analysis.skippedDueToMissingDescription, 1);
    assert.equal(summary.analysis.detailFetchAttempts, 1);
    assert.equal(summary.analysis.detailsFetched, 1);
    assert.equal(summary.analysis.detailsWithUsableDescription, 0);
    assert.equal(summary.analysis.detailsWithoutUsableDescription, 1);
    assert.equal(summary.usageTotals.totalTokens, 0);
    await assert.rejects(analyzeJob({}, { description: value }, {
      transport: async () => assert.fail('No debe llamarse al transporte OpenAI'),
    }), { code: DESCRIPTION_INSUFFICIENT });
  });
}

for (const value of [good, ` \n${good}\t `, 'a'.repeat(301)]) {
  test(`evidencia utilizable con ${value.length} caracteres brutos`, async () => {
    assert.equal(isDescriptionUsable(value), true);
    const svc = service();
    let calls = 0;
    const summary = await runPipeline({ jobService: svc, discover,
      fetchDetails: async () => ({ description: value }),
      analyze: async job => { calls++; assert.equal(job.description, value); return result; },
    });
    assert.equal(calls, 1);
    assert.equal(svc.getJob('test').analysisStatus, 'completed');
    assert.equal(summary.analysis.detailsWithUsableDescription, 1);
    assert.equal(summary.analysis.detailsWithoutUsableDescription, 0);
    assert.equal(summary.analysis.skippedDueToMissingDescription, 0);
  });
}

for (const initial of [null, 'short description', ' \n ']) {
  test(`reintento posterior recupera evidencia: ${JSON.stringify(initial)}`, async () => {
    const svc = service();
    svc.createJob({ jobId: 'test', description: initial });
    svc.markAsInterested('test');
    const before = svc.getJob('test');
    await runPipeline({ jobService: svc, discover,
      fetchDetails: async () => ({ description: initial, descriptionLength: (initial || '').length }),
      analyze: async () => assert.fail('Evidencia insuficiente'),
    });
    assert.equal(shouldAnalyzeJob(svc.getJob('test')), true);
    let fetches = 0;
    const summary = await runPipeline({ jobService: svc, discover,
      fetchDetails: async () => { fetches++; return { description: good }; },
      analyze: async job => { assert.equal(job.description, good); return result; },
    });
    const after = svc.getJob('test');
    assert.equal(fetches, 1);
    assert.equal(after.descriptionLength, 300);
    assert.equal(after.analysisStatus, 'completed');
    assert.equal(after.analysisError, null);
    assert.equal(shouldAnalyzeJob(after), false);
    assert.equal(after.userState.status, 'interested');
    assert.equal(after.userState.firstSeenAt, before.userState.firstSeenAt);
    assert.deepEqual(after.feedbackEvents, before.feedbackEvents);
    assert.equal(summary.analysis.analyzed, 1);
  });
}

test('evidencia utilizable persistida no requiere fetch', async () => {
  const svc = service(); svc.createJob({ jobId: 'test', description: good });
  const summary = await runPipeline({ jobService: svc, discover,
    fetchDetails: async () => assert.fail('No refetch'), analyze: async () => result });
  assert.equal(summary.analysis.analyzed, 1);
  assert.equal(summary.analysis.detailFetchAttempts, 0);
  assert.equal(summary.analysis.detailsWithUsableDescription, 0);
  assert.equal(summary.analysis.detailsWithoutUsableDescription, 0);
});

test('historico ya analizado sin descripcion no se reanaliza', async () => {
  const svc = service(); svc.createJob({ jobId: 'test', description: null, aiAnalysis: result.analysis });
  const before = svc.getJob('test');
  const summary = await runPipeline({ jobService: svc, discover,
    fetchDetails: async () => assert.fail('No refetch historico'),
    analyze: async () => assert.fail('No reanalisis historico') });
  assert.deepEqual(svc.getJob('test').aiAnalysis, before.aiAnalysis);
  assert.equal(svc.getJob('test').description, null);
  assert.equal(summary.analysis.alreadyAnalyzed, 1);
  assert.equal(summary.analysis.detailFetchAttempts, 0);
});

test('metricas separan intento fallido, retorno insuficiente y retorno utilizable', async () => {
  const summary = await runPipeline({ jobService: service(),
    discover: async () => ({ jobs: ['error', 'short', 'good'].map(jobId => ({ jobId })) }),
    fetchDetails: async job => {
      if (job.jobId === 'error') throw new Error('network');
      return { description: job.jobId === 'good' ? good : null };
    }, analyze: async () => result });
  assert.equal(summary.analysis.detailFetchAttempts, 3);
  assert.equal(summary.analysis.detailsFetched, 2);
  assert.equal(summary.analysis.detailsWithUsableDescription, 1);
  assert.equal(summary.analysis.detailsWithoutUsableDescription, 1);
  assert.equal(summary.analysis.skippedDueToMissingDescription, 1);
  assert.equal(summary.analysis.analyzed, 1);
  assert.equal(summary.analysis.failed, 1);
});

test('challenge cuenta intento, no retorno ni fallo de modelo', async () => {
  const summary = await runPipeline({ jobService: service(), discover,
    fetchDetails: async () => { const e = new Error('challenge'); e.name = 'SecurityChallengeError'; throw e; },
    analyze: async () => assert.fail('challenge') });
  assert.equal(summary.stoppedByChallenge, true);
  assert.equal(summary.analysis.detailFetchAttempts, 1);
  assert.equal(summary.analysis.detailsFetched, 0);
  assert.equal(summary.analysis.detailsWithoutUsableDescription, 0);
  assert.equal(summary.analysis.failed, 0);
});

test('sin analyzer: evidencia insuficiente queda pending con razon', async () => {
  const svc = service();
  const summary = await runPipeline({ jobService: svc, discover,
    fetchDetails: async () => null, analyze: null });
  assert.equal(svc.getJob('test').analysisError, DESCRIPTION_INSUFFICIENT);
  assert.equal(summary.analysis.skippedDueToMissingDescription, 1);
  assert.equal(summary.analysis.failed, 0);
});

test('prompt delimita matchedQueries y matchedFamilies como procedencia', () => {
  const prompt = buildSystemPrompt({});
  assert.match(prompt, /matchedQueries and matchedFamilies indicate how the job was discovered/);
  assert.match(prompt, /NOT evidence of job requirements, responsibilities, or fit/);
  assert.match(prompt, /only as contextual metadata; NEVER infer missing job content from them/);
});

test('P1 conserva diagnosticos de detalle sin debug en job y resumen', async () => {
  const svc = service();
  const diagnostics = { status: 'description_too_short', jobId: 'test', descriptionLength: 5 };
  const summary = await runPipeline({ jobService: svc, discover,
    fetchDetails: async () => ({ description: 'short', detailExtraction: diagnostics }),
    analyze: () => assert.fail('P0 sigue activo') });
  assert.deepEqual(svc.getJob('test').detailExtraction, diagnostics);
  assert.deepEqual(summary.detailDiagnostics, [diagnostics]);
  assert.equal(summary.analysis.detailExtractionCounts.description_too_short, 1);
});

test('P1 autenticacion detiene pipeline y conserva diagnostico', async () => {
  const svc = service();
  const diagnostics = { status: 'auth_or_challenge', jobId: 'test' };
  const summary = await runPipeline({ jobService: svc, discover,
    fetchDetails: async () => { const e = new Error('login'); e.name = 'AuthenticationError'; e.detailDiagnostics = diagnostics; throw e; },
    analyze: () => assert.fail('auth') });
  assert.equal(summary.stoppedByChallenge, true);
  assert.equal(summary.analysis.analyzed, 0);
  assert.deepEqual(svc.getJob('test').detailExtraction, diagnostics);
  assert.equal(summary.analysis.detailExtractionCounts.auth_or_challenge, 1);
});

'use strict';

// Tests PUROS de la integracion de InfoJobs (sin navegador, sin red):
// URLs, plataformas, config por plataforma, challenge, modelo, summary combinado,
// notificaciones y filtro de la UI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const urls = require('../infojobs/urls');
const { evaluateInfoJobsChallenge } = require('../infojobs/challenge');
const { sourceOf, sourceLabel, parseSources } = require('../domain/sources');
const { getActiveSearchQueries, SEARCH_QUERIES } = require('../config');
const { createJobRecord, mergeDiscovery } = require('../domain/jobRecord');
const { combineSummaries } = require('../pipeline/combineSummaries');
const { buildRunOutcomeNotification, classifyRunOutcome } = require('../notifications/runOutcome');
const { jobClickUrl, buildHighMatchNotification } = require('../notifications/ntfy');
const L = require('../ui/jobListLogic');
const { createLocalRepository } = require('../data/jobRepository');
const { createJobService } = require('../services/jobService');
const { runPipeline } = require('../pipeline/pipeline');

const OFFER = 'https://www.infojobs.net/barcelona/director-operaciones/of-i3f9a1c2b4d5e6f7a8b9c0d1e2f3a4b5c';

test('urls: id, canonica y jobId con prefijo', () => {
  assert.equal(urls.parseOfferId(OFFER + '?applicationOrigin=search-new&page=1'), 'i3f9a1c2b4d5e6f7a8b9c0d1e2f3a4b5c');
  assert.equal(urls.canonicalOfferUrl('http://infojobs.net/barcelona/director-operaciones/of-i3f9a1c2b4d5e6f7a8b9c0d1e2f3a4b5c?x=1#y'), OFFER);
  assert.equal(urls.toJobId('I3F9A1C2B4'), 'ij_i3f9a1c2b4');
  assert.equal(urls.parseOfferId('https://www.linkedin.com/jobs/view/123/'), null);
  assert.equal(urls.parseOfferId('https://evil.example/of-i3f9a1c2b4d5e6f7'), null);
  assert.equal(urls.parseOfferId('/barcelona/x/of-iabcdef123456'), 'iabcdef123456');
});

test('urls: busqueda con los mismos filtros que LinkedIn y verificacion en la URL real', () => {
  const filters = { provinceId: '9', datePosted: 'Past week', employmentType: 'Full-time' };
  const u = new URL(urls.buildSearchUrl('Director de Operaciones', filters, 1));
  assert.equal(u.hostname, 'www.infojobs.net');
  assert.equal(u.searchParams.get('keyword'), 'Director de Operaciones');
  assert.equal(u.searchParams.get('provinceIds'), '9');
  assert.equal(u.searchParams.get('sinceDate'), '_7_DAYS');
  assert.equal(u.searchParams.get('page'), null);
  assert.equal(new URL(urls.buildSearchUrl('x', filters, 3)).searchParams.get('page'), '3');
  assert.deepEqual(
    { ...urls.verifyFiltersInUrl(u.toString(), filters), url: null },
    { url: null, locationActive: true, datePostedActive: true },
  );
  const lost = urls.verifyFiltersInUrl('https://www.infojobs.net/jobsearch/search-results/list.xhtml?keyword=x', filters);
  assert.equal(lost.locationActive, false);
  assert.equal(lost.datePostedActive, false);
});

test('sources: ausente = linkedin; prefijo ij_ = infojobs; parseo de SOURCES', () => {
  assert.equal(sourceOf({ jobId: '4461234567' }), 'linkedin');
  assert.equal(sourceOf({ jobId: 'ij_iabc' }), 'infojobs');
  assert.equal(sourceOf({ jobId: '1', source: 'infojobs' }), 'infojobs');
  assert.equal(sourceLabel('infojobs'), 'InfoJobs');
  assert.deepEqual(parseSources(undefined), ['linkedin', 'infojobs']);
  assert.deepEqual(parseSources(' InfoJobs , linkedin,infojobs,foo'), ['infojobs', 'linkedin']);
  assert.deepEqual(parseSources('foo'), ['linkedin', 'infojobs']);
});

test('config: LinkedIn conserva sus 14 queries; InfoJobs suma las de castellano', () => {
  const legacy = getActiveSearchQueries();
  const li = getActiveSearchQueries(SEARCH_QUERIES, 'linkedin');
  const ij = getActiveSearchQueries(SEARCH_QUERIES, 'infojobs');
  assert.deepEqual(li.map((q) => q.query), legacy.map((q) => q.query));
  assert.equal(li.length, 14);
  assert.ok(!li.some((q) => /Director de Operaciones/.test(q.query)));
  assert.ok(ij.some((q) => q.query === 'Director de Operaciones' && q.family === 'operations'));
  assert.ok(ij.some((q) => q.query === 'Head of Operations'));
  assert.ok(ij.length > li.length);
});

test('challenge: CAPTCHA concluyente si; vocabulario de una oferta no', () => {
  assert.equal(evaluateInfoJobsChallenge({ url: 'https://geo.captcha-delivery.com/captcha/?x=1' }).signal, 'url:captcha');
  assert.equal(evaluateInfoJobsChallenge({ url: OFFER, domSignals: ['dom:datadome'] }).signal, 'dom:datadome');
  assert.equal(evaluateInfoJobsChallenge({ url: OFFER, text: 'Tu acceso ha sido bloqueado' }).signal, 'text:access_blocked');
  assert.equal(evaluateInfoJobsChallenge({ url: OFFER, text: 'Mantén pulsado el botón para continuar' }).signal, 'text:press_and_hold');
  assert.equal(evaluateInfoJobsChallenge({ url: OFFER, text: '¿Eres humano o un robot?' }).signal, 'text:human_or_robot');
  assert.equal(evaluateInfoJobsChallenge({
    url: OFFER,
    text: 'Gestionarás checkpoints de proyecto, controles de seguridad y la verificación de entregables. Captcha no.',
  }), null);
  assert.equal(evaluateInfoJobsChallenge({ url: urls.buildSearchUrl('Challenge Manager', { provinceId: '9' }) }), null);
});

test('modelo: source persistido, campos extra y merge que rellena sin pisar', () => {
  const li = createJobRecord({ jobId: '123' });
  assert.equal(li.source, 'linkedin');
  const ij = createJobRecord({ jobId: 'ij_iabc', source: 'infojobs', title: 'Director' });
  assert.equal(ij.source, 'infojobs');
  assert.equal(ij.salary, null);
  mergeDiscovery(ij, { salary: '40.000 - 50.000 EUR / año', experienceMin: 'Al menos 5 años', title: 'Otro' });
  assert.equal(ij.salary, '40.000 - 50.000 EUR / año');
  assert.equal(ij.experienceMin, 'Al menos 5 años');
  assert.equal(ij.title, 'Director');
});

function pipelineSummary(over = {}) {
  return {
    runId: 'run_a', startedAt: '2026-10-05T08:00:00.000Z', stoppedByChallenge: false, challenge: null,
    discovery: { queriesExecuted: 14, rawResults: 180, uniqueResults: 100, duplicatesRemoved: 80, newJobs: 30, existingJobs: 70 },
    analysis: { requiringAnalysis: 30, alreadyAnalyzed: 70, processed: 25, analyzed: 24, failed: 1, skipped: 5, analysisEnabled: true, detailExtractionCounts: { description_extracted: 25 } },
    persistence: { created: 30, updated: 10, unchanged: 60 },
    notifications: { eligible: 1, sent: 1, alreadyNotified: 0, failed: 0 },
    usageTotals: { promptTokens: 1000, completionTokens: 200, cachedTokens: 0, totalTokens: 1200, model: 'm' },
    durations: { discoveryMs: 1000, detailsMs: 1000, analysisMs: 1000, totalMs: 3000 },
    retention: { eligible: 0, deleted: 0 },
    detailDiagnostics: [],
    jobs: [{ jobId: '1' }],
    ...over,
  };
}

test('combineSummaries: suma, conserva la forma y desglosa por plataforma', () => {
  const ij = pipelineSummary({
    discovery: { queriesExecuted: 22, rawResults: 50, uniqueResults: 40, duplicatesRemoved: 10, newJobs: 12, existingJobs: 28 },
    analysis: { analyzed: 10, failed: 0, skipped: 2, analysisEnabled: true, detailExtractionCounts: { description_extracted: 10, offer_expired: 1 } },
    notifications: { eligible: 2, sent: 2, alreadyNotified: 0, failed: 0 },
    retention: null,
    jobs: [{ jobId: 'ij_x' }],
  });
  const c = combineSummaries([{ source: 'linkedin', summary: pipelineSummary() }, { source: 'infojobs', summary: ij }], { totalMs: 9000 });
  assert.equal(c.discovery.uniqueResults, 140);
  assert.equal(c.discovery.newJobs, 42);
  assert.equal(c.analysis.analyzed, 34);
  assert.equal(c.notifications.eligible, 3);
  assert.equal(c.durations.totalMs, 9000);
  assert.deepEqual(c.analysis.detailExtractionCounts, { description_extracted: 35, offer_expired: 1 });
  assert.equal(c.jobs.length, 2);
  assert.equal(c.stoppedByChallenge, false);
  assert.equal(c.sources.infojobs.label, 'InfoJobs');
  assert.equal(c.sources.infojobs.status, 'completed');
  assert.ok(c.retention);
});

test('combineSummaries: una plataforma cortada no tapa a la otra', () => {
  const err = new Error('InfoJobs presento un CAPTCHA');
  const c = combineSummaries([
    { source: 'linkedin', summary: pipelineSummary() },
    { source: 'infojobs', error: err, challenge: true, challengeDiagnostic: { platform: 'infojobs', signal: 'dom:datadome' } },
  ]);
  assert.equal(c.stoppedByChallenge, true);
  assert.equal(c.challenge.platform, 'infojobs');
  assert.equal(c.sources.infojobs.status, 'interrupted');
  assert.equal(c.sources.linkedin.status, 'completed');
  assert.equal(c.discovery.uniqueResults, 100);
  assert.equal(classifyRunOutcome({ summary: c }), 'interrupted');
  const msg = buildRunOutcomeNotification({ outcome: 'interrupted', summary: c });
  assert.match(msg.body, /^InfoJobs pidió una verificación de seguridad y el hunt se detuvo en esa plataforma\./);
  assert.ok(msg.body.includes('LinkedIn: 100 encontradas · 30 nuevas · 24 analizadas'));
  assert.ok(msg.body.includes('InfoJobs: ❌ interrumpido'));
  assert.equal(msg.click, undefined);
});

test('notificacion de cierre: desglose por plataforma cuando ambas terminan', () => {
  const c = combineSummaries([
    { source: 'linkedin', summary: pipelineSummary() },
    { source: 'infojobs', summary: pipelineSummary({ discovery: { uniqueResults: 40, newJobs: 12 }, analysis: { analyzed: 10 } }) },
  ], { totalMs: 42 * 60000 });
  const msg = buildRunOutcomeNotification({ outcome: 'completed', summary: c });
  assert.equal(msg.title, '✅ Job Hunter terminado');
  assert.deepEqual(msg.body.split('\n'), [
    'LinkedIn: 100 encontradas · 30 nuevas · 24 analizadas',
    'InfoJobs: 40 encontradas · 12 nuevas · 10 analizadas',
    '🔥 2 matches ≥90',
    '⚠️ 1 con error de análisis',
    'Duración: 42 min',
  ]);
});

test('ntfy: oferta de InfoJobs lleva plataforma en el texto y link a InfoJobs', () => {
  const job = { jobId: 'ij_i3f9a1c2b4d5e6f7a8b9c0d1e2f3a4b5c', source: 'infojobs', title: 'Director de Operaciones', company: 'ACME', url: OFFER, aiAnalysis: { overallMatchScore: 92 } };
  const msg = buildHighMatchNotification(job);
  assert.equal(msg.title, '🔥 Match 92 — [InfoJobs] Director de Operaciones');
  assert.equal(msg.body, 'ACME\nRating: 92/100\nPlataforma: InfoJobs');
  assert.equal(msg.click, OFFER);
  assert.equal(jobClickUrl({ ...job, url: OFFER + '?utm=1' }), OFFER);
  assert.equal(jobClickUrl({ ...job, url: 'https://evil.example/of-i3f9a1c2b4d5e6f7' }), null);
  assert.equal(jobClickUrl({ ...job, url: null }), null);
});

test('UI: filtro y contadores por plataforma', () => {
  const jobs = [
    { jobId: '1', userState: { status: 'new' } },
    { jobId: 'ij_a', source: 'infojobs', userState: { status: 'new' } },
    { jobId: 'ij_b', source: 'infojobs', userState: { status: 'read' }, availability: 'closed' },
  ];
  assert.deepEqual(L.filterJobs(jobs, { status: 'all', source: 'infojobs' }).map((j) => j.jobId), ['ij_a']);
  assert.deepEqual(L.filterJobs(jobs, { status: 'all', source: 'linkedin' }).map((j) => j.jobId), ['1']);
  assert.equal(L.filterJobs(jobs, { status: 'all', source: 'all' }).length, 2);
  assert.deepEqual(L.countBySource(jobs), { all: 2, linkedin: 1, infojobs: 1 });
  assert.equal(L.listItemView(jobs[1]).source, 'infojobs');
  assert.deepEqual(L.activeFilterKeys({ source: 'infojobs' }), ['source']);
  assert.equal(L.clearedFilters({ source: 'infojobs', status: 'inbox' }).source, 'all');
});

test('pipeline: ofertas de InfoJobs se persisten con source y conviven con LinkedIn', async () => {
  const svc = createJobService(createLocalRepository({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'jh-ij-')) }));
  const description = 'Responsable de operaciones con gestion de equipos y procesos. '.repeat(10);
  const s = await runPipeline({
    jobService: svc,
    analyzeLimit: 5,
    discover: async () => ({
      jobs: [
        { jobId: 'ij_iabcdef123456', source: 'infojobs', title: 'Director de Operaciones', company: 'ACME', url: OFFER, matchedQueries: ['Director de Operaciones'], matchedFamilies: ['operations'] },
      ],
      discovery: { queriesExecuted: 1, rawResults: 1, duplicatesRemoved: 0 },
    }),
    fetchDetails: async (job) => ({ jobId: job.jobId, description, salary: '45.000 EUR / año', detailExtraction: { status: 'description_extracted' } }),
    analyze: async () => ({ analysis: { decision: 'YES', overallMatchScore: 91 }, model: 'm', usage: {} }),
  });
  assert.equal(s.analysis.analyzed, 1);
  const saved = svc.getJob('ij_iabcdef123456');
  assert.equal(saved.source, 'infojobs');
  assert.equal(saved.salary, '45.000 EUR / año');
  assert.equal(saved.analysisStatus, 'completed');
});

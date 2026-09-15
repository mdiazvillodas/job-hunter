'use strict';

// Disponibilidad de la oferta ("ya no acepta postulaciones") como eje INDEPENDIENTE
// de la decision del usuario. Verifica que no contamina userState/feedback/learning/
// calibration/scoring y que sobrevive a hunts posteriores.

const test = require('node:test');
const assert = require('node:assert');

const {
  createJobRecord, applyApplicationsClosed, applyDiscarded, mergeDiscovery,
  availabilityOf, isApplicationsClosed, AVAILABILITY, AVAILABILITY_REASON,
} = require('../domain/jobRecord');
const { computeCalibrationSignal } = require('../domain/calibration');
const { computeLearnedPreferences, collectDiscardEvents } = require('../ai/learnedPreferences');
const { REASON_KEYS } = require('../domain/feedbackConfig');
const L = require('../ui/jobListLogic');

const ANALYSIS = Object.freeze({
  decision: 'YES', overallMatchScore: 88, professionalFitScore: 90,
  interestFitScore: 85, cvFitScore: 80, confidence: 90,
});

function makeJob(jobId, extra) {
  return createJobRecord(Object.assign({
    jobId: jobId || '111',
    title: 'Head of Operations',
    company: 'ACME',
    location: 'Barcelona',
    url: 'https://www.linkedin.com/jobs/view/' + (jobId || '111') + '/',
    aiAnalysis: ANALYSIS,
  }, extra || {}));
}

test('1) applications_closed no crea ni altera userDecision', () => {
  const job = makeJob();
  const before = JSON.parse(JSON.stringify(job.userState));
  applyApplicationsClosed(job);

  assert.strictEqual(job.availability, AVAILABILITY.CLOSED);
  assert.strictEqual(job.availabilityReason, AVAILABILITY_REASON.APPLICATIONS_CLOSED);
  assert.ok(job.availabilityUpdatedAt, 'availabilityUpdatedAt debe quedar seteado');

  // userState intacto: sigue 'new', sin discardedAt.
  assert.deepStrictEqual(job.userState, before);
  assert.strictEqual(job.userState.status, 'new');
  assert.strictEqual(job.userState.discardedAt, null);
});

test('2) applications_closed no crea feedback negativo', () => {
  const job = makeJob();
  applyApplicationsClosed(job);

  assert.deepStrictEqual(job.feedback, { reasons: [], comment: null, createdAt: null });
  assert.strictEqual(job.feedbackEvents.length, 0, 'no debe emitir eventos de feedback');
  // El motivo de cierre NO reutiliza el vocabulario de descarte.
  assert.ok(!REASON_KEYS.includes(job.availabilityReason));
});

test('3) applications_closed no entra en discard stats (learning ni calibration)', () => {
  const closed = makeJob('111');
  applyApplicationsClosed(closed);
  const discarded = makeJob('222');
  applyDiscarded(discarded, { reasons: ['too_commercial'] });

  // Learning: solo cuenta el descarte real.
  assert.strictEqual(collectDiscardEvents([closed]).length, 0);
  const prefs = computeLearnedPreferences([closed, discarded]);
  const flat = JSON.stringify(prefs);
  assert.ok(flat.indexOf('too_commercial') !== -1);
  assert.strictEqual(flat.indexOf('applications_closed'), -1, 'el cierre no debe llegar a learning');

  const onlyClosed = computeLearnedPreferences([closed]);
  assert.strictEqual(JSON.stringify(onlyClosed).indexOf('applications_closed'), -1);

  // Calibration: un cierre no se lee como desacuerdo con el AI.
  const sig = computeCalibrationSignal(closed);
  assert.strictEqual(sig.userStatus, 'new');
  assert.strictEqual(sig.calibrationSignal, 'unknown');
  assert.deepStrictEqual(sig.reasons, []);
  // El descarte real si produce senal.
  assert.notStrictEqual(computeCalibrationSignal(discarded).calibrationSignal, 'unknown');
});

test('4) el job desaparece de activos y no se mezcla con descartadas', () => {
  const open = makeJob('111');
  const closed = makeJob('222');
  applyApplicationsClosed(closed);
  const discarded = makeJob('333');
  applyDiscarded(discarded, { reasons: ['company'] });
  const jobs = [open, closed, discarded];

  const ids = (f) => L.filterJobs(jobs, f).map((j) => j.jobId);
  assert.deepStrictEqual(ids({ status: 'inbox' }), ['111']);
  assert.deepStrictEqual(ids({ status: 'all' }), ['111', '333']);
  assert.deepStrictEqual(ids({ status: 'new' }), ['111']);
  assert.deepStrictEqual(ids({ status: 'discarded' }), ['333'], 'no debe aparecer entre descartadas');
  assert.deepStrictEqual(ids({ status: 'closed' }), ['222'], 'tiene su propia vista');

  const counts = L.countByStatus(jobs);
  assert.strictEqual(counts.closed, 1);
  assert.strictEqual(counts.inbox, 1);
  assert.strictEqual(counts.discarded, 1);
  assert.strictEqual(counts.all, 2, 'las cerradas no inflan los contadores de activos');
});

test('5) conserva aiAnalysis, score y analysisStatus', () => {
  const job = makeJob();
  const analysisBefore = JSON.parse(JSON.stringify(job.aiAnalysis));
  const statusBefore = job.analysisStatus;
  applyApplicationsClosed(job);

  assert.deepStrictEqual(job.aiAnalysis, analysisBefore);
  assert.strictEqual(job.aiAnalysis.overallMatchScore, 88);
  assert.strictEqual(job.aiAnalysis.decision, 'YES');
  assert.strictEqual(job.analysisStatus, statusBefore);
  assert.strictEqual(job.analysisStatus, 'completed');
});

test('6) un mismo jobId cerrado sigue cerrado tras un ingest posterior', () => {
  const job = makeJob('111');
  applyApplicationsClosed(job);
  const closedAt = job.availabilityUpdatedAt;

  // El hunt vuelve a encontrar exactamente la misma oferta.
  mergeDiscovery(job, {
    jobId: '111', title: 'Head of Operations', company: 'ACME', location: 'Barcelona',
    url: 'https://www.linkedin.com/jobs/view/111/',
    matchedQueries: ['Head of Operations'], matchedFamilies: ['operations'],
  });

  assert.strictEqual(job.availability, AVAILABILITY.CLOSED, 'no se reactiva sola');
  assert.strictEqual(job.availabilityReason, 'applications_closed');
  assert.strictEqual(job.availabilityUpdatedAt, closedAt, 'no se re-timestampea');
  assert.ok(isApplicationsClosed(job));
  // Sigue fuera de activos.
  assert.deepStrictEqual(L.filterJobs([job], { status: 'inbox' }), []);
  // El discovery si actualiza su provenance.
  assert.deepStrictEqual(job.matchedQueries, ['Head of Operations']);
});

test('7) un jobId nuevo equivalente no hereda el cierre', () => {
  const oldJob = makeJob('111');
  applyApplicationsClosed(oldJob);

  // Republicacion: misma company + title, jobId distinto.
  const republished = makeJob('999');

  assert.strictEqual(republished.availability, AVAILABILITY.OPEN);
  assert.strictEqual(republished.availabilityReason, null);
  assert.strictEqual(republished.availabilityUpdatedAt, null);
  assert.ok(!isApplicationsClosed(republished));
  assert.deepStrictEqual(
    L.filterJobs([oldJob, republished], { status: 'inbox' }).map((j) => j.jobId),
    ['999'],
    'la republicacion se trata como oferta independiente'
  );
});

test('compatibilidad: un registro previo sin el campo se lee como open', () => {
  const legacy = { jobId: '777', userState: { status: 'new' }, aiAnalysis: ANALYSIS };
  assert.strictEqual(availabilityOf(legacy), AVAILABILITY.OPEN);
  assert.ok(!isApplicationsClosed(legacy));
  assert.strictEqual(L.filterJobs([legacy], { status: 'inbox' }).length, 1);
  assert.strictEqual(L.countByStatus([legacy]).closed, 0);
});

test('idempotencia: cerrar dos veces no duplica efectos', () => {
  const job = makeJob();
  applyApplicationsClosed(job, { clock: () => '2026-09-14T10:00:00.000Z' });
  applyApplicationsClosed(job, { clock: () => '2026-09-14T11:00:00.000Z' });

  assert.strictEqual(job.availability, AVAILABILITY.CLOSED);
  assert.strictEqual(job.availabilityUpdatedAt, '2026-09-14T11:00:00.000Z');
  assert.strictEqual(job.feedbackEvents.length, 0);
  assert.strictEqual(job.userState.status, 'new');
});

test('cerrar una oferta ya descartada no altera su descarte', () => {
  const job = makeJob();
  applyDiscarded(job, { reasons: ['location'], comment: 'lejos' });
  const feedbackBefore = JSON.parse(JSON.stringify(job.feedback));
  const eventsBefore = job.feedbackEvents.length;

  applyApplicationsClosed(job);

  assert.strictEqual(job.userState.status, 'discarded');
  assert.deepStrictEqual(job.feedback, feedbackBefore);
  assert.strictEqual(job.feedbackEvents.length, eventsBefore);
  assert.strictEqual(job.availability, AVAILABILITY.CLOSED);
});

test('el servicio persiste el cierre sin tocar feedback ni userState', () => {
  const { createJobService } = require('../services/jobService');
  const store = new Map();
  const repository = {
    has: (id) => store.has(id),
    get: (id) => store.get(id) || null,
    getAll: () => Array.from(store.values()),
    save: (job) => { store.set(job.jobId, job); return job; },
  };
  const svc = createJobService(repository);
  store.set('111', makeJob('111'));

  const saved = svc.markApplicationsClosed('111');
  assert.strictEqual(saved.availability, 'closed');
  assert.strictEqual(saved.availabilityReason, 'applications_closed');
  assert.strictEqual(saved.userState.status, 'new');
  assert.strictEqual(saved.feedbackEvents.length, 0);
  assert.strictEqual(store.get('111').availability, 'closed');
});

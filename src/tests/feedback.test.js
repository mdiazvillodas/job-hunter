'use strict';

// Tests del sistema de estado + feedback + learning (Milestone 7).
// Harness minimo en Node (sin dependencias). Ejecutar: node src/tests/feedback.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLocalRepository } = require('../data/jobRepository');
const { createJobService } = require('../services/jobService');
const { computeLearnedPreferences } = require('../ai/learnedPreferences');
const { JOB_STATES } = require('../domain/feedbackConfig');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function section(t) {
  console.log(`\n### ${t}`);
}

function tmpRepoDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunter-test-'));
}

function sampleJob(overrides = {}) {
  return {
    jobId: '1001',
    title: 'Head of Operations',
    company: 'Acme',
    location: 'Barcelona, Spain (Hybrid)',
    url: 'https://www.linkedin.com/jobs/view/1001/',
    employmentType: 'Full-time',
    workplaceType: 'Hybrid',
    seniority: 'Director',
    easyApply: true,
    description: 'A real description used as data.',
    matchedQueries: ['Head of Operations'],
    matchedFamilies: ['operations'],
    aiAnalysis: { decision: 'YES', overallMatchScore: 84, professionalFitScore: 88, interestFitScore: 70, cvFitScore: 80 },
    ...overrides,
  };
}

function isIso(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function run() {
  // ---------- Job creation ----------
  section('Job creation');
  {
    const dir = tmpRepoDir();
    const svc = createJobService(createLocalRepository({ dir }));
    const job = svc.createJob(sampleJob());
    ok('crea job', !!job);
    ok('conserva jobId', job.jobId === '1001');
    ok('status inicial = new', job.userState.status === JOB_STATES.NEW);
    ok('firstSeenAt/lastSeenAt en ISO', isIso(job.userState.firstSeenAt) && isIso(job.userState.lastSeenAt));
    // no duplica
    svc.createJob(sampleJob());
    ok('no duplica jobId', svc.getAllJobs().length === 1);
  }

  // ---------- State ----------
  section('State transitions');
  {
    const dir = tmpRepoDir();
    const svc = createJobService(createLocalRepository({ dir }));
    svc.createJob(sampleJob({ jobId: '2001' }));

    let j = svc.markAsRead('2001');
    ok('read', j.userState.status === JOB_STATES.READ && isIso(j.userState.readAt));

    j = svc.markAsInterested('2001', { comment: 'looks relevant' });
    ok('interested', j.userState.status === JOB_STATES.INTERESTED && isIso(j.userState.interestedAt));

    j = svc.markAsPriority('2001');
    ok('priority', j.userState.status === JOB_STATES.PRIORITY && isIso(j.userState.priorityAt));

    j = svc.markAsApplied('2001');
    ok('applied', j.userState.status === JOB_STATES.APPLIED && isIso(j.userState.appliedAt));

    j = svc.markAsDiscarded('2001', { reasons: ['too_product'], comment: 'x' });
    ok('discarded', j.userState.status === JOB_STATES.DISCARDED && isIso(j.userState.discardedAt));

    // re-transicion permitida (discarded -> interested)
    j = svc.markAsInterested('2001');
    ok('re-transicion permitida', j.userState.status === JOB_STATES.INTERESTED);
  }

  // ---------- Feedback (single/multiple reasons, comment, timestamps, history) ----------
  section('Feedback');
  {
    const dir = tmpRepoDir();
    const svc = createJobService(createLocalRepository({ dir }));
    svc.createJob(sampleJob({ jobId: '3001' }));

    let j = svc.markAsDiscarded('3001', { reasons: ['too_product'], comment: 'No traditional PM' });
    ok('un solo reason', j.feedback.reasons.length === 1 && j.feedback.reasons[0] === 'too_product');
    ok('comentario guardado', j.feedback.comment === 'No traditional PM');
    ok('feedback.createdAt en ISO', isIso(j.feedback.createdAt));

    j = svc.markAsDiscarded('3001', { reasons: ['too_commercial', 'insufficient_ownership'], comment: 'sales-heavy' });
    ok('multiples reasons', j.feedback.reasons.length === 2);

    const discardEvents = j.feedbackEvents.filter((e) => e.type === JOB_STATES.DISCARDED);
    ok('historial NO se sobreescribe', discardEvents.length === 2);
    ok('cada evento tiene timestamp', discardEvents.every((e) => isIso(e.createdAt)));

    // reason invalido -> error
    let threw = false;
    try {
      svc.markAsDiscarded('3001', { reasons: ['not_a_real_reason'] });
    } catch (e) {
      threw = true;
    }
    ok('rechaza reason invalido', threw);
  }

  // ---------- AI/User disagreement ----------
  section('AI/User disagreement');
  {
    const dir = tmpRepoDir();
    const svc = createJobService(createLocalRepository({ dir }));

    // AI YES + user discarded (too_product = interest) -> ai_overestimated_interest
    svc.createJob(sampleJob({ jobId: '4001', aiAnalysis: { decision: 'YES' } }));
    svc.markAsDiscarded('4001', { reasons: ['too_product'], comment: 'no PM' });
    const c1 = svc.getCalibration('4001');
    ok('AI YES + discarded conserva ambos', c1.aiDecision === 'YES' && c1.userStatus === 'discarded');
    ok('signal = ai_overestimated_interest', c1.calibrationSignal === 'ai_overestimated_interest', c1.calibrationSignal);

    // AI NO + user interested -> ai_underestimated_interest
    svc.createJob(sampleJob({ jobId: '4002', aiAnalysis: { decision: 'NO' } }));
    svc.markAsInterested('4002');
    const c2 = svc.getCalibration('4002');
    ok('AI NO + interested', c2.calibrationSignal === 'ai_underestimated_interest', c2.calibrationSignal);

    // AI MAYBE + user applied -> ai_correct
    svc.createJob(sampleJob({ jobId: '4003', aiAnalysis: { decision: 'MAYBE' } }));
    svc.markAsApplied('4003');
    const c3 = svc.getCalibration('4003');
    ok('AI MAYBE + applied', c3.calibrationSignal === 'ai_correct', c3.calibrationSignal);

    // AI YES + discarded (insufficient_technical_fit = professional_fit) -> ai_overestimated_professional_fit
    svc.createJob(sampleJob({ jobId: '4004', aiAnalysis: { decision: 'YES' } }));
    svc.markAsDiscarded('4004', { reasons: ['insufficient_technical_fit'] });
    const c4 = svc.getCalibration('4004');
    ok('AI YES + prof-fit reason', c4.calibrationSignal === 'ai_overestimated_professional_fit', c4.calibrationSignal);
  }

  // ---------- Learning (1 -> signal, 2-3 -> emerging, 4+ -> established) ----------
  section('Learning thresholds');
  {
    function discardsFor(n) {
      const dir = tmpRepoDir();
      const svc = createJobService(createLocalRepository({ dir }));
      for (let i = 0; i < n; i += 1) {
        const id = `5${String(i).padStart(3, '0')}`;
        svc.createJob(sampleJob({ jobId: id }));
        svc.markAsDiscarded(id, { reasons: ['too_product'] });
      }
      const lp = computeLearnedPreferences(svc.getAllJobs());
      return lp.preferences.find((p) => p.key === 'too_product');
    }
    ok('1 evento -> signal', discardsFor(1).tier === 'signal');
    ok('2 eventos -> emerging', discardsFor(2).tier === 'emerging');
    ok('3 eventos -> emerging', discardsFor(3).tier === 'emerging');
    const est = discardsFor(4);
    ok('4 eventos -> established', est.tier === 'established');
    ok('established -> confidence high', est.confidence === 'high');
    ok('learned pref conserva dimension', est.dimension === 'interest');
    ok('learned pref direction avoid', est.direction === 'avoid');
  }

  // ---------- Independence (user state no modifica aiAnalysis) ----------
  section('Independence AI vs user');
  {
    const dir = tmpRepoDir();
    const svc = createJobService(createLocalRepository({ dir }));
    const created = svc.createJob(sampleJob({ jobId: '6001' }));
    const aiBefore = JSON.stringify(created.aiAnalysis);
    svc.markAsRead('6001');
    svc.markAsInterested('6001');
    svc.markAsDiscarded('6001', { reasons: ['too_commercial'], comment: 'c' });
    const after = svc.getJob('6001');
    ok('aiAnalysis intacto tras cambios de estado', JSON.stringify(after.aiAnalysis) === aiBefore);
  }

  // ---------- Persistence (reopen) ----------
  section('Persistence');
  {
    const dir = tmpRepoDir();
    const svc1 = createJobService(createLocalRepository({ dir }));
    svc1.createJob(sampleJob({ jobId: '7001' }));
    svc1.markAsInterested('7001', { comment: 'keep' });

    // Nuevo repository sobre el mismo dir = simula cerrar/reabrir.
    const svc2 = createJobService(createLocalRepository({ dir }));
    const j = svc2.getJob('7001');
    ok('recupera tras reabrir', !!j && j.userState.status === JOB_STATES.INTERESTED);
    ok('recupera historial', j.feedbackEvents.some((e) => e.type === JOB_STATES.INTERESTED));
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run();

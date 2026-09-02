'use strict';

// Tests de la UI: logica de lista pura (jobListLogic) + integracion con el jobService
// (las acciones que la UI dispara via /api). Sin navegador. Ejecutar: node src/tests/ui.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const L = require('../ui/jobListLogic');
const { createLocalRepository } = require('../data/jobRepository');
const { createJobService } = require('../services/jobService');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunter-ui-')); }

function mkJob(over) {
  return {
    jobId: 'x', title: 'T', company: 'C', location: 'Barcelona', url: 'u',
    employmentType: 'Full-time', workplaceType: 'Remote', seniority: 'Director', easyApply: true,
    description: 'desc', matchedQueries: ['Head of Operations'], matchedFamilies: ['operations'],
    userState: { status: 'new', firstSeenAt: '2026-01-01T00:00:00.000Z' },
    aiAnalysis: { decision: 'YES', overallMatchScore: 82 },
    feedbackEvents: [], feedback: { reasons: [], comment: null, createdAt: null },
    ...over,
  };
}

function run() {
  // Dataset de prueba para la logica de lista
  const jobs = [
    mkJob({ jobId: '1', title: 'Senior Operations Manager', company: 'Square One', easyApply: true,
      userState: { status: 'new', firstSeenAt: '2026-02-01T00:00:00.000Z' },
      aiAnalysis: { decision: 'MAYBE', overallMatchScore: 82 }, matchedFamilies: ['operations'], matchedQueries: ['Head of Operations'] }),
    mkJob({ jobId: '2', title: 'Head of Delivery', company: 'Acme', easyApply: false,
      userState: { status: 'interested', firstSeenAt: '2026-03-01T00:00:00.000Z' },
      aiAnalysis: { decision: 'YES', overallMatchScore: 91 }, matchedFamilies: ['delivery'], matchedQueries: ['Delivery Lead'] }),
    mkJob({ jobId: '3', title: 'Product Manager', company: 'Zeta', easyApply: true,
      userState: { status: 'discarded', firstSeenAt: '2026-01-15T00:00:00.000Z' },
      aiAnalysis: { decision: 'NO', overallMatchScore: 55 }, matchedFamilies: ['product'], matchedQueries: ['Product Operations'] }),
    mkJob({ jobId: '4', title: 'Ops Lead (no AI)', company: 'NoAI', easyApply: false,
      userState: { status: 'new', firstSeenAt: '2026-04-01T00:00:00.000Z' }, aiAnalysis: null,
      matchedFamilies: ['operations'], matchedQueries: ['Operations Lead'] }),
  ];

  section('List logic — filters');
  ok('status filter', L.filterJobs(jobs, { status: 'interested' }).length === 1);
  ok('aiDecision filter', L.filterJobs(jobs, { aiDecision: 'YES' }).length === 1);
  ok('easyApply yes', L.filterJobs(jobs, { easyApply: 'yes' }).length === 2);
  ok('easyApply no', L.filterJobs(jobs, { easyApply: 'no' }).length === 2);
  ok('family filter', L.filterJobs(jobs, { families: ['operations'] }).length === 2);
  ok('minScore 80+ excluye sin score', L.filterJobs(jobs, { minScore: 80 }).length === 2);
  ok('company filter', L.filterJobs(jobs, { company: 'square' }).length === 1);
  ok('matchedQuery filter', L.filterJobs(jobs, { matchedQuery: 'Delivery Lead' }).length === 1);

  section('Inbox — bandeja de pendientes (lógica pura)');
  const iso = '2026-05-01T00:00:00.000Z';
  const inboxJobs = [
    mkJob({ jobId: 'n', userState: { status: 'new', firstSeenAt: iso } }),
    mkJob({ jobId: 'r', userState: { status: 'read', firstSeenAt: iso } }),
    mkJob({ jobId: 'i', userState: { status: 'interested', firstSeenAt: iso } }),
    mkJob({ jobId: 'a', userState: { status: 'applied', firstSeenAt: iso } }),
    mkJob({ jobId: 'd', userState: { status: 'discarded', firstSeenAt: iso } }),
    mkJob({ jobId: 'p', userState: { status: 'priority', firstSeenAt: iso } }),
  ];
  const inbox = L.filterJobs(inboxJobs, { status: 'inbox' }).map((j) => j.jobId);
  ok('1. new aparece en el Inbox', inbox.includes('n'));
  ok('2. read aparece en el Inbox', inbox.includes('r'));
  ok('3. interested NO aparece en el Inbox', !inbox.includes('i'));
  ok('4. applied NO aparece en el Inbox', !inbox.includes('a'));
  ok('5. discarded NO aparece en el Inbox', !inbox.includes('d'));
  ok('priority sigue en el Inbox (no es decisión terminal)', inbox.includes('p'));
  ok('countByStatus.inbox = pendientes (new+read+priority)', L.countByStatus(inboxJobs).inbox === 3);
  ok('isPending discrimina decisión vs pendiente', L.isPending(inboxJobs[0]) === true && L.isPending(inboxJobs[2]) === false);

  section('List logic — search');
  ok('search title', L.searchJobs(jobs, 'delivery').length === 1);
  ok('search company', L.searchJobs(jobs, 'zeta').length === 1);
  ok('search location', L.searchJobs(jobs, 'barcelona').length === 4);

  section('List logic — sort');
  ok('overall desc', L.sortJobs(jobs, 'overall')[0].jobId === '2');
  ok('overall pone sin-score al final', L.sortJobs(jobs, 'overall').slice(-1)[0].jobId === '4');
  ok('newest', L.sortJobs(jobs, 'newest')[0].jobId === '4');
  ok('oldest', L.sortJobs(jobs, 'oldest')[0].jobId === '3');
  ok('title A-Z', L.sortJobs(jobs, 'title')[0].title.startsWith('Head'));

  section('List logic — counters / derive');
  const counts = L.countByStatus(jobs);
  ok('counts all', counts.all === 4);
  ok('counts new', counts.new === 2 && counts.interested === 1 && counts.discarded === 1);
  ok('deriveFamilies', JSON.stringify(L.deriveFamilies(jobs)) === JSON.stringify(['delivery', 'operations', 'product']));
  ok('deriveQueries incluye todas', L.deriveQueries(jobs).length === 4);

  section('List logic — listItemView tolera campos faltantes');
  const v = L.listItemView(mkJob({ jobId: '9', company: null, aiAnalysis: null }));
  ok('view sin company/AI no rompe', v.company === null && v.overall === null && v.aiDecision === null);

  // ---------- Integracion con el service (acciones de la UI) ----------
  section('Service integration (acciones de la UI)');
  const dir = tmpDir();
  const svc = createJobService(createLocalRepository({ dir }));
  svc.createJob(mkJob({ jobId: '100', aiAnalysis: { decision: 'YES', overallMatchScore: 84 } }));
  const aiBefore = JSON.stringify(svc.getJob('100').aiAnalysis);

  ok('mark read', svc.markAsRead('100').userState.status === 'read');
  ok('mark interested', svc.markAsInterested('100', { comment: 'x' }).userState.status === 'interested');
  const disc = svc.markAsDiscarded('100', { reasons: ['too_product', 'insufficient_ownership'], comment: 'PM otra vez' });
  ok('discard + multiples reasons + comentario', disc.userState.status === 'discarded' && disc.feedback.reasons.length === 2 && disc.feedback.comment === 'PM otra vez');
  ok('applied', svc.markAsApplied('100').userState.status === 'applied');
  ok('priority', svc.markAsPriority('100').userState.status === 'priority');
  ok('historial conservado', svc.getJob('100').feedbackEvents.length === 5);
  ok('aiAnalysis intacto', JSON.stringify(svc.getJob('100').aiAnalysis) === aiBefore);

  section('Service integration — persistencia y disagreement');
  const svc2 = createJobService(createLocalRepository({ dir }));
  ok('persistencia tras reabrir', svc2.getJob('100').userState.status === 'priority');

  svc2.createJob(mkJob({ jobId: '200', aiAnalysis: { decision: 'YES' } }));
  svc2.markAsDiscarded('200', { reasons: ['too_product'] });
  ok('AI YES + user discarded (disagreement)', svc2.getCalibration('200').calibrationSignal === 'ai_overestimated_interest');
  svc2.createJob(mkJob({ jobId: '201', aiAnalysis: { decision: 'NO' } }));
  svc2.markAsInterested('201');
  ok('AI NO + user interested (disagreement)', svc2.getCalibration('201').calibrationSignal === 'ai_underestimated_interest');

  section('Inbox — las decisiones sacan la oferta de la bandeja (integración + persistencia)');
  const idir = tmpDir();
  const isvc = createJobService(createLocalRepository({ dir: idir }));
  const inboxOf = (svcx) => L.filterJobs(svcx.getAllJobs(), { status: 'inbox' }).map((j) => j.jobId);

  isvc.createJob(mkJob({ jobId: 'INT_I', userState: { status: 'new', firstSeenAt: iso }, aiAnalysis: { decision: 'YES', overallMatchScore: 88, reasoning: 'r' } }));
  const aiSnap = JSON.stringify(isvc.getJob('INT_I').aiAnalysis);
  ok('oferta nueva está en la bandeja', inboxOf(isvc).includes('INT_I'));
  isvc.markAsInterested('INT_I');
  ok('6. "Me interesa" -> interested y sale de la bandeja', isvc.getJob('INT_I').userState.status === 'interested' && !inboxOf(isvc).includes('INT_I'));

  isvc.createJob(mkJob({ jobId: 'INT_A', userState: { status: 'new', firstSeenAt: iso }, aiAnalysis: { decision: 'YES' } }));
  isvc.markAsApplied('INT_A');
  ok('7. "Aplicar" -> applied y sale de la bandeja', isvc.getJob('INT_A').userState.status === 'applied' && !inboxOf(isvc).includes('INT_A'));

  isvc.createJob(mkJob({ jobId: 'INT_D', userState: { status: 'new', firstSeenAt: iso }, aiAnalysis: { decision: 'NO' } }));
  isvc.markAsDiscarded('INT_D', { reasons: ['too_product'] });
  ok('8. "Descartar" -> discarded y sale de la bandeja', isvc.getJob('INT_D').userState.status === 'discarded' && !inboxOf(isvc).includes('INT_D'));

  ok('9. el job y su aiAnalysis permanecen intactos', isvc.getJob('INT_I').aiAnalysis && JSON.stringify(isvc.getJob('INT_I').aiAnalysis) === aiSnap);

  const isvc2 = createJobService(createLocalRepository({ dir: idir }));
  ok('10. persiste tras reabrir: interested no reaparece en la bandeja', isvc2.getJob('INT_I').userState.status === 'interested' && !inboxOf(isvc2).includes('INT_I'));

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run();

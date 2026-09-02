'use strict';

// CLI de prueba manual del sistema de estado + feedback + learning (Milestone 7).
// No UI, no OpenAI, no LinkedIn. Ejecutar: npm run feedback:test
//
// Demuestra: crear job -> read -> interested -> discarded (+ reasons + comment)
//            -> feedback history -> learned preferences -> AI vs user calibration.

const path = require('path');
const { createLocalRepository } = require('./data/jobRepository');
const { createJobService } = require('./services/jobService');
const { computeLearnedPreferences } = require('./ai/learnedPreferences');

const DEMO_DIR = path.join(__dirname, 'data', 'jobs');
const DEMO_IDS = ['demo-main', 'demo-r1', 'demo-r2', 'demo-r3', 'demo-r4'];

function line(t) {
  console.log('\n' + t);
}

// Fixture: job con un aiAnalysis de ejemplo (NO es una respuesta real de OpenAI; es un fixture
// para demostrar la separacion AI vs user state).
function demoJob() {
  return {
    jobId: 'demo-main',
    title: 'Senior Product Manager',
    company: 'ExampleTech',
    location: 'Barcelona, Spain (Hybrid)',
    url: 'https://www.linkedin.com/jobs/view/demo-main/',
    employmentType: 'Full-time',
    workplaceType: 'Hybrid',
    seniority: 'Mid-Senior level',
    easyApply: true,
    description: 'Own the product roadmap and coordinate delivery. (fixture description used as data)',
    matchedQueries: ['Product Operations'],
    matchedFamilies: ['product'],
    aiAnalysis: {
      decision: 'YES',
      overallMatchScore: 82,
      professionalFitScore: 88,
      interestFitScore: 70,
      cvFitScore: 80,
      confidence: 66,
      roleFamily: 'product',
      summary: '[fixture] Strong capability fit for a product-leaning operations role.',
    },
  };
}

function main() {
  const repo = createLocalRepository({ dir: DEMO_DIR });
  const svc = createJobService(repo);

  // Reset idempotente de los jobs de demo.
  for (const id of DEMO_IDS) repo.delete(id);

  console.log('=== FEEDBACK CLI DEMO (Milestone 7) ===');
  console.log('Repository local:', DEMO_DIR, '(un archivo JSON por job)');

  // 1. crear job
  line('1) createJob');
  let job = svc.createJob(demoJob());
  console.log(`   job ${job.jobId} — ${job.title} @ ${job.company} | status=${job.userState.status}`);
  console.log(`   aiAnalysis.decision=${job.aiAnalysis.decision} (professionalFit=${job.aiAnalysis.professionalFitScore}, interestFit=${job.aiAnalysis.interestFitScore})`);

  // 2. read
  line('2) markAsRead');
  job = svc.markAsRead('demo-main');
  console.log(`   status=${job.userState.status} readAt=${job.userState.readAt}`);

  // 3. interested
  line('3) markAsInterested');
  job = svc.markAsInterested('demo-main', { comment: 'Interesting on paper' });
  console.log(`   status=${job.userState.status} interestedAt=${job.userState.interestedAt}`);

  // 4-6. discarded + reasons + comment
  line('4-6) markAsDiscarded (+ reasons + comment)');
  job = svc.markAsDiscarded('demo-main', {
    reasons: ['too_product', 'insufficient_ownership'],
    comment: 'No quiero volver a Product Management tradicional. Prefiero Operations con componente de producto.',
  });
  console.log(`   status=${job.userState.status} reasons=${JSON.stringify(job.feedback.reasons)}`);
  console.log(`   comment="${job.feedback.comment}"`);

  // 7. feedback history
  line('7) feedback history (feedbackEvents)');
  job.feedbackEvents.forEach((e, i) => {
    console.log(`   [${i + 1}] ${e.type}${e.reasons ? ' reasons=' + JSON.stringify(e.reasons) : ''}${e.comment ? ' comment="' + e.comment + '"' : ''} @ ${e.createdAt}`);
  });

  // 9 (calibration for this job)
  line('9) AI vs user calibration (este job)');
  console.log('   ' + JSON.stringify(svc.getCalibration('demo-main')));

  // 8. learned preferences: simular VARIOS rechazos de too_product para llegar a 'established'
  line('8) learned preferences (tras varios rechazos)');
  ['demo-r1', 'demo-r2', 'demo-r3', 'demo-r4'].forEach((id, i) => {
    svc.createJob({
      jobId: id,
      title: `Product Manager ${i + 1}`,
      company: `Co${i + 1}`,
      aiAnalysis: { decision: 'MAYBE' },
      matchedFamilies: ['product'],
    });
    svc.markAsDiscarded(id, { reasons: ['too_product'], comment: 'traditional PM again' });
  });
  const lp = computeLearnedPreferences(svc.getAllJobs());
  console.log(`   totalDiscardEvents=${lp.totalDiscardEvents}`);
  lp.preferences.forEach((p) => {
    console.log(`   - ${p.key} [${p.dimension}] direction=${p.direction} count=${p.count} tier=${p.tier} confidence=${p.confidence}`);
  });

  console.log('\n(los jobs de demo quedan en', DEMO_DIR, '— podés inspeccionarlos o borrarlos)');
  console.log('=== DEMO OK ===');
}

main();

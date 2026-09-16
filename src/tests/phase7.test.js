'use strict';

// Phase 7 — notificaciones push de high match (ntfy).
// NINGUN test hace un request real: el sender se inyecta siempre.
// Ejecutar: node src/tests/phase7.test.js

const N = require('../notifications/ntfy');
const { validateUserConfig, getNotificationSettings } = require('../config/userConfig');
const { createJobRecord, applyHighMatchNotified, applyDiscarded, mergeDiscovery } = require('../domain/jobRecord');
const { createJobService } = require('../services/jobService');
const { runPipeline } = require('../pipeline/pipeline');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }

const ON = { enabled: true, topic: 'jobhunter-test', baseUrl: 'https://ntfy.sh', threshold: 90 };

function analysis(score) {
  return {
    decision: score >= 90 ? 'YES' : 'MAYBE', overallMatchScore: score,
    professionalFitScore: score, interestFitScore: score, cvFitScore: score, confidence: 90,
  };
}
function makeJob(jobId, score, extra) {
  return createJobRecord(Object.assign({
    jobId, title: 'Director of Business Operations', company: 'Acme',
    location: 'Ciudad A', url: 'https://www.linkedin.com/jobs/view/' + jobId + '/',
    aiAnalysis: score == null ? null : analysis(score),
  }, extra || {}));
}
function harness(over) {
  const o = over || {};
  const sent = [];
  const marked = [];
  const logs = [];
  const notifier = N.createHighMatchNotifier({
    settings: 'settings' in o ? o.settings : ON,
    send: o.send || (async (url, message) => { sent.push({ url, message }); return { ok: true, status: 200 }; }),
    markNotified: (jobId) => marked.push(jobId),
    log: (m) => logs.push(m),
  });
  return { notifier, sent, marked, logs };
}
function memoryService() {
  const store = new Map();
  const repository = {
    has: (id) => store.has(id), get: (id) => store.get(id) || null,
    getAll: () => Array.from(store.values()), save: (j) => { store.set(j.jobId, j); return j; },
  };
  return { svc: createJobService(repository), store };
}
function discoveryOf(jobs) {
  return async () => ({ jobs: jobs.map((j) => ({ jobId: j.jobId, title: j.title, company: j.company, url: j.url, description: j.description })), discovery: {} });
}

async function run() {
  section('Umbral');
  ok('1. score 89 no notifica', (await harness().notifier.notifyHighMatch(makeJob('1', 89))).status === 'below_threshold');
  const h2 = harness();
  ok('2. score 90 notifica (el umbral es >=, no >)',
    (await h2.notifier.notifyHighMatch(makeJob('1', 90))).status === 'sent' && h2.sent.length === 1);
  const h3 = harness();
  await h3.notifier.notifyHighMatch(makeJob('1', 95));
  ok('3. score 95 notifica con titulo, cuerpo y prioridad',
    h3.sent[0].message.title === '🔥 Match 95 — Director of Business Operations'
    && h3.sent[0].message.body === 'Acme\nRating: 95/100'
    && h3.sent[0].message.priority === 'high');
  const h4 = harness({ settings: { ...ON, threshold: 70 } });
  ok('4. el umbral configurado por el usuario manda',
    (await h4.notifier.notifyHighMatch(makeJob('1', 75))).status === 'sent');
  ok('5. el umbral se acota al rango permitido',
    N.clampThreshold(10) === 50 && N.clampThreshold(200) === 100 && N.clampThreshold('x') === 90);

  section('Idempotencia y fallos');
  const already = makeJob('1', 94);
  already.highMatchNotifiedAt = '2026-09-15T10:00:00.000Z';
  const h6 = harness();
  ok('6. un job ya notificado no se vuelve a notificar',
    (await h6.notifier.notifyHighMatch(already)).status === 'already_notified' && h6.sent.length === 0 && h6.marked.length === 0);

  const { svc, store } = memoryService();
  store.set('1', makeJob('1', 93));
  const okNotifier = N.createHighMatchNotifier({
    settings: ON, send: async () => ({ ok: true, status: 200 }),
    markNotified: (jobId) => svc.markHighMatchNotified(jobId),
  });
  await okNotifier.notifyHighMatch(svc.getJob('1'));
  ok('7. un envio exitoso persiste highMatchNotifiedAt', !!store.get('1').highMatchNotifiedAt);

  const failJob = makeJob('1', 96);
  const h8 = harness({ send: async () => { throw new Error('ntfy HTTP 503'); } });
  const outFail = await h8.notifier.notifyHighMatch(failJob);
  ok('8. un envio fallido NO persiste la marca y queda reintentable',
    outFail.status === 'failed' && h8.marked.length === 0 && failJob.highMatchNotifiedAt === null);
  ok('9. un intento posterior con ntfy sano si notifica',
    (await harness().notifier.notifyHighMatch(failJob)).status === 'sent');

  section('Configuracion');
  const hOff = harness({ settings: { enabled: false, topic: 'jobhunter-test' } });
  ok('10. desactivado no envia nada',
    (await hOff.notifier.notifyHighMatch(makeJob('1', 99))).status === 'disabled' && hOff.sent.length === 0);
  const hAbsent = harness({ settings: undefined });
  ok('11. sin bloque de configuracion equivale a desactivado',
    (await hAbsent.notifier.notifyHighMatch(makeJob('1', 99))).status === 'disabled');
  const hBad = harness({ settings: { enabled: true } });
  const bad1 = await hBad.notifier.notifyHighMatch(makeJob('1', 99));
  await hBad.notifier.notifyHighMatch(makeJob('2', 99));
  ok('12. configuracion incompleta no rompe y se avisa una sola vez por run',
    bad1.status === 'misconfigured' && hBad.sent.length === 0
    && hBad.logs.filter((m) => m.includes('configuracion invalida')).length === 1);
  ok('13. un topic con forma invalida se detecta',
    N.getNtfyConfig({ enabled: true, topic: 'a/../b' }).configError !== null
    && N.getNtfyConfig({ enabled: true, topic: 't', baseUrl: 'ftp://x' }).configError !== null);

  section('Compatibilidad de user.json');
  const baseConfig = () => ({
    identity: { name: 'Test User', linkedinUrl: 'https://www.linkedin.com/in/test-user/' },
    search: { targetAnalyzedJobs: 20, locations: ['A'], queryGroups: [{ family: 'f', label: 'F', enabled: true, queries: [{ query: 'q', enabled: true }] }] },
  });
  let legacyOk = true;
  try { validateUserConfig(baseConfig()); } catch (e) { legacyOk = false; }
  ok('14. un user.json sin bloque notifications sigue validando', legacyOk);
  ok('15. sin bloque, las notificaciones quedan desactivadas',
    getNotificationSettings(baseConfig()).enabled !== true);
  ok('16. un bloque valido se acepta',
    !!validateUserConfig({ ...baseConfig(), notifications: { ntfy: { enabled: true, topic: 'mi-topic', threshold: 85 } } }));
  let noTopic = false;
  try { validateUserConfig({ ...baseConfig(), notifications: { ntfy: { enabled: true } } }); } catch (e) { noTopic = true; }
  ok('17. activarlo sin topic se rechaza', noTopic);

  section('Republicaciones y aislamiento');
  const hRep = harness();
  const original = makeJob('111', 92);
  await hRep.notifier.notifyHighMatch(original);
  original.highMatchNotifiedAt = '2026-09-16T00:00:00.000Z';
  const republished = makeJob('999', 92);
  ok('18. un jobId nuevo equivalente no hereda la marca',
    republished.highMatchNotifiedAt === null
    && (await hRep.notifier.notifyHighMatch(republished)).status === 'sent'
    && hRep.marked.join() === '111,999');

  const clean = makeJob('1', 91);
  await harness().notifier.notifyHighMatch(clean);
  ok('19. notificar no modifica userState ni crea feedback',
    clean.userState.status === 'new' && clean.feedbackEvents.length === 0
    && JSON.stringify(clean.feedback) === JSON.stringify({ reasons: [], comment: null, createdAt: null }));
  clean.highMatchNotifiedAt = '2026-09-16T00:00:00.000Z';
  applyDiscarded(clean, { reasons: ['company'] });
  mergeDiscovery(clean, { jobId: '1', matchedQueries: ['q'], matchedFamilies: ['f'] });
  ok('20. descartar y redescubrir no alteran la marca', clean.highMatchNotifiedAt === '2026-09-16T00:00:00.000Z');

  section('Hook del pipeline');
  const desc = 'x'.repeat(400);
  const pipelineCase = async (over) => {
    const m = memoryService();
    const jobs = (over.jobs || [{ jobId: '1', score: 97 }]);
    for (const j of jobs) if (j.preexisting) m.store.set(j.jobId, j.preexisting);
    const summary = await runPipeline(Object.assign({
      jobService: m.svc,
      discover: discoveryOf(jobs.map((j) => ({ jobId: j.jobId, title: 'T', company: 'C', url: 'https://www.linkedin.com/jobs/view/' + j.jobId + '/', description: desc }))),
      fetchDetails: async (job) => job,
      analyze: async (job) => ({ analysis: analysis(jobs.find((j) => j.jobId === job.jobId).score), usage: {}, model: 'test' }),
      analyzeLimit: 10,
    }, over.deps || {}));
    return { summary, store: m.store, svc: m.svc };
  };

  const thrown = await pipelineCase({ deps: { notify: async () => { throw new Error('ntfy caido'); } } });
  ok('21. un notificador que rechaza no convierte un analisis exitoso en fallido',
    thrown.summary.analysis.analyzed === 1 && thrown.summary.analysis.failed === 0
    && thrown.store.get('1').analysisStatus === 'completed'
    && thrown.store.get('1').aiAnalysis.overallMatchScore === 97
    && thrown.summary.notifications.failed === 1);
  ok('22. un fallo de notificacion no persiste la marca', thrown.store.get('1').highMatchNotifiedAt === null);

  const noNotify = await pipelineCase({});
  ok('23. sin notificador inyectado el pipeline funciona igual',
    noNotify.summary.analysis.analyzed === 1
    && JSON.stringify(noNotify.summary.notifications) === JSON.stringify({ eligible: 0, sent: 0, alreadyNotified: 0, failed: 0 }));

  const sentMsgs = [];
  const many = await pipelineCase({
    jobs: [{ jobId: '1', score: 94 }, { jobId: '2', score: 91 }, { jobId: '3', score: 70 }, { jobId: '4', score: 90 }],
    deps: {
      notify: null,
    },
  });
  void many;
  const m2 = memoryService();
  const notifier2 = N.createHighMatchNotifier({
    settings: ON, send: async (url, message) => { sentMsgs.push(message); return { ok: true, status: 200 }; },
    markNotified: (jobId) => m2.svc.markHighMatchNotified(jobId),
  });
  const scores = { 1: 94, 2: 91, 3: 70, 4: 90 };
  const summaryMany = await runPipeline({
    jobService: m2.svc,
    discover: discoveryOf(Object.keys(scores).map((id) => ({ jobId: id, title: 'T', company: 'C', url: 'https://www.linkedin.com/jobs/view/' + id + '/', description: desc }))),
    fetchDetails: async (job) => job,
    analyze: async (job) => ({ analysis: analysis(scores[job.jobId]), usage: {}, model: 'test' }),
    analyzeLimit: 10,
    notify: (j) => notifier2.notifyHighMatch(j),
  });
  ok('24. una notificacion independiente por oferta, sin resumen agrupado',
    sentMsgs.length === 3 && summaryMany.notifications.sent === 3 && summaryMany.notifications.eligible === 3);
  ok('25. el que no llega al umbral no se notifica', m2.store.get('3').highMatchNotifiedAt === null);
  ok('26. el que esta exactamente en el umbral si', !!m2.store.get('4').highMatchNotifiedAt);

  // Historico ya analizado: el hunt lo redescubre pero no requiere analisis.
  const historic = makeJob('1', 98);
  historic.analysisStatus = 'completed';
  const notified = [];
  const mHist = memoryService();
  mHist.store.set('1', historic);
  const histSummary = await runPipeline({
    jobService: mHist.svc,
    discover: discoveryOf([{ jobId: '1', title: 'T', company: 'C', url: 'https://www.linkedin.com/jobs/view/1/' }]),
    fetchDetails: async (job) => job,
    analyze: async () => { throw new Error('no deberia analizarse'); },
    analyzeLimit: 10,
    notify: async (job) => { notified.push(job.jobId); return { status: 'sent' }; },
  });
  ok('27. un historico >= umbral no analizado en el run no se notifica retroactivamente',
    histSummary.analysis.analyzed === 0 && notified.length === 0
    && histSummary.notifications.sent === 0 && mHist.store.get('1').highMatchNotifiedAt === null);

  // Reanalisis de un job ya notificado.
  const mRe = memoryService();
  const prior = makeJob('1', 93, { description: desc });
  prior.aiAnalysis = null;
  prior.analysisStatus = 'pending';
  prior.highMatchNotifiedAt = '2026-09-15T10:00:00.000Z';
  mRe.store.set('1', prior);
  const reSent = [];
  const notifier3 = N.createHighMatchNotifier({
    settings: ON, send: async (url, m) => { reSent.push(m); return { ok: true, status: 200 }; },
    markNotified: (jobId) => mRe.svc.markHighMatchNotified(jobId),
  });
  const reSummary = await runPipeline({
    jobService: mRe.svc,
    discover: discoveryOf([{ jobId: '1', title: 'T', company: 'C', url: 'https://www.linkedin.com/jobs/view/1/', description: desc }]),
    fetchDetails: async (job) => job,
    analyze: async () => ({ analysis: analysis(95), usage: {}, model: 'test' }),
    analyzeLimit: 10,
    notify: (j) => notifier3.notifyHighMatch(j),
  });
  ok('28. un job ya notificado no se re-notifica al volver a analizarse',
    reSummary.analysis.analyzed === 1 && reSent.length === 0
    && reSummary.notifications.alreadyNotified === 1
    && mRe.store.get('1').highMatchNotifiedAt === '2026-09-15T10:00:00.000Z');

  // Cancelacion con notificador activo.
  const mCancel = memoryService();
  const controller = new AbortController();
  let cancelled = false;
  try {
    await runPipeline({
      jobService: mCancel.svc,
      discover: discoveryOf([{ jobId: '1', title: 'T', company: 'C', url: 'https://www.linkedin.com/jobs/view/1/', description: desc }]),
      fetchDetails: async (job) => job,
      analyze: async () => { controller.abort(); return { analysis: analysis(95), usage: {}, model: 'test' }; },
      analyzeLimit: 10,
      signal: controller.signal,
      notify: async () => ({ status: 'sent' }),
    });
  } catch (e) { cancelled = e && e.name === 'HuntCancelledError'; }
  ok('29. cancelar durante un run con notificador sigue siendo una cancelacion', cancelled);

  // analysisTarget sigue cortando igual.
  const mTarget = memoryService();
  const targetJobs = ['1', '2', '3', '4', '5'];
  const targetSummary = await runPipeline({
    jobService: mTarget.svc,
    discover: discoveryOf(targetJobs.map((id) => ({ jobId: id, title: 'T', company: 'C', url: 'https://www.linkedin.com/jobs/view/' + id + '/', description: desc }))),
    fetchDetails: async (job) => job,
    analyze: async () => ({ analysis: analysis(95), usage: {}, model: 'test' }),
    analyzeLimit: 10,
    analysisTarget: 2,
    notify: async () => ({ status: 'sent' }),
  });
  ok('30. analysisTarget sigue acotando el run con el notificador activo',
    targetSummary.analysis.analyzed === 2 && targetSummary.notifications.sent === 2);

  section('Mensaje');
  ok('31. el Click usa la URL canonica de la oferta',
    N.jobClickUrl({ jobId: '4461234567', url: 'https://www.linkedin.com/jobs/view/4461234567/' }) === 'https://www.linkedin.com/jobs/view/4461234567/'
    && N.jobClickUrl({ jobId: '4461234567', url: null }) === 'https://www.linkedin.com/jobs/view/4461234567/'
    && N.jobClickUrl({ jobId: '4461234567', url: 'https://example.com/x' }) === 'https://www.linkedin.com/jobs/view/4461234567/');
  ok('32. sin datos fiables no se inventa una URL',
    N.jobClickUrl({ jobId: 'demo', url: 'https://example.com/x' }) === null);
  const hNoUrl = harness();
  const noUrl = makeJob('4461234567', 94);
  noUrl.jobId = 'demo'; noUrl.url = null;
  ok('33. sin Click la notificacion se envia igual',
    (await hNoUrl.notifier.notifyHighMatch(noUrl)).status === 'sent' && hNoUrl.sent[0].message.click === null);
  const encoded = N.encodeHeaderValue('🔥 Match 94 — Dirección');
  ok('34. el titulo con emoji y acentos viaja codificado en el header',
    encoded.startsWith('=?UTF-8?B?') && Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8') === '🔥 Match 94 — Dirección'
    && N.encodeHeaderValue('Plain ASCII') === 'Plain ASCII');
  const noScore = makeJob('1', null);
  noScore.aiAnalysis = { decision: 'YES', overallMatchScore: null };
  ok('35. un analisis sin score numerico no dispara notificacion',
    (await harness().notifier.notifyHighMatch(noScore)).status === 'below_threshold');

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((error) => { console.error(error); process.exitCode = 1; });

'use strict';

// Notificaciones push de high match (ntfy).
// NINGUN test hace un request real: el sender se inyecta siempre.

const test = require('node:test');
const assert = require('node:assert');

const {
  HIGH_MATCH_THRESHOLD, getNtfyConfig, isHighMatch, jobClickUrl,
  buildHighMatchNotification, encodeHeaderValue, createHighMatchNotifier,
} = require('../notifications/ntfy');
const { createJobRecord, applyApplicationsClosed, applyDiscarded } = require('../domain/jobRecord');
const { runPipeline } = require('../pipeline/pipeline');
const { createJobService } = require('../services/jobService');

const ENV_ON = { NTFY_ENABLED: 'true', NTFY_TOPIC: 'jobhunter-test', NTFY_BASE_URL: 'https://ntfy.sh' };

function analysis(score) {
  return {
    decision: score >= 90 ? 'YES' : 'MAYBE', overallMatchScore: score,
    professionalFitScore: score, interestFitScore: score, cvFitScore: score, confidence: 90,
  };
}

function makeJob(jobId, score, extra) {
  return createJobRecord(Object.assign({
    jobId, title: 'Director of Business Operations', company: 'MUI',
    location: 'Barcelona', url: 'https://www.linkedin.com/jobs/view/' + jobId + '/',
    aiAnalysis: score == null ? null : analysis(score),
  }, extra || {}));
}

// Notificador con sender espia. Devuelve { notifier, sent, marked }.
function harness(options) {
  const o = options || {};
  const sent = [];
  const marked = [];
  const logs = [];
  const notifier = createHighMatchNotifier({
    env: o.env || ENV_ON,
    send: o.send || (async (url, message) => { sent.push({ url, message }); return { ok: true, status: 200 }; }),
    markNotified: (jobId) => marked.push(jobId),
    log: (m) => logs.push(m),
  });
  return { notifier, sent, marked, logs };
}

/* ---------------- 1-3: umbral ---------------- */

test('1) score 89 => no notification', async () => {
  const h = harness();
  const out = await h.notifier.notifyHighMatch(makeJob('111', 89));
  assert.strictEqual(out.status, 'below_threshold');
  assert.strictEqual(h.sent.length, 0);
  assert.strictEqual(h.marked.length, 0);
});

test('2) score 90 => notification (el umbral es >=, no >)', async () => {
  const h = harness();
  const out = await h.notifier.notifyHighMatch(makeJob('111', 90));
  assert.strictEqual(out.status, 'sent');
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(HIGH_MATCH_THRESHOLD, 90);
  assert.ok(isHighMatch(makeJob('x', 90)));
  assert.ok(!isHighMatch(makeJob('x', 89)));
});

test('3) score 95 => notification', async () => {
  const h = harness();
  const out = await h.notifier.notifyHighMatch(makeJob('111', 95));
  assert.strictEqual(out.status, 'sent');
  assert.strictEqual(h.sent[0].message.title, '🔥 Match 95 — Director of Business Operations');
  assert.strictEqual(h.sent[0].message.body, 'MUI\nRating: 95/100');
  assert.strictEqual(h.sent[0].message.priority, 'high');
});

/* ---------------- 4-7: idempotencia y fallos ---------------- */

test('4) job >=90 ya notificado => no segunda notification', async () => {
  const h = harness();
  const job = makeJob('111', 94);
  job.highMatchNotifiedAt = '2026-09-14T10:00:00.000Z';
  const out = await h.notifier.notifyHighMatch(job);
  assert.strictEqual(out.status, 'already_notified');
  assert.strictEqual(h.sent.length, 0);
  assert.strictEqual(h.marked.length, 0);
});

test('5) POST exitoso => persiste highMatchNotifiedAt', async () => {
  const store = new Map();
  const repository = {
    has: (id) => store.has(id), get: (id) => store.get(id) || null,
    getAll: () => Array.from(store.values()), save: (j) => { store.set(j.jobId, j); return j; },
  };
  const svc = createJobService(repository);
  store.set('111', makeJob('111', 93));

  const notifier = createHighMatchNotifier({
    env: ENV_ON,
    send: async () => ({ ok: true, status: 200 }),
    markNotified: (jobId) => svc.markHighMatchNotified(jobId),
  });
  const out = await notifier.notifyHighMatch(svc.getJob('111'));

  assert.strictEqual(out.status, 'sent');
  assert.ok(store.get('111').highMatchNotifiedAt, 'debe quedar persistido');
});

test('6) POST falla => NO persiste highMatchNotifiedAt (queda reintentable)', async () => {
  const h = harness({ send: async () => { throw new Error('ntfy HTTP 503'); } });
  const job = makeJob('111', 96);
  const out = await h.notifier.notifyHighMatch(job);

  assert.strictEqual(out.status, 'failed');
  assert.strictEqual(out.error, 'ntfy HTTP 503');
  assert.strictEqual(h.marked.length, 0, 'no debe marcarse');
  assert.strictEqual(job.highMatchNotifiedAt, null);
  assert.ok(h.logs.some((m) => m.startsWith('ntfy failed: 111')));

  // Un intento posterior con ntfy sano si notifica.
  const h2 = harness();
  assert.strictEqual((await h2.notifier.notifyHighMatch(job)).status, 'sent');
});

test('7) POST falla => el pipeline no falla por la notificacion', async () => {
  const store = new Map();
  const repository = {
    has: (id) => store.has(id), get: (id) => store.get(id) || null,
    getAll: () => Array.from(store.values()), save: (j) => { store.set(j.jobId, j); return j; },
  };
  const svc = createJobService(repository);

  const summary = await runPipeline({
    jobService: svc,
    discover: async () => ({ jobs: [{ jobId: '111', title: 'T', company: 'C', url: 'https://www.linkedin.com/jobs/view/111/', description: 'x'.repeat(400) }], discovery: {} }),
    fetchDetails: async (j) => j,
    analyze: async () => ({ analysis: analysis(97), usage: {}, model: 'test' }),
    analyzeLimit: 10,
    // Contrato roto a proposito: el notifier RECHAZA.
    notify: async () => { throw new Error('ntfy caido'); },
  });

  assert.strictEqual(summary.analysis.analyzed, 1, 'el analisis sigue contando como exitoso');
  assert.strictEqual(summary.analysis.failed, 0, 'un fallo de ntfy no marca el analisis como fallido');
  assert.strictEqual(store.get('111').analysisStatus, 'completed');
  assert.strictEqual(store.get('111').aiAnalysis.overallMatchScore, 97);
  assert.strictEqual(store.get('111').highMatchNotifiedAt, null);
  assert.strictEqual(summary.notifications.failed, 1);
});

/* ---------------- 8-9: configuracion ---------------- */

test('8) NTFY_ENABLED=false => no request', async () => {
  const h = harness({ env: { NTFY_ENABLED: 'false', NTFY_TOPIC: 'jobhunter-test' } });
  const out = await h.notifier.notifyHighMatch(makeJob('111', 99));
  assert.strictEqual(out.status, 'disabled');
  assert.strictEqual(h.sent.length, 0);
  assert.strictEqual(h.marked.length, 0);

  // Ausente por completo tambien desactiva.
  const h2 = harness({ env: {} });
  assert.strictEqual((await h2.notifier.notifyHighMatch(makeJob('111', 99))).status, 'disabled');
});

test('9) configuracion incompleta => no rompe el hunt', async () => {
  const h = harness({ env: { NTFY_ENABLED: 'true' } }); // falta NTFY_TOPIC
  const out = await h.notifier.notifyHighMatch(makeJob('111', 99));
  assert.strictEqual(out.status, 'misconfigured');
  assert.strictEqual(h.sent.length, 0);
  assert.strictEqual(h.marked.length, 0);
  assert.ok(h.logs.some((m) => m.includes('configuracion invalida')));

  // Se loguea una sola vez por run, no por job.
  await h.notifier.notifyHighMatch(makeJob('222', 99));
  assert.strictEqual(h.logs.filter((m) => m.includes('configuracion invalida')).length, 1);

  // Topic con forma invalida tampoco construye URL.
  assert.strictEqual(getNtfyConfig({ NTFY_ENABLED: 'true', NTFY_TOPIC: 'a/../b' }).configError, 'NTFY_TOPIC invalido');
  assert.strictEqual(getNtfyConfig({ NTFY_ENABLED: 'true', NTFY_TOPIC: 't', NTFY_BASE_URL: 'ftp://x' }).configError, 'NTFY_BASE_URL invalido');
});

/* ---------------- 10: republicaciones ---------------- */

test('10) job republicado con jobId distinto => se notifica independientemente', async () => {
  const h = harness();
  const original = makeJob('111', 92);
  assert.strictEqual((await h.notifier.notifyHighMatch(original)).status, 'sent');
  original.highMatchNotifiedAt = '2026-09-15T00:00:00.000Z';

  // Misma company + title, jobId nuevo: NO hereda la marca.
  const republished = makeJob('999', 92);
  assert.strictEqual(republished.highMatchNotifiedAt, null);
  const out = await h.notifier.notifyHighMatch(republished);
  assert.strictEqual(out.status, 'sent');
  assert.strictEqual(h.sent.length, 2);
  assert.deepStrictEqual(h.marked, ['111', '999']);
});

/* ---------------- 11-13: la notificacion no ensena nada ---------------- */

test('11) notification no modifica userState', async () => {
  const h = harness();
  const job = makeJob('111', 91);
  const before = JSON.parse(JSON.stringify(job.userState));
  await h.notifier.notifyHighMatch(job);
  assert.deepStrictEqual(job.userState, before);
  assert.strictEqual(job.userState.status, 'new');
});

test('12) notification no crea feedbackEvents ni feedback', async () => {
  const h = harness();
  const job = makeJob('111', 91);
  await h.notifier.notifyHighMatch(job);
  assert.strictEqual(job.feedbackEvents.length, 0);
  assert.deepStrictEqual(job.feedback, { reasons: [], comment: null, createdAt: null });
});

test('13) notification no modifica availability', async () => {
  const h = harness();
  const job = makeJob('111', 91);
  await h.notifier.notifyHighMatch(job);
  assert.strictEqual(job.availability, 'open');
  assert.strictEqual(job.availabilityReason, null);
  assert.strictEqual(job.availabilityUpdatedAt, null);

  // Y a la inversa: cerrar/descartar no toca la marca de notificacion.
  job.highMatchNotifiedAt = '2026-09-15T00:00:00.000Z';
  applyApplicationsClosed(job);
  applyDiscarded(job, { reasons: ['company'] });
  assert.strictEqual(job.highMatchNotifiedAt, '2026-09-15T00:00:00.000Z');
});

/* ---------------- 14-15: historicos y reanalisis ---------------- */

test('14) job historico >=90 no analizado en el run => no se notifica retroactivamente', async () => {
  const store = new Map();
  const repository = {
    has: (id) => store.has(id), get: (id) => store.get(id) || null,
    getAll: () => Array.from(store.values()), save: (j) => { store.set(j.jobId, j); return j; },
  };
  const svc = createJobService(repository);

  // Historico ya analizado con 98 y nunca notificado (estado previo al despliegue).
  const historic = makeJob('111', 98);
  historic.analysisStatus = 'completed';
  store.set('111', historic);

  const notified = [];
  const summary = await runPipeline({
    jobService: svc,
    // El hunt lo vuelve a descubrir, pero NO requiere analisis.
    discover: async () => ({ jobs: [{ jobId: '111', title: 'T', company: 'C', url: 'https://www.linkedin.com/jobs/view/111/' }], discovery: {} }),
    fetchDetails: async (j) => j,
    analyze: async () => { throw new Error('no deberia analizarse'); },
    analyzeLimit: 10,
    notify: async (job) => { notified.push(job.jobId); return { status: 'sent' }; },
  });

  assert.strictEqual(summary.analysis.analyzed, 0);
  assert.strictEqual(summary.analysis.alreadyAnalyzed, 1);
  assert.deepStrictEqual(notified, [], 'no se notifica por existir en persistencia');
  assert.strictEqual(summary.notifications.sent, 0);
  assert.strictEqual(store.get('111').highMatchNotifiedAt, null);
});

test('15) reanalysis de job ya notificado => no vuelve a notificar', async () => {
  const store = new Map();
  const repository = {
    has: (id) => store.has(id), get: (id) => store.get(id) || null,
    getAll: () => Array.from(store.values()), save: (j) => { store.set(j.jobId, j); return j; },
  };
  const svc = createJobService(repository);

  // Job stale (requiere reanalisis) que YA fue notificado antes.
  const job = makeJob('111', 93, { description: 'x'.repeat(400) });
  job.analysisStatus = 'stale';
  job.analysisStaleReason = 'description_repaired';
  job.highMatchNotifiedAt = '2026-09-14T10:00:00.000Z';
  store.set('111', job);

  const sent = [];
  const notifier = createHighMatchNotifier({
    env: ENV_ON,
    send: async (url, message) => { sent.push(message); return { ok: true, status: 200 }; },
    markNotified: (jobId) => svc.markHighMatchNotified(jobId),
  });

  const summary = await runPipeline({
    jobService: svc,
    discover: async () => ({ jobs: [{ jobId: '111', title: 'T', company: 'C', url: 'https://www.linkedin.com/jobs/view/111/', description: 'x'.repeat(400) }], discovery: {} }),
    fetchDetails: async (j) => j,
    analyze: async () => ({ analysis: analysis(95), usage: {}, model: 'test' }),
    analyzeLimit: 10,
    notify: (j) => notifier.notifyHighMatch(j),
  });

  assert.strictEqual(summary.analysis.analyzed, 1, 'el reanalisis si ocurre');
  assert.strictEqual(sent.length, 0, 'pero no se re-notifica');
  assert.strictEqual(summary.notifications.alreadyNotified, 1);
  assert.strictEqual(summary.notifications.sent, 0);
  // La marca original se conserva intacta.
  assert.strictEqual(store.get('111').highMatchNotifiedAt, '2026-09-14T10:00:00.000Z');
});

/* ---------------- 16: Click ---------------- */

test('16) Click usa la URL exacta del job', async () => {
  const h = harness();
  await h.notifier.notifyHighMatch(makeJob('4461234567', 94));
  assert.strictEqual(h.sent[0].message.click, 'https://www.linkedin.com/jobs/view/4461234567/');
  assert.strictEqual(h.sent[0].url, 'https://ntfy.sh/jobhunter-test');

  // Sin url persistida se reconstruye la canonica desde jobId.
  const noUrl = makeJob('4461234567', 94);
  noUrl.url = null;
  assert.strictEqual(jobClickUrl(noUrl), 'https://www.linkedin.com/jobs/view/4461234567/');

  // URL ajena o jobId no numerico: no se inventa nada.
  const foreign = makeJob('4461234567', 94);
  foreign.url = 'https://example.com/jobs/view/4461234567/';
  assert.strictEqual(jobClickUrl(foreign), 'https://www.linkedin.com/jobs/view/4461234567/');
  assert.strictEqual(jobClickUrl({ jobId: 'demo-main', url: 'https://example.com/x' }), null);

  // Sin Click, la notificacion igual se envia.
  const h2 = harness();
  const demo = makeJob('4461234567', 94);
  demo.url = null; demo.jobId = 'demo-main';
  const out = await h2.notifier.notifyHighMatch(demo);
  assert.strictEqual(out.status, 'sent');
  assert.strictEqual(h2.sent[0].message.click, null);
});

/* ---------------- extras ---------------- */

test('el pipeline notifica un job por oferta, sin resumen agrupado', async () => {
  const store = new Map();
  const repository = {
    has: (id) => store.has(id), get: (id) => store.get(id) || null,
    getAll: () => Array.from(store.values()), save: (j) => { store.set(j.jobId, j); return j; },
  };
  const svc = createJobService(repository);
  const scores = { 111: 94, 222: 91, 333: 70, 444: 90 };

  const sent = [];
  const notifier = createHighMatchNotifier({
    env: ENV_ON,
    send: async (url, message) => { sent.push(message); return { ok: true, status: 200 }; },
    markNotified: (jobId) => svc.markHighMatchNotified(jobId),
  });

  const summary = await runPipeline({
    jobService: svc,
    discover: async () => ({
      jobs: Object.keys(scores).map((id) => ({
        jobId: id, title: 'T' + id, company: 'C', url: 'https://www.linkedin.com/jobs/view/' + id + '/',
        description: 'x'.repeat(400),
      })),
      discovery: {},
    }),
    fetchDetails: async (j) => j,
    analyze: async (job) => ({ analysis: analysis(scores[job.jobId]), usage: {}, model: 'test' }),
    analyzeLimit: 10,
    notify: (j) => notifier.notifyHighMatch(j),
  });

  assert.strictEqual(sent.length, 3, '3 jobs >=90 => 3 notificaciones independientes');
  assert.strictEqual(summary.notifications.sent, 3);
  assert.strictEqual(summary.notifications.eligible, 3);
  assert.strictEqual(summary.notifications.failed, 0);
  assert.strictEqual(store.get('333').highMatchNotifiedAt, null, 'el de 70 no se notifica');
  assert.ok(store.get('444').highMatchNotifiedAt, 'el de exactamente 90 si');
});

test('sin notifier inyectado el pipeline funciona igual', async () => {
  const store = new Map();
  const repository = {
    has: (id) => store.has(id), get: (id) => store.get(id) || null,
    getAll: () => Array.from(store.values()), save: (j) => { store.set(j.jobId, j); return j; },
  };
  const svc = createJobService(repository);
  const summary = await runPipeline({
    jobService: svc,
    discover: async () => ({ jobs: [{ jobId: '111', title: 'T', company: 'C', url: 'https://www.linkedin.com/jobs/view/111/', description: 'x'.repeat(400) }], discovery: {} }),
    fetchDetails: async (j) => j,
    analyze: async () => ({ analysis: analysis(99), usage: {}, model: 'test' }),
    analyzeLimit: 10,
    // notify ausente
  });
  assert.strictEqual(summary.analysis.analyzed, 1);
  assert.deepStrictEqual(summary.notifications, { eligible: 0, sent: 0, alreadyNotified: 0, failed: 0 });
});

test('el Title con emoji y acentos viaja codificado en el header', () => {
  assert.strictEqual(encodeHeaderValue('Plain ASCII'), 'Plain ASCII');
  const encoded = encodeHeaderValue('🔥 Match 94 — Dirección');
  assert.ok(encoded.startsWith('=?UTF-8?B?') && encoded.endsWith('?='));
  const decoded = Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8');
  assert.strictEqual(decoded, '🔥 Match 94 — Dirección');
});

test('un analisis sin score numerico no dispara notificacion', async () => {
  const h = harness();
  const job = makeJob('111', null);
  job.aiAnalysis = { decision: 'YES', overallMatchScore: null };
  assert.strictEqual((await h.notifier.notifyHighMatch(job)).status, 'below_threshold');
  job.aiAnalysis = { decision: 'YES' };
  assert.strictEqual((await h.notifier.notifyHighMatch(job)).status, 'below_threshold');
  assert.strictEqual(h.sent.length, 0);
});

test('buildHighMatchNotification tolera title/company ausentes', () => {
  const msg = buildHighMatchNotification({ jobId: '111', aiAnalysis: analysis(90) });
  assert.strictEqual(msg.title, '🔥 Match 90 — Oferta sin titulo');
  assert.strictEqual(msg.body, 'Empresa no informada\nRating: 90/100');
});

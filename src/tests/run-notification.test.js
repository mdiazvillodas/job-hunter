'use strict';

// Tests de la notificacion ntfy de CIERRE de hunt (src/notifications/runOutcome.js).
// Deterministas: ningun POST real a ntfy, ningun hunt real.

const test = require('node:test');
const assert = require('node:assert');

const {
  COMPLETED,
  INTERRUPTED,
  FAILED,
  classifyRunOutcome,
  safeErrorMessage,
  formatDuration,
  metricLines,
  buildRunOutcomeNotification,
  createRunOutcomeNotifier,
} = require('../notifications/runOutcome');

const {
  buildHighMatchNotification,
  defaultSend,
  HIGH_MATCH_THRESHOLD,
} = require('../notifications/ntfy');

const CONFIG_ON = {
  enabled: true,
  configError: null,
  url: 'https://ntfy.sh/topic-de-prueba',
  topic: 'topic-de-prueba',
  baseUrl: 'https://ntfy.sh',
};

// Summary realista, con la forma exacta que devuelve src/pipeline/pipeline.js.
function summaryFixture(overrides = {}) {
  return {
    runId: 'run_test',
    stoppedByChallenge: false,
    discovery: { queriesExecuted: 14, rawResults: 180, uniqueResults: 109, duplicatesRemoved: 71, newJobs: 34, existingJobs: 75 },
    analysis: { requiringAnalysis: 34, alreadyAnalyzed: 75, processed: 27, analyzed: 27, failed: 0, skipped: 7, analysisEnabled: true },
    persistence: { created: 34, updated: 2, unchanged: 73 },
    notifications: { eligible: 2, sent: 2, alreadyNotified: 0, failed: 0 },
    usageTotals: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, totalTokens: 2, model: 'gpt-4.1-mini' },
    durations: { discoveryMs: 1000, detailsMs: 1000, analysisMs: 1000, totalMs: 42 * 60 * 1000 },
    ...overrides,
  };
}

function collectingSend() {
  const sent = [];
  return {
    sent,
    send: async (url, message) => { sent.push({ url, message }); return { ok: true }; },
  };
}

// ---------- clasificacion ----------

test('un run normal se clasifica como completed', () => {
  assert.strictEqual(classifyRunOutcome({ summary: summaryFixture() }), COMPLETED);
});

test('stoppedByChallenge se clasifica como interrupted, no como completed', () => {
  const summary = summaryFixture({ stoppedByChallenge: true });
  assert.strictEqual(classifyRunOutcome({ summary }), INTERRUPTED);
});

test('un challenge sin summary tambien es interrupted', () => {
  assert.strictEqual(classifyRunOutcome({ challenge: true, error: new Error('security challenge') }), INTERRUPTED);
});

test('una excepcion sin summary es failed', () => {
  assert.strictEqual(classifyRunOutcome({ error: new Error('boom') }), FAILED);
});

test('sin summary y sin error tambien es failed (no se asume exito)', () => {
  assert.strictEqual(classifyRunOutcome({}), FAILED);
});

// ---------- formato ----------

test('formatDuration usa segundos, minutos u horas segun corresponda', () => {
  assert.strictEqual(formatDuration(38000), '38 s');
  assert.strictEqual(formatDuration(42 * 60 * 1000), '42 min');
  assert.strictEqual(formatDuration(65 * 60 * 1000), '1 h 5 min');
  assert.strictEqual(formatDuration(null), null);
  assert.strictEqual(formatDuration(undefined), null);
});

test('el cuerpo usa metricas reales del summary', () => {
  const msg = buildRunOutcomeNotification({ outcome: COMPLETED, summary: summaryFixture() });
  assert.strictEqual(msg.title, '✅ Job Hunter terminado');
  assert.deepStrictEqual(msg.body.split('\n'), [
    '109 ofertas encontradas',
    '34 nuevas',
    '27 analizadas',
    `🔥 2 matches ≥${HIGH_MATCH_THRESHOLD}`,
    'Duración: 42 min',
  ]);
});

test('una metrica ausente se omite, no se inventa', () => {
  const summary = summaryFixture();
  delete summary.durations.totalMs;
  summary.analysis.analyzed = null;
  const lines = metricLines(summary);
  assert.ok(!lines.some((l) => l.includes('Duración')));
  assert.ok(!lines.some((l) => l.includes('analizadas')));
  assert.ok(lines.includes('109 ofertas encontradas'));
});

test('sin high matches no se imprime la linea de matches', () => {
  const summary = summaryFixture({ notifications: { eligible: 0, sent: 0, alreadyNotified: 0, failed: 0 } });
  assert.ok(!metricLines(summary).some((l) => l.includes('matches')));
});

test('los analisis fallidos se informan solo si hubo alguno', () => {
  const base = summaryFixture();
  const conFallos = summaryFixture({ analysis: { ...base.analysis, failed: 3 } });
  assert.ok(metricLines(conFallos).some((l) => l.includes('3 con error de análisis')));
  assert.ok(!metricLines(base).some((l) => l.includes('error de análisis')));
});

test('un summary vacio no rompe el formateo', () => {
  const msg = buildRunOutcomeNotification({ outcome: COMPLETED, summary: {} });
  assert.strictEqual(msg.title, '✅ Job Hunter terminado');
  assert.ok(typeof msg.body === 'string' && msg.body.length > 0);
});

// ---------- sin Click URL ----------

test('la notificacion de cierre NO lleva click', () => {
  const messages = [
    buildRunOutcomeNotification({ outcome: COMPLETED, summary: summaryFixture() }),
    buildRunOutcomeNotification({ outcome: INTERRUPTED, summary: summaryFixture({ stoppedByChallenge: true }) }),
    buildRunOutcomeNotification({ outcome: FAILED, error: new Error('boom') }),
  ];
  for (const msg of messages) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(msg, 'click'), false);
    const serialized = JSON.stringify(msg);
    assert.ok(!serialized.includes('linkedin.com'));
    assert.ok(!serialized.includes('http'));
  }
});

test('defaultSend no manda header Click cuando el mensaje no lo tiene', async () => {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { captured = { url, init }; return { ok: true, status: 200 }; };
  try {
    const msg = buildRunOutcomeNotification({ outcome: COMPLETED, summary: summaryFixture() });
    await defaultSend('https://ntfy.sh/t', msg);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(captured.init.headers, 'Click'), false);
});

test('la notificacion de high match CONSERVA su Click URL', () => {
  const job = { jobId: '4373758192', title: 'Head of Operations', company: 'ACME', aiAnalysis: { overallMatchScore: 93 } };
  const msg = buildHighMatchNotification(job);
  assert.strictEqual(msg.click, 'https://www.linkedin.com/jobs/view/4373758192/');
  assert.ok(msg.title.startsWith('🔥 Match 93'));
});

// ---------- challenge / error ----------

test('un challenge no se anuncia como terminado', async () => {
  const { sent, send } = collectingSend();
  const notifier = createRunOutcomeNotifier({ config: CONFIG_ON, send });
  const result = await notifier.notifyRunOutcome({ summary: summaryFixture({ stoppedByChallenge: true }) });

  assert.strictEqual(result.status, 'sent');
  assert.strictEqual(result.outcome, INTERRUPTED);
  assert.strictEqual(sent[0].message.title, '❌ Job Hunter interrumpido');
  assert.ok(!sent[0].message.title.includes('terminado'));
  // Aun interrumpido, informa lo que alcanzo a hacer.
  assert.ok(sent[0].message.body.includes('109 ofertas encontradas'));
});

test('un error real produce un cuerpo breve y seguro', () => {
  const msg = buildRunOutcomeNotification({ outcome: FAILED, error: new Error('Timeout 30000ms exceeded') });
  assert.strictEqual(msg.title, '❌ Job Hunter interrumpido');
  assert.ok(msg.body.includes('Timeout 30000ms exceeded'));
});

test('safeErrorMessage nunca filtra secretos ni multilinea', () => {
  const env = {
    OPENAI_API_KEY: 'sk-SECRETO-SUPER-LARGO-123456',
    TELEGRAM_BOT_TOKEN: '8000000:AA-TOKEN-SECRETO-XYZ',
  };
  const err = new Error(`fallo con ${env.OPENAI_API_KEY}\ny ${env.TELEGRAM_BOT_TOKEN}\nstack...`);
  const msg = safeErrorMessage(err, env);
  assert.ok(!msg.includes(env.OPENAI_API_KEY));
  assert.ok(!msg.includes(env.TELEGRAM_BOT_TOKEN));
  assert.ok(msg.includes('[redacted]'));
  assert.ok(!msg.includes('\n'));
});

test('safeErrorMessage acota la longitud', () => {
  assert.ok(safeErrorMessage(new Error('x'.repeat(1000))).length <= 180);
});

// ---------- contrato defensivo ----------

test('con ntfy deshabilitado no se envia nada y no se rompe', async () => {
  const { sent, send } = collectingSend();
  const notifier = createRunOutcomeNotifier({ config: { enabled: false, configError: null }, send });
  const r = await notifier.notifyRunOutcome({ summary: summaryFixture() });
  assert.strictEqual(r.status, 'disabled');
  assert.strictEqual(sent.length, 0);
});

test('mal configurado no envia y no lanza', async () => {
  const notifier = createRunOutcomeNotifier({
    config: { enabled: true, configError: 'NTFY_TOPIC ausente', url: null },
  });
  const r = await notifier.notifyRunOutcome({ summary: summaryFixture() });
  assert.strictEqual(r.status, 'misconfigured');
});

test('un fallo de red de ntfy nunca se propaga', async () => {
  const notifier = createRunOutcomeNotifier({
    config: CONFIG_ON,
    send: async () => { throw new Error('ntfy HTTP 503'); },
  });
  const r = await notifier.notifyRunOutcome({ summary: summaryFixture() });
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(r.outcome, COMPLETED);
});

test('un run normal envia el cierre con prioridad informativa', async () => {
  const { sent, send } = collectingSend();
  const notifier = createRunOutcomeNotifier({ config: CONFIG_ON, send });
  const r = await notifier.notifyRunOutcome({ summary: summaryFixture() });
  assert.strictEqual(r.status, 'sent');
  assert.strictEqual(r.outcome, COMPLETED);
  assert.strictEqual(sent[0].url, CONFIG_ON.url);
  assert.strictEqual(sent[0].message.priority, 'default');
});

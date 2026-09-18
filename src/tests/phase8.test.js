'use strict';

// Phase 8 — notificacion ntfy de CIERRE de hunt (terminado / interrumpido).
// NINGUN test hace un request real: el sender se inyecta siempre.
// Ejecutar: node src/tests/phase8.test.js

const R = require('../notifications/runOutcome');
const { buildHighMatchNotification, defaultSend } = require('../notifications/ntfy');
const { createHuntRunManager } = require('../run/huntRunManager');
const { STATES } = require('../session/linkedinSessionService');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }

const ON = { enabled: true, topic: 'jobhunter-test', baseUrl: 'https://ntfy.sh', threshold: 90 };

// Summary con la forma REAL que devuelve runPipeline (no la recortada por safeSummary).
function fullSummary(over) {
  return Object.assign({
    runId: 'run_x',
    stoppedByChallenge: false,
    discovery: { queriesExecuted: 4, rawResults: 140, uniqueResults: 109, duplicatesRemoved: 31, newJobs: 34, existingJobs: 75 },
    analysis: { requiringAnalysis: 34, alreadyAnalyzed: 0, processed: 27, analyzed: 27, failed: 0, skipped: 7, target: 27, stopReason: 'target_reached' },
    persistence: { created: 34, updated: 75, unchanged: 0 },
    notifications: { eligible: 2, sent: 2, alreadyNotified: 0, failed: 0 },
    usageTotals: { promptTokens: 1, completionTokens: 1, totalTokens: 2, model: 'gpt' },
    durations: { discoveryMs: 1000, detailsMs: 2000, analysisMs: 3000, totalMs: 2520000 },
  }, over || {});
}

function notifierHarness(over) {
  const o = over || {};
  const sent = [];
  const logs = [];
  const notifier = R.createRunOutcomeNotifier({
    settings: o.settings === undefined ? ON : o.settings,
    send: o.send || (async (url, message) => { sent.push({ url, message }); return { ok: true }; }),
    log: (m) => logs.push(m),
  });
  return { notifier, sent, logs };
}

/* ------------------------------------------------------------------ */
section('Clasificacion del desenlace');

ok('1. un run normal se clasifica como completed',
  R.classifyRunOutcome({ status: 'COMPLETED', summary: fullSummary() }) === R.COMPLETED);

ok('2. stoppedByChallenge se clasifica como interrupted, no como completed',
  R.classifyRunOutcome({ status: 'COMPLETED', summary: fullSummary({ stoppedByChallenge: true }) }) === R.INTERRUPTED);

ok('3. un challenge por excepcion tambien es interrupted',
  R.classifyRunOutcome({ status: 'FAILED', error: { code: 'CHECKPOINT_REQUIRED', message: 'LinkedIn requiere una verificación manual.' } }) === R.INTERRUPTED);

ok('4. una sesion caida es interrupted',
  R.classifyRunOutcome({ status: 'FAILED', error: { code: 'LOGIN_REQUIRED', message: 'Necesitás iniciar sesión en LinkedIn.' } }) === R.INTERRUPTED);

ok('5. cualquier otro error es failed',
  R.classifyRunOutcome({ status: 'FAILED', error: { code: 'HUNT_FAILED', message: 'La búsqueda no pudo completarse.' } }) === R.FAILED);

ok('6. sin summary y sin error no se asume exito',
  R.classifyRunOutcome({ status: 'COMPLETED' }) === R.FAILED);

ok('7. una cancelacion del usuario es cancelled, ni completed ni interrupted',
  R.classifyRunOutcome({ status: 'CANCELLED', summary: fullSummary() }) === R.CANCELLED);

ok('8. una cancelacion sigue siendo cancelled aunque el summary marque challenge',
  R.classifyRunOutcome({ status: 'CANCELLED', summary: fullSummary({ stoppedByChallenge: true }) }) === R.CANCELLED);

/* ------------------------------------------------------------------ */
section('Metricas reales');

ok('9. formatDuration usa segundos, minutos u horas segun corresponda',
  R.formatDuration(38000) === '38 s'
  && R.formatDuration(2520000) === '42 min'
  && R.formatDuration(3900000) === '1 h 5 min'
  && R.formatDuration(null) === null);

{
  const lines = R.metricLines(fullSummary(), 90);
  ok('10. el cuerpo usa metricas reales del summary',
    lines.includes('109 ofertas encontradas')
    && lines.includes('34 nuevas')
    && lines.includes('27 analizadas')
    && lines.includes('🔥 2 matches ≥90')
    && lines.includes('Duración: 42 min'),
    JSON.stringify(lines));
}

{
  const lines = R.metricLines({ discovery: { uniqueResults: 5 }, analysis: {}, durations: {} });
  ok('11. una metrica ausente se omite, no se inventa en 0',
    lines.length === 1 && lines[0] === '5 ofertas encontradas', JSON.stringify(lines));
}

{
  const lines = R.metricLines(fullSummary({ notifications: { eligible: 0 }, analysis: { analyzed: 3, failed: 0 } }));
  ok('12. sin high matches no se imprime la linea de matches',
    !lines.some((l) => l.includes('matches')), JSON.stringify(lines));
  ok('13. sin analisis fallidos no se imprime la linea de errores',
    !lines.some((l) => l.includes('error de análisis')), JSON.stringify(lines));
}

{
  const lines = R.metricLines(fullSummary({ analysis: { analyzed: 3, failed: 2 } }));
  ok('14. los analisis fallidos se informan solo si hubo alguno',
    lines.includes('⚠️ 2 con error de análisis'), JSON.stringify(lines));
}

ok('15. el umbral configurado por el usuario aparece en la linea de matches',
  R.metricLines(fullSummary(), 75).includes('🔥 2 matches ≥75'));

ok('16. un summary vacio no rompe el formateo',
  Array.isArray(R.metricLines(null)) && R.metricLines(null).length === 0
  && Array.isArray(R.metricLines({})) && R.metricLines({}).length === 0);

/* ------------------------------------------------------------------ */
section('Mensaje de cierre');

{
  const message = R.buildRunOutcomeNotification({ outcome: R.COMPLETED, summary: fullSummary(), threshold: 90 });
  ok('17. el cierre exitoso usa el titulo probado', message.title === '✅ Job Hunter terminado');
  ok('18. la notificacion de cierre NO lleva click',
    !('click' in message) || message.click == null, JSON.stringify(message));
  ok('19. el cierre normal tiene prioridad informativa', message.priority === R.PRIORITY_COMPLETED);
}

{
  const message = R.buildRunOutcomeNotification({
    outcome: R.INTERRUPTED,
    summary: fullSummary({ stoppedByChallenge: true, analysis: { analyzed: 4 } }),
    challenge: true,
  });
  ok('20. un challenge no se anuncia como terminado', message.title === '❌ Job Hunter interrumpido');
  ok('21. el challenge explica el motivo sin tecnicismos',
    message.body.includes('verificación de seguridad'), message.body);
  ok('22. un challenge conserva las metricas parciales reales',
    message.body.includes('4 analizadas'), message.body);
  ok('23. la interrupcion tiene prioridad alta', message.priority === R.PRIORITY_PROBLEM);
  ok('24. la interrupcion tampoco lleva click', !('click' in message) || message.click == null);
}

{
  const message = R.buildRunOutcomeNotification({
    outcome: R.FAILED,
    error: { code: 'HUNT_FAILED', message: 'La búsqueda no pudo completarse.' },
  });
  ok('25. un fallo produce un cuerpo breve y seguro',
    message.title === '❌ Job Hunter interrumpido' && message.body.includes('El hunt no pudo completarse.'), message.body);
  ok('26. el cuerpo avisa que lo persistido se conserva',
    message.body.includes('Las ofertas ya guardadas se conservan.'));
}

ok('27. una cancelacion no produce mensaje',
  R.buildRunOutcomeNotification({ outcome: R.CANCELLED, summary: fullSummary() }) === null);

/* ------------------------------------------------------------------ */
section('Redaccion de secretos');

{
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-supersecreto-12345';
  const msg = R.safeErrorMessage('fallo con sk-supersecreto-12345\nen la linea 2\t y mas', { redact: ['jobhunter-test'] });
  ok('28. safeErrorMessage nunca filtra secretos ni multilinea',
    !msg.includes('sk-supersecreto-12345') && msg.includes('[redacted]') && !/[\r\n\t]/.test(msg), msg);
  const topicMsg = R.safeErrorMessage('POST https://ntfy.sh/jobhunter-test fallo', { redact: ['jobhunter-test'] });
  ok('29. el topic de ntfy tampoco viaja dentro del mensaje',
    !topicMsg.includes('jobhunter-test'), topicMsg);
  if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
}

ok('30. safeErrorMessage acota la longitud',
  R.safeErrorMessage('x'.repeat(500)).length <= 180);

ok('31. el path del proyecto no aparece en el mensaje',
  !R.safeErrorMessage(`fallo en ${require('path').resolve(__dirname, '..', '..')}/src/hunt.js`).includes(':\\'));

/* ------------------------------------------------------------------ */
section('Notificador: contrato defensivo');

(async () => {
  {
    const { notifier, sent } = notifierHarness();
    const result = await notifier.notifyRunOutcome({ status: 'COMPLETED', summary: fullSummary() });
    ok('32. un run normal envia el cierre', result.status === 'sent' && sent.length === 1, JSON.stringify(result));
    ok('33. se envia al topic configurado', sent[0].url === 'https://ntfy.sh/jobhunter-test');
  }

  {
    const { notifier, sent } = notifierHarness();
    const result = await notifier.notifyRunOutcome({ status: 'CANCELLED', summary: fullSummary() });
    ok('34. una cancelacion no envia NADA', result.status === 'skipped' && result.outcome === R.CANCELLED && sent.length === 0);
  }

  {
    const { notifier, sent } = notifierHarness({ settings: { enabled: false } });
    const result = await notifier.notifyRunOutcome({ status: 'COMPLETED', summary: fullSummary() });
    ok('35. con ntfy desactivado no se envia nada y no se rompe', result.status === 'disabled' && sent.length === 0);
  }

  {
    const { notifier, sent } = notifierHarness({ settings: { enabled: true, topic: 'topic invalido!' } });
    const result = await notifier.notifyRunOutcome({ status: 'COMPLETED', summary: fullSummary() });
    ok('36. mal configurado no envia y no lanza', result.status === 'misconfigured' && sent.length === 0);
  }

  {
    const { notifier } = notifierHarness({ send: async () => { throw new Error('ntfy HTTP 500'); } });
    const result = await notifier.notifyRunOutcome({ status: 'COMPLETED', summary: fullSummary() });
    ok('37. un fallo de red de ntfy nunca se propaga', result.status === 'failed', JSON.stringify(result));
  }

  {
    const { notifier, sent } = notifierHarness();
    await notifier.notifyRunOutcome({ status: 'FAILED', error: { code: 'CHECKPOINT_REQUIRED', message: 'LinkedIn requiere una verificación manual.' } });
    ok('38. el challenge por excepcion se envia como interrumpido',
      sent.length === 1 && sent[0].message.title === '❌ Job Hunter interrumpido');
  }

  /* --------------------------------------------------------------- */
  section('Contrato de ntfy: click');

  {
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
    await defaultSend('https://ntfy.sh/t', { title: 'x', body: 'y', priority: 'default' });
    ok('39. defaultSend no manda header Click cuando el mensaje no lo tiene',
      !Object.keys(calls[0].init.headers).some((h) => h.toLowerCase() === 'click'), JSON.stringify(calls[0].init.headers));
    delete globalThis.fetch;
  }

  {
    const job = { jobId: '4321', title: 'Ops Director', company: 'Acme', url: 'https://www.linkedin.com/jobs/view/4321/', aiAnalysis: { overallMatchScore: 95 } };
    const message = buildHighMatchNotification(job);
    ok('40. la notificacion de high match CONSERVA su Click URL',
      message.click === 'https://www.linkedin.com/jobs/view/4321/', JSON.stringify(message));
  }

  /* --------------------------------------------------------------- */
  section('Hook en huntRunManager');

  function managerHarness(over) {
    const o = over || {};
    const announced = [];
    const manager = createHuntRunManager({
      huntRunner: o.huntRunner || (async () => fullSummary()),
      notifyRunOutcome: async (input) => { announced.push(input); return o.notifyResult || { status: 'sent' }; },
      setupService: { getStatus: () => ({ readyForHunt: true }) },
      sessionService: { isOpen: () => false, verifyPersistedSession: async () => ({ state: STATES.AUTHENTICATED }) },
      acquireLock: () => {},
      releaseLock: () => {},
    });
    return { manager, announced };
  }

  {
    const { manager, announced } = managerHarness();
    const accepted = await manager.start();
    const final = await manager.waitForRun(accepted.runId);
    ok('41. el manager notifica el cierre una sola vez', announced.length === 1);
    ok('42. las metricas crudas sobreviven al hook del manager',
      announced[0].summary && announced[0].summary.notifications.eligible === 2
      && announced[0].summary.durations.totalMs === 2520000,
      JSON.stringify(announced[0].summary && Object.keys(announced[0].summary)));
    ok('43. el summary publico sigue recortado por safeSummary',
      final.summary && final.summary.notifications === undefined && final.summary.durations === undefined,
      JSON.stringify(Object.keys(final.summary || {})));
    ok('44. se notifica con el estado terminal real', announced[0].status === 'COMPLETED');
    ok('45. waitForRun conserva el resultado del run notificado', final.status === 'COMPLETED' && final.runId === accepted.runId);
  }

  {
    const { manager, announced } = managerHarness({
      huntRunner: async () => { const e = new Error('boom'); e.name = 'SecurityChallengeError'; throw e; },
    });
    const accepted = await manager.start();
    const final = await manager.waitForRun(accepted.runId);
    ok('46. un challenge llega al notificador con su codigo saneado',
      announced.length === 1 && announced[0].status === 'FAILED' && announced[0].error.code === 'CHECKPOINT_REQUIRED',
      JSON.stringify(announced[0]));
    ok('47. el error notificado no contiene el mensaje interno',
      !JSON.stringify(announced[0].error).includes('boom'), JSON.stringify(announced[0].error));
    ok('48. el estado del run sigue siendo FAILED', final.status === 'FAILED');
  }

  {
    let release = null;
    const { manager, announced } = managerHarness({
      huntRunner: (huntOptions) => new Promise((resolve, reject) => {
        release = () => {
          const error = new Error('Hunt cancelled.');
          error.name = 'HuntCancelledError';
          reject(error);
        };
      }),
    });
    const accepted = await manager.start();
    manager.cancel();
    release();
    const final = await manager.waitForRun(accepted.runId);
    ok('49. una cancelacion llega al notificador como CANCELLED',
      announced.length === 1 && announced[0].status === 'CANCELLED', JSON.stringify(announced[0]));
    ok('50. la cancelacion conserva su semantica de estado', final.status === 'CANCELLED' && final.error === null);
  }

  {
    const { manager } = managerHarness({ notifyResult: null });
    const failing = createHuntRunManager({
      huntRunner: async () => fullSummary(),
      notifyRunOutcome: async () => { throw new Error('notificador roto'); },
      setupService: { getStatus: () => ({ readyForHunt: true }) },
      sessionService: { isOpen: () => false, verifyPersistedSession: async () => ({ state: STATES.AUTHENTICATED }) },
      acquireLock: () => {},
      releaseLock: () => {},
    });
    const accepted = await failing.start();
    const final = await failing.waitForRun(accepted.runId);
    ok('51. un notificador que lanza no convierte un hunt exitoso en fallido',
      final.status === 'COMPLETED' && final.error === null, JSON.stringify(final));
    ok('52. y el manager queda libre para el siguiente run', manager.getStatus().status === 'IDLE');
  }

  {
    const releases = [];
    const manager = createHuntRunManager({
      huntRunner: () => new Promise((resolve) => { releases.push(() => resolve(fullSummary())); }),
      notifyRunOutcome: async () => ({ status: 'sent' }),
      setupService: { getStatus: () => ({ readyForHunt: true }) },
      sessionService: { isOpen: () => false, verifyPersistedSession: async () => ({ state: STATES.AUTHENTICATED }) },
      acquireLock: () => {},
      releaseLock: () => {},
    });
    const accepted = await manager.start();
    releases[0]();
    const final = await manager.waitForRun(accepted.runId);
    ok('53. el lock se libera aunque la notificacion tarde', final.finishedAt !== null);
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : 'FAILURES'} (${passed} passed, ${failed} failed) ===`);
  if (failed) process.exitCode = 1;
})();

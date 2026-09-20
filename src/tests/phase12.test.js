'use strict';

// Phase 12 — deteccion de challenge de LinkedIn basada en SEÑALES, y aviso
// util al usuario cuando el hunt se detiene por uno.
//
// Contexto: el detector anterior buscaba /checkpoint/i sobre el body completo,
// asi que una oferta que hablara de "project checkpoints" abortaba el run
// entero y dejaba el job pending para volver a abortarlo al dia siguiente.
//
// NINGUN test abre LinkedIn ni usa Playwright: la pagina se simula.
// Ejecutar: node src/tests/phase12.test.js

const S = require('../linkedin/challengeSignals');
const { detectSecurityChallenge, assertAuthenticatedSession } = require('../linkedin/session');
const { openJobsSearch } = require('../linkedin/jobsCollector');
const { collectJobDetails } = require('../linkedin/detailCollector');
const { detectState, STATES } = require('../session/linkedinSessionService');
const { runPipeline, challengeDiagnostic } = require('../pipeline/pipeline');
const { safeSummary, safeError, safeChallenge } = require('../run/huntRunManager');
const R = require('../notifications/runOutcome');
const { createJobRecord } = require('../domain/jobRecord');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }

const JOB_URL = 'https://www.linkedin.com/jobs/view/4466696432/';

// Descompone un selector CSS en sus alternativas. La pagina simulada razona en
// terminos de NODOS, no de cadenas: asi una consulta combinada (varios
// selectores separados por coma) se comporta como en un navegador de verdad.
function atoms(selector) {
  return String(selector).split(',').map((part) => part.trim()).filter(Boolean);
}

// Pagina simulada.
//   visibleNodes -> selectores ATOMICOS que existen y se ven en la pagina.
function fakePage({ url = JOB_URL, body = '', visibleNodes = [] } = {}) {
  const seen = (selector) => atoms(selector).some((atom) => visibleNodes.includes(atom));
  const page = {
    url: () => url,
    goto: async () => {},
    waitForLoadState: async () => {},
    locator: (selector) => ({
      first: () => ({ isVisible: async () => seen(selector), waitFor: async () => {} }),
      innerText: async () => (selector === 'body' ? body : ''),
    }),
    evaluate: async () => ({ found: false, clicked: false, text: null }),
    probes: [],
  };
  // Instrumentacion para contar cuantas veces se pregunta al DOM.
  const realLocator = page.locator;
  page.locator = (selector) => { page.probes.push(selector); return realLocator(selector); };
  return page;
}

function firstNodeOf(signal) {
  return atoms(signal.selector)[0];
}

async function capture(fn) {
  try { const value = await fn(); return { value, error: null }; }
  catch (error) { return { value: null, error }; }
}

async function detect(page) {
  const { error } = await capture(() => detectSecurityChallenge(page));
  return error;
}

/* ------------------------------------------------------------------ */
section('Regresion: vocabulario normal de ofertas NO es un challenge');

// Los textos que provocaron los falsos positivos en produccion.
const INNOCENT_TEXTS = [
  'We use project checkpoints throughout delivery.',
  'Responsible for quality checkpoints and milestone reviews.',
  'Coordinate security checkpoint requirements for facilities.',
  'Define project checkpoint meetings with stakeholders.',
  'Checkpoint, Palo Alto and Fortinet experience is a plus.',
  'Weekly checkpoint with the delivery team; monthly checkpoints with the client.',
  'Experience integrating CAPTCHA widgets into sign-up flows.',
  'Run a security check of the deployment pipeline before release.',
];

(async () => {
  for (const [i, text] of INNOCENT_TEXTS.entries()) {
    const error = await detect(fakePage({ body: text }));
    ok(`1.${i + 1} no es challenge: "${text.slice(0, 46)}…"`, error === null, error && error.challengeDiagnostic && error.challengeDiagnostic.signal);
  }

  {
    // Descripcion larga y realista, con "checkpoint" repetido muchas veces.
    const longDescription = [
      'Technical Software Project Manager — ALTEN, Barcelona (Hybrid).',
      'You will own delivery planning and define project checkpoints for each milestone.',
      'Responsibilities: run checkpoint meetings, track quality checkpoints, escalate risks.',
      'Coordinate with facilities on security checkpoint access for the data centre.',
      'We expect strong stakeholder management and clear checkpoint reporting cadence.',
      'Benefits: hybrid work, training budget, private health insurance.',
      'ALTEN is an equal opportunity employer.',
    ].join('\n').repeat(4);
    const error = await detect(fakePage({ body: longDescription }));
    ok('2. una descripcion extensa con "checkpoint" 28 veces no aborta el run',
      error === null, error && error.challengeDiagnostic && error.challengeDiagnostic.signal);
    ok('2b. el texto de control realmente contenia la palabra',
      (longDescription.match(/checkpoint/gi) || []).length >= 20);
  }

  {
    // La URL de la oferta que disparo el falso positivo del 19-sep.
    const error = await detect(fakePage({ url: JOB_URL, body: 'Define project checkpoint meetings with stakeholders.' }));
    ok('3. el caso real del 19-sep (ALTEN) ya no dispara challenge', error === null);
  }

  /* --------------------------------------------------------------- */
  section('Challenges reales: siguen detectandose');

  const REAL_URLS = [
    ['https://www.linkedin.com/checkpoint/challenge/AgH123', 'url:checkpoint'],
    ['https://www.linkedin.com/challenge/verify', 'url:challenge'],
    ['https://www.linkedin.com/captcha/v2', 'url:captcha'],
    ['https://www.linkedin.com/uas/login-submit', 'url:login_submit'],
  ];
  for (const [url, signal] of REAL_URLS) {
    const error = await detect(fakePage({ url, body: 'contenido irrelevante' }));
    ok(`4.${signal} URL de seguridad -> challenge`,
      !!error && error.name === 'SecurityChallengeError' && error.challengeDiagnostic.signal === signal,
      error && error.challengeDiagnostic && error.challengeDiagnostic.signal);
  }

  const REAL_TEXTS = [
    ['Security verification required to continue.', 'text:security_verification'],
    ['Verificación de seguridad necesaria para continuar.', 'text:security_verification'],
    ['Please confirm your identity to continue.', 'text:confirm_identity'],
    ['Confirma tu identidad para continuar.', 'text:confirm_identity'],
    ["Let's do a quick security check", 'text:quick_security_check'],
    ['We detected unusual activity from your account.', 'text:unusual_activity'],
    ["I'm not a robot", 'text:human_verification'],
    ['Verify you are human to continue.', 'text:human_verification'],
    ['Please complete the CAPTCHA below.', 'text:captcha_context'],
    ['Resuelve el captcha para continuar.', 'text:captcha_context'],
  ];
  for (const [body, signal] of REAL_TEXTS) {
    const error = await detect(fakePage({ body }));
    ok(`5.${signal} "${body.slice(0, 34)}…" -> challenge`,
      !!error && error.challengeDiagnostic.signal === signal,
      error ? error.challengeDiagnostic.signal : 'NO detecto');
  }

  for (const domSignal of S.DOM_SIGNALS) {
    const error = await detect(fakePage({ body: 'texto inocuo', visibleNodes: [firstNodeOf(domSignal)] }));
    ok(`6.${domSignal.id} nodo de challenge visible -> challenge`,
      !!error && error.challengeDiagnostic.source === 'dom' && error.challengeDiagnostic.signal === domSignal.id,
      error ? JSON.stringify(error.challengeDiagnostic) : 'NO detecto');
  }

  /* --------------------------------------------------------------- */
  section('authwall es LOGIN, nunca CHECKPOINT');

  {
    const error = await detect(fakePage({ url: 'https://www.linkedin.com/authwall?trk=x', body: 'Join LinkedIn' }));
    ok('7a. un authwall NO es un challenge', error === null, error && error.challengeDiagnostic.signal);
  }

  ok('7b. authwall no figura entre las señales de challenge',
    !S.URL_SIGNALS.some((signal) => signal.id.includes('authwall'))
    && !S.DOM_SIGNALS.some((signal) => signal.id.includes('authwall')));

  ok('7c. authwall si figura entre las señales de login',
    S.evaluateLogin({ url: 'https://www.linkedin.com/authwall?trk=x' }).signal === 'url:authwall');

  {
    // El servicio de sesion: es el que decide el estado que ve la UI y el que
    // bloquea el hunt. authwall tiene que salir como "inicia sesion".
    const authwall = await detectState({}, fakePage({ url: 'https://www.linkedin.com/authwall?trk=x' }));
    ok('7d. detectState: authwall -> LOGIN_REQUIRED', authwall === STATES.LOGIN_REQUIRED, authwall);

    const login = await detectState({}, fakePage({ url: 'https://www.linkedin.com/login' }));
    ok('7e. detectState: /login -> LOGIN_REQUIRED', login === STATES.LOGIN_REQUIRED, login);

    const checkpoint = await detectState({}, fakePage({ url: 'https://www.linkedin.com/checkpoint/challenge/x' }));
    ok('7f. detectState: checkpoint -> CHECKPOINT_REQUIRED', checkpoint === STATES.CHECKPOINT_REQUIRED, checkpoint);

    // login-submit casa con las dos familias: gana el challenge.
    const submit = await detectState({}, fakePage({ url: 'https://www.linkedin.com/uas/login-submit' }));
    ok('7g. detectState: /uas/login-submit -> CHECKPOINT_REQUIRED', submit === STATES.CHECKPOINT_REQUIRED, submit);

    // Una oferta que habla de checkpoints no puede cambiar el estado de sesion.
    const innocent = await detectState({}, fakePage({ url: JOB_URL, body: 'We run project checkpoints weekly.' }));
    ok('7h. detectState: "project checkpoints" no es checkpoint', innocent !== STATES.CHECKPOINT_REQUIRED, innocent);
  }

  {
    // La sesion del hunt: authwall tiene que dar AuthenticationError, no
    // SecurityChallengeError. Son dos instrucciones distintas al usuario.
    const { error } = await capture(() => assertAuthenticatedSession(
      { cookies: async () => [] },
      fakePage({ url: 'https://www.linkedin.com/authwall?trk=x' })
    ));
    ok('7i. assertAuthenticatedSession: authwall -> AuthenticationError',
      !!error && error.name === 'AuthenticationError', error && error.name);
  }

  {
    // El nodo de authwall sin URL de authwall tampoco es un challenge.
    const page = fakePage({ url: JOB_URL, visibleNodes: ['.authwall'] });
    const challengeError = await detect(page);
    const { error } = await capture(() => assertAuthenticatedSession({ cookies: async () => [] }, page));
    ok('7j. el nodo .authwall es login, no challenge',
      challengeError === null && !!error && error.name === 'AuthenticationError',
      challengeError ? 'detecto challenge' : (error && error.name));
  }

  /* --------------------------------------------------------------- */
  section('Prioridad y contenido del diagnostico');

  {
    const error = await detect(fakePage({ url: 'https://www.linkedin.com/checkpoint/x', body: 'Security verification' }));
    ok('8. la URL tiene prioridad sobre el texto', error.challengeDiagnostic.source === 'url');
  }

  {
    const error = await detect(fakePage({ body: 'Security verification', visibleNodes: [firstNodeOf(S.DOM_SIGNALS[0])] }));
    ok('9. el DOM tiene prioridad sobre el texto', error.challengeDiagnostic.source === 'dom');
  }

  {
    const error = await detect(fakePage({ body: 'Please confirm your identity now' }));
    const d = error.challengeDiagnostic;
    ok('10. el diagnostico dice source, signal y momento',
      d.source === 'text' && d.signal === 'text:confirm_identity' && typeof d.at === 'string' && !Number.isNaN(Date.parse(d.at)));
    ok('11. guarda un extracto minusculo, no el body',
      d.excerpt === 'confirm your identity' && d.excerpt.length <= S.MAX_EXCERPT_CHARS, d.excerpt);
  }

  {
    // Una URL de checkpoint lleva tokens en la query: no deben persistirse.
    const error = await detect(fakePage({ url: 'https://www.linkedin.com/checkpoint/challenge/AgFabcdefghijklmnopqrstuvwxyz0123?ct=SESSIONTOKEN123&li_at=SECRET' }));
    const d = error.challengeDiagnostic;
    ok('12. la url del diagnostico no lleva query ni tokens',
      !d.url.includes('?') && !d.url.includes('SESSIONTOKEN123') && !d.url.includes('SECRET'), d.url);
    ok('13. los segmentos opacos largos se enmascaran', d.url.includes('[id]'), d.url);
  }

  {
    const evaluation = S.evaluateChallenge({ text: 'contacta con soporte en abuse@example.com o https://x.test/a y el codigo 123456789' });
    ok('14. un texto sin señal no produce challenge', evaluation === null);
    ok('15. sanitizeExcerpt limpia urls, emails y numeros largos',
      S.sanitizeExcerpt('ver https://x.test/a mail a@b.co num 123456789') === 'ver [url] mail [email] num [num]',
      S.sanitizeExcerpt('ver https://x.test/a mail a@b.co num 123456789'));
  }

  ok('16. el detector devuelve null cuando no hay nada (no lanza)',
    (await detect(fakePage({ body: 'oferta normal' }))) === null);

  ok('17. "checkpoint" NO figura como patron de texto',
    !S.TEXT_SIGNALS.some((signal) => signal.pattern.test('we run project checkpoints weekly')));

  ok('18. "captcha" a secas tampoco es señal de texto',
    !S.TEXT_SIGNALS.some((signal) => signal.pattern.test('experience with captcha libraries')));

  /* --------------------------------------------------------------- */
  section('Sonda de DOM: una sola consulta cuando no hay challenge');

  {
    // El caso comun se paga una vez por pagina; antes eran 5 probes en serie.
    const page = fakePage({ body: 'oferta normal' });
    await detect(page);
    const domProbes = page.probes.filter((selector) => selector !== 'body');
    ok('19. pagina limpia -> UNA sola consulta al DOM',
      domProbes.length === 1 && domProbes[0] === S.DOM_SIGNAL_SELECTOR, JSON.stringify(domProbes));
  }

  {
    // Solo cuando la combinada dice que si se paga la clasificacion.
    const page = fakePage({ visibleNodes: [firstNodeOf(S.DOM_SIGNALS[2])] });
    const error = await detect(page);
    const domProbes = page.probes.filter((selector) => selector !== 'body');
    ok('20. con challenge -> combinada + clasificacion, y acierta la señal',
      !!error && error.challengeDiagnostic.signal === 'dom:checkpoint_form'
      && domProbes[0] === S.DOM_SIGNAL_SELECTOR && domProbes.length === 1 + S.DOM_SIGNALS.length,
      JSON.stringify(domProbes));
  }

  ok('21. si la combinada acierta pero no se puede clasificar, sigue siendo challenge',
    S.evaluateChallenge({ domSignals: [S.DOM_FALLBACK_SIGNAL] }).signal === S.DOM_FALLBACK_SIGNAL);

  /* --------------------------------------------------------------- */
  section('Etapa: por los caminos REALES de produccion');

  {
    const { error } = await capture(() => assertAuthenticatedSession(
      { cookies: async () => [] },
      fakePage({ url: 'https://www.linkedin.com/checkpoint/challenge/x' })
    ));
    ok('22. verificacion de sesion -> stage session_verification',
      !!error && error.challengeDiagnostic.stage === S.CHALLENGE_STAGES.SESSION,
      error && JSON.stringify(error.challengeDiagnostic));
  }

  {
    // jobsCollector: el modulo real que abre la busqueda.
    const { error } = await capture(() => openJobsSearch(
      fakePage({ url: 'https://www.linkedin.com/checkpoint/challenge/x' }), 'product manager'
    ));
    ok('23. busqueda de ofertas -> stage discovery',
      !!error && error.name === 'SecurityChallengeError' && error.challengeDiagnostic.stage === S.CHALLENGE_STAGES.DISCOVERY,
      error && JSON.stringify(error.challengeDiagnostic));
  }

  {
    // detailCollector: el modulo real que abre una oferta concreta.
    const { error } = await capture(() => collectJobDetails(
      fakePage({ url: 'https://www.linkedin.com/checkpoint/challenge/x' }),
      [{ jobId: '999', url: JOB_URL }],
      {}
    ));
    ok('24. apertura de una oferta -> stage detail_collection',
      !!error && error.name === 'SecurityChallengeError' && error.challengeDiagnostic.stage === S.CHALLENGE_STAGES.DETAIL,
      error && JSON.stringify(error.challengeDiagnostic));
  }

  ok('25. el vocabulario de etapas es cerrado y corto',
    Object.keys(S.CHALLENGE_STAGES).length === 4
    && S.isKnownStage('discovery') && !S.isKnownStage('cualquier_cosa'));

  /* --------------------------------------------------------------- */
  section('Blast radius: el run se detiene igual, pero ahora se sabe donde');

  function svcWithJobs(ids) {
    const store = new Map(ids.map((id) => [id, createJobRecord({ jobId: id, title: 'T' + id, company: 'C', url: 'https://www.linkedin.com/jobs/view/' + id + '/' })]));
    return {
      getAllJobs: () => [...store.values()],
      getJob: (id) => store.get(id) || null,
      ingestDiscovery: (job) => { const rec = createJobRecord(job); store.set(rec.jobId, rec); return { created: true, job: rec }; },
      updateDiscovery: (id, patch) => { const rec = { ...store.get(id), ...patch }; store.set(id, rec); return rec; },
      applyAnalysisProcessing: (id) => store.get(id),
      applyAnalysisResult: (id) => store.get(id),
      applyAnalysisFailure: (id) => store.get(id),
      markHighMatchNotified: () => {},
    };
  }

  // Error de challenge producido por el DETECTOR REAL, no a mano.
  async function realChallengeError(url) {
    const error = await detect(fakePage({ url: url || 'https://www.linkedin.com/checkpoint/x' }));
    if (!error) throw new Error('el fixture deberia producir un challenge');
    return error;
  }

  {
    const svc = svcWithJobs([]);
    const summary = await runPipeline({
      jobService: svc,
      discover: async () => ({ jobs: [{ jobId: '1', title: 'A', company: 'C', url: 'https://www.linkedin.com/jobs/view/1/' }], discovery: {} }),
      fetchDetails: async () => { throw await realChallengeError(); },
      analyze: async () => ({ analysis: {}, model: 'm', usage: {} }),
    });
    ok('26. un challenge real sigue deteniendo el run', summary.stoppedByChallenge === true);
    ok('27. el summary ahora dice POR QUE se detuvo',
      summary.challenge && summary.challenge.signal === 'url:checkpoint' && summary.challenge.source === 'url', JSON.stringify(summary.challenge));
    ok('28. y DONDE: etapa y oferta concreta',
      summary.challenge.stage === S.CHALLENGE_STAGES.DETAIL && summary.challenge.jobId === '1', JSON.stringify(summary.challenge));
  }

  {
    // Un challenge durante el analisis no es un analisis fallido.
    const svc = svcWithJobs([]);
    const summary = await runPipeline({
      jobService: svc,
      discover: async () => ({ jobs: [{ jobId: '3', title: 'C', company: 'C', url: 'https://www.linkedin.com/jobs/view/3/' }], discovery: {} }),
      fetchDetails: async () => ({ description: 'ok' }),
      analyze: async () => { throw await realChallengeError(); },
    });
    ok('29. un challenge en la fase de analisis detiene el run',
      summary.stoppedByChallenge === true && summary.challenge.stage === S.CHALLENGE_STAGES.ANALYSIS,
      JSON.stringify(summary.challenge));
    ok('30. y no se contabiliza como analisis fallido', summary.analysis.failed === 0, String(summary.analysis.failed));
  }

  {
    const svc = svcWithJobs([]);
    const summary = await runPipeline({
      jobService: svc,
      discover: async () => ({ jobs: [{ jobId: '2', title: 'B', company: 'C', url: 'https://www.linkedin.com/jobs/view/2/' }], discovery: {} }),
      fetchDetails: async () => ({ description: 'ok' }),
      analyze: async () => ({ analysis: {}, model: 'm', usage: {} }),
    });
    ok('31. un run normal deja challenge en null', summary.stoppedByChallenge === false && summary.challenge === null);
  }

  {
    const legacy = { name: 'SecurityChallengeError' };
    ok('32. un error sin diagnostico no rompe el pipeline', challengeDiagnostic(legacy, { stage: 'discovery' }) === null);
  }

  ok('33. una etapa inventada no sobrevive al pipeline',
    challengeDiagnostic({ challengeDiagnostic: { source: 'url', signal: 'url:checkpoint', stage: 'etapa_inventada' } }, {}).stage === undefined);

  /* --------------------------------------------------------------- */
  section('Exposicion segura hacia la UI');

  {
    const summary = safeSummary({
      runId: 'run_1',
      stoppedByChallenge: true,
      challenge: { source: 'text', signal: 'text:confirm_identity', at: '2026-09-19T00:16:24.254Z', stage: S.CHALLENGE_STAGES.DETAIL, jobId: '4466696432', excerpt: 'confirm your identity', url: 'https://www.linkedin.com/checkpoint/x' },
      discovery: {}, analysis: {}, persistence: {},
    });
    ok('34. safeSummary expone el diagnostico del challenge',
      summary.challenge.signal === 'text:confirm_identity' && summary.challenge.jobId === '4466696432');
    ok('35. y sigue sin exponer notifications/durations/usageTotals',
      summary.notifications === undefined && summary.durations === undefined && summary.usageTotals === undefined);
  }

  {
    const noisy = safeChallenge({ source: 'x'.repeat(100), signal: 'y'.repeat(300), excerpt: 'z'.repeat(500), url: 'u'.repeat(500), jobId: '9'.repeat(100), stage: 's'.repeat(200) });
    ok('36. safeChallenge acota todos los campos',
      noisy.source.length <= 16 && noisy.signal.length <= 64 && noisy.excerpt.length <= 80
      && noisy.url.length <= 200 && noisy.jobId.length <= 32);
    ok('37. y descarta una etapa que no sea del vocabulario cerrado', noisy.stage === undefined, noisy.stage);
    ok('38. safeChallenge ignora basura', safeChallenge(null) === null && safeChallenge('x') === null);
  }

  {
    const error = new Error('interno');
    error.name = 'SecurityChallengeError';
    error.challengeDiagnostic = { source: 'url', signal: 'url:checkpoint', at: '2026-09-19T00:00:00.000Z', stage: S.CHALLENGE_STAGES.DISCOVERY };
    const safe = safeError(error);
    ok('39. un challenge fuera del bucle de detalles tambien lleva diagnostico',
      safe.code === 'CHECKPOINT_REQUIRED' && safe.challenge.signal === 'url:checkpoint' && safe.challenge.stage === 'discovery');
    ok('40. y no filtra el mensaje interno', !JSON.stringify(safe).includes('interno'));
  }

  ok('41. un challenge sin diagnostico sigue produciendo un error valido',
    (() => { const e = new Error('x'); e.name = 'SecurityChallengeError'; const s = safeError(e); return s.code === 'CHECKPOINT_REQUIRED' && s.challenge === undefined; })());

  /* --------------------------------------------------------------- */
  section('El diagnostico llega al usuario por la ntfy de cierre');

  const NTFY = { enabled: true, topic: 'jobhunter-secreto', baseUrl: 'https://ntfy.sh', threshold: 90 };

  function notifierHarness() {
    const sent = [];
    const notifier = R.createRunOutcomeNotifier({
      settings: NTFY,
      send: async (url, message) => { sent.push({ url, message }); return { ok: true }; },
      log: () => {},
    });
    return { notifier, sent };
  }

  function challengeSummary(stage) {
    return {
      runId: 'run_x',
      stoppedByChallenge: true,
      challenge: stage ? { source: 'url', signal: 'url:checkpoint', at: '2026-09-19T00:00:00.000Z', stage } : null,
      discovery: { uniqueResults: 12, newJobs: 3 },
      analysis: { analyzed: 4, failed: 0 },
      notifications: { eligible: 0 },
      durations: { totalMs: 60000 },
    };
  }

  {
    const { notifier, sent } = notifierHarness();
    await notifier.notifyRunOutcome({ status: 'COMPLETED', summary: challengeSummary(S.CHALLENGE_STAGES.DISCOVERY) });
    const message = sent[0].message;
    ok('42. un challenge en discovery lo dice en la notificacion',
      message.title === '❌ Job Hunter interrumpido'
      && message.body.includes('durante la búsqueda de ofertas'), message.body);
    ok('43. sigue sin llevar Click', !('click' in message) && message.priority === R.PRIORITY_PROBLEM);
    ok('44. y conserva las metricas reales del run', message.body.includes('4 analizadas'), message.body);
  }

  {
    const { notifier, sent } = notifierHarness();
    await notifier.notifyRunOutcome({ status: 'COMPLETED', summary: challengeSummary(S.CHALLENGE_STAGES.DETAIL) });
    ok('45. un challenge abriendo una oferta se cuenta distinto',
      sent[0].message.body.includes('mientras analizaba una oferta'), sent[0].message.body);
  }

  {
    const { notifier, sent } = notifierHarness();
    await notifier.notifyRunOutcome({ status: 'COMPLETED', summary: challengeSummary(S.CHALLENGE_STAGES.SESSION) });
    ok('46. y uno al comprobar la sesion, tambien',
      sent[0].message.body.includes('al comprobar la sesión'), sent[0].message.body);
  }

  {
    // Camino por EXCEPCION: el challenge aborto el run antes del summary.
    const { notifier, sent } = notifierHarness();
    await notifier.notifyRunOutcome({
      status: 'FAILED',
      error: safeError(Object.assign(new Error('interno'), {
        name: 'SecurityChallengeError',
        challengeDiagnostic: { source: 'url', signal: 'url:checkpoint', at: 'x', stage: S.CHALLENGE_STAGES.DISCOVERY },
      })),
    });
    ok('47. un challenge sin summary tambien explica la etapa',
      sent[0].message.body.includes('durante la búsqueda de ofertas'), sent[0].message.body);
  }

  {
    const { notifier, sent } = notifierHarness();
    await notifier.notifyRunOutcome({ status: 'COMPLETED', summary: challengeSummary(null) });
    ok('48. sin etapa se usa el mensaje generico de siempre',
      sent[0].message.body.includes('verificación de seguridad') && sent[0].message.title === '❌ Job Hunter interrumpido',
      sent[0].message.body);
  }

  {
    const { notifier, sent } = notifierHarness();
    await notifier.notifyRunOutcome({
      status: 'COMPLETED',
      summary: { ...challengeSummary(null), challenge: { stage: 'etapa_inventada', signal: 'x' } },
    });
    ok('49. una etapa desconocida cae en el generico, no se imprime',
      sent[0].message.body.includes('verificación de seguridad') && !sent[0].message.body.includes('etapa_inventada'),
      sent[0].message.body);
  }

  {
    // authwall / sesion caida: mensaje propio, no el de verificacion.
    const { notifier, sent } = notifierHarness();
    await notifier.notifyRunOutcome({
      status: 'FAILED',
      error: { code: 'LOGIN_REQUIRED', message: 'Necesitás iniciar sesión en LinkedIn.' },
    });
    const message = sent[0].message;
    ok('50. un login requerido pide iniciar sesion, no resolver una verificacion',
      message.title === '❌ Job Hunter interrumpido'
      && message.body.includes('iniciar sesión')
      && !message.body.includes('verificación'), message.body);
    ok('51. y no se confunde con un fallo generico', !message.body.includes('El hunt no pudo completarse.'), message.body);
  }

  {
    // Todo el diagnostico tecnico se queda dentro: a ntfy solo va la frase.
    const { notifier, sent } = notifierHarness();
    await notifier.notifyRunOutcome({
      status: 'COMPLETED',
      summary: {
        ...challengeSummary(S.CHALLENGE_STAGES.DETAIL),
        challenge: {
          source: 'text', signal: 'text:confirm_identity', at: '2026-09-19T00:00:00.000Z',
          stage: S.CHALLENGE_STAGES.DETAIL, jobId: '4466696432',
          excerpt: 'confirm your identity', url: 'https://www.linkedin.com/checkpoint/[id]',
        },
      },
    });
    const body = sent[0].message.body;
    const leaked = ['4466696432', 'confirm your identity', 'linkedin.com', 'text:confirm_identity',
      'detail_collection', 'captcha-internal', 'jobhunter-secreto', 'C:\\', '#', 'http'];
    ok('52. la notificacion no filtra jobId, url, selector, extracto, señal ni topic',
      !leaked.some((value) => body.includes(value)), body);
    ok('53. y el mapa de etapas es cerrado (4 frases fijas)',
      Object.keys(R.CHALLENGE_STAGE_TEXTS).length === 4
      && Object.values(R.CHALLENGE_STAGE_TEXTS).every((text) => typeof text === 'string' && text.length < 120));
  }

  {
    // Invariantes de cierre que ya existian y no pueden cambiar.
    const { notifier, sent } = notifierHarness();
    const completed = await notifier.notifyRunOutcome({
      status: 'COMPLETED',
      summary: { runId: 'r', stoppedByChallenge: false, discovery: { uniqueResults: 9 }, analysis: { analyzed: 9 }, notifications: {}, durations: { totalMs: 1000 } },
    });
    ok('54. un run normal sigue siendo "terminado" y sin Click',
      completed.outcome === R.COMPLETED && sent[0].message.title === '✅ Job Hunter terminado' && !('click' in sent[0].message));

    const cancelled = await notifier.notifyRunOutcome({ status: 'CANCELLED', summary: challengeSummary(S.CHALLENGE_STAGES.DETAIL) });
    ok('55. una cancelacion sigue sin notificar nada',
      cancelled.status === 'skipped' && sent.length === 1);
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : 'FAILURES'} (${passed} passed, ${failed} failed) ===`);
  if (failed) process.exitCode = 1;
})();

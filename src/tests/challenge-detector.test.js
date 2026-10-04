'use strict';

// Deteccion de challenge de LinkedIn basada en SEÑALES.
//
// El detector anterior buscaba /checkpoint/i sobre body.innerText completo, asi
// que una oferta que hablara de "project checkpoints" abortaba el run entero,
// dejaba el job pending y volvia a abortarlo al dia siguiente. El forense del
// 19-sep confirmo 17 runs interrumpidos asi, todos con URL normal de oferta.
//
// NINGUN test abre LinkedIn ni usa Playwright: la pagina se simula.
// Ejecutar: node --test src/tests/challenge-detector.test.js

const test = require('node:test');
const assert = require('node:assert');

const S = require('../linkedin/challengeSignals');
const { detectSecurityChallenge } = require('../linkedin/session');
const { runPipeline } = require('../pipeline/pipeline');

const JOB_URL = 'https://www.linkedin.com/jobs/view/4466696432/';

function fakePage({ url = JOB_URL, body = '', visibleSelectors = [] } = {}) {
  return {
    url: () => url,
    locator: (selector) => ({
      first: () => ({ isVisible: async () => visibleSelectors.includes(selector) }),
      innerText: async () => (selector === 'body' ? body : ''),
    }),
  };
}

async function detect(page) {
  try { await detectSecurityChallenge(page); return null; }
  catch (error) { return error; }
}

/* ---------- REGRESION: vocabulario normal de ofertas ---------- */

const INNOCENT = [
  'We use project checkpoints throughout delivery.',
  'Responsible for quality checkpoints and milestone reviews.',
  'Coordinate security checkpoint requirements for facilities.',
  'Define project checkpoint meetings with stakeholders.',
  'Checkpoint, Palo Alto and Fortinet experience is a plus.',
  'Experience integrating CAPTCHA widgets into sign-up flows.',
  'Run a security check of the deployment pipeline before release.',
];

for (const body of INNOCENT) {
  test(`no es challenge: ${body.slice(0, 50)}`, async () => {
    assert.equal(await detect(fakePage({ body })), null);
  });
}

test('una descripcion extensa con "checkpoint" repetido no aborta el run', async () => {
  const description = [
    'Technical Software Project Manager — ALTEN, Barcelona (Hybrid).',
    'You will own delivery planning and define project checkpoints for each milestone.',
    'Responsibilities: run checkpoint meetings, track quality checkpoints, escalate risks.',
    'Coordinate with facilities on security checkpoint access for the data centre.',
    'We expect clear checkpoint reporting cadence.',
  ].join('\n').repeat(4);
  assert.ok((description.match(/checkpoint/gi) || []).length >= 20);
  assert.equal(await detect(fakePage({ body: description })), null);
});

test('el caso real del 19-sep (ALTEN, job 4466696432) ya no dispara challenge', async () => {
  const error = await detect(fakePage({ url: JOB_URL, body: 'Define project checkpoint meetings with stakeholders.' }));
  assert.equal(error, null);
});

/* ---------- CHALLENGES REALES ---------- */

const REAL_URLS = [
  ['https://www.linkedin.com/checkpoint/challenge/AgH123', 'url:checkpoint'],
  ['https://www.linkedin.com/challenge/verify', 'url:challenge'],
  ['https://www.linkedin.com/captcha/v2', 'url:captcha'],
  ['https://www.linkedin.com/uas/login-submit', 'url:login_submit'],
  ['https://www.linkedin.com/authwall?trk=x', 'url:authwall'],
  ['https://www.linkedin.com/verification/step', 'url:verification'],
];

for (const [url, signal] of REAL_URLS) {
  test(`URL de seguridad -> challenge (${signal})`, async () => {
    const error = await detect(fakePage({ url, body: 'irrelevante' }));
    assert.equal(error && error.name, 'SecurityChallengeError');
    assert.equal(error.challengeDiagnostic.signal, signal);
    assert.equal(error.challengeDiagnostic.source, 'url');
  });
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
  test(`texto de verificacion -> challenge (${signal})`, async () => {
    const error = await detect(fakePage({ body }));
    assert.equal(error && error.challengeDiagnostic.signal, signal);
    assert.equal(error.challengeDiagnostic.source, 'text');
  });
}

for (const domSignal of S.DOM_SIGNALS) {
  test(`DOM de challenge -> challenge (${domSignal.id})`, async () => {
    const error = await detect(fakePage({ body: 'texto inocuo', visibleSelectors: [domSignal.selector] }));
    assert.equal(error && error.challengeDiagnostic.source, 'dom');
    assert.equal(error.challengeDiagnostic.signal, domSignal.id);
  });
}

/* ---------- PRIORIDAD Y DIAGNOSTICO ---------- */

test('la URL tiene prioridad sobre el texto', async () => {
  const error = await detect(fakePage({ url: 'https://www.linkedin.com/checkpoint/x', body: 'Security verification' }));
  assert.equal(error.challengeDiagnostic.source, 'url');
});

test('el DOM tiene prioridad sobre el texto', async () => {
  const error = await detect(fakePage({ body: 'Security verification', visibleSelectors: [S.DOM_SIGNALS[0].selector] }));
  assert.equal(error.challengeDiagnostic.source, 'dom');
});

test('el diagnostico identifica source, signal, momento y extracto minimo', async () => {
  const error = await detect(fakePage({ body: 'Please confirm your identity now' }));
  const d = error.challengeDiagnostic;
  assert.equal(d.source, 'text');
  assert.equal(d.signal, 'text:confirm_identity');
  assert.ok(!Number.isNaN(Date.parse(d.at)));
  assert.equal(d.excerpt, 'confirm your identity');
  assert.ok(d.excerpt.length <= S.MAX_EXCERPT_CHARS);
});

test('la url del diagnostico no lleva query ni tokens', async () => {
  const error = await detect(fakePage({ url: 'https://www.linkedin.com/checkpoint/challenge/AgFabcdefghijklmnopqrstuvwxyz0123?ct=SESSIONTOKEN&li_at=SECRET' }));
  const { url } = error.challengeDiagnostic;
  assert.ok(!url.includes('?'));
  assert.ok(!url.includes('SESSIONTOKEN'));
  assert.ok(!url.includes('SECRET'));
  assert.ok(url.includes('[id]'));
});

test('"checkpoint" y "captcha" sueltos ya no son señales de texto', () => {
  assert.ok(!S.TEXT_SIGNALS.some((s) => s.pattern.test('we run project checkpoints weekly')));
  assert.ok(!S.TEXT_SIGNALS.some((s) => s.pattern.test('experience with captcha libraries')));
});

test('sanitizeExcerpt limpia urls, emails y numeros largos', () => {
  assert.equal(S.sanitizeExcerpt('ver https://x.test/a mail a@b.co num 123456789'), 'ver [url] mail [email] num [num]');
});

/* ---------- BLAST RADIUS Y DIAGNOSTICO EN EL PIPELINE ---------- */

function fakeService() {
  const store = new Map();
  return {
    getAllJobs: () => [...store.values()],
    getJob: (id) => store.get(id) || null,
    ingestDiscovery: (job) => { store.set(job.jobId, { ...job, analysisStatus: 'pending' }); return { created: true, job: store.get(job.jobId) }; },
    updateDiscovery: (id, patch) => { store.set(id, { ...store.get(id), ...patch }); return store.get(id); },
    applyAnalysisProcessing: (id) => store.get(id),
    applyAnalysisResult: (id) => store.get(id),
    applyAnalysisFailure: (id) => store.get(id),
    deferAnalysisForDescription: (id) => store.get(id),
    markHighMatchNotified: () => {},
  };
}

test('un challenge real sigue deteniendo el run y ahora dice por que y donde', async () => {
  const error = new Error('challenge');
  error.name = 'SecurityChallengeError';
  error.challengeDiagnostic = { source: 'url', signal: 'url:checkpoint', at: '2026-09-19T00:16:24.254Z' };
  error.detailDiagnostics = { status: 'auth_or_challenge', jobId: '1', url: JOB_URL, challenge: error.challengeDiagnostic };

  const summary = await runPipeline({
    jobService: fakeService(),
    discover: async () => ({ jobs: [{ jobId: '1', title: 'A', company: 'C', url: JOB_URL }], discovery: {} }),
    fetchDetails: () => Promise.reject(error),
    analyze: async () => ({ analysis: {}, model: 'm', usage: {} }),
  });

  assert.equal(summary.stoppedByChallenge, true);
  assert.equal(summary.challenge.signal, 'url:checkpoint');
  assert.equal(summary.challenge.source, 'url');
  assert.equal(summary.challenge.stage, 'detail_collection');
  assert.equal(summary.challenge.jobId, '1');
  // Y sigue quedando en la infraestructura que principal ya tenia.
  const diag = summary.detailDiagnostics.find((d) => d.status === 'auth_or_challenge');
  assert.equal(diag.challenge.signal, 'url:checkpoint');
});

test('un run normal deja challenge en null', async () => {
  const summary = await runPipeline({
    jobService: fakeService(),
    discover: async () => ({ jobs: [{ jobId: '2', title: 'B', company: 'C', url: JOB_URL }], discovery: {} }),
    fetchDetails: async () => ({ description: 'ok' }),
    analyze: async () => ({ analysis: {}, model: 'm', usage: {} }),
  });
  assert.equal(summary.stoppedByChallenge, false);
  assert.equal(summary.challenge, null);
});

test('un challenge sin diagnostico no rompe el pipeline y deja constancia explicita', async () => {
  const error = new Error('legacy');
  error.name = 'SecurityChallengeError';
  const summary = await runPipeline({
    jobService: fakeService(),
    discover: async () => ({ jobs: [{ jobId: '3', title: 'C', company: 'C', url: JOB_URL }], discovery: {} }),
    fetchDetails: () => Promise.reject(error),
    analyze: async () => ({ analysis: {}, model: 'm', usage: {} }),
  });
  assert.equal(summary.stoppedByChallenge, true);
  // Antes era null y un run quedaba detenido sin explicacion. Ahora dice que
  // no hubo evidencia, que no es lo mismo que no haber parado.
  assert.equal(summary.challenge.signal, S.CHALLENGE_UNSPECIFIED);
  assert.equal(summary.challenge.source, 'unspecified');
  assert.equal(summary.challenge.stage, 'detail_collection');
  assert.equal(summary.challenge.jobId, '3');
  assert.ok(summary.challenge.at, 'lleva marca de tiempo');
  assert.equal(summary.challenge.url, undefined, 'sin evidencia no se inventa una URL');
});

/* ---------- SANITIZACION DE LA URL EN detailDiagnostics ---------- */

// La URL del detalle se persiste en el job y en el summary del run. Ante un
// checkpoint real, page.url() lleva los tokens de la sesion en la query.
const { toDetailAccessDiagnostics } = require('../linkedin/descriptionExtractor');

const CHECKPOINT_URL_CON_SECRETOS =
  'https://www.linkedin.com/checkpoint/challenge/AgHqE9ySsm3trAAAAZK?csrfToken=ajax%3A9933881122&' +
  'session_redirect=%2Ffeed&email=mariano%40example.com&authToken=SUPERSECRETO123';

test('detailDiagnostics: una URL de checkpoint no persiste query ni tokens', () => {
  const error = new Error('challenge');
  error.name = 'SecurityChallengeError';
  const diagnostics = toDetailAccessDiagnostics(error, { jobId: '1', url: CHECKPOINT_URL_CON_SECRETOS });
  const serializado = JSON.stringify(diagnostics);

  for (const secreto of ['csrfToken', 'ajax', '9933881122', 'authToken', 'SUPERSECRETO123', 'example.com', 'session_redirect', '?', '#']) {
    assert.ok(!serializado.includes(secreto), `no debe persistirse "${secreto}" -> ${serializado}`);
  }
  // Se conserva la ruta (dice que fue un checkpoint) y se pierde la query entera.
  assert.equal(diagnostics.url, 'https://www.linkedin.com/checkpoint/challenge/AgHqE9ySsm3trAAAAZK');
  assert.equal(diagnostics.status, 'auth_or_challenge');
});

test('detailDiagnostics: un segmento opaco largo se enmascara', () => {
  const error = new Error('challenge');
  error.name = 'SecurityChallengeError';
  const diagnostics = toDetailAccessDiagnostics(error, {
    jobId: '1',
    url: 'https://www.linkedin.com/checkpoint/challenge/AgHqE9ySsm3trAAAAZKdeMuchaLongitudExtra?csrfToken=x',
  });
  assert.equal(diagnostics.url, 'https://www.linkedin.com/checkpoint/challenge/[id]');
});

test('detailDiagnostics: la URL normal de un job sigue siendo util', () => {
  const error = new Error('challenge');
  error.name = 'SecurityChallengeError';
  const diagnostics = toDetailAccessDiagnostics(error, { jobId: '4466696432', url: JOB_URL });
  // Ni enmascarada ni recortada: el jobId se lee a simple vista.
  assert.equal(diagnostics.url, 'https://www.linkedin.com/jobs/view/4466696432/');
  assert.ok(diagnostics.url.includes('4466696432'));
});

test('detailDiagnostics: los parametros de tracking de un job tampoco se persisten', () => {
  const error = new Error('challenge');
  error.name = 'SecurityChallengeError';
  const diagnostics = toDetailAccessDiagnostics(error, {
    jobId: '4466696432',
    url: 'https://www.linkedin.com/jobs/view/4466696432/?refId=abc123&trackingId=zzz%3D%3D#detalle',
  });
  assert.equal(diagnostics.url, 'https://www.linkedin.com/jobs/view/4466696432/');
});

test('detailDiagnostics: una URL no parseable o vacia no se propaga tal cual', () => {
  const error = new Error('challenge');
  error.name = 'SecurityChallengeError';
  const url = (value) => toDetailAccessDiagnostics(error, { jobId: '1', url: value }).url;
  assert.equal(url('no-es-una-url'), null);
  assert.equal(url(''), null);
  assert.equal(url(undefined), null);
  // about:blank no es http: el resultado es inservible pero, que es lo que
  // importa aqui, tampoco arrastra la query.
  assert.ok(!url('about:blank?token=x').includes('token'));
});

test('detailDiagnostics: conserva el diagnostico de challenge y la forma previa', () => {
  const error = new Error('challenge');
  error.name = 'SecurityChallengeError';
  error.challengeDiagnostic = { source: 'url', signal: 'url:checkpoint', at: '2026-09-19T00:16:24.254Z' };
  const d = toDetailAccessDiagnostics(error, { jobId: '7', url: JOB_URL, at: '2026-09-19T00:16:24.254Z' });
  assert.deepEqual(Object.keys(d), ['status', 'jobId', 'url', 'fetchedAt', 'error', 'challenge']);
  assert.equal(d.challenge.signal, 'url:checkpoint');
  assert.equal(d.jobId, '7');
  assert.equal(d.error, 'challenge');
});

/* ---------- AuthenticationError CON DIAGNOSTICO ---------- */

const { assertAuthenticatedSession } = require('../linkedin/session');

function authPage({ url, cookies = [], uiVisible = false }) {
  const page = {
    url: () => url,
    goto: async () => {},
    waitForLoadState: async () => {},
    // Solo el selector de UI autenticada responde que si: si respondiera a
    // todo, los selectores de DOM del detector darian un challenge falso.
    locator: (selector) => ({
      first: () => ({ isVisible: async () => uiVisible && selector.includes('/feed/') }),
      innerText: async () => '',
    }),
  };
  return { page, context: { cookies: async () => cookies } };
}

async function grab(fn) {
  try { await fn(); return null; } catch (error) { return error; }
}

test('auth: redireccion a /login trae diagnostico con la señal correcta', async () => {
  const { page, context } = authPage({ url: 'https://www.linkedin.com/login?session_redirect=%2Ffeed&trk=secreto' });
  const error = await grab(() => assertAuthenticatedSession(context, page));
  assert.equal(error.name, 'AuthenticationError');
  assert.equal(error.challengeDiagnostic.signal, S.AUTH_SIGNALS.LOGIN_REDIRECT);
  assert.equal(error.challengeDiagnostic.source, 'auth');
  assert.equal(error.challengeDiagnostic.stage, 'session_check');
  assert.equal(error.challengeDiagnostic.url, 'https://www.linkedin.com/login');
  assert.ok(!JSON.stringify(error.challengeDiagnostic).includes('secreto'));
});

test('auth: redireccion a /signup se distingue de /login', async () => {
  const { page, context } = authPage({ url: 'https://www.linkedin.com/signup/cold-join' });
  const error = await grab(() => assertAuthenticatedSession(context, page));
  assert.equal(error.challengeDiagnostic.signal, S.AUTH_SIGNALS.SIGNUP_REDIRECT);
});

test('auth: sin cookie li_at ni UI autenticada -> session_unconfirmed', async () => {
  const { page, context } = authPage({ url: 'https://www.linkedin.com/feed/', cookies: [{ name: 'bcookie' }], uiVisible: false });
  const error = await grab(() => assertAuthenticatedSession(context, page));
  assert.equal(error.name, 'AuthenticationError');
  assert.equal(error.challengeDiagnostic.signal, S.AUTH_SIGNALS.SESSION_UNCONFIRMED);
  assert.equal(error.challengeDiagnostic.url, 'https://www.linkedin.com/feed/');
});

test('auth: una sesion valida sigue sin lanzar nada', async () => {
  const { page, context } = authPage({ url: 'https://www.linkedin.com/feed/', cookies: [{ name: 'li_at' }], uiVisible: true });
  assert.equal(await grab(() => assertAuthenticatedSession(context, page)), null);
});

test('auth: un AuthenticationError del detalle llega al summary con su señal', async () => {
  const error = new Error('LinkedIn requiere autenticacion para acceder al detalle.');
  error.name = 'AuthenticationError';
  error.challengeDiagnostic = S.toAuthDiagnostic({
    signal: S.AUTH_SIGNALS.DETAIL_REQUIRED,
    url: 'https://www.linkedin.com/login?redirect=%2Fjobs%2Fview%2F1&token=NOPE',
    stage: 'detail_collection',
  });

  const summary = await runPipeline({
    jobService: fakeService(),
    discover: async () => ({ jobs: [{ jobId: '9', title: 'D', company: 'C', url: JOB_URL }], discovery: {} }),
    fetchDetails: () => Promise.reject(error),
    analyze: async () => ({ analysis: {}, model: 'm', usage: {} }),
  });

  assert.equal(summary.stoppedByChallenge, true, 'stoppedByChallenge sigue funcionando');
  assert.equal(summary.challenge.source, 'auth');
  assert.equal(summary.challenge.signal, 'auth:detail_required');
  assert.equal(summary.challenge.stage, 'detail_collection');
  assert.equal(summary.challenge.jobId, '9');
  assert.equal(summary.challenge.url, 'https://www.linkedin.com/login');
  assert.ok(!JSON.stringify(summary.challenge).includes('NOPE'), 'la query no viaja al summary');
});

test('auth: un AuthenticationError legacy no rompe y queda explicito', async () => {
  const error = new Error('login');
  error.name = 'AuthenticationError';
  const summary = await runPipeline({
    jobService: fakeService(),
    discover: async () => ({ jobs: [{ jobId: '10', title: 'E', company: 'C', url: JOB_URL }], discovery: {} }),
    fetchDetails: () => Promise.reject(error),
    analyze: async () => ({ analysis: {}, model: 'm', usage: {} }),
  });
  assert.equal(summary.stoppedByChallenge, true);
  assert.equal(summary.challenge.signal, S.AUTH_SIGNALS.UNSPECIFIED);
  assert.equal(summary.challenge.source, 'unspecified');
  assert.equal(summary.challenge.jobId, '10');
});

test('auth: una señal desconocida no se cuela como tal', () => {
  const d = S.toAuthDiagnostic({ signal: 'auth:inventada', url: JOB_URL });
  assert.equal(d.signal, S.AUTH_SIGNALS.UNSPECIFIED, 'solo se aceptan ids del catalogo');
});

test('toStopDiagnostic: respeta el stage que ya trae el error', () => {
  const error = new Error('x');
  error.name = 'SecurityChallengeError';
  error.challengeDiagnostic = { source: 'url', signal: 'url:checkpoint', stage: 'session_check', at: 'z' };
  const d = S.toStopDiagnostic(error, { stage: 'detail_collection', jobId: 5 });
  assert.equal(d.stage, 'session_check', 'no se pisa el stage original');
  assert.equal(d.jobId, '5');
});

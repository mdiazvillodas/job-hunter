'use strict';

// Fase 3: sólo dobles en memoria y HTTP loopback. Nunca abre browser, LinkedIn ni OpenAI.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createLinkedinSessionService, STATES } = require('../session/linkedinSessionService');
const { createHuntRunManager } = require('../run/huntRunManager');
const { startServer } = require('../ui/server');

let passed = 0;
let failed = 0;
function ok(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' - ' + detail : ''}`); }
}
function tick() { return new Promise((resolve) => setImmediate(resolve)); }

function fakeBrowser(fixture = {}) {
  const listeners = {};
  const page = {
    closed: false,
    url: () => fixture.url || 'https://www.linkedin.com/login',
    goto: async () => { if (fixture.gotoError) throw fixture.gotoError; },
    isClosed: () => page.closed,
    locator: (selector) => ({
      first: () => ({ isVisible: async () => {
        if (selector === 'body') return false;
        if (fixture.genericNav && selector.includes('nav[aria-label]')) return true;
        return !!fixture.authenticatedUi;
      } }),
      innerText: async () => fixture.body || '',
    }),
  };
  const context = {
    pages: () => [page],
    cookies: async () => fixture.cookies || [],
    once: (event, fn) => { listeners[event] = fn; },
    close: async () => {
      context.closed = true;
      if (fixture.closeError) throw fixture.closeError;
      if (listeners.close) listeners.close();
    },
    emitClose: () => { context.closed = true; if (listeners.close) listeners.close(); },
  };
  return { page, context };
}

function makeSession(fixture, profileDir = 'X:/safe/browser-profile', dependencies = {}) {
  const fake = fakeBrowser(fixture);
  const calls = [];
  const service = createLinkedinSessionService({
    browserProfileDir: profileDir,
    launchBrowser: async (...args) => { calls.push(args); return fake.context; },
    getInitialPage: async () => fake.page,
    acquireLock: dependencies.acquireLock || (() => {}),
    releaseLock: dependencies.releaseLock || (() => {}),
  });
  return { service, fake, calls };
}

function request(server, method, pathname) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({ hostname: '127.0.0.1', port: address.port, method, path: pathname }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('\n### LinkedIn session service');
  const auth = makeSession({ url: 'https://www.linkedin.com/feed/', authenticatedUi: true, cookies: [{ name: 'li_at', value: 'never-return-this' }] });
  const opened = await auth.service.open();
  ok('1. usa el BROWSER_PROFILE_DIR inyectado', auth.calls[0][0] === 'X:/safe/browser-profile');
  ok('2. abre mediante el launcher de persistent context', auth.calls.length === 1 && opened.windowOpen === true);
  ok('3. no pasa username/password al launcher', auth.calls[0].length === 1);
  ok('4. fixture autenticada -> AUTHENTICATED', opened.state === STATES.AUTHENTICATED);
  const publicStatusText = JSON.stringify(opened).toLowerCase();
  ok('5. status es seguro y no devuelve cookies/tokens/storage/html/url',
    Object.keys(opened).every((key) => ['state', 'message', 'windowOpen'].includes(key)) &&
    !['li_at', 'never-return-this', 'cookie', 'token', 'storage', 'html', 'linkedin.com'].some((value) => publicStatusText.includes(value)));

  const login = makeSession({ url: 'https://www.linkedin.com/login' });
  ok('6. URL login -> LOGIN_REQUIRED', (await login.service.open()).state === STATES.LOGIN_REQUIRED);
  const checkpoint = makeSession({ url: 'https://www.linkedin.com/checkpoint/challenge/' });
  ok('7. checkpoint -> CHECKPOINT_REQUIRED', (await checkpoint.service.open()).state === STATES.CHECKPOINT_REQUIRED);
  const bodyChallenge = makeSession({ url: 'https://www.linkedin.com/feed/', body: 'Security verification' });
  ok('8. challenge DOM -> CHECKPOINT_REQUIRED', (await bodyChallenge.service.open()).state === STATES.CHECKPOINT_REQUIRED);
  const challengeOverAuth = makeSession({ url: 'https://www.linkedin.com/feed/', body: 'Security verification', authenticatedUi: true });
  ok('8b. checkpoint DOM tiene prioridad sobre auth', (await challengeOverAuth.service.open()).state === STATES.CHECKPOINT_REQUIRED);
  const genericNav = makeSession({ url: 'https://www.linkedin.com/anything', genericNav: true });
  ok('8c. nav[aria-label] genérico no autentica', (await genericNav.service.open()).state === STATES.LOGIN_REQUIRED);

  let duplicateCode;
  try { await auth.service.open(); } catch (error) { duplicateCode = error.code; }
  ok('9. no admite dos ventanas manuales', duplicateCode === 'SESSION_WINDOW_OPEN');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-phase3-profile-'));
  const marker = path.join(temp, 'cookie-store.marker');
  fs.writeFileSync(marker, 'persist');
  const closeFixture = makeSession({ url: 'https://www.linkedin.com/feed/', authenticatedUi: true, cookies: [{ name: 'li_at' }] }, temp);
  await closeFixture.service.open();
  const closed = await closeFixture.service.close();
  ok('10. close cierra el context', closeFixture.fake.context.closed === true && closed.windowOpen === false);
  ok('11. close no borra browser-profile', fs.existsSync(marker));
  ok('11b. close invalida estado autenticado', closed.state === STATES.NOT_INITIALIZED);

  let manualLocks = 0;
  const manuallyClosed = makeSession(
    { url: 'https://www.linkedin.com/feed/', authenticatedUi: true },
    'X:/manual-close',
    { acquireLock: () => { manualLocks += 1; }, releaseLock: () => { manualLocks -= 1; } }
  );
  await manuallyClosed.service.open();
  manuallyClosed.fake.context.emitClose();
  const afterManualClose = await manuallyClosed.service.getStatus();
  ok('11c. context close limpia referencias y estado', afterManualClose.windowOpen === false && afterManualClose.state === STATES.NOT_INITIALIZED);
  ok('11d. context close libera lock', manualLocks === 0);

  const pageClosed = makeSession({ url: 'https://www.linkedin.com/feed/', authenticatedUi: true });
  await pageClosed.service.open();
  pageClosed.fake.page.closed = true;
  const closedPageStatus = await pageClosed.service.getStatus();
  ok('11e. page cerrada con context vivo produce ERROR', closedPageStatus.state === STATES.ERROR && closedPageStatus.windowOpen === true);

  let browserError;
  let launchLocks = 0;
  const missingBrowser = createLinkedinSessionService({
    launchBrowser: async () => { throw new Error('Executable does not exist'); },
    acquireLock: () => { launchLocks += 1; }, releaseLock: () => { launchLocks -= 1; },
  });
  try { await missingBrowser.open(); } catch (error) { browserError = error; }
  ok('12. launch failure es error controlado', browserError.code === 'LINKEDIN_BROWSER_ERROR' && browserError.statusCode === 503);
  ok('12a. launch failure libera lock', launchLocks === 0);

  let navigationLocks = 0;
  const navigationFailure = makeSession(
    { gotoError: new Error('private navigation error') },
    'X:/navigation-failure',
    { acquireLock: () => { navigationLocks += 1; }, releaseLock: () => { navigationLocks -= 1; } }
  );
  let navigationError;
  try { await navigationFailure.service.open(); } catch (error) { navigationError = error; }
  ok('12b. navigation failure intenta close', navigationFailure.fake.context.closed === true);
  ok('12c. navigation failure libera lock y sanitiza', navigationLocks === 0 && navigationError.code === 'LINKEDIN_BROWSER_ERROR');

  let cleanupLocks = 0;
  const cleanupFailure = makeSession(
    { gotoError: new Error('goto'), closeError: new Error('close') },
    'X:/cleanup-failure',
    { acquireLock: () => { cleanupLocks += 1; }, releaseLock: () => { cleanupLocks -= 1; } }
  );
  try { await cleanupFailure.service.open(); } catch (_) {}
  ok('12d. cleanup close failure igualmente libera lock', cleanupLocks === 0);

  let closeFailureLocks = 0;
  const closeFailure = makeSession(
    { url: 'https://www.linkedin.com/feed/', authenticatedUi: true, closeError: new Error('close') },
    'X:/close-failure',
    { acquireLock: () => { closeFailureLocks += 1; }, releaseLock: () => { closeFailureLocks -= 1; } }
  );
  await closeFailure.service.open();
  const closeFailureStatus = await closeFailure.service.close();
  const secondCloseStatus = await closeFailure.service.close();
  ok('12e. close error libera lock e invalida estado', closeFailureLocks === 0 && closeFailureStatus.state === STATES.NOT_INITIALIZED);
  ok('12f. close sin sesión es idempotente', secondCloseStatus.windowOpen === false && secondCloseStatus.state === STATES.NOT_INITIALIZED);

  let sharedHeld = false;
  const sharedAcquire = () => { if (sharedHeld) { const error = new Error('busy'); error.code = 'LOCK_HELD'; throw error; } sharedHeld = true; };
  const sharedRelease = () => { sharedHeld = false; };
  const sharedSession = makeSession({ url: 'https://www.linkedin.com/login' }, 'X:/shared-lock', { acquireLock: sharedAcquire, releaseLock: sharedRelease });
  await sharedSession.service.open();
  let cliEquivalentCode;
  try { sharedAcquire(); } catch (error) { cliEquivalentCode = error.code; }
  ok('12g. manual session bloquea adquisición CLI-equivalent', cliEquivalentCode === 'LOCK_HELD');
  await sharedSession.service.close();
  let acquiredAfterClose = false;
  try { sharedAcquire(); acquiredAfterClose = true; } finally { sharedRelease(); }
  ok('12h. lock compartido puede adquirirse después de close', acquiredAfterClose);

  const externallyLocked = createLinkedinSessionService({ acquireLock: () => { const error = new Error('busy'); error.code = 'LOCK_HELD'; throw error; }, releaseLock: () => {} });
  let externalLockCode;
  try { await externallyLocked.open(); } catch (error) { externalLockCode = error.code; }
  ok('12b. ventana manual respeta lock de otro hunt', externalLockCode === 'HUNT_ALREADY_RUNNING');

  console.log('\n### Hunt run manager');
  const setupReady = { getStatus: () => ({ readyForHunt: true }) };
  const sessionReady = { isOpen: () => false, getStatus: async () => ({ state: STATES.AUTHENTICATED }) };
  let resolveRun;
  const pending = new Promise((resolve) => { resolveRun = resolve; });
  let locks = 0;
  const manager = createHuntRunManager({
    setupService: setupReady, sessionService: sessionReady, huntRunner: () => pending,
    acquireLock: () => { locks += 1; }, releaseLock: () => { locks -= 1; }, makeRunId: () => 'run_phase3',
  });
  const started = await manager.start();
  ok('13. start devuelve rápido un runId', started.runId === 'run_phase3' && started.status === 'STARTING');
  await tick();
  ok('14. transición real a RUNNING', manager.getStatus().status === 'RUNNING');
  ok('15. mantiene hunt lock durante ejecución', locks === 1);
  let concurrent;
  try { await manager.start(); } catch (error) { concurrent = error.code; }
  ok('16. sólo una ejecución simultánea', concurrent === 'HUNT_ALREADY_RUNNING');
  resolveRun({ runId: 'engine_run', discovery: { uniqueResults: 8, newJobs: 3 }, analysis: { analyzed: 2 }, persistence: { created: 3 } });
  await tick(); await tick();
  const completed = manager.getStatus();
  ok('17. transición a COMPLETED', completed.status === 'COMPLETED' && !!completed.finishedAt);
  ok('18. conserva resumen real', completed.summary.discovery.uniqueResults === 8 && completed.summary.analysis.analyzed === 2);
  ok('19. libera lock al completar', locks === 0);

  let statusResolvers = [];
  let raceLocked = false;
  let raceRunnerCalls = 0;
  let finishRace;
  const raceRun = new Promise((resolve) => { finishRace = resolve; });
  const racingManager = createHuntRunManager({
    setupService: setupReady,
    sessionService: {
      isOpen: () => false,
      getStatus: () => new Promise((resolve) => { statusResolvers.push(resolve); }),
    },
    acquireLock: () => { if (raceLocked) { const error = new Error('busy'); error.code = 'LOCK_HELD'; throw error; } raceLocked = true; },
    releaseLock: () => { raceLocked = false; },
    huntRunner: () => { raceRunnerCalls += 1; return raceRun; },
  });
  const raceOne = racingManager.start();
  const raceTwo = racingManager.start();
  await tick();
  statusResolvers.forEach((resolve) => resolve({ state: STATES.AUTHENTICATED }));
  const raceResults = await Promise.allSettled([raceOne, raceTwo]);
  await tick();
  ok('19a. starts simultáneos: exactamente uno inicia', raceResults.filter((item) => item.status === 'fulfilled').length === 1);
  ok('19b. starts simultáneos: el otro recibe HUNT_ALREADY_RUNNING', raceResults.filter((item) => item.status === 'rejected' && item.reason.code === 'HUNT_ALREADY_RUNNING').length === 1);
  ok('19c. starts simultáneos ejecutan runner una sola vez', raceRunnerCalls === 1);
  finishRace({});
  await tick(); await tick();

  const manual = createHuntRunManager({ setupService: setupReady, sessionService: { isOpen: () => true }, huntRunner: async () => {}, acquireLock: () => {} });
  let manualCode;
  try { await manual.start(); } catch (error) { manualCode = error.code; }
  ok('20. hunt bloqueado con ventana manual', manualCode === 'SESSION_WINDOW_OPEN');
  const incomplete = createHuntRunManager({ setupService: { getStatus: () => ({ readyForHunt: false }) }, sessionService: sessionReady, huntRunner: async () => {}, acquireLock: () => {} });
  let setupCode;
  try { await incomplete.start(); } catch (error) { setupCode = error.code; }
  ok('21. hunt requiere readyForHunt', setupCode === 'SETUP_REQUIRED');
  const noLogin = createHuntRunManager({ setupService: setupReady, sessionService: { isOpen: () => false, getStatus: async () => ({ state: STATES.LOGIN_REQUIRED }) }, huntRunner: async () => {}, acquireLock: () => {} });
  let loginCode;
  try { await noLogin.start(); } catch (error) { loginCode = error.code; }
  ok('22. hunt requiere sesión autenticada', loginCode === 'LOGIN_REQUIRED');

  const failedManager = createHuntRunManager({ setupService: setupReady, sessionService: sessionReady, huntRunner: async () => { const e = new Error('private stack and URL'); e.secret = 'token'; throw e; }, acquireLock: () => {}, releaseLock: () => {}, makeRunId: () => 'run_failed' });
  await failedManager.start(); await tick(); await tick();
  const failedRun = failedManager.getStatus();
  ok('23. transición a FAILED', failedRun.status === 'FAILED');
  ok('24. error sanitizado', failedRun.error.code === 'HUNT_FAILED' && !JSON.stringify(failedRun).includes('private stack'));

  async function verifyRunnerFailure(name, runner) {
    let held = 0;
    const failureManager = createHuntRunManager({
      setupService: setupReady, sessionService: sessionReady, huntRunner: runner,
      acquireLock: () => { held += 1; }, releaseLock: () => { held -= 1; },
    });
    await failureManager.start(); await tick(); await tick();
    const result = failureManager.getStatus();
    ok(`${name} queda FAILED y finalizado`, result.status === 'FAILED' && !!result.finishedAt);
    ok(`${name} libera lock y sanitiza`, held === 0 && result.error.code === 'HUNT_FAILED');
  }
  await verifyRunnerFailure('24a. sync throw', () => { throw new Error('sync secret'); });
  await verifyRunnerFailure('24b. async rejection', () => Promise.reject(new Error('async secret')));

  let sequence = 0;
  const restartAfterComplete = createHuntRunManager({ setupService: setupReady, sessionService: sessionReady, huntRunner: async () => ({ runId: `engine_${++sequence}` }), acquireLock: () => {}, releaseLock: () => {}, makeRunId: () => `run_${sequence + 1}` });
  const firstCompleted = await restartAfterComplete.start(); await tick(); await tick();
  const secondCompleted = await restartAfterComplete.start(); await tick(); await tick();
  ok('24c. segundo hunt inicia después de COMPLETED', firstCompleted.runId !== secondCompleted.runId && restartAfterComplete.getStatus().status === 'COMPLETED');
  ok('24d. sólo conserva el último run', restartAfterComplete.getStatus().runId === secondCompleted.runId);

  let failThenSucceed = true;
  const restartAfterFailure = createHuntRunManager({ setupService: setupReady, sessionService: sessionReady, huntRunner: () => { if (failThenSucceed) { failThenSucceed = false; throw new Error('first'); } return {}; }, acquireLock: () => {}, releaseLock: () => {} });
  await restartAfterFailure.start(); await tick(); await tick();
  const afterFailureStart = await restartAfterFailure.start(); await tick(); await tick();
  ok('24e. segundo hunt inicia después de FAILED', !!afterFailureStart.runId && restartAfterFailure.getStatus().status === 'COMPLETED');

  console.log('\n### HTTP y frontend');
  const endpointSession = { open: async () => ({ state: 'LOGIN_REQUIRED', message: 'manual', windowOpen: true }), getStatus: async () => ({ state: 'AUTHENTICATED', message: 'ok', windowOpen: false }), close: async () => ({ state: 'AUTHENTICATED', message: 'ok', windowOpen: false }) };
  const endpointRuns = { start: async () => ({ runId: 'run_http', status: 'STARTING' }), getStatus: () => ({ runId: 'run_http', status: 'RUNNING', error: null }) };
  const server = startServer({ port: 0, jobService: {}, setupService: {}, linkedinSessionService: endpointSession, huntRunManager: endpointRuns });
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const openResponse = await request(server, 'POST', '/api/linkedin/session/open');
  const statusResponse = await request(server, 'GET', '/api/linkedin/session/status');
  const huntResponse = await request(server, 'POST', '/api/hunt');
  const huntStatus = await request(server, 'GET', '/api/hunt/status');
  await new Promise((resolve) => server.close(resolve));
  ok('25. endpoint open responde sin esperar login', openResponse.status === 202 && openResponse.json.state === 'LOGIN_REQUIRED');
  ok('26. session status sólo expone estado operativo', statusResponse.status === 200 && Object.keys(statusResponse.json).every((key) => ['state', 'message', 'windowOpen'].includes(key)));
  ok('27. POST hunt responde 202 con runId', huntResponse.status === 202 && huntResponse.json.runId === 'run_http');
  ok('28. status hunt es asíncrono y seguro', huntStatus.status === 200 && huntStatus.json.status === 'RUNNING');

  const frontend = fs.readFileSync(path.join(__dirname, '../ui/public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../ui/public/index.html'), 'utf8');
  ok('29. polling usa ~2 segundos', /setInterval\([\s\S]*?,\s*2000\)/.test(frontend));
  ok('30. polling se detiene en COMPLETED y FAILED', frontend.includes("status === 'COMPLETED' || state.hunt.status === 'FAILED'") && frontend.includes('clearInterval(huntPollTimer)'));
  ok('31. setup incompleto ofrece /setup', html.includes('id="completeSetupLink"') && html.includes('href="/setup"'));

  console.log('\n### Reutilización y aislamiento');
  const node = process.execPath;
  const imported = spawnSync(node, ['-e', "require('./src/hunt'); process.stdout.write('import-safe')"], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' });
  ok('32. importar hunt no lo ejecuta', imported.status === 0 && imported.stdout === 'import-safe');
  const huntSource = fs.readFileSync(path.join(__dirname, '../hunt.js'), 'utf8');
  ok('33. CLI main sigue exportado y protegido', huntSource.includes('if (require.main === module) runCli()') && typeof require('../hunt').main === 'function');
  const reusableSource = huntSource.slice(huntSource.indexOf('async function runHunt'), huntSource.indexOf('function runCli'));
  ok('34. runHunt reutilizable no usa process.exit', typeof require('../hunt').runHunt === 'function' && !/process\.exit(?:Code)?/.test(reusableSource));
  const previousExitCode = process.exitCode;
  const previousConsoleError = console.error;
  let fatalOutput = '';
  console.error = (message) => { fatalOutput += String(message); };
  process.exitCode = undefined;
  await require('../hunt').runCli(() => { throw new Error('sensitive fatal detail'); });
  console.error = previousConsoleError;
  const fatalExitCode = process.exitCode;
  process.exitCode = previousExitCode;
  ok('34a. top-level CLI captura rejection y fija exitCode', fatalExitCode === 1);
  ok('34b. top-level CLI sanitiza error extraordinario', fatalOutput.includes('Error fatal inesperado') && !fatalOutput.includes('sensitive fatal detail'));
  ok('35. tests usan launcher mock, no browser/LinkedIn/OpenAI real', auth.calls.length === 1 && !frontend.includes('WebSocket'));

  console.log(`\nPhase 3: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run().catch((error) => { console.error(error); process.exitCode = 1; });

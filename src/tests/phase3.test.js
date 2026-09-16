'use strict';

// Fase 3: sólo dobles en memoria y HTTP loopback. Nunca abre browser, LinkedIn ni OpenAI.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createLinkedinSessionService, STATES } = require('../session/linkedinSessionService');
const { createHuntRunManager } = require('../run/huntRunManager');
const {
  getLocationInput,
  getKeywordInput,
  applyLocationFilter,
  applyModalFilters,
  getAllFiltersButton,
  getShowResultsButton,
  LOCATION_INPUT_SELECTORS,
  KEYWORD_INPUT_SELECTORS,
  ALL_FILTERS_BUTTON_SELECTORS,
  SHOW_RESULTS_BUTTON_SELECTORS,
} = require('../linkedin/searchScope');
const { startServer } = require('../ui/server');
const { acquireLock: acquireFilesystemLock, releaseLock: releaseFilesystemLock } = require('../domain/huntLock');

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
      if (fixture.closePromise) await fixture.closePromise;
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

function makeSequencedSession(fixtures, profileDir = 'X:/safe/browser-profile', dependencies = {}) {
  const fakes = [];
  const calls = [];
  const service = createLinkedinSessionService({
    browserProfileDir: profileDir,
    launchBrowser: async (...args) => {
      const fake = fakeBrowser(fixtures[fakes.length] || {});
      fakes.push(fake);
      calls.push(args);
      return fake.context;
    },
    getInitialPage: async (context) => fakes.find((fake) => fake.context === context).page,
    acquireLock: dependencies.acquireLock || (() => {}),
    releaseLock: dependencies.releaseLock || (() => {}),
  });
  return { service, fakes, calls };
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
  const closedAgain = await closeFixture.service.close();
  ok('11b2. close sin sesión es idempotente', closedAgain.windowOpen === false && closedAgain.state === STATES.NOT_INITIALIZED);

  let resolvePendingClose;
  const pendingCloseGate = new Promise((resolve) => { resolvePendingClose = resolve; });
  let pendingCloseLocks = 0;
  const pendingManualClose = makeSequencedSession(
    [
      { url: 'https://www.linkedin.com/feed/', authenticatedUi: true, closePromise: pendingCloseGate },
      { url: 'https://www.linkedin.com/feed/', authenticatedUi: true },
    ],
    'X:/pending-manual-close',
    { acquireLock: () => { pendingCloseLocks += 1; }, releaseLock: () => { pendingCloseLocks -= 1; } }
  );
  await pendingManualClose.service.open();
  const pendingClose = pendingManualClose.service.close();
  await tick();
  ok('11b3. close pendiente mantiene context y lock', pendingManualClose.service.isOpen() && pendingCloseLocks === 1);
  let verifyDuringCloseCode;
  try { await pendingManualClose.service.verifyPersistedSession(); } catch (error) { verifyDuringCloseCode = error.code; }
  ok('11b4. close pendiente bloquea verificación concurrente', verifyDuringCloseCode === 'SESSION_WINDOW_OPEN' && pendingManualClose.calls.length === 1);
  const huntDuringClose = createHuntRunManager({ setupService: { getStatus: () => ({ readyForHunt: true }) }, sessionService: pendingManualClose.service, huntRunner: async () => {}, acquireLock: () => {} });
  let huntDuringCloseCode;
  try { await huntDuringClose.start(); } catch (error) { huntDuringCloseCode = error.code; }
  ok('11b5. close pendiente bloquea hunt', huntDuringCloseCode === 'SESSION_WINDOW_OPEN');
  resolvePendingClose();
  const afterPendingClose = await pendingClose;
  ok('11b6. close exitoso limpia context y libera lock al final', !pendingManualClose.service.isOpen() && pendingCloseLocks === 0 && afterPendingClose.state === STATES.NOT_INITIALIZED);
  const afterCloseProbe = await pendingManualClose.service.verifyPersistedSession();
  ok('11b7. verificación puede proceder después del close', afterCloseProbe.state === STATES.AUTHENTICATED && pendingManualClose.calls.length === 2);

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
  let manualCloseError;
  try { await closeFailure.service.close(); } catch (error) { manualCloseError = error; }
  const closeFailureStatus = await closeFailure.service.getStatus();
  ok('12e. close manual fallido rechaza con error controlado', manualCloseError && manualCloseError.code === 'LINKEDIN_BROWSER_ERROR');
  ok('12f. close manual fallido conserva context, estado seguro y lock', closeFailureLocks === 1 && closeFailureStatus.windowOpen === true && closeFailureStatus.state === STATES.ERROR);
  let verifyAfterFailedCloseCode;
  try { await closeFailure.service.verifyPersistedSession(); } catch (error) { verifyAfterFailedCloseCode = error.code; }
  ok('12f2. close manual fallido no habilita otro context', verifyAfterFailedCloseCode === 'SESSION_WINDOW_OPEN');
  let failedManualCloseRunnerCalls = 0;
  const huntAfterFailedManualClose = createHuntRunManager({
    setupService: { getStatus: () => ({ readyForHunt: true }) }, sessionService: closeFailure.service,
    huntRunner: async () => { failedManualCloseRunnerCalls += 1; }, acquireLock: () => {},
  });
  let huntAfterFailedCloseCode;
  try { await huntAfterFailedManualClose.start(); } catch (error) { huntAfterFailedCloseCode = error.code; }
  ok('12f3. close manual fallido impide hunt', huntAfterFailedCloseCode === 'SESSION_WINDOW_OPEN' && failedManualCloseRunnerCalls === 0);

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

  const persistedLogin = makeSequencedSession([{ url: 'https://www.linkedin.com/login' }, { url: 'https://www.linkedin.com/login' }]);
  const persistedLoginStatus = await persistedLogin.service.verifyPersistedSession();
  ok('12i. perfil sin login persistido -> LOGIN_REQUIRED', persistedLoginStatus.state === STATES.LOGIN_REQUIRED);
  ok('12j. probe sin login siempre cierra su context', persistedLogin.fakes[0].context.closed === true);

  const persistedCheckpoint = makeSequencedSession([{ url: 'https://www.linkedin.com/checkpoint/challenge/' }, { url: 'https://www.linkedin.com/checkpoint/challenge/' }]);
  const persistedCheckpointStatus = await persistedCheckpoint.service.verifyPersistedSession();
  ok('12k. checkpoint persistido -> CHECKPOINT_REQUIRED', persistedCheckpointStatus.state === STATES.CHECKPOINT_REQUIRED);
  ok('12l. probe de checkpoint siempre cierra su context', persistedCheckpoint.fakes[0].context.closed === true);

  let probeCloseLockHeld = false;
  let probeCloseReleases = 0;
  const acquireProbeCloseLock = () => {
    if (probeCloseLockHeld) { const error = new Error('busy'); error.code = 'LOCK_HELD'; throw error; }
    probeCloseLockHeld = true;
  };
  const releaseProbeCloseLock = () => { probeCloseLockHeld = false; probeCloseReleases += 1; };
  const probeCloseFailure = makeSequencedSession(
    [{ url: 'https://www.linkedin.com/feed/', authenticatedUi: true, closeError: new Error('private close failure') }],
    'X:/probe-close-failure',
    { acquireLock: acquireProbeCloseLock, releaseLock: releaseProbeCloseLock }
  );
  let probeCloseError;
  try { await probeCloseFailure.service.verifyPersistedSession(); } catch (error) { probeCloseError = error; }
  ok('12m. close fallido del probe rechaza verificación autenticada', probeCloseError && probeCloseError.code === 'LINKEDIN_BROWSER_ERROR');
  ok('12n. close fallido del probe retiene lock compartido', probeCloseLockHeld && probeCloseReleases === 0);
  ok('12o. close fallido no conserva AUTHENTICATED', (await probeCloseFailure.service.getStatus()).state === STATES.ERROR);
  let secondProbeCode;
  try { await probeCloseFailure.service.verifyPersistedSession(); } catch (error) { secondProbeCode = error.code; }
  let openAfterProbeFailureCode;
  try { await probeCloseFailure.service.open(); } catch (error) { openAfterProbeFailureCode = error.code; }
  ok('12p. probe fallido bloquea verificaciones posteriores sin abrir context', secondProbeCode === 'LINKEDIN_BROWSER_ERROR' && probeCloseFailure.calls.length === 1);
  ok('12q. probe fallido bloquea apertura manual sin abrir context', openAfterProbeFailureCode === 'LINKEDIN_BROWSER_ERROR' && probeCloseFailure.calls.length === 1);

  const independentAfterProbeFailure = makeSequencedSession(
    [{ url: 'https://www.linkedin.com/feed/', authenticatedUi: true }],
    'X:/probe-close-failure',
    { acquireLock: acquireProbeCloseLock, releaseLock: releaseProbeCloseLock }
  );
  let independentProbeCode;
  try { await independentAfterProbeFailure.service.verifyPersistedSession(); } catch (error) { independentProbeCode = error.code; }
  ok('12r. otra instancia no puede adquirir el perfil inseguro', independentProbeCode === 'HUNT_ALREADY_RUNNING' && independentAfterProbeFailure.calls.length === 0);

  const staleLockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-phase3-stale-lock-'));
  const staleLockPath = path.join(staleLockDir, 'hunt.lock');
  fs.writeFileSync(staleLockPath, JSON.stringify({ pid: 999999998, startedAt: new Date(0).toISOString(), hostname: 'stale-test' }));
  let staleRecovered = false;
  try { acquireFilesystemLock(staleLockPath); staleRecovered = true; } finally { releaseFilesystemLock(staleLockPath); }
  ok('12s. restart recupera lock retenido cuando el PID murió', staleRecovered && !fs.existsSync(staleLockPath));

  let combinedFailureAcquires = 0;
  let combinedFailureReleases = 0;
  const combinedProbeFailure = makeSequencedSession(
    [{ gotoError: new Error('private navigation failure'), closeError: new Error('private close failure') }],
    'X:/combined-probe-failure',
    { acquireLock: () => { combinedFailureAcquires += 1; }, releaseLock: () => { combinedFailureReleases += 1; } }
  );
  let combinedPrimaryCode;
  try { await combinedProbeFailure.service.verifyPersistedSession(); } catch (error) { combinedPrimaryCode = error.code; }
  let combinedRetryCode;
  try { await combinedProbeFailure.service.open(); } catch (error) { combinedRetryCode = error.code; }
  ok('12t. error primario se conserva si también falla cleanup', combinedPrimaryCode === 'LINKEDIN_BROWSER_ERROR');
  ok('12u. cleanup fallido combinado marca unsafe y retiene lock', combinedRetryCode === 'LINKEDIN_BROWSER_ERROR' && combinedFailureAcquires === 1 && combinedFailureReleases === 0 && combinedProbeFailure.calls.length === 1);

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

  const persistedAuth = makeSequencedSession([
    { url: 'https://www.linkedin.com/feed/', authenticatedUi: true },
    { url: 'https://www.linkedin.com/feed/', authenticatedUi: true },
  ], 'X:/persisted-auth');
  await persistedAuth.service.open();
  await persistedAuth.service.close();
  let runnerSawClosedProbe = false;
  const persistedManager = createHuntRunManager({
    setupService: setupReady,
    sessionService: persistedAuth.service,
    huntRunner: async () => { runnerSawClosedProbe = persistedAuth.fakes[1].context.closed === true; return {}; },
    acquireLock: () => {}, releaseLock: () => {}, makeRunId: () => 'run_persisted',
  });
  const persistedStart = await persistedManager.start();
  await tick(); await tick();
  ok('22a. manual autenticada -> close -> verificación persistida permite hunt', persistedStart.runId === 'run_persisted');
  ok('22b. context de verificación cierra antes del collector', runnerSawClosedProbe);

  const rejectedLoginManager = createHuntRunManager({
    setupService: setupReady, sessionService: persistedLogin.service,
    huntRunner: async () => {}, acquireLock: () => {}, releaseLock: () => {},
  });
  let persistedLoginCode;
  try { await rejectedLoginManager.start(); } catch (error) { persistedLoginCode = error.code; }
  ok('22c. perfil persistido sin login rechaza hunt', persistedLoginCode === 'LOGIN_REQUIRED');

  const rejectedCheckpointManager = createHuntRunManager({
    setupService: setupReady, sessionService: persistedCheckpoint.service,
    huntRunner: async () => {}, acquireLock: () => {}, releaseLock: () => {},
  });
  let persistedCheckpointCode;
  try { await rejectedCheckpointManager.start(); } catch (error) { persistedCheckpointCode = error.code; }
  ok('22d. checkpoint persistido se propaga al hunt', persistedCheckpointCode === 'CHECKPOINT_REQUIRED');

  let closeFailureRunnerCalls = 0;
  let huntProbeLocks = 0;
  const huntProbeCloseFailure = makeSequencedSession(
    [{ url: 'https://www.linkedin.com/feed/', authenticatedUi: true, closeError: new Error('private close failure') }],
    'X:/hunt-probe-close-failure',
    { acquireLock: () => { huntProbeLocks += 1; }, releaseLock: () => { huntProbeLocks -= 1; } }
  );
  const closeFailureManager = createHuntRunManager({
    setupService: setupReady, sessionService: huntProbeCloseFailure.service,
    huntRunner: async () => { closeFailureRunnerCalls += 1; }, acquireLock: () => {}, releaseLock: () => {},
  });
  let huntProbeCloseCode;
  try { await closeFailureManager.start(); } catch (error) { huntProbeCloseCode = error.code; }
  ok('22e. close fallido del probe impide iniciar hunt', huntProbeCloseCode === 'LINKEDIN_BROWSER_ERROR' && closeFailureRunnerCalls === 0);
  ok('22f. close fallido previo al hunt retiene lock de sesión', huntProbeLocks === 1);
  let poisonedRunnerCalls = 0;
  const poisonedManager = createHuntRunManager({
    setupService: setupReady, sessionService: huntProbeCloseFailure.service,
    huntRunner: async () => { poisonedRunnerCalls += 1; }, acquireLock: () => {}, releaseLock: () => {},
  });
  let poisonedHuntCode;
  try { await poisonedManager.start(); } catch (error) { poisonedHuntCode = error.code; }
  ok('22g. estado inseguro persistente bloquea hunts posteriores', poisonedHuntCode === 'LINKEDIN_BROWSER_ERROR' && poisonedRunnerCalls === 0 && huntProbeCloseFailure.calls.length === 1);

  let successfulProbeLocks = 0;
  const successfulProbe = makeSequencedSession(
    [{ url: 'https://www.linkedin.com/feed/', authenticatedUi: true }],
    'X:/successful-probe',
    { acquireLock: () => { successfulProbeLocks += 1; }, releaseLock: () => { successfulProbeLocks -= 1; } }
  );
  let successfulProbeRunnerCalls = 0;
  const successfulProbeManager = createHuntRunManager({
    setupService: setupReady, sessionService: successfulProbe.service,
    huntRunner: async () => { successfulProbeRunnerCalls += 1; return {}; },
    acquireLock: () => {}, releaseLock: () => {}, makeRunId: () => 'run_successful_probe',
  });
  await successfulProbeManager.start();
  await tick(); await tick();
  ok('22h. probe exitoso libera lock y permite collector', successfulProbeLocks === 0 && successfulProbeRunnerCalls === 1);

  const failedManager = createHuntRunManager({ setupService: setupReady, sessionService: sessionReady, huntRunner: async () => { const e = new Error('private stack and URL'); e.secret = 'token'; throw e; }, acquireLock: () => {}, releaseLock: () => {}, makeRunId: () => 'run_failed' });
  const previousDiagnosticError = console.error;
  let diagnosticOutput = '';
  console.error = (message) => { diagnosticOutput += String(message); };
  await failedManager.start(); await tick(); await tick();
  console.error = previousDiagnosticError;
  const failedRun = failedManager.getStatus();
  ok('23. transición a FAILED', failedRun.status === 'FAILED');
  ok('24. error sanitizado', failedRun.error.code === 'HUNT_FAILED' && !JSON.stringify(failedRun).includes('private stack'));
  ok('24a. diagnóstico conserva etapa y excepción sólo en el log local', diagnosticOutput.includes('collector_launch') && diagnosticOutput.includes('Error') && diagnosticOutput.includes('private stack and URL') && !JSON.stringify(failedRun).includes('diagnostic'));

  let redactedOutput = '';
  console.error = (message) => { redactedOutput += String(message); };
  const redactedManager = createHuntRunManager({
    setupService: setupReady, sessionService: sessionReady,
    huntRunner: async ({ reportStage }) => {
      reportStage('discovery');
      throw new Error('GET https://www.linkedin.com/jobs/search/?keywords=secret li_at=session-secret Authorization: Bearer bearer-secret OPENAI_API_KEY=sk-private123 prompt=private candidate source');
    },
    acquireLock: () => {}, releaseLock: () => {}, makeRunId: () => 'run_redacted',
  });
  await redactedManager.start(); await redactedManager.waitForIdle();
  console.error = previousDiagnosticError;
  const redactedRun = redactedManager.getStatus();
  ok('24b. diagnóstico registra la etapa reportada', redactedOutput.includes('"stage":"discovery"'));
  ok('24c. diagnóstico redacta URL, query, prompt y secretos', redactedOutput.includes('[REDACTED_URL]') && redactedOutput.includes('[REDACTED]') && redactedOutput.includes('[REDACTED_API_KEY]') && !/keywords=secret|session-secret|bearer-secret|sk-private123|private candidate source/.test(redactedOutput));
  ok('24d. error visible sigue siendo HUNT_FAILED genérico', redactedRun.error.code === 'HUNT_FAILED' && !JSON.stringify(redactedRun).includes('linkedin.com'));

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
  await verifyRunnerFailure('24e. sync throw', () => { throw new Error('sync secret'); });
  await verifyRunnerFailure('24f. async rejection', () => Promise.reject(new Error('async secret')));

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

  let cancelLocks = 0; let cancelSignal;
  const cancellableManager = createHuntRunManager({
    setupService: setupReady, sessionService: sessionReady,
    acquireLock: () => { cancelLocks += 1; }, releaseLock: () => { cancelLocks -= 1; },
    huntRunner: ({ signal, reportProgress }) => new Promise((resolve, reject) => {
      cancelSignal = signal;
      reportProgress({ phase: 'analysis', analysisCompleted: 1, analysisTarget: 20, currentQueryLabel: 'Operations', generatedUrl: 'https://secret.invalid' });
      signal.addEventListener('abort', () => { const error = new Error('cancel'); error.name = 'AbortError'; reject(error); }, { once: true });
    }),
  });
  await cancellableManager.start(); await tick();
  const cancelOne = cancellableManager.cancel();
  const cancelTwo = cancellableManager.cancel();
  await cancellableManager.waitForIdle();
  const cancelledRun = cancellableManager.getStatus();
  ok('24f. cancel is idempotent', cancelOne.progress.cancellationRequested && cancelTwo.progress.cancellationRequested && cancelSignal.aborted);
  ok('24g. cancel ends CANCELLED, not FAILED', cancelledRun.status === 'CANCELLED' && cancelledRun.error === null);
  ok('24h. cancel releases lock', cancelLocks === 0);
  ok('24i. public progress is safely whitelisted', cancelledRun.progress.analysisCompleted === 1 && !('generatedUrl' in cancelledRun.progress) && !JSON.stringify(cancelledRun.progress).includes('secret.invalid'));

  console.log('\n### HTTP y frontend');
  const endpointSession = { open: async () => ({ state: 'LOGIN_REQUIRED', message: 'manual', windowOpen: true }), getStatus: async () => ({ state: 'AUTHENTICATED', message: 'ok', windowOpen: false }), verifyPersistedSession: async () => ({ state: 'AUTHENTICATED', message: 'ok', windowOpen: false }), close: async () => ({ state: 'NOT_INITIALIZED', message: 'closed', windowOpen: false }) };
  const endpointRuns = { start: async () => ({ runId: 'run_http', status: 'STARTING' }), cancel: () => ({ runId: 'run_http', status: 'RUNNING', progress: { cancellationRequested: true } }), waitForRun: async () => ({ runId: 'run_http', status: 'COMPLETED' }), getStatus: () => ({ runId: 'run_http', status: 'RUNNING', error: null }) };
  const server = startServer({ port: 0, jobService: {}, setupService: {}, linkedinSessionService: endpointSession, huntRunManager: endpointRuns });
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const openResponse = await request(server, 'POST', '/api/linkedin/session/open');
  const statusResponse = await request(server, 'GET', '/api/linkedin/session/status');
  const verifyResponse = await request(server, 'POST', '/api/linkedin/session/verify-persisted');
  const closeResponse = await request(server, 'POST', '/api/linkedin/session/close');
  const huntResponse = await request(server, 'POST', '/api/hunt');
  const huntStatus = await request(server, 'GET', '/api/hunt/status');
  const huntCancel = await request(server, 'POST', '/api/hunt/cancel');
  await new Promise((resolve) => server.close(resolve));
  ok('25. endpoint open responde sin esperar login', openResponse.status === 202 && openResponse.json.state === 'LOGIN_REQUIRED');
  ok('26. session status sólo expone estado operativo', statusResponse.status === 200 && Object.keys(statusResponse.json).every((key) => ['state', 'message', 'windowOpen'].includes(key)));
  ok('27. POST hunt responde 202 con runId', huntResponse.status === 202 && huntResponse.json.runId === 'run_http');
  ok('28. status hunt es asíncrono y seguro', huntStatus.status === 200 && huntStatus.json.status === 'RUNNING');
  ok('28a. endpoint verify-persisted devuelve estado verificado', verifyResponse.status === 200 && verifyResponse.json.state === 'AUTHENTICATED');
  ok('28b. endpoint close verifica el perfil después de cerrar', closeResponse.status === 200 && closeResponse.json.state === 'AUTHENTICATED' && closeResponse.json.windowOpen === false);

  ok('28c. cancel endpoint is asynchronous and idempotent', huntCancel.status === 202 && huntCancel.json.progress.cancellationRequested === true);

  const frontend = fs.readFileSync(path.join(__dirname, '../ui/public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../ui/public/index.html'), 'utf8');
  ok('29. polling usa ~2 segundos', /setInterval\([\s\S]*?,\s*2000\)/.test(frontend));
  ok('30. polling se detiene en estados terminales', frontend.includes("status === 'COMPLETED' || state.hunt.status === 'CANCELLED' || state.hunt.status === 'FAILED'") && frontend.includes('clearInterval(huntPollTimer)'));
  ok('31. setup incompleto ofrece /setup', html.includes('id="completeSetupLink"') && html.includes('href="/setup"'));

  ok('31a. UI offers hunt cancellation', html.includes('id="huntCancelBtn"') && frontend.includes("'/api/hunt/cancel'"));

  console.log('\n### LinkedIn search inputs');
  function selectorPage(visibleSelector) {
    const actions = [];
    const page = {
      actions,
      locator: (selector) => {
        const candidate = {
          selector,
          first: () => candidate,
          filter: () => candidate,
          waitFor: async () => {
            if (!selector.includes(visibleSelector)) throw new Error('not visible');
          },
          isVisible: async () => selector === visibleSelector,
          count: async () => 0,
          innerText: async () => '',
          click: async () => { actions.push(['click']); },
          fill: async (value) => { actions.push(['fill', value]); },
          type: async (value, options) => { actions.push(['type', value, options]); },
          press: async (key) => { actions.push(['press', key]); },
        };
        return candidate;
      },
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      url: () => 'https://www.linkedin.com/jobs/search/',
    };
    return page;
  }
  const preferredLocation = await getLocationInput(selectorPage(LOCATION_INPUT_SELECTORS[0]));
  const semanticLocation = await getLocationInput(selectorPage(LOCATION_INPUT_SELECTORS[1]));
  const englishLocation = await getLocationInput(selectorPage(LOCATION_INPUT_SELECTORS[2]));
  const spanishLocation = await getLocationInput(selectorPage(LOCATION_INPUT_SELECTORS[3]));
  const preferredKeyword = await getKeywordInput(selectorPage(KEYWORD_INPUT_SELECTORS[0]));
  const spanishKeyword = await getKeywordInput(selectorPage(KEYWORD_INPUT_SELECTORS[3]));
  ok('31a. location prefiere id estructural independiente del locale', preferredLocation.selector === LOCATION_INPUT_SELECTORS[0]);
  ok('31b. location acepta atributo semántico independiente del locale', semanticLocation.selector === LOCATION_INPUT_SELECTORS[1]);
  ok('31c. location conserva fallback de DOM inglés', englishLocation.selector === LOCATION_INPUT_SELECTORS[2]);
  ok('31d. location acepta el DOM español observado', spanishLocation.selector === LOCATION_INPUT_SELECTORS[3]);
  ok('31e. keyword prefiere id estructural y acepta fallback español', preferredKeyword.selector === KEYWORD_INPUT_SELECTORS[0] && spanishKeyword.selector === KEYWORD_INPUT_SELECTORS[3]);
  const filterPage = selectorPage(LOCATION_INPUT_SELECTORS[3]);
  await applyLocationFilter(filterPage, 'España', {});
  ok('31f. filtro conserva limpieza, valor y Enter cuando no hay sugerencia', JSON.stringify(filterPage.actions) === JSON.stringify([['click'], ['fill', ''], ['type', 'España', { delay: 60 }], ['press', 'Enter']]));
  let missingSelectorError;
  try { await getLocationInput(selectorPage('not-present')); } catch (error) { missingSelectorError = error; }
  ok('31g. input ausente produce error claro y estable', missingSelectorError && missingSelectorError.name === 'LinkedInSelectorError' && missingSelectorError.message === 'LinkedIn search location input was not found.');

  const preferredAllFilters = await getAllFiltersButton(selectorPage(ALL_FILTERS_BUTTON_SELECTORS[0]));
  const englishAllFilters = await getAllFiltersButton(selectorPage(ALL_FILTERS_BUTTON_SELECTORS[1]));
  const spanishAllFilters = await getAllFiltersButton(selectorPage(ALL_FILTERS_BUTTON_SELECTORS[2]));
  const preferredShowResults = await getShowResultsButton(selectorPage(SHOW_RESULTS_BUTTON_SELECTORS[0]));
  const spanishShowResults = await getShowResultsButton(selectorPage(SHOW_RESULTS_BUTTON_SELECTORS[2]));
  ok('31h. modal prefiere clases estructurales independientes del locale', preferredAllFilters.selector === ALL_FILTERS_BUTTON_SELECTORS[0] && preferredShowResults.selector === SHOW_RESULTS_BUTTON_SELECTORS[0]);
  ok('31i. modal conserva fallback inglés', englishAllFilters.selector === ALL_FILTERS_BUTTON_SELECTORS[1]);
  ok('31j. modal acepta fallbacks españoles observados', spanishAllFilters.selector === ALL_FILTERS_BUTTON_SELECTORS[2] && spanishShowResults.selector === SHOW_RESULTS_BUTTON_SELECTORS[2]);
  let missingButtonError;
  try { await getAllFiltersButton(selectorPage('not-present')); } catch (error) { missingButtonError = error; }
  ok('31k. botón ausente produce error claro y estable', missingButtonError && missingButtonError.name === 'LinkedInSelectorError' && missingButtonError.message === 'LinkedIn all filters button was not found.');

  function modalFilterPage() {
    const actions = [];
    const visible = new Set([
      ALL_FILTERS_BUTTON_SELECTORS[0],
      '.artdeco-modal, [role="dialog"]',
      SHOW_RESULTS_BUTTON_SELECTORS[0],
      'label[for="advanced-filter-timePostedRange-r604800"]',
      'label[for="advanced-filter-jobType-F"]',
    ]);
    const page = {
      actions,
      locator: (selector) => {
        const candidate = {
          selector,
          first: () => candidate,
          nth: () => candidate,
          locator: (childSelector) => page.locator(childSelector),
          waitFor: async () => {
            if (![...visible].some((entry) => selector.includes(entry))) throw new Error('not visible');
          },
          isVisible: async () => visible.has(selector),
          count: async () => visible.has(selector) ? 1 : 0,
          click: async () => { actions.push(['click', selector]); },
          check: async () => { actions.push(['check', selector]); },
          innerText: async () => '',
        };
        return candidate;
      },
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      url: () => 'https://www.linkedin.com/jobs/search/',
    };
    return page;
  }
  const modalPage = modalFilterPage();
  const modalResult = await applyModalFilters(modalPage, { datePosted: 'past week', employmentType: 'full-time' }, {});
  ok('31l. flujo modal conserva selección y confirmación existentes', modalResult.datePostedSelected && modalResult.employmentSelected && JSON.stringify(modalPage.actions) === JSON.stringify([
    ['click', ALL_FILTERS_BUTTON_SELECTORS[0]],
    ['click', 'label[for="advanced-filter-timePostedRange-r604800"]'],
    ['click', 'label[for="advanced-filter-jobType-F"]'],
    ['click', SHOW_RESULTS_BUTTON_SELECTORS[0]],
  ]));

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

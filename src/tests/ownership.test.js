'use strict';

// MD3a — contrato de propiedad de operaciones sobre el navegador gestionado.
// Determinista: sin LinkedIn, sin Chromium, sin red, sin OpenAI.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { OPERATION_TYPES, createOwner, isSameOwner, describeOwner, newOperationId, unspecifiedOwner } = require('../domain/operationOwner');
const { acquireLock, releaseLock, inspectLock, describeLock } = require('../domain/huntLock');
const { createHuntRunManager } = require('../run/huntRunManager');
const { createLinkedinSessionService } = require('../session/linkedinSessionService');
const { createLocalScheduler } = require('../scheduler/localScheduler');
const runtime = require('../runtime');

const roots = [];
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed++; console.log('[PASS] ' + name); }
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md3a-')); roots.push(dir); return dir; }
function lockFile() { return path.join(temp(), 'hunt.lock'); }
const tick = () => new Promise((resolve) => setImmediate(resolve));

const huntOwner = (id = 'run_hunt_a') => createOwner(OPERATION_TYPES.HUNT, id);
const marketOwner = (id = 'md_run_a') => createOwner(OPERATION_TYPES.MARKET_DISCOVERY, id);
const manualOwner = (id = 'session_a') => createOwner(OPERATION_TYPES.MANUAL_SESSION, id);

function fakePage() {
  return {
    isClosed: () => false,
    url: () => 'https://www.linkedin.com/feed/',
    goto: async () => {},
    locator: () => ({ first: () => ({ isVisible: async () => true }), innerText: async () => '' }),
  };
}
function fakeContext() {
  return { pages: () => [], newPage: async () => fakePage(), once: () => {}, close: async () => {} };
}

const originalFetch = global.fetch;
global.fetch = () => { throw new Error('External activity forbidden in MD3a'); };

(async () => {
  try {
    // ---------------------------------------------------------------- contrato
    test('owner identity requires process, operation type and operation instance', () => {
      const owner = huntOwner();
      assert.deepEqual({ ...owner }, { pid: process.pid, operationType: 'HUNT', operationId: 'run_hunt_a' });
      assert(Object.isFrozen(owner));
      assert.throws(() => createOwner('NOT_A_TYPE', 'x'), TypeError);
      assert.throws(() => createOwner(OPERATION_TYPES.HUNT, ''), TypeError);
      assert.throws(() => createOwner(OPERATION_TYPES.HUNT, '../escape'), TypeError);
      assert.throws(() => createOwner(OPERATION_TYPES.HUNT, 'x', 0), TypeError);
    });
    test('market discovery can request ownership without any hunt machinery', () => {
      const owner = marketOwner(newOperationId('md'));
      assert.equal(owner.operationType, OPERATION_TYPES.MARKET_DISCOVERY);
      assert.equal(owner.pid, process.pid);
      assert(/^md_[a-f0-9]{16}$/.test(owner.operationId));
    });
    test('same pid is not the same owner', () => {
      const record = { pid: process.pid, operationType: 'HUNT', operationId: 'run_a' };
      assert.equal(isSameOwner(record, huntOwner('run_a')), true);
      assert.equal(isSameOwner(record, huntOwner('run_b')), false, 'distinto operationId');
      assert.equal(isSameOwner(record, marketOwner('run_a')), false, 'distinto operationType');
      assert.equal(isSameOwner({ ...record, pid: process.pid + 1 }, huntOwner('run_a')), false, 'distinto pid');
      // Un registro sin identidad de operacion no pertenece a nadie.
      assert.equal(isSameOwner({ pid: process.pid }, huntOwner('run_a')), false);
      assert.equal(isSameOwner({ pid: process.pid }, unspecifiedOwner()), false);
    });

    // ------------------------------------------------------- adquirir / liberar
    test('the legitimate owner acquires and releases', () => {
      const file = lockFile();
      const owner = huntOwner();
      const handle = acquireLock(file, { owner });
      assert.deepEqual(handle.owner, owner);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(record.operationType, 'HUNT');
      assert.equal(record.operationId, 'run_hunt_a');
      assert.equal(record.pid, process.pid);
      assert.equal(releaseLock(file, { owner }), true);
      assert.equal(fs.existsSync(file), false);
    });
    test('repeated release by the legitimate owner is safe', () => {
      const file = lockFile();
      const owner = huntOwner();
      acquireLock(file, { owner });
      assert.equal(releaseLock(file, { owner }), true);
      assert.equal(releaseLock(file, { owner }), false, 'la segunda vez no hay nada que liberar');
      assert.doesNotThrow(() => releaseLock(file, { owner }));
    });
    test('wrong operation id cannot release', () => {
      const file = lockFile();
      acquireLock(file, { owner: huntOwner('run_real') });
      assert.equal(releaseLock(file, { owner: huntOwner('run_impostor') }), false);
      assert.equal(fs.existsSync(file), true);
      assert.equal(releaseLock(file, { owner: huntOwner('run_real') }), true);
    });
    test('wrong operation type cannot release', () => {
      const file = lockFile();
      acquireLock(file, { owner: huntOwner('shared_id') });
      assert.equal(releaseLock(file, { owner: marketOwner('shared_id') }), false, 'mismo pid y mismo id, distinta operacion');
      assert.equal(releaseLock(file, { owner: manualOwner('shared_id') }), false);
      assert.equal(fs.existsSync(file), true);
    });
    test('an undeclared release cannot free a declared operation', () => {
      const file = lockFile();
      acquireLock(file, { owner: marketOwner() });
      assert.equal(releaseLock(file), false, 'sin owner no se libera lo ajeno');
      assert.equal(fs.existsSync(file), true);
    });
    test('the compatibility owner still owns what it acquired', () => {
      const file = lockFile();
      acquireLock(file);
      assert.equal(releaseLock(file, { owner: huntOwner() }), false);
      assert.equal(releaseLock(file), true);
      assert.equal(fs.existsSync(file), false);
    });

    // ------------------------------------------------------------- exclusividad
    test('same process, different operation cannot acquire', () => {
      const file = lockFile();
      acquireLock(file, { owner: huntOwner() });
      let error;
      try { acquireLock(file, { owner: marketOwner() }); } catch (e) { error = e; }
      assert.equal(error && error.code, 'LOCK_HELD');
      assert.equal(error.owner.operationType, 'HUNT');
      assert.equal(error.owner.sameProcess, true, 'el mismo PID NO lo convierte en el mismo dueño');
      // Ni siquiera la misma operacion puede volver a adquirir mientras lo retiene.
      assert.throws(() => acquireLock(file, { owner: huntOwner() }), (e) => e.code === 'LOCK_HELD');
    });
    test('market discovery blocks a hunt in the same process, and the reverse', () => {
      const file = lockFile();
      acquireLock(file, { owner: marketOwner() });
      assert.throws(() => acquireLock(file, { owner: huntOwner() }), (e) => e.code === 'LOCK_HELD');
      releaseLock(file, { owner: marketOwner() });
      acquireLock(file, { owner: huntOwner() });
      assert.throws(() => acquireLock(file, { owner: marketOwner() }), (e) => e.code === 'LOCK_HELD');
    });
    test('a manual session blocks a hunt in the same process', () => {
      const file = lockFile();
      acquireLock(file, { owner: manualOwner() });
      assert.throws(() => acquireLock(file, { owner: huntOwner() }), (e) => e.code === 'LOCK_HELD');
    });
    test('own live operation is never mistaken for a stale lock', () => {
      const file = lockFile();
      acquireLock(file, { owner: huntOwner() });
      const status = inspectLock(file);
      assert.equal(status.busy, true);
      assert.equal(status.stale, false);
      assert.throws(() => acquireLock(file, { owner: marketOwner() }), (e) => e.code === 'LOCK_HELD');
      assert.equal(fs.existsSync(file), true, 'la recuperacion de stale no puede borrarlo');
    });

    // -------------------------------------------------- otros procesos / stale
    await testAsync('a live foreign process holds the lock; a dead one is recovered', async () => {
      const file = lockFile();
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      await new Promise((resolve) => child.once('spawn', resolve));
      fs.writeFileSync(file, JSON.stringify({ pid: child.pid, operationType: 'MARKET_DISCOVERY', operationId: 'md_foreign', startedAt: new Date().toISOString(), hostname: 'other' }));
      assert.equal(inspectLock(file).busy, true, 'PID vivo ajeno -> ocupado');
      assert.throws(() => acquireLock(file, { owner: huntOwner() }), (e) => e.code === 'LOCK_HELD');
      assert.equal(releaseLock(file, { owner: huntOwner() }), false, 'no se libera lo ajeno');
      assert.equal(fs.existsSync(file), true);
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
      const stale = inspectLock(file);
      assert.equal(stale.stale, true);
      assert.equal(stale.busy, false);
      const handle = acquireLock(file, { owner: huntOwner() });
      assert.equal(handle.owner.operationType, 'HUNT');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).operationId, 'run_hunt_a');
    });
    test('an undeterminable or corrupt lock stays busy', () => {
      const file = lockFile();
      fs.writeFileSync(file, 'no es json');
      assert.equal(inspectLock(file).busy, true);
      assert.throws(() => acquireLock(file, { owner: huntOwner() }), (e) => e.code === 'LOCK_HELD');
    });
    test('a pre-ownership lock record is only recoverable through a dead pid', () => {
      const legacyAlive = lockFile();
      fs.writeFileSync(legacyAlive, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: 'legacy' }));
      assert.equal(releaseLock(legacyAlive, { owner: huntOwner() }), false, 'sin identidad de operacion no hay dueño');
      assert.equal(releaseLock(legacyAlive), false);
      assert.throws(() => acquireLock(legacyAlive, { owner: huntOwner() }), (e) => e.code === 'LOCK_HELD');
      const legacyDead = lockFile();
      fs.writeFileSync(legacyDead, JSON.stringify({ pid: 999999998, startedAt: new Date(0).toISOString(), hostname: 'legacy' }));
      assert.doesNotThrow(() => acquireLock(legacyDead, { owner: huntOwner() }));
    });

    // ------------------------------------------------------------ diagnosticos
    test('ownership diagnostics are safe to expose internally', () => {
      const file = lockFile();
      acquireLock(file, { owner: marketOwner('md_diag') });
      const described = describeLock(file);
      assert.equal(described.busy, true);
      assert.deepEqual(Object.keys(described.owner).sort(), ['operationId', 'operationType', 'pid', 'sameProcess', 'startedAt']);
      assert.equal(described.owner.operationType, 'MARKET_DISCOVERY');
      assert.equal(described.owner.operationId, 'md_diag');
      const text = JSON.stringify(described);
      assert(!text.includes(os.hostname()), 'sin hostname');
      assert(!text.includes(file), 'sin rutas');
      assert.equal(describeOwner(null), null);
      assert.equal(describeOwner({ pid: 1, operationType: 'BOGUS', operationId: 'x' }).operationType, 'UNKNOWN');
    });

    // ------------------------------------------------------- integracion hunt
    const setupReady = { getStatus: () => ({ readyForHunt: true }) };
    const sessionReady = { isOpen: () => false, getStatus: async () => ({ state: 'AUTHENTICATED' }) };
    function boundManager(file, extra = {}) {
      return createHuntRunManager({
        setupService: setupReady,
        sessionService: sessionReady,
        notifyRunOutcome: async () => {},
        acquireLock: (owner) => acquireLock(file, { owner }),
        releaseLock: (owner) => releaseLock(file, { owner }),
        ...extra,
      });
    }

    await testAsync('a hunt owns the real lock under its own run id', async () => {
      const file = lockFile();
      let finish;
      const manager = boundManager(file, { makeRunId: () => 'run_bound', huntRunner: () => new Promise((resolve) => { finish = resolve; }) });
      const started = await manager.start();
      await tick();
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(record.operationType, 'HUNT');
      assert.equal(record.operationId, 'run_bound');
      assert.equal(record.operationId, started.runId, 'el id de operacion es el del run, no uno regenerado');
      // Market Discovery en el MISMO proceso no puede entrar ni liberar.
      assert.throws(() => acquireLock(file, { owner: marketOwner() }), (e) => e.code === 'LOCK_HELD');
      assert.equal(releaseLock(file, { owner: marketOwner() }), false);
      assert.equal(releaseLock(file, { owner: manualOwner() }), false);
      assert.equal(releaseLock(file), false);
      assert.equal(fs.existsSync(file), true);
      finish({});
      await manager.waitForIdle();
      assert.equal(fs.existsSync(file), false, 'el hunt libera lo suyo al terminar');
    });
    await testAsync('a hunt cannot start while market discovery owns the browser', async () => {
      const file = lockFile();
      acquireLock(file, { owner: marketOwner('md_active') });
      const manager = boundManager(file, { huntRunner: async () => {} });
      let code;
      try { await manager.start(); } catch (error) { code = error.code; }
      assert.equal(code, 'HUNT_ALREADY_RUNNING');
      assert.equal(manager.getStatus().status, 'IDLE');
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(record.operationType, 'MARKET_DISCOVERY', 'el hunt no roba ni pisa la propiedad ajena');
      assert.equal(record.operationId, 'md_active');
    });
    await testAsync('cancellation releases only the cancelled hunt ownership', async () => {
      const file = lockFile();
      const otherFile = lockFile();
      acquireLock(otherFile, { owner: marketOwner('md_untouched') });
      const manager = boundManager(file, {
        makeRunId: () => 'run_cancel',
        huntRunner: ({ signal }) => new Promise((_, reject) => {
          signal.addEventListener('abort', () => { const error = new Error('abort'); error.name = 'AbortError'; reject(error); });
        }),
      });
      await manager.start();
      await tick();
      assert.equal(fs.existsSync(file), true);
      manager.cancel();
      await manager.waitForIdle();
      assert.equal(manager.getStatus().status, 'CANCELLED');
      assert.equal(fs.existsSync(file), false, 'libera lo suyo');
      assert.equal(fs.existsSync(otherFile), true, 'no toca la propiedad de Market Discovery');
      assert.equal(JSON.parse(fs.readFileSync(otherFile, 'utf8')).operationId, 'md_untouched');
    });

    await testAsync('a scheduled hunt is blocked by market discovery and steals nothing', async () => {
      const file = lockFile();
      acquireLock(file, { owner: marketOwner('md_scheduled_guard') });
      let runnerCalls = 0;
      const manager = boundManager(file, { huntRunner: async () => { runnerCalls += 1; } });
      const scheduler = createLocalScheduler({
        scheduleStore: { get: () => ({ enabled: false, daysOfWeek: [], time: '09:00' }), save: () => {} },
        huntRunManager: manager,
        setTimeout: () => ({ unref() {} }),
        clearTimeout: () => {},
      });
      scheduler.start();
      const ran = await scheduler.trigger();
      assert.equal(ran, false);
      assert.equal(scheduler.getStatus().lastStatus, 'BLOCKED', 'comportamiento seguro previo: bloqueado, sin reintento');
      assert.equal(runnerCalls, 0, 'no se ejecuta ningun hunt');
      assert.equal(fs.existsSync(file), true);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).operationId, 'md_scheduled_guard', 'el scheduler no roba ni libera la propiedad de Market Discovery');
    });

    // ---------------------------------------------- integracion sesion manual
    function boundSession(file) {
      return createLinkedinSessionService({
        browserProfileDir: path.join(temp(), 'profile'),
        launchBrowser: async () => fakeContext(),
        getInitialPage: async () => fakePage(),
        acquireLock: (owner) => acquireLock(file, { owner }),
        releaseLock: (owner) => releaseLock(file, { owner }),
      });
    }
    await testAsync('the manual window owns the browser and blocks a hunt', async () => {
      const file = lockFile();
      const session = boundSession(file);
      await session.open();
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(record.operationType, 'MANUAL_SESSION');
      assert(record.operationId.startsWith('session_'));
      assert.throws(() => acquireLock(file, { owner: huntOwner() }), (e) => e.code === 'LOCK_HELD');
      assert.throws(() => acquireLock(file, { owner: marketOwner() }), (e) => e.code === 'LOCK_HELD');
      await session.close();
      assert.equal(fs.existsSync(file), false, 'cerrar la ventana libera solo lo suyo');
    });
    await testAsync('closing a manual session never releases someone else ownership', async () => {
      const file = lockFile();
      acquireLock(file, { owner: marketOwner('md_holding') });
      const session = boundSession(file);
      // Nunca adquirio: cerrar no puede liberar la propiedad de Market Discovery.
      await session.close();
      assert.equal(fs.existsSync(file), true);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).operationId, 'md_holding');
      let code;
      try { await session.open(); } catch (error) { code = error.code; }
      assert.equal(code, 'HUNT_ALREADY_RUNNING', 'la ventana manual respeta al dueño vigente');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).operationId, 'md_holding');
    });
    await testAsync('the persisted-session probe uses its own short-lived ownership', async () => {
      const file = lockFile();
      let seen = null;
      const session = createLinkedinSessionService({
        browserProfileDir: path.join(temp(), 'profile'),
        launchBrowser: async () => { seen = JSON.parse(fs.readFileSync(file, 'utf8')); return fakeContext(); },
        getInitialPage: async () => fakePage(),
        acquireLock: (owner) => acquireLock(file, { owner }),
        releaseLock: (owner) => releaseLock(file, { owner }),
      });
      await session.verifyPersistedSession();
      assert.equal(seen.operationType, 'SESSION_PROBE');
      assert(seen.operationId.startsWith('probe_'));
      assert.equal(fs.existsSync(file), false, 'la verificacion devuelve el navegador');
    });

    // ------------------------------------------------------ guardas de codigo
    test('no browser consumer bypasses the ownership contract', () => {
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'tests' ? [] : walk(full);
        return entry.name.endsWith('.js') ? [full] : [];
      });
      const sources = walk(path.join(runtime.PROJECT_ROOT, 'src'));
      const browserModule = path.join(runtime.PROJECT_ROOT, 'src', 'linkedin', 'browser.js');
      const consumers = sources.filter((file) => file !== browserModule
        && /launchLinkedInBrowser|launchPersistentContext/.test(fs.readFileSync(file, 'utf8')));
      assert(consumers.length >= 4, 'se esperan los consumidores conocidos del navegador');
      for (const file of consumers) {
        const source = fs.readFileSync(file, 'utf8');
        assert(source.includes('acquireLock'), `${path.relative(runtime.PROJECT_ROOT, file)} abre el navegador sin tomar el lock`);
      }
      // Ninguna liberacion fuera del propio lock puede omitir el dueño.
      const lockModule = path.join(runtime.PROJECT_ROOT, 'src', 'domain', 'huntLock.js');
      for (const file of sources) {
        if (file === lockModule) continue;
        const source = fs.readFileSync(file, 'utf8');
        for (const call of source.match(/releaseLock\([^)]*\)/g) || []) {
          assert(!/^releaseLock\(\s*\)$/.test(call), `${path.relative(runtime.PROJECT_ROOT, file)} libera sin dueño: ${call}`);
        }
      }
    });
    test('the scheduler and the UI server still own no lock of their own', () => {
      const source = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/scheduler/localScheduler.js'), 'utf8');
      assert(!source.includes('huntLock') && !source.includes('acquireLock') && !source.includes('operationOwner'));
      const server = fs.readFileSync(path.join(runtime.PROJECT_ROOT, 'src/ui/server.js'), 'utf8');
      assert(!server.includes("require('../domain/huntLock')") && !server.includes('releaseLock('));
    });

    console.log('Ownership (MD3a): ' + passed + ' tests passed');
  } finally {
    global.fetch = originalFetch;
    for (const dir of roots.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

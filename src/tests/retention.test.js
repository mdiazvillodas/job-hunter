'use strict';

// TTL de 7 dias SOLO para ofertas nunca abiertas.
// Reloj fijo e inyectado: no hay sleeps reales ni dependencia de la hora actual.
// Sin OpenAI, sin LinkedIn, sin filesystem real (repositorio en memoria).

const test = require('node:test');
const assert = require('node:assert');

const R = require('../domain/retention');
const { createJobRecord, applyRead, applyInterested, applyApplied, applyDiscarded, applyPriority, applyApplicationsClosed } = require('../domain/jobRecord');
const { createJobService } = require('../services/jobService');

/* ---------- reloj fijo ---------- */

const T0 = Date.parse('2026-09-01T10:00:00.000Z'); // ingreso al sistema
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const iso = (ms) => new Date(ms).toISOString();
const at = (offsetMs) => iso(T0 + offsetMs);

/* ---------- repositorio en memoria (mismo contrato que LocalRepository) ---------- */

function memoryRepository() {
  const map = new Map();
  return {
    kind: 'memory',
    save(job) { map.set(String(job.jobId), JSON.parse(JSON.stringify(job))); return job; },
    get(jobId) { const j = map.get(String(jobId)); return j ? JSON.parse(JSON.stringify(j)) : null; },
    has(jobId) { return map.has(String(jobId)); },
    getAll() { return Array.from(map.values()).map((j) => JSON.parse(JSON.stringify(j))); },
    delete(jobId) { return map.delete(String(jobId)); },
    _map: map,
  };
}

// Job creado en T0 (nunca abierto salvo que el test lo abra despues).
function newJob(jobId, createdOffset = 0) {
  return createJobRecord({ jobId: String(jobId), title: 'T', company: 'C', description: 'd' },
    { clock: () => at(createdOffset) });
}

/* ================= 1-3: nunca leido, limite exacto ================= */

test('1. unread + 6d23h59m => se CONSERVA', () => {
  const j = newJob('a');
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 7 * DAY - MIN), false);
});

test('2. unread + exactamente 7d => se ELIMINA', () => {
  const j = newJob('b');
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 7 * DAY), true);
});

test('3. unread + mas de 7d => se ELIMINA', () => {
  const j = newJob('c');
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 7 * DAY + MIN), true);
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 90 * DAY), true);
});

/* ================= 4-5: leido => protegido para siempre ================= */

test('4. read + mas de 7d => se CONSERVA', () => {
  const j = applyRead(newJob('d'), { clock: () => at(HOUR) });
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 8 * DAY), false);
  assert.strictEqual(R.protectionReason(j), 'read_at_least_once');
});

test('5. read + 30d => se CONSERVA (la proteccion no caduca)', () => {
  const j = applyRead(newJob('e'), { clock: () => at(HOUR) });
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 30 * DAY), false);
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 365 * DAY), false);
});

/* ================= 6-9: estados protegidos explicitamente ================= */

test('6. applied + mas de 7d => se CONSERVA', () => {
  const j = applyApplied(newJob('f'), { clock: () => at(HOUR) });
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 20 * DAY), false);
});

test('7. interested + mas de 7d => se CONSERVA', () => {
  const j = applyInterested(newJob('g'), { clock: () => at(HOUR) });
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 20 * DAY), false);
});

test('8. discarded + mas de 7d => se CONSERVA', () => {
  const j = applyDiscarded(newJob('h'), { clock: () => at(HOUR), reasons: ['company'] });
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 20 * DAY), false);
});

test('9. closed + mas de 7d => se CONSERVA', () => {
  const j = applyApplicationsClosed(newJob('i'), { clock: () => at(HOUR) });
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 20 * DAY), false);
  assert.strictEqual(R.protectionReason(j), 'applications_closed');
});

test('9b. priority + mas de 7d => se CONSERVA', () => {
  const j = applyPriority(newJob('i2'), { clock: () => at(HOUR) });
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 20 * DAY), false);
});

test('9c. estados protegidos aunque falte la marca de lectura (caso historico real)', () => {
  // En el repositorio real existen descartes con readAt === null.
  const j = newJob('i3');
  j.userState.status = 'discarded';
  j.userState.discardedAt = null;
  j.userState.readAt = null;
  j.feedbackEvents = [];
  assert.strictEqual(R.hasEverBeenRead(j), true, 'el status por si solo ya protege');
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 60 * DAY), false);
});

/* ================= 10: reciente ================= */

test('10. job reciente sin leer => se CONSERVA', () => {
  const j = newJob('j');
  assert.strictEqual(R.isExpiredByTtl(j, T0), false);
  assert.strictEqual(R.isExpiredByTtl(j, T0 + DAY), false);
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 6 * DAY), false);
});

/* ================= 11: fail-safe ================= */

test('11. sin timestamp confiable => FAIL-SAFE: no se borra', () => {
  const sinFecha = newJob('k'); sinFecha.userState.firstSeenAt = null;
  const basura = newJob('l'); basura.userState.firstSeenAt = 'no-es-una-fecha';
  const vacio = newJob('m'); vacio.userState.firstSeenAt = '';
  const sinUserState = newJob('n'); delete sinUserState.userState;

  for (const j of [sinFecha, basura, vacio, sinUserState]) {
    assert.strictEqual(R.isExpiredByTtl(j, T0 + 90 * DAY), false,
      'ante un timestamp ilegible se conserva');
  }
  assert.strictEqual(R.protectionReason(sinFecha), 'unknown_first_seen');

  // Tampoco se borra nada si el "ahora" que llega es invalido.
  const sano = newJob('o');
  assert.strictEqual(R.isExpiredByTtl(sano, 'ahora'), false);
  assert.strictEqual(R.isExpiredByTtl(sano, null), false);
  assert.strictEqual(R.isExpiredByTtl(sano, undefined), false);

  // Y un registro invalido nunca es candidato.
  assert.strictEqual(R.isExpiredByTtl(null, T0 + 90 * DAY), false);
  assert.strictEqual(R.isExpiredByTtl(undefined, T0 + 90 * DAY), false);
});

test('11b. la ausencia de un campo nuevo NO se interpreta como "never read"', () => {
  // Registro legacy: sin feedbackEvents, sin availability, sin campos nuevos.
  const legacy = {
    jobId: 'legacy-1',
    userState: { status: 'read', firstSeenAt: at(0), readAt: at(HOUR) },
  };
  assert.strictEqual(R.hasEverBeenRead(legacy), true);
  assert.strictEqual(R.isExpiredByTtl(legacy, T0 + 90 * DAY), false);

  // Legacy sin readAt PERO con evento historico: tambien protegido.
  const legacyEvento = {
    jobId: 'legacy-2',
    userState: { status: 'new', firstSeenAt: at(0), readAt: null },
    feedbackEvents: [{ type: 'read', createdAt: at(HOUR) }],
  };
  assert.strictEqual(R.hasEverBeenRead(legacyEvento), true);
  assert.strictEqual(R.isExpiredByTtl(legacyEvento, T0 + 90 * DAY), false);
});

/* ================= 12-13: la lectura es un hecho monotonico ================= */

test('12. el evento de lectura queda persistido', () => {
  const repo = memoryRepository();
  const svc = createJobService(repo, { clock: () => at(HOUR) });
  svc.createJob({ jobId: 'p', title: 'T', description: 'd' });
  svc.markAsRead('p');

  const saved = repo.get('p');
  assert.ok(saved.userState.readAt, 'readAt persiste');
  assert.strictEqual(saved.userState.status, 'read');
  assert.ok(saved.feedbackEvents.some((e) => e.type === 'read'), 'el evento read persiste');
  assert.strictEqual(svc.retentionProtectionReason('p'), 'read_at_least_once');
});

test('13. una vez leido, nunca vuelve conceptualmente a never-read', () => {
  const j = applyRead(newJob('q'), { clock: () => at(HOUR) });
  assert.strictEqual(R.hasEverBeenRead(j), true);

  // Aunque el status retroceda por cualquier via, la evidencia historica manda.
  j.userState.status = 'new';
  assert.strictEqual(R.hasEverBeenRead(j), true, 'readAt sigue probando la lectura');
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 90 * DAY), false);

  // Incluso si ademas se perdiera readAt, queda el evento append-only.
  j.userState.readAt = null;
  assert.strictEqual(R.hasEverBeenRead(j), true, 'el evento read sigue probando la lectura');
  assert.strictEqual(R.isExpiredByTtl(j, T0 + 90 * DAY), false);
});

test('13b. el discovery repetido NO reinicia el reloj del TTL', () => {
  const repo = memoryRepository();
  const svc = createJobService(repo, { clock: () => at(0) });
  svc.ingestDiscovery({ jobId: 'r', title: 'T', description: 'd' });

  // El collector vuelve a encontrarla 5 dias despues: actualiza lastSeenAt, no firstSeenAt.
  const svcLater = createJobService(repo, { clock: () => at(5 * DAY) });
  svcLater.ingestDiscovery({ jobId: 'r', title: 'T', description: 'd' });

  const saved = repo.get('r');
  assert.strictEqual(saved.userState.firstSeenAt, at(0), 'firstSeenAt no se mueve');
  assert.strictEqual(saved.userState.lastSeenAt, at(5 * DAY));
  assert.strictEqual(R.isExpiredByTtl(saved, T0 + 7 * DAY), true,
    'el TTL se cuenta desde el ingreso original, no desde el ultimo avistamiento');
});

/* ================= 14: repost = oportunidad nueva ================= */

test('14. un jobId nuevo de repost no hereda read state ni TTL del anterior', () => {
  const repo = memoryRepository();
  const svc = createJobService(repo, { clock: () => at(0) });
  svc.createJob({ jobId: 'A', title: 'Mismo puesto', description: 'misma descripcion' });

  // A envejece sin leerse y se borra.
  const purge = svc.cleanupExpiredJobs({ now: at(8 * DAY) });
  assert.deepStrictEqual(purge.jobIds, ['A']);
  assert.strictEqual(repo.has('A'), false);

  // Reaparece como jobId B: entra normalmente, con su propio reloj y sin read state.
  const svcB = createJobService(repo, { clock: () => at(8 * DAY) });
  svcB.createJob({ jobId: 'B', title: 'Mismo puesto', description: 'misma descripcion' });
  const b = repo.get('B');

  assert.strictEqual(b.userState.firstSeenAt, at(8 * DAY), 'B arranca su propio TTL');
  assert.strictEqual(b.userState.readAt, null, 'B no hereda lectura');
  assert.deepStrictEqual(b.feedbackEvents, [], 'B no hereda historial');
  assert.strictEqual(R.isExpiredByTtl(b, T0 + 8 * DAY), false, 'B recien entra: se conserva');
  assert.strictEqual(R.isExpiredByTtl(b, T0 + 15 * DAY), true, 'B expira por su propia edad');
});

/* ================= 15: idempotencia ================= */

test('15. la limpieza repetida es idempotente', () => {
  const repo = memoryRepository();
  const svc = createJobService(repo, { clock: () => at(0) });
  svc.createJob({ jobId: 'x1', title: 'T', description: 'd' }); // unread viejo
  svc.createJob({ jobId: 'x2', title: 'T', description: 'd' }); // se leera
  svc.markAsRead('x2');

  const now = at(10 * DAY);
  const first = svc.cleanupExpiredJobs({ now });
  assert.strictEqual(first.eligible, 1);
  assert.strictEqual(first.deleted, 1);
  assert.deepStrictEqual(first.jobIds, ['x1']);

  const second = svc.cleanupExpiredJobs({ now });
  assert.strictEqual(second.eligible, 0, 'la segunda pasada no encuentra nada');
  assert.strictEqual(second.deleted, 0);

  const third = svc.cleanupExpiredJobs({ now });
  assert.strictEqual(third.deleted, 0);

  assert.strictEqual(repo.has('x1'), false);
  assert.strictEqual(repo.has('x2'), true, 'el leido sobrevive a todas las pasadas');
});

/* ================= borrado por la capa de persistencia ================= */

test('el borrado pasa por repository.delete y no deja referencias huerfanas', () => {
  const repo = memoryRepository();
  const calls = [];
  const spy = { ...repo, delete: (id) => { calls.push(id); return repo.delete(id); } };
  const svc = createJobService(spy, { clock: () => at(0) });
  svc.createJob({ jobId: 'y1', title: 'T', description: 'd' });

  svc.cleanupExpiredJobs({ now: at(9 * DAY) });
  assert.deepStrictEqual(calls, ['y1'], 'se borra por el repositorio, no por fs');
  assert.strictEqual(repo.get('y1'), null);
  assert.strictEqual(svc.getAllJobs().length, 0);
});

test('dryRun calcula lo mismo pero NO borra', () => {
  const repo = memoryRepository();
  const svc = createJobService(repo, { clock: () => at(0) });
  svc.createJob({ jobId: 'z1', title: 'T', description: 'd' });
  svc.createJob({ jobId: 'z2', title: 'T', description: 'd' });
  svc.markAsRead('z2');

  const sim = svc.cleanupExpiredJobs({ now: at(10 * DAY), dryRun: true });
  assert.strictEqual(sim.dryRun, true);
  assert.strictEqual(sim.eligible, 1);
  assert.strictEqual(sim.deleted, 0, 'dry-run no borra');
  assert.deepStrictEqual(sim.jobIds, ['z1']);
  assert.strictEqual(repo.has('z1'), true, 'el job sigue en disco tras el dry-run');

  const real = svc.cleanupExpiredJobs({ now: at(10 * DAY) });
  assert.strictEqual(real.deleted, 1);
  assert.strictEqual(repo.has('z1'), false);
});

test('el reporte de limpieza incluye el TTL y lo escaneado', () => {
  const repo = memoryRepository();
  const svc = createJobService(repo, { clock: () => at(0) });
  svc.createJob({ jobId: 'w1', title: 'T', description: 'd' });
  svc.createJob({ jobId: 'w2', title: 'T', description: 'd' });

  const r = svc.cleanupExpiredJobs({ now: at(10 * DAY), dryRun: true });
  assert.strictEqual(r.ttlDays, 7);
  assert.strictEqual(r.scanned, 2);
  assert.strictEqual(r.now, at(10 * DAY));
  assert.deepStrictEqual(r.failed, []);
});

/* ================= la limpieza no toca el analisis ================= */

test('la limpieza no modifica los jobs que conserva', () => {
  const repo = memoryRepository();
  const svc = createJobService(repo, { clock: () => at(0) });
  svc.createJob({ jobId: 'k1', title: 'T', description: 'd', aiAnalysis: { overallMatchScore: 90 } });
  svc.markAsRead('k1');
  const before = JSON.stringify(repo.get('k1'));

  svc.cleanupExpiredJobs({ now: at(60 * DAY) });
  assert.strictEqual(JSON.stringify(repo.get('k1')), before,
    'un job protegido queda byte a byte igual tras la limpieza');
});

/* ================= constantes ================= */

test('el TTL es de 7 dias corridos', () => {
  assert.strictEqual(R.TTL_DAYS, 7);
  assert.strictEqual(R.TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

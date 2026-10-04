'use strict';

// Filtro manual de puntaje minimo del Inbox.
// Es EXCLUSIVAMENTE un filtro de visualizacion: se verifica tanto que filtre bien
// como que NO toque el job ni su analisis. Logica pura: sin DOM, sin backend, sin OpenAI.

const test = require('node:test');
const assert = require('node:assert');

const L = require('../ui/jobListLogic');
const P = require('../ui/public/uiPrefs');

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}
function brokenStorage() {
  return {
    getItem() { throw new Error('storage bloqueado'); },
    setItem() { throw new Error('storage bloqueado'); },
  };
}

// Job minimo con analisis completado y un overallMatchScore concreto.
function job(jobId, overall) {
  return {
    jobId: String(jobId),
    title: 'Job ' + jobId,
    company: 'ACME',
    analysisStatus: 'completed',
    aiAnalysis: overall == null ? null : { overallMatchScore: overall, decision: 'MAYBE' },
    userState: { status: 'new', firstSeenAt: '2026-09-01T10:00:00.000Z' },
    availability: 'open',
  };
}

// Set de prueba que cubre exactamente los bordes de cada opcion del selector.
const JOBS = [
  job('s90', 90), job('s85', 85), job('s80', 80), job('s75', 75),
  job('s74', 74), job('s70', 70), job('s65', 65), job('s64', 64), job('s50', 50),
];

const ids = (filters) => L.filterJobs(JOBS, { status: 'all', ...filters }).map((j) => j.jobId);

/* ---------- default ---------- */

test('el default del filtro es 75+', () => {
  assert.strictEqual(P.DEFAULT_MIN_SCORE, 75);
  // Sin preferencia guardada, la UI arranca en 75+.
  assert.strictEqual(P.resolveMinScore(P.readStoredMinScore(fakeStorage())), 75);
});

test('las opciones del selector son exactamente Todos/65/70/75/80/90', () => {
  assert.deepStrictEqual(P.SCORE_FILTER_OPTIONS, [0, 65, 70, 75, 80, 90]);
});

/* ---------- visibilidad con el default 75+ ---------- */

test('con el default 75+: 90, 80 y 75 son visibles', () => {
  const visible = ids({ minScore: P.DEFAULT_MIN_SCORE });
  assert.ok(visible.includes('s90'), '90 debe verse');
  assert.ok(visible.includes('s80'), '80 debe verse');
  assert.ok(visible.includes('s75'), '75 debe verse (el umbral es inclusivo)');
});

test('con el default 75+: 74 queda oculto', () => {
  assert.ok(!ids({ minScore: P.DEFAULT_MIN_SCORE }).includes('s74'));
});

test('"Todos" (0) muestra tambien los puntajes bajos', () => {
  const visible = ids({ minScore: 0 });
  assert.ok(visible.includes('s50'), '50 debe verse con Todos');
  assert.ok(visible.includes('s64'), '64 debe verse con Todos');
  assert.strictEqual(visible.length, JOBS.length, 'Todos no filtra ninguna oferta por puntaje');
});

/* ---------- cada opcion del selector ---------- */

test('65+ filtra por 65 inclusive', () => {
  const visible = ids({ minScore: 65 });
  assert.ok(visible.includes('s65'));
  assert.ok(!visible.includes('s64'));
});

test('70+ filtra por 70 inclusive', () => {
  const visible = ids({ minScore: 70 });
  assert.ok(visible.includes('s70'));
  assert.ok(!visible.includes('s65'));
});

test('75+ filtra por 75 inclusive', () => {
  const visible = ids({ minScore: 75 });
  assert.ok(visible.includes('s75'));
  assert.ok(!visible.includes('s74'));
});

test('80+ filtra por 80 inclusive', () => {
  const visible = ids({ minScore: 80 });
  assert.ok(visible.includes('s80'));
  assert.ok(!visible.includes('s75'));
});

test('90+ filtra por 90 inclusive', () => {
  const visible = ids({ minScore: 90 });
  assert.deepStrictEqual(visible, ['s90']);
});

test('cada opcion del selector deja pasar solo lo que le corresponde', () => {
  for (const min of P.SCORE_FILTER_OPTIONS) {
    const visible = L.filterJobs(JOBS, { status: 'all', minScore: min });
    for (const j of visible) {
      assert.ok(j.aiAnalysis.overallMatchScore >= min,
        `con ${min}+ no puede aparecer ${j.jobId}`);
    }
  }
});

/* ---------- el filtro NO muta nada ---------- */

test('cambiar el filtro NO modifica el job ni su analisis', () => {
  const before = JSON.stringify(JOBS);
  for (const min of P.SCORE_FILTER_OPTIONS) {
    L.filterJobs(JOBS, { status: 'all', minScore: min });
  }
  assert.strictEqual(JSON.stringify(JOBS), before,
    'filterJobs debe ser puro: ningun job puede cambiar al filtrar');
});

test('un job por debajo del umbral sigue existiendo y reaparece al bajar el filtro', () => {
  // Oculto con el default...
  assert.ok(!ids({ minScore: 75 }).includes('s70'));
  // ...pero el registro nunca se toco: con 70+ o Todos vuelve a verse.
  assert.ok(ids({ minScore: 70 }).includes('s70'));
  assert.ok(ids({ minScore: 0 }).includes('s70'));
  const original = JOBS.find((j) => j.jobId === 's70');
  assert.strictEqual(original.aiAnalysis.overallMatchScore, 70, 'el analisis queda intacto');
  assert.strictEqual(original.userState.status, 'new', 'el userState queda intacto');
});

test('el filtro no altera el analysisStatus ni descarta jobs sin analisis del repositorio', () => {
  const sinAnalisis = job('none', null);
  const set = [sinAnalisis, job('s90b', 90)];
  const visible = L.filterJobs(set, { status: 'all', minScore: 75 });
  // Un job sin score no pasa el filtro de puntaje, pero el registro no se modifica.
  assert.deepStrictEqual(visible.map((j) => j.jobId), ['s90b']);
  assert.strictEqual(sinAnalisis.aiAnalysis, null);
  assert.strictEqual(sinAnalisis.analysisStatus, 'completed');
});

/* ---------- persistencia de la preferencia ---------- */

test('la preferencia de puntaje se guarda y se relee', () => {
  const storage = fakeStorage();
  assert.strictEqual(P.storeMinScore(storage, 90), true);
  assert.strictEqual(P.readStoredMinScore(storage), 90);
  assert.strictEqual(P.resolveMinScore(P.readStoredMinScore(storage)), 90);
});

test('la preferencia guardada gana sobre el default', () => {
  const storage = fakeStorage({ 'jobhunter.minScore': '0' });
  assert.strictEqual(P.resolveMinScore(P.readStoredMinScore(storage)), 0,
    'si el usuario eligio Todos, se respeta Todos');
});

test('un valor guardado invalido cae al default 75 (no esconde ofertas de mas)', () => {
  for (const bad of ['garbage', '73', '', '-10', '100']) {
    const storage = fakeStorage({ 'jobhunter.minScore': bad });
    assert.strictEqual(P.readStoredMinScore(storage), null);
    assert.strictEqual(P.resolveMinScore(P.readStoredMinScore(storage)), 75);
  }
});

test('un storage inaccesible no rompe la UI: cae al default', () => {
  const storage = brokenStorage();
  assert.strictEqual(P.readStoredMinScore(storage), null);
  assert.strictEqual(P.storeMinScore(storage, 80), false);
  assert.strictEqual(P.resolveMinScore(P.readStoredMinScore(storage)), 75);
});

test('no se persiste un valor fuera del selector', () => {
  const storage = fakeStorage();
  assert.strictEqual(P.storeMinScore(storage, 73), false);
  assert.strictEqual(storage._map.has('jobhunter.minScore'), false);
});

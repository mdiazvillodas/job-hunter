'use strict';

// Preferencias de UI (tema) + contadores de filtros activos.
// Logica pura: sin DOM real, sin navegador, sin backend.

const test = require('node:test');
const assert = require('node:assert');

const P = require('../ui/public/uiPrefs');
const L = require('../ui/jobListLogic');

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
function fakeRoot() {
  const attrs = {};
  return { setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => (k in attrs ? attrs[k] : null), _attrs: attrs };
}

/* ---------------- tema ---------------- */

test('la preferencia guardada gana sobre prefers-color-scheme', () => {
  assert.strictEqual(P.resolveTheme('light', true), 'light');
  assert.strictEqual(P.resolveTheme('dark', false), 'dark');
});

test('sin preferencia guardada se usa prefers-color-scheme', () => {
  assert.strictEqual(P.resolveTheme(null, true), 'dark');
  assert.strictEqual(P.resolveTheme(null, false), 'light');
  assert.strictEqual(P.resolveTheme(undefined, false), 'light');
});

test('un valor guardado invalido se ignora', () => {
  assert.strictEqual(P.readStoredTheme(fakeStorage({ 'jobhunter.theme': 'neon' })), null);
  assert.strictEqual(P.readStoredTheme(fakeStorage({ 'jobhunter.theme': '' })), null);
  assert.strictEqual(P.readStoredTheme(fakeStorage({})), null);
  assert.strictEqual(P.resolveTheme('neon', true), 'dark', 'cae al sistema');
});

test('un storage inaccesible no rompe: se comporta como sin preferencia', () => {
  assert.strictEqual(P.readStoredTheme(brokenStorage()), null);
  assert.strictEqual(P.storeTheme(brokenStorage(), 'dark'), false);
  assert.strictEqual(P.readStoredTheme(null), null);
  assert.strictEqual(P.readStoredTheme(undefined), null);
});

test('la preferencia se persiste en localStorage', () => {
  const storage = fakeStorage();
  assert.strictEqual(P.storeTheme(storage, 'dark'), true);
  assert.strictEqual(storage.getItem('jobhunter.theme'), 'dark');
  assert.strictEqual(P.readStoredTheme(storage), 'dark');
  assert.strictEqual(P.storeTheme(storage, 'neon'), false, 'no guarda valores invalidos');
  assert.strictEqual(storage.getItem('jobhunter.theme'), 'dark');
});

test('el toggle alterna entre light y dark', () => {
  assert.strictEqual(P.nextTheme('light'), 'dark');
  assert.strictEqual(P.nextTheme('dark'), 'light');
  assert.strictEqual(P.nextTheme(null), 'dark', 'desde un estado desconocido va a dark');
});

test('applyTheme escribe data-theme en la raiz', () => {
  const root = fakeRoot();
  assert.strictEqual(P.applyTheme(root, 'dark'), 'dark');
  assert.strictEqual(root.getAttribute('data-theme'), 'dark');
  assert.strictEqual(P.currentTheme(root), 'dark');

  P.applyTheme(root, 'neon');
  assert.strictEqual(root.getAttribute('data-theme'), 'light', 'un tema invalido cae a light');
  assert.strictEqual(P.applyTheme(null, 'dark'), null, 'sin raiz no rompe');
});

test('currentTheme devuelve light cuando no hay atributo', () => {
  assert.strictEqual(P.currentTheme(fakeRoot()), 'light');
  assert.strictEqual(P.currentTheme(null), 'light');
});

test('applyStoredTheme resuelve y aplica en el arranque', () => {
  const root = fakeRoot();
  const doc = { documentElement: root };

  // Preferencia guardada: manda.
  P.applyStoredTheme({ localStorage: fakeStorage({ 'jobhunter.theme': 'dark' }), matchMedia: () => ({ matches: false }) }, doc);
  assert.strictEqual(root.getAttribute('data-theme'), 'dark');

  // Sin preferencia: sistema en dark.
  const root2 = fakeRoot();
  P.applyStoredTheme({ localStorage: fakeStorage(), matchMedia: () => ({ matches: true }) }, { documentElement: root2 });
  assert.strictEqual(root2.getAttribute('data-theme'), 'dark');

  // Sin preferencia ni matchMedia: light.
  const root3 = fakeRoot();
  P.applyStoredTheme({ localStorage: fakeStorage() }, { documentElement: root3 });
  assert.strictEqual(root3.getAttribute('data-theme'), 'light');

  // Sin document no rompe.
  assert.strictEqual(P.applyStoredTheme({}, null), null);
});

test('prefersDarkFrom tolera un matchMedia roto', () => {
  assert.strictEqual(P.prefersDarkFrom({ matchMedia() { throw new Error('nope'); } }), false);
  assert.strictEqual(P.prefersDarkFrom({}), false);
  assert.strictEqual(P.prefersDarkFrom(null), false);
});

/* ---------------- contador de filtros activos ---------------- */

const DEFAULTS = { status: 'inbox', aiDecision: 'all', easyApply: 'all', minScore: 0, families: [], company: '', matchedQuery: '', search: '' };

test('sin filtros del panel el contador es 0', () => {
  assert.strictEqual(L.countActiveFilters(DEFAULTS), 0);
  assert.deepStrictEqual(L.activeFilterKeys(DEFAULTS), []);
  assert.strictEqual(L.countActiveFilters({}), 0);
  assert.strictEqual(L.countActiveFilters(null), 0);
});

test('el estado y la busqueda libre NO cuentan como filtros del panel', () => {
  // Viven fuera del drawer: tabs de estado y caja de busqueda.
  assert.strictEqual(L.countActiveFilters({ ...DEFAULTS, status: 'discarded' }), 0);
  assert.strictEqual(L.countActiveFilters({ ...DEFAULTS, search: 'delivery' }), 0);
});

test('cada dimension del panel suma uno', () => {
  assert.deepStrictEqual(L.activeFilterKeys({ ...DEFAULTS, aiDecision: 'YES' }), ['aiDecision']);
  assert.deepStrictEqual(L.activeFilterKeys({ ...DEFAULTS, easyApply: 'yes' }), ['easyApply']);
  assert.deepStrictEqual(L.activeFilterKeys({ ...DEFAULTS, minScore: 70 }), ['minScore']);
  assert.deepStrictEqual(L.activeFilterKeys({ ...DEFAULTS, matchedQuery: 'Head of Operations' }), ['matchedQuery']);
  assert.deepStrictEqual(L.activeFilterKeys({ ...DEFAULTS, company: 'Glovo' }), ['company']);
  assert.deepStrictEqual(L.activeFilterKeys({ ...DEFAULTS, families: ['operations'] }), ['families']);

  // Varias familias siguen siendo UNA dimension activa.
  assert.strictEqual(L.countActiveFilters({ ...DEFAULTS, families: ['operations', 'delivery'] }), 1);
  assert.strictEqual(L.countActiveFilters({ ...DEFAULTS, aiDecision: 'YES', minScore: 80, company: 'X' }), 3);
});

test('una empresa en blanco no cuenta como filtro', () => {
  assert.strictEqual(L.countActiveFilters({ ...DEFAULTS, company: '   ' }), 0);
  assert.strictEqual(L.countActiveFilters({ ...DEFAULTS, minScore: 0 }), 0);
});

test('clearedFilters resetea el panel y conserva estado y busqueda', () => {
  const cleared = L.clearedFilters({
    status: 'discarded', search: 'delivery',
    aiDecision: 'NO', easyApply: 'yes', minScore: 80, company: 'Glovo',
    matchedQuery: 'Operations Lead', families: ['operations', 'delivery'],
  });
  assert.strictEqual(cleared.status, 'discarded', 'la vista de estado se conserva');
  assert.strictEqual(cleared.search, 'delivery', 'la busqueda libre se conserva');
  assert.strictEqual(L.countActiveFilters(cleared), 0);
  assert.deepStrictEqual(cleared.families, []);
});

test('limpiar filtros no cambia como se filtra: solo vuelve a los defaults', () => {
  const jobs = [
    { jobId: '1', title: 'A', company: 'Glovo', userState: { status: 'new' }, aiAnalysis: { decision: 'YES', overallMatchScore: 90 }, analysisStatus: 'completed', matchedFamilies: ['operations'] },
    { jobId: '2', title: 'B', company: 'Otra', userState: { status: 'new' }, aiAnalysis: { decision: 'NO', overallMatchScore: 30 }, analysisStatus: 'completed', matchedFamilies: ['delivery'] },
  ];
  const filtered = { ...DEFAULTS, aiDecision: 'YES', minScore: 80, company: 'Glovo' };
  assert.deepStrictEqual(L.filterJobs(jobs, filtered).map((j) => j.jobId), ['1']);
  assert.deepStrictEqual(L.filterJobs(jobs, L.clearedFilters(filtered)).map((j) => j.jobId), ['1', '2']);
});

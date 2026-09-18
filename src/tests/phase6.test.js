'use strict';

// Phase 6 — convergencia de frontend.
// Tema (uiPrefs) + indicadores de filtros activos + contrato de markup de la
// bandeja. Logica pura: sin navegador, sin red, sin runtime-data.
// Ejecutar: node src/tests/phase6.test.js

const fs = require('fs');
const path = require('path');

const P = require('../ui/public/uiPrefs');
const L = require('../ui/jobListLogic');
const { toEditableSearch, applySearchSettings } = require('../config/searchSettings');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}
function brokenStorage() {
  return { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } };
}
function fakeRoot() {
  const attrs = {};
  return { setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => (k in attrs ? attrs[k] : null) };
}

const DEFAULTS = {
  status: 'inbox', aiDecision: 'all', easyApply: 'all', minScore: 0,
  families: [], company: '', matchedQuery: '', search: '',
};

function run() {
  section('Tema: resolucion');
  ok('1. la preferencia guardada gana sobre el sistema',
    P.resolveTheme('light', true) === 'light' && P.resolveTheme('dark', false) === 'dark');
  ok('2. sin preferencia se usa prefers-color-scheme',
    P.resolveTheme(null, true) === 'dark' && P.resolveTheme(null, false) === 'light');
  ok('3. un valor guardado invalido se ignora',
    P.readStoredTheme(fakeStorage({ 'jobhunter.theme': 'neon' })) === null
    && P.readStoredTheme(fakeStorage({})) === null
    && P.resolveTheme('neon', true) === 'dark');
  ok('4. un storage inaccesible no rompe',
    P.readStoredTheme(brokenStorage()) === null
    && P.storeTheme(brokenStorage(), 'dark') === false
    && P.readStoredTheme(null) === null);

  section('Tema: persistencia y aplicacion');
  const storage = fakeStorage();
  ok('5. la preferencia se persiste',
    P.storeTheme(storage, 'dark') === true && P.readStoredTheme(storage) === 'dark');
  ok('6. no se persisten valores invalidos',
    P.storeTheme(storage, 'neon') === false && P.readStoredTheme(storage) === 'dark');
  ok('7. el toggle alterna light/dark',
    P.nextTheme('light') === 'dark' && P.nextTheme('dark') === 'light' && P.nextTheme(null) === 'dark');
  const root = fakeRoot();
  ok('8. applyTheme escribe data-theme',
    P.applyTheme(root, 'dark') === 'dark' && root.getAttribute('data-theme') === 'dark' && P.currentTheme(root) === 'dark');
  P.applyTheme(root, 'neon');
  ok('9. un tema invalido cae a light',
    root.getAttribute('data-theme') === 'light' && P.applyTheme(null, 'dark') === null);
  ok('10. currentTheme sin atributo es light',
    P.currentTheme(fakeRoot()) === 'light' && P.currentTheme(null) === 'light');

  section('Tema: arranque');
  const r1 = fakeRoot();
  P.applyStoredTheme({ localStorage: fakeStorage({ 'jobhunter.theme': 'dark' }), matchMedia: () => ({ matches: false }) }, { documentElement: r1 });
  ok('11. la preferencia guardada manda en el arranque', r1.getAttribute('data-theme') === 'dark');
  const r2 = fakeRoot();
  P.applyStoredTheme({ localStorage: fakeStorage(), matchMedia: () => ({ matches: true }) }, { documentElement: r2 });
  ok('12. sin preferencia se usa el sistema', r2.getAttribute('data-theme') === 'dark');
  const r3 = fakeRoot();
  P.applyStoredTheme({ localStorage: fakeStorage() }, { documentElement: r3 });
  ok('13. sin preferencia ni matchMedia queda light', r3.getAttribute('data-theme') === 'light');
  ok('14. sin document no rompe', P.applyStoredTheme({}, null) === null);
  ok('15. prefersDarkFrom tolera un matchMedia roto',
    P.prefersDarkFrom({ matchMedia() { throw new Error('nope'); } }) === false
    && P.prefersDarkFrom({}) === false && P.prefersDarkFrom(null) === false);

  section('Filtros activos');
  ok('16. sin filtros del panel el contador es 0',
    L.countActiveFilters(DEFAULTS) === 0 && L.countActiveFilters({}) === 0 && L.countActiveFilters(null) === 0);
  ok('17. el estado y la busqueda libre no cuentan como filtros del panel',
    L.countActiveFilters({ ...DEFAULTS, status: 'discarded' }) === 0
    && L.countActiveFilters({ ...DEFAULTS, search: 'delivery' }) === 0);
  ok('18. cada dimension del panel suma uno',
    L.activeFilterKeys({ ...DEFAULTS, aiDecision: 'YES' }).join() === 'aiDecision'
    && L.activeFilterKeys({ ...DEFAULTS, easyApply: 'yes' }).join() === 'easyApply'
    && L.activeFilterKeys({ ...DEFAULTS, minScore: 70 }).join() === 'minScore'
    && L.activeFilterKeys({ ...DEFAULTS, matchedQuery: 'Operations Manager' }).join() === 'matchedQuery'
    && L.activeFilterKeys({ ...DEFAULTS, company: 'Acme' }).join() === 'company'
    && L.activeFilterKeys({ ...DEFAULTS, families: ['operations'] }).join() === 'families');
  ok('19. varias familias siguen siendo una dimension',
    L.countActiveFilters({ ...DEFAULTS, families: ['operations', 'delivery'] }) === 1);
  ok('20. se acumulan varias dimensiones',
    L.countActiveFilters({ ...DEFAULTS, aiDecision: 'YES', minScore: 80, company: 'X' }) === 3);
  ok('21. una empresa en blanco no cuenta',
    L.countActiveFilters({ ...DEFAULTS, company: '   ' }) === 0);

  section('Limpiar filtros');
  const cleared = L.clearedFilters({
    status: 'discarded', search: 'delivery', aiDecision: 'NO', easyApply: 'yes',
    minScore: 80, company: 'Acme', matchedQuery: 'Operations Lead', families: ['operations', 'delivery'],
  });
  ok('22. conserva la vista de estado y la busqueda libre',
    cleared.status === 'discarded' && cleared.search === 'delivery');
  ok('23. resetea todas las dimensiones del panel',
    L.countActiveFilters(cleared) === 0 && cleared.families.length === 0);

  const jobs = [
    { jobId: '1', title: 'A', company: 'Acme', userState: { status: 'new' }, aiAnalysis: { decision: 'YES', overallMatchScore: 90 }, analysisStatus: 'completed', matchedFamilies: ['operations'] },
    { jobId: '2', title: 'B', company: 'Otra', userState: { status: 'new' }, aiAnalysis: { decision: 'NO', overallMatchScore: 30 }, analysisStatus: 'completed', matchedFamilies: ['delivery'] },
  ];
  const filtered = { ...DEFAULTS, aiDecision: 'YES', minScore: 80, company: 'Acme' };
  ok('24. limpiar no cambia como se filtra: solo vuelve a los defaults',
    L.filterJobs(jobs, filtered).map((j) => j.jobId).join() === '1'
    && L.filterJobs(jobs, L.clearedFilters(filtered)).map((j) => j.jobId).join() === '1,2');

  section('Contrato de markup de la bandeja');
  const pub = path.join(__dirname, '..', 'ui', 'public');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');

  ok('25. el tema se aplica antes de la hoja de estilos (evita el flash)',
    html.indexOf('/uiPrefs.js') < html.indexOf('/styles.css') && html.includes('applyStoredTheme'));
  ok('26. existe el toggle de tema con etiqueta accesible',
    html.includes('id="themeToggle"') && /id="themeToggle"[^>]*aria-label=/.test(html));
  ok('27. light y dark comparten estructura de tokens',
    css.includes(':root {') && css.includes("[data-theme='dark']") && css.includes('--surface-2: var(--surface-secondary)'));
  ok('28. los seis filtros viven en el panel desplegable',
    ['aiDecisionFilter', 'easyApplyFilter', 'scoreFilter', 'queryFilter', 'companyFilter', 'familyFilter']
      .every((id) => html.includes(`id="${id}"`))
    && html.indexOf('id="filterDrawer"') < html.indexOf('id="aiDecisionFilter"'));
  ok('29. el panel se superpone a la lista en lugar de empujarla',
    /\.filter-drawer\s*\{[^}]*position:\s*absolute/.test(css));
  ok('30. el boton de filtros declara su panel',
    html.includes('id="filtersBtn"') && html.includes('aria-controls="filterDrawer"'));
  ok('31. existen indicador y chips de filtros activos',
    html.includes('id="filterCount"') && html.includes('id="activeChips"') && app.includes('renderFilterState'));
  ok('32. todos los filtros del panel refrescan el indicador',
    (app.match(/renderList\(\); renderFilterState\(\);/g) || []).length === 5);
  ok('33. la app ocupa el viewport sin scroll global',
    /body\s*\{[^}]*height:\s*100vh/.test(css) && /body\s*\{[^}]*overflow:\s*hidden/.test(css));
  ok('34. la cabecera del detalle acota valores desmedidos',
    /\.meta-line\s*>\s*span\s*\{[^}]*text-overflow:\s*ellipsis/.test(css));
  ok('35. la lista conserva un tamano de texto legible',
    /\.job-title\s*\{[^}]*font-size:\s*13px/.test(css));
  ok('36. se conservan las cinco acciones del detalle',
    ['interested', 'discard', 'applied', 'priority', 'read']
      .every((a) => app.includes(`data-act="${a}"`)));

  section('Configuracion: seccion de Telegram');
  ok('36a. Telegram es una seccion mas de Configuracion, no una pantalla nueva',
    html.includes('data-section="telegram"')
    && (html.match(/class="settings-nav-item"[^>]*data-section="telegram"/) || []).length === 1
    && (html.match(/class="settings-panel" data-section="telegram"/) || []).length === 1);
  ok('36b. la seccion de Telegram nace oculta como las demas',
    /class="settings-panel" data-section="telegram" hidden/.test(html));
  ok('36c. las cuatro secciones anteriores siguen presentes',
    ['search', 'schedule', 'notifications', 'linkedin']
      .every((s) => html.includes(`data-section="${s}"`)));
  ok('36d. la bandeja compacta no cambia: Telegram vive dentro del overlay',
    html.indexOf('id="settingsView"') < html.indexOf('data-section="telegram"')
    && html.indexOf('data-section="telegram"') < html.indexOf('id="mainLayout"'));
  ok('36e. existen los controles de onboarding y de estado',
    ['telegramToken', 'telegramValidateBtn', 'telegramDetectBtn', 'telegramCandidates',
      'telegramEnabled', 'telegramTestBtn', 'telegramUnlinkBtn', 'telegramState']
      .every((id) => html.includes(`id="${id}"`)));
  ok('36f. el campo del token no se rellena nunca desde el estado guardado',
    /el\('telegramToken'\)\.value = '';/.test(app)
    && !/el\('telegramToken'\)\.value = [^']/.test(app)
    && !/value="[^"]/.test((html.match(/<input id="telegramToken"[^>]*>/) || [''])[0]));
  ok('36g. el token viaja como campo de contrasena y sin autocompletado',
    /<input id="telegramToken"[^>]*type="password"/.test(html)
    && /<input id="telegramToken"[^>]*autocomplete="off"/.test(html));
  ok('36h. vincular una cuenta exige un clic explicito por candidato',
    app.includes('data-link-index') && app.includes('linkTelegramAccount')
    && !/autoLink|linkFirst/.test(app));
  ok('36i. la UI no muestra el Telegram User ID como dato que haya que entender',
    !/User ID|userId:/.test(html));

  section('Configuracion de busqueda: los grupos nunca se pierden');
  const baseConfig = () => ({
    identity: { name: 'Test User', linkedinUrl: 'https://www.linkedin.com/in/test-user/' },
    cvSource: 'profile.json',
    search: {
      targetAnalyzedJobs: 20,
      locations: ['Ciudad A'],
      modalities: ['remote'],
      queryGroups: [
        { family: 'operations', label: 'Operations', enabled: true, priority: 1, queries: [{ query: 'Ops Manager', enabled: true }, { query: 'Ops Lead', enabled: false }] },
        { family: 'delivery', label: 'Delivery', enabled: true, priority: 2, queries: [{ query: 'Delivery Manager', enabled: true }] },
        { family: 'strategy', label: 'Strategy', enabled: false, priority: 3, queries: [{ query: 'Transformation', enabled: false }] },
      ],
    },
  });
  const editable = toEditableSearch(baseConfig());
  const fullBody = (over) => Object.assign({
    targetAnalyzedJobs: 20, locations: ['Ciudad A'], modalities: ['remote'],
    queryGroups: editable.queryGroups.map((g) => ({ family: g.family, enabled: g.enabled, queries: g.queries.slice() })),
  }, over || {});

  ok('37. la vista editable expone un bloque por grupo existente',
    editable.queryGroups.length === 3
    && editable.queryGroups.map((g) => g.family).join() === 'operations,delivery,strategy'
    && editable.queryGroups[0].label === 'Operations');

  const onlyOps = fullBody();
  onlyOps.queryGroups[0].queries = ['Ops Manager', 'Head of Ops'];
  const afterEdit = applySearchSettings(baseConfig(), onlyOps);
  ok('38. editar un grupo no toca a los demas',
    afterEdit.search.queryGroups.length === 3
    && JSON.stringify(afterEdit.search.queryGroups[1]) === JSON.stringify(baseConfig().search.queryGroups[1])
    && JSON.stringify(afterEdit.search.queryGroups[2]) === JSON.stringify(baseConfig().search.queryGroups[2]));
  ok('39. se conservan identidad, rotulo, prioridad y orden',
    afterEdit.search.queryGroups.map((g) => g.family + '/' + g.label + '/' + g.priority).join() === 'operations/Operations/1,delivery/Delivery/2,strategy/Strategy/3');
  ok('40. una query que sobrevive conserva su estado y una nueva nace activa',
    afterEdit.search.queryGroups[0].queries[0].enabled === true
    && afterEdit.search.queryGroups[0].queries[1].query === 'Head of Ops'
    && afterEdit.search.queryGroups[0].queries[1].enabled === true);
  ok('41. un grupo desactivado sigue desactivado con sus queries intactas',
    afterEdit.search.queryGroups[2].enabled === false
    && afterEdit.search.queryGroups[2].queries[0].enabled === false);

  let omitted = null;
  try { applySearchSettings(baseConfig(), fullBody({ queryGroups: [{ family: 'operations', enabled: true, queries: ['Ops Manager'] }] })); }
  catch (e) { omitted = e; }
  ok('42. omitir grupos se rechaza en lugar de descartarlos en silencio',
    !!omitted && /Faltan grupos/.test(omitted.message) && omitted.statusCode === 400);

  let unknown = null;
  try { applySearchSettings(baseConfig(), fullBody({ queryGroups: editable.queryGroups.concat([{ family: 'inventado', enabled: true, queries: ['X'] }]) })); }
  catch (e) { unknown = e; }
  ok('43. no se pueden inventar grupos desde el editor', !!unknown && /no existe/.test(unknown.message));

  const toggled = fullBody();
  toggled.queryGroups[2].enabled = true;
  ok('44. el interruptor del grupo si es editable',
    applySearchSettings(baseConfig(), toggled).search.queryGroups[2].enabled === true);

  const messy = fullBody();
  messy.queryGroups[1].queries = ['  Delivery Manager  ', '', 'delivery manager', 'Head of Delivery'];
  const cleaned = applySearchSettings(baseConfig(), messy).search.queryGroups[1].queries;
  ok('45. se limpian espacios, vacios y duplicados sin perder el resto',
    cleaned.map((q) => q.query).join() === 'Delivery Manager,Head of Delivery');

  ok('46. el objetivo de analisis respeta el rango existente',
    applySearchSettings(baseConfig(), fullBody({ targetAnalyzedJobs: 50 })).search.targetAnalyzedJobs === 50);
  let badTarget = null;
  try { applySearchSettings(baseConfig(), fullBody({ targetAnalyzedJobs: 51 })); } catch (e) { badTarget = e; }
  ok('47. un objetivo fuera de rango se rechaza', !!badTarget);
  let noQueries = null;
  try {
    const empty = fullBody();
    empty.queryGroups.forEach((g) => { g.queries = []; });
    applySearchSettings(baseConfig(), empty);
  } catch (e) { noQueries = e; }
  ok('48. no se puede dejar la busqueda sin ninguna query activa', !!noQueries);
  ok('49. se conservan campos ajenos al editor',
    applySearchSettings(baseConfig(), fullBody()).cvSource === 'profile.json');

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run();

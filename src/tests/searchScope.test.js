'use strict';

// Compatibilidad con la barra de busqueda unificada de LinkedIn Jobs.
//
// Regresion del fallo real observado en mdrun_04183018c309f616: las dos
// busquedas terminaron en SOURCE_FAILED porque el combobox de ubicacion EXISTE
// y su selector SIGUE casando, pero su contenedor esta en display:none mientras
// la barra unificada esta colapsada, y getLocationInput exige visibilidad.
//
// Cubre ademas los otros dos defectos probados en vivo:
//   - la sugerencia localizada ("Barcelona, Cataluña, España") no casaba con el
//     texto configurado ("Barcelona, spain");
//   - cualquier geoId se aceptaba como prueba de la ubicacion, aunque fuese el
//     de un pais entero.
//
// Determinista: sin LinkedIn, sin Chromium, sin OpenAI, sin red.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const {
  applyLocationFilter,
  verifyFiltersActive,
  ensureSearchBoxExpandedForLocation,
  initializeSearchWithFilters,
  matchesConfiguredLocality,
  configuredLocalityToken,
  normalizeLocationText,
  rankLocationCandidate,
  LOCATION_RESOLUTION,
  LOCATION_INPUT_SELECTORS,
  KEYWORD_INPUT_SELECTORS,
} = require('../linkedin/searchScope');
const { createLinkedinMarketSource, STATUS, SCOPE } = require('../marketDiscovery/linkedinMarketSource');
const { OPERATION_TYPES, createOwner } = require('../domain/operationOwner');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('[PASS] ' + name); }
async function testAsync(name, fn) { await fn(); passed += 1; console.log('[PASS] ' + name); }

const CONFIGURED = 'Barcelona, spain';
const BARCELONA_OPTIONS = [
  'Barcelona, Cataluña, España',
  '08001, Barcelona, Catalonia, Spain',
  '08013, Barcelona, Catalonia, Spain',
  'Barceloneta, Cataluña, España',
];

// --- Doble de pagina de LinkedIn Jobs -----------------------------------
//
// Modela lo que importa del DOM real observado en vivo:
//   - el combobox de keyword esta SIEMPRE visible;
//   - el de ubicacion esta presente pero OCULTO mientras la barra esta
//     colapsada, y se vuelve visible al activar la barra por el keyword;
//   - el typeahead devuelve opciones ya localizadas;
//   - tras un Enter a ciegas el control conserva el texto que escribimos,
//     que es justo lo que hace inservible releerlo como prueba.
function linkedinPage(config = {}) {
  const state = {
    expanded: config.expanded === true,
    locationPresent: config.locationPresent !== false,
    locationValue: config.initialLocationValue === undefined ? 'España' : config.initialLocationValue,
    suggestions: [],
    options: config.options || BARCELONA_OPTIONS,
    url: config.url || 'https://www.linkedin.com/jobs/search/?keywords=Retail+Architect',
    geoIdOnSelection: config.geoIdOnSelection === undefined ? '999888777' : config.geoIdOnSelection,
    actions: [],
    typed: '',
  };

  const matchesLocationSelector = (sel) => sel.includes('jobs-search-box-location-id-')
    || sel.includes('autocomplete="address-level2"')
    || sel.includes('Ciudad, provincia/estado');
  const matchesKeywordSelector = (sel) => sel.includes('jobs-search-box-keyword-id-')
    || sel.includes('autocomplete="organization-title"')
    || sel.includes('Busca por cargo');
  const locationVisible = () => state.locationPresent && state.expanded;

  function element(kind, extra = {}) {
    const el = {
      kind,
      first: () => el,
      nth: () => el,
      filter: () => el,
      count: async () => (extra.count === undefined ? 1 : extra.count),
      isVisible: async () => (typeof extra.visible === 'function' ? extra.visible() : !!extra.visible),
      waitFor: async () => {
        const visible = typeof extra.visible === 'function' ? extra.visible() : !!extra.visible;
        if (!visible) throw new Error('not visible');
      },
      innerText: async () => extra.text || '',
      getAttribute: async () => null,
      isEnabled: async () => true,
      scrollIntoViewIfNeeded: async () => {},
      check: async () => { state.actions.push(['check', kind]); },
      click: async () => { state.actions.push(['click', kind]); if (extra.onClick) extra.onClick(); },
      fill: async (value) => { state.actions.push(['fill', value]); if (extra.onFill) extra.onFill(value); },
      type: async (value, opts) => { state.actions.push(['type', value, opts]); if (extra.onType) extra.onType(value); },
      press: async (key) => { state.actions.push(['press', key]); if (extra.onPress) extra.onPress(key); },
      locator: (sel) => router(sel),
    };
    return el;
  }

  const emptyElement = () => element('none', { count: 0, visible: false });

  function router(selector) {
    const sel = String(selector);

    if (matchesLocationSelector(sel)) {
      // El fallback de DOM ingles no existe en esta cuenta, igual que en vivo.
      if (sel === LOCATION_INPUT_SELECTORS[2]) return emptyElement();
      return element('location', {
        count: state.locationPresent ? 1 : 0,
        visible: locationVisible,
        onClick: () => {},
        onFill: (value) => { state.locationValue = value; state.suggestions = []; },
        onType: (value) => {
          state.typed = value;
          state.locationValue = value;
          state.suggestions = state.options.slice();
        },
        onPress: (key) => {
          // Enter a ciegas: LinkedIn deja EN EL CONTROL lo que escribimos.
          if (key === 'Enter') state.suggestions = [];
        },
      });
    }

    if (matchesKeywordSelector(sel)) {
      if (sel === KEYWORD_INPUT_SELECTORS[2]) return emptyElement();
      return element('keyword', { count: 1, visible: true, onClick: () => { state.expanded = true; } });
    }

    if (sel.includes('basic-typeahead__selectable') || sel.includes('role="option"')) {
      const list = state.suggestions;
      const suggestion = {
        first: () => suggestion,
        count: async () => list.length,
        nth: (i) => element('suggestion:' + list[i], {
          count: 1,
          visible: true,
          text: list[i],
          onClick: () => {
            state.locationValue = list[i];
            state.suggestions = [];
            state.expanded = false; // la barra vuelve a colapsarse, como en vivo
            if (state.geoIdOnSelection) {
              state.url = 'https://www.linkedin.com/jobs/search/?keywords=Retail+Architect'
                + '&geoId=' + state.geoIdOnSelection
                + '&origin=JOB_SEARCH_PAGE_LOCATION_AUTOCOMPLETE&refresh=true';
            }
          },
        }),
        isVisible: async () => list.length > 0,
        waitFor: async () => { if (!list.length) throw new Error('not visible'); },
        filter: () => suggestion,
        locator: (s) => router(s),
      };
      return suggestion;
    }

    if (sel.includes('data-occludable-job-id') || sel.includes('job-card-container')) {
      return element('cards', { count: 1, visible: true });
    }
    if (sel.includes('search-reusables__all-filters-pill-button') || sel.includes('Mostrar todos los filtros')) {
      return element('allFilters', { count: 1, visible: true });
    }
    if (sel.includes('artdeco-modal') || sel.includes('role="dialog"')) {
      return element('modal', { count: 1, visible: true });
    }
    if (sel.includes('show-results-button') || sel.includes('Aplicar los filtros')) {
      return element('showResults', {
        count: 1,
        visible: true,
        onClick: () => {
          for (const id of state.checkedFilters || []) {
            if (id.includes('timePostedRange-r')) state.url += '&f_TPR=' + id.split('timePostedRange-')[1];
            if (id.includes('jobType-')) state.url += '&f_JT=' + id.split('jobType-')[1];
          }
        },
      });
    }
    if (sel.startsWith('label[for=')) {
      const id = sel.slice('label[for="'.length, -2);
      return element('label:' + id, {
        count: 1,
        visible: true,
        onClick: () => { state.checkedFilters = (state.checkedFilters || []).concat(id); },
      });
    }
    return emptyElement();
  }

  const page = {
    state,
    locator: router,
    url: () => state.url,
    goto: async (target) => { state.url = target; },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    // Emula el lado navegador de readSelectedLocationValue: devuelve el .value
    // real del control de ubicacion, este visible u oculto.
    evaluate: async (fn, arg) => {
      if (typeof arg === 'string' && matchesLocationSelector(arg)) {
        return state.locationPresent ? state.locationValue : null;
      }
      return null;
    },
  };
  return page;
}

const clicksOn = (page, kind) => page.state.actions.filter((a) => a[0] === 'click' && a[1] === kind).length;

(async () => {
  console.log('\n### Activacion de la barra unificada');

  await testAsync('1. ubicacion oculta se detecta y no se da por ausente', async () => {
    const page = linkedinPage({ expanded: false });
    const location = page.locator(LOCATION_INPUT_SELECTORS.join(', ')).first();
    assert.equal(await location.count(), 1, 'el selector sigue casando');
    assert.equal(await location.isVisible(), false, 'pero no es visible');
  });

  await testAsync('2. barra colapsada se activa por el combobox de keyword', async () => {
    const page = linkedinPage({ expanded: false });
    const outcome = await ensureSearchBoxExpandedForLocation(page, {});
    assert.equal(outcome.activated, true);
    assert.equal(outcome.visible, true);
    assert.equal(clicksOn(page, 'keyword'), 1, 'se activa por el keyword visible');
  });

  await testAsync('3. barra ya expandida no se toca', async () => {
    const page = linkedinPage({ expanded: true });
    const outcome = await ensureSearchBoxExpandedForLocation(page, {});
    assert.equal(outcome.activated, false);
    assert.equal(outcome.visible, true);
    assert.equal(clicksOn(page, 'keyword'), 0, 'no se hace clic si no hace falta');
  });

  await testAsync('4. tras activar, la ubicacion es visible y applyLocationFilter progresa', async () => {
    const page = linkedinPage({ expanded: false });
    const outcome = await applyLocationFilter(page, CONFIGURED, {});
    assert.equal(outcome.resolution, LOCATION_RESOLUTION.AUTOCOMPLETE_SELECTION);
    assert.equal(outcome.selectedLocation, 'Barcelona, Cataluña, España');
  });

  await testAsync('4b. ubicacion ausente conserva el LinkedInSelectorError estable', async () => {
    const page = linkedinPage({ expanded: false, locationPresent: false });
    let error;
    try { await applyLocationFilter(page, CONFIGURED, {}); } catch (e) { error = e; }
    assert.equal(error && error.name, 'LinkedInSelectorError');
    assert.equal(error.message, 'LinkedIn search location input was not found.');
    assert.equal(clicksOn(page, 'keyword'), 0, 'no se activa la barra si el control no existe');
  });

  console.log('\n### Seleccion de sugerencia localizada');

  await testAsync('5. Barcelona localizada se selecciona explicitamente', async () => {
    const page = linkedinPage({ expanded: false });
    const outcome = await applyLocationFilter(page, CONFIGURED, {});
    assert.equal(outcome.selectedLocation, 'Barcelona, Cataluña, España');
    assert.equal(page.state.actions.some((a) => a[0] === 'press' && a[1] === 'Enter'), false, 'no se cae al Enter ciego');
  });

  await testAsync('6. Madrid localizada se selecciona con la misma logica generica', async () => {
    const page = linkedinPage({
      expanded: false,
      options: ['Comunidad de Madrid, España', 'Madrid, Comunidad de Madrid, España', '28001, Madrid, Spain'],
    });
    const outcome = await applyLocationFilter(page, 'Madrid, spain', {});
    assert.equal(outcome.selectedLocation, 'Madrid, Comunidad de Madrid, España');
  });

  await testAsync('7. Paris con acentos se resuelve sin tratamiento especial', async () => {
    const page = linkedinPage({
      expanded: false,
      options: ['Île-de-France, France', 'Paris, Île-de-France, France', '75001, Paris, France'],
    });
    const outcome = await applyLocationFilter(page, 'Paris, france', {});
    assert.equal(outcome.selectedLocation, 'Paris, Île-de-France, France');
  });

  await testAsync('7b. la opcion a nivel de ciudad gana al codigo postal', async () => {
    assert.equal(rankLocationCandidate(CONFIGURED, 'Barcelona, Cataluña, España'), 0);
    assert.equal(rankLocationCandidate(CONFIGURED, '08001, Barcelona, Catalonia, Spain'), 1);
    assert.equal(rankLocationCandidate(CONFIGURED, 'Madrid, Comunidad de Madrid, España'), null);
  });

  console.log('\n### Coincidencia negativa');

  test('8. Barcelona no casa con Barceloneta', () => {
    assert.equal(matchesConfiguredLocality(CONFIGURED, 'Barceloneta, Cataluña, España'), false);
    assert.equal(rankLocationCandidate(CONFIGURED, 'Barceloneta, Cataluña, España'), null);
  });

  test('9. no se aceptan substrings arbitrarios', () => {
    assert.equal(matchesConfiguredLocality('Madrid, spain', 'MadridSomething, España'), false);
    assert.equal(matchesConfiguredLocality('Paris, france', 'ParisSomething, France'), false);
    assert.equal(matchesConfiguredLocality(CONFIGURED, 'BarcelonaSomething'), false);
  });

  test('10. un valor de pais no satisface una localidad configurada', () => {
    assert.equal(matchesConfiguredLocality(CONFIGURED, 'España'), false);
    assert.equal(matchesConfiguredLocality(CONFIGURED, ''), false);
    assert.equal(matchesConfiguredLocality(CONFIGURED, null), false);
  });

  test('11. una ciudad distinta no satisface la configurada', () => {
    assert.equal(matchesConfiguredLocality('Madrid, spain', 'Barcelona, Cataluña, España'), false);
    assert.equal(matchesConfiguredLocality(CONFIGURED, 'Madrid, Comunidad de Madrid, España'), false);
  });

  test('11b. la normalizacion es la documentada y el pais NO se exige', () => {
    assert.equal(normalizeLocationText('  Barcelona,   CATALUÑA '), 'barcelona, cataluna');
    assert.equal(configuredLocalityToken(CONFIGURED), 'barcelona');
    assert.equal(configuredLocalityToken('  ,  '), null);
    // Limitacion deliberada: "spain" nunca casa con "España"; por eso solo se
    // exige la localidad y el pais se ignora.
    assert.equal(matchesConfiguredLocality('spain', 'España'), false);
    assert.equal(matchesConfiguredLocality('España', 'España'), true);
  });

  console.log('\n### Verificacion de ubicacion');

  const verifyAfter = async (pageConfig, applyWith, verifyWith) => {
    const page = linkedinPage(pageConfig);
    await applyLocationFilter(page, applyWith, {});
    return { page, active: await verifyFiltersActive(page, { location: verifyWith }) };
  };

  await testAsync('12. valor seleccionado correcto => VERIFIED', async () => {
    const { active } = await verifyAfter({ expanded: false }, CONFIGURED, CONFIGURED);
    assert.equal(active.locationActive, true);
    assert.equal(active.selectedLocation, 'Barcelona, Cataluña, España');
    assert.equal(active.locationResolution, LOCATION_RESOLUTION.AUTOCOMPLETE_SELECTION);
    assert.equal(active.locationGeoId, '999888777', 'el geoId se registra como apoyo');
    assert.equal(active.locationFromAutocompleteOrigin, true);
  });

  await testAsync('13. valor correcto SIN geoId sigue siendo VERIFIED', async () => {
    const { active } = await verifyAfter({ expanded: false, geoIdOnSelection: null }, CONFIGURED, CONFIGURED);
    assert.equal(active.locationActive, true);
    assert.equal(active.locationGeoId, null, 'el geoId no es el verificador');
  });

  await testAsync('14. ciudad equivocada CON geoId => UNVERIFIED', async () => {
    const { active } = await verifyAfter({ expanded: false }, CONFIGURED, 'Madrid, spain');
    assert.equal(active.locationGeoId, '999888777');
    assert.equal(active.locationActive, false, 'un geoId valido no puede validar otra ciudad');
  });

  await testAsync('15. valor de pais CON geoId => UNVERIFIED', async () => {
    const { active } = await verifyAfter({ expanded: false, options: ['España'] }, 'España', CONFIGURED);
    assert.equal(active.selectedLocation, 'España');
    assert.equal(active.locationGeoId, '999888777');
    assert.equal(active.locationActive, false, 'un ambito de pais no prueba la localidad');
  });

  await testAsync('16. la via de autocompletado queda registrada', async () => {
    const { active } = await verifyAfter({ expanded: false }, CONFIGURED, CONFIGURED);
    assert.equal(active.locationResolution, LOCATION_RESOLUTION.AUTOCOMPLETE_SELECTION);
  });

  await testAsync('17. un Enter a ciegas NO puede verificar por si solo', async () => {
    // Sin sugerencias: se cae al Enter y el control conserva EXACTAMENTE el texto
    // configurado, que casaria con la localidad. Aun asi no se da por verificado.
    const page = linkedinPage({ expanded: false, options: [] });
    const outcome = await applyLocationFilter(page, CONFIGURED, {});
    assert.equal(outcome.resolution, LOCATION_RESOLUTION.TYPED_FALLBACK);
    assert.equal(page.state.actions.some((a) => a[0] === 'press' && a[1] === 'Enter'), true);
    const active = await verifyFiltersActive(page, { location: CONFIGURED });
    assert.equal(matchesConfiguredLocality(CONFIGURED, active.selectedLocation), true, 'el texto escrito si casaria');
    assert.equal(active.locationActive, false, 'pero el Enter a ciegas no es evidencia');
  });

  console.log('\n### Hunter');

  const HUNTER_FILTERS = { location: CONFIGURED, employmentType: 'Full-time', datePosted: 'Past week' };

  await testAsync('18/19/20. Hunter aplica ubicacion + Full-time + Past week sobre la barra unificada', async () => {
    const page = linkedinPage({ expanded: false });
    const { filtersActive } = await initializeSearchWithFilters(page, 'Retail Architect', HUNTER_FILTERS, {});
    assert.equal(clicksOn(page, 'keyword'), 1, 'la barra se expandio una sola vez');
    assert.equal(filtersActive.locationActive, true, 'ubicacion verificada');
    assert.equal(filtersActive.employmentTypeActive, true, 'Full-time sigue aplicandose');
    assert.equal(filtersActive.datePostedActive, true, 'Past week sigue aplicandose');
    assert.deepEqual(page.state.checkedFilters, ['advanced-filter-timePostedRange-r604800', 'advanced-filter-jobType-F']);
  });

  console.log('\n### Market Discovery');

  await testAsync('21/22/23. MD aplica solo la ubicacion y no hereda filtros de Hunter', async () => {
    const page = linkedinPage({ expanded: false });
    const mdFilters = { location: CONFIGURED, employmentType: null, datePosted: null };
    const { filtersActive } = await initializeSearchWithFilters(page, 'Retail Architect', mdFilters, {});
    assert.equal(filtersActive.locationActive, true);
    assert.equal(filtersActive.employmentTypeActive, null, 'Full-time no se hereda');
    assert.equal(filtersActive.datePostedActive, null, 'Past week no se hereda');
    assert.equal(page.state.checkedFilters, undefined, 'no se marca ningun filtro del modal');
    assert.ok(!/f_JT=|f_TPR=/.test(page.state.url), 'la URL no gana filtros de Hunter');
  });

  const MD_OWNER = createOwner(OPERATION_TYPES.MARKET_DISCOVERY, 'md_scope1');
  const mdRequest = () => ({
    owner: MD_OWNER,
    page: {},
    search: { searchId: 'd0_1', familyId: null, query: 'Retail Architect', queryLanguage: 'und' },
    filters: { location: CONFIGURED },
  });

  await testAsync('24. MD conserva su cierre en falso: UNVERIFIED => SCOPE_NOT_VERIFIED sin ofertas', async () => {
    const source = createLinkedinMarketSource({
      initializeSearch: async () => {},
      collectSearch: async () => ({
        metadata: { rawResults: 2, uniqueResults: 2, pagesVisited: 1, stopReason: 'no_next_page',
          filtersActive: { url: 'https://x/?geoId=1', locationActive: false, datePostedActive: null, employmentTypeActive: null } },
        jobs: [{ jobId: '1', url: 'u', title: 't', company: 'c', location: 'l', easyApply: false }],
      }),
    });
    const outcome = await source.search(mdRequest());
    assert.equal(outcome.status, STATUS.INTERRUPTED);
    assert.equal(outcome.stopReason, 'scope_not_verified');
    assert.equal(outcome.observedScope.location, SCOPE.UNVERIFIED);
    assert.equal(outcome.results.length, 0);
  });

  await testAsync('25. fallo de selector/aplicacion sigue siendo SOURCE_FAILED', async () => {
    const selectorError = new Error('LinkedIn search location input was not found.');
    selectorError.name = 'LinkedInSelectorError';
    const source = createLinkedinMarketSource({
      initializeSearch: async () => { throw selectorError; },
      collectSearch: async () => { throw new Error('unreachable'); },
    });
    const outcome = await source.search(mdRequest());
    assert.equal(outcome.status, STATUS.FAILED);
    assert.equal(outcome.stopReason, 'source_failed', 'no se remapea a scope_not_verified');
    assert.equal(outcome.observedScope.location, SCOPE.UNVERIFIED);
  });

  console.log('\n### Contrato y riesgos estaticos');

  const source = fs.readFileSync(path.join(__dirname, '../linkedin/searchScope.js'), 'utf8');
  // Se juzga el CODIGO, no los comentarios: la documentacion si cita ciudades
  // como ejemplo, pero ninguna puede influir en el comportamiento.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('26. no hay ninguna ciudad cableada en la implementacion', () => {
    for (const city of ['Barcelona', 'Madrid', 'Paris', 'Cataluña', 'España', 'Barceloneta']) {
      assert.ok(!new RegExp(city, 'i').test(code), 'aparece ' + city + ' en el codigo de searchScope.js');
    }
  });

  test('27. no hay ningun geoId cableado en la implementacion', () => {
    assert.ok(!/107025191/.test(source), 'geoId de Barcelona cableado');
    assert.ok(!/geoId\s*=\s*['"]?\d/.test(source), 'geoId literal cableado');
  });

  test('27b. los selectores que la diagnosis probo validos se conservan', () => {
    assert.equal(LOCATION_INPUT_SELECTORS[0], 'input[id^="jobs-search-box-location-id-"][role="combobox"]');
    assert.equal(LOCATION_INPUT_SELECTORS.length, 4);
    assert.equal(KEYWORD_INPUT_SELECTORS.length, 4);
  });

  await testAsync('28. la deteccion de challenge sigue cortando la aplicacion de ubicacion', async () => {
    const page = linkedinPage({ expanded: false });
    // LinkedIn corta justo despues de aplicar la ubicacion: la navegacion
    // resultante aterriza en un checkpoint.
    page.waitForLoadState = async () => { page.state.url = 'https://www.linkedin.com/checkpoint/challenge/'; };
    let error;
    try { await applyLocationFilter(page, CONFIGURED, {}); } catch (e) { error = e; }
    assert.equal(error && error.name, 'SecurityChallengeError');
    assert.ok(error.challengeDiagnostic, 'conserva el diagnostico acotado');
  });

  await testAsync('29. la cancelacion sigue cortando antes de tocar LinkedIn', async () => {
    const page = linkedinPage({ expanded: false });
    const controller = new AbortController();
    controller.abort();
    let error;
    try {
      await initializeSearchWithFilters(page, 'Retail Architect', HUNTER_FILTERS, { signal: controller.signal });
    } catch (e) { error = e; }
    assert.equal(error && error.name, 'HuntCancelledError');
    assert.equal(page.state.actions.length, 0, 'no se ejecuto ninguna accion de UI');
  });

  await testAsync('30. la inicializacion completa de busqueda sigue verde', async () => {
    const page = linkedinPage({ expanded: false });
    const result = await initializeSearchWithFilters(page, 'Retail Architect', HUNTER_FILTERS, {});
    assert.ok(result.filtersActive, 'devuelve la verificacion de filtros');
    assert.ok(page.state.url.startsWith('https://www.linkedin.com/jobs/search/'));
    assert.equal(clicksOn(page, 'allFilters'), 1);
    assert.equal(clicksOn(page, 'showResults'), 1);
  });

  console.log(`\n${passed} comprobaciones OK`);
})().catch((error) => {
  console.error('\n[FAIL]', error && error.stack ? error.stack : error);
  process.exit(1);
});

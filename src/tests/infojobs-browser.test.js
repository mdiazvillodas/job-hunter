'use strict';

// Collector + detalle de InfoJobs contra una web SIMULADA (page.route, sin red real).
// Las paginas imitan la forma de la web: tarjetas con links /of-<id>, paginacion por
// ?page=N, JSON-LD JobPosting en la oferta. Cubre tambien el corte por CAPTCHA.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { collectQuery, collectInfoJobsSearches } = require('../infojobs/collector');
const { fetchInfoJobsDetail } = require('../infojobs/detail');
const { extractSearchCardsDom, extractOfferDetailDom } = require('../infojobs/extract');

const FILTERS = { location: 'Barcelona', provinceId: '9', employmentType: 'Full-time', datePosted: 'Past week' };
const FAST = { minDelayMs: 0, maxDelayMs: 0 };
const DESC = '<p>Buscamos <b>Director/a de Operaciones</b> para liderar procesos y equipos.</p><ul><li>Gestión de P&amp;L</li><li>Mejora continua</li></ul>' + '<p>Responsabilidades de operaciones, presupuesto y personas.</p>'.repeat(8);

function card(id, title, company, city, extra = '') {
  return `<li class="ij-List-item"><div class="ij-OfferCard">
    <h2 class="ij-OfferCardContent-description-title"><a href="//www.infojobs.net/${city.toLowerCase()}/${title.toLowerCase().replace(/\W+/g, '-')}/of-${id}?applicationOrigin=search-new&page=1">${title}</a></h2>
    <h3 class="ij-OfferCardContent-description-subtitle"><a href="https://www.infojobs.net/${company.toLowerCase()}/em-i123">${company}</a></h3>
    <ul><li class="ij-OfferCardContent-description-list-item">${city}</li><li>Presencial</li><li>Hace 2d</li></ul>
    <a class="ij-OfferCardContent-description-description-link" href="https://www.infojobs.net/${city.toLowerCase()}/x/of-${id}">Ver oferta</a>
    <p>Contrato indefinido | ${extra || 'Jornada completa'} | 40.000€ - 50.000€ Bruto/año</p>
  </div></li>`;
}

function searchPage(cards) {
  return `<!doctype html><html><body><header><a href="/">InfoJobs</a></header><main><ul>${cards.join('')}</ul></main></body></html>`;
}

const PAGES = {
  1: [
    card('i1111111111aaaaaaaaaa', 'Director de Operaciones', 'ACME', 'Barcelona'),
    card('i2222222222bbbbbbbbbb', 'Responsable de Operaciones', 'Globex', "L'Hospitalet de Llobregat"),
    card('i3333333333cccccccccc', 'Operations Manager', 'Initech', 'Barcelona', 'Jornada parcial'),
  ],
  2: [
    card('i4444444444dddddddddd', 'Head of Operations', 'Umbrella', 'Barcelona'),
    card('i1111111111aaaaaaaaaa', 'Director de Operaciones', 'ACME', 'Barcelona'),
  ],
};

function offerPage(withJsonLd) {
  const ld = withJsonLd ? `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Director de Operaciones', description: DESC,
    hiringOrganization: { '@type': 'Organization', name: 'ACME' },
    jobLocation: { '@type': 'Place', address: { addressLocality: 'Barcelona', addressRegion: 'Barcelona' } },
    employmentType: 'FULL_TIME', datePosted: '2026-10-01',
    baseSalary: { '@type': 'MonetaryAmount', currency: 'EUR', value: { '@type': 'QuantitativeValue', minValue: 40000, maxValue: 50000, unitText: 'YEAR' } },
  })}</script>` : '';
  // Sin JSON-LD = estructura REAL de InfoJobs (capturada con npm run recon:infojobs).
  const body = withJsonLd ? '<h1>Director de Operaciones</h1>' : `
    <section><article><div><h1 class="ij-Heading-title1">Responsable de Operaciones</h1></div>
      <div class="ij-Box ij-OfferDetailHeader-companyLogo"><div class="ij-OfferDetailHeader-companyLogo-title"><div class="ij-Box ij-OfferDetailHeader-companyLogo-companyName"><a href="//globex.ofertas-trabajo.infojobs.net">Globex</a></div></div></div>
      <div class="ij-OfferDetailHeader-details"><div class="ij-OfferDetailHeader-detailsList">
        <div class="ij-OfferDetailHeader-detailsList-column">
          <div class="ij-Box ij-OfferDetailHeader-detailsList-item"><p>L'Hospitalet de Llobregat (<a href="/ofertas-trabajo/barcelona">Barcelona</a>)</p></div>
          <div class="ij-Box ij-OfferDetailHeader-detailsList-item"><p>Híbrido</p></div>
          <div class="ij-Box ij-OfferDetailHeader-detailsList-item"><p>45.000€ - 55.000€ Bruto/año</p></div>
        </div><div class="ij-OfferDetailHeader-detailsList-column">
          <div class="ij-Box ij-OfferDetailHeader-detailsList-item"><p>Experiencia mínima: Al menos 5 años</p></div>
          <div class="ij-Box ij-OfferDetailHeader-detailsList-item"><p>Contrato indefinido, jornada completa</p></div>
        </div></div></div></article></section>
    <section class="ij-Box ij-OfferDetailPage-mainContent">
      <article class="ij-Box"><h3>Requisitos</h3><dl>
        <dt>Estudios mínimos</dt><dd><p>Grado</p></dd>
        <dt>Conocimientos necesarios</dt><dd><div><a href="/ofertas-trabajo/lean"><span class="sui-AtomTag-label">Lean</span></a><a href="/ofertas-trabajo/sap"><span class="sui-AtomTag-label">SAP</span></a></div></dd>
      </dl></article>
      <article class="ij-Box"><h3>Descripción</h3><div class="ij-EnrichedTextArea-paragraph">${DESC}</div></article>
      <article><h3>Ofertas similares</h3><h2 class="ij-OfferCardContent2-titleContainer">Otra oferta que no es esta</h2></article>
    </section>`;
  return `<!doctype html><html><head>${ld}</head><body>${body}<p>Experiencia mínima: Al menos 5 años</p></body></html>`;
}

async function withPage(t, handler) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const visited = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    visited.push(url.toString());
    const html = handler(url);
    if (html == null) return route.abort();
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
  return { page, visited };
}

function fakeInfoJobs(url) {
  if (!/infojobs\.net$/.test(url.hostname)) return null;
  if (url.pathname.startsWith('/jobsearch/')) {
    const n = Number(url.searchParams.get('page') || 1);
    return searchPage(PAGES[n] || PAGES[2]); // como la web: una pagina inexistente repite la ultima
  }
  if (url.pathname.includes('/of-i1111111111')) return offerPage(true);
  if (url.pathname.includes('/of-i2222222222')) return offerPage(false);
  return '<html><body>404</body></html>';
}

test('busqueda: tarjetas, paginacion, dedup, jornada parcial fuera, filtros verificados', async (t) => {
  const { page, visited } = await withPage(t, fakeInfoJobs);
  const r = await collectQuery(page, 'Director de Operaciones', FILTERS, { ...FAST });
  const byId = Object.fromEntries(r.jobs.map((j) => [j.jobId, j]));

  assert.deepEqual(Object.keys(byId).sort(), ['ij_i1111111111aaaaaaaaaa', 'ij_i2222222222bbbbbbbbbb', 'ij_i4444444444dddddddddd']);
  assert.deepEqual(byId.ij_i1111111111aaaaaaaaaa, {
    jobId: 'ij_i1111111111aaaaaaaaaa', source: 'infojobs', title: 'Director de Operaciones', company: 'ACME', location: 'Barcelona',
    url: 'https://www.infojobs.net/barcelona/director-de-operaciones/of-i1111111111aaaaaaaaaa', easyApply: null, workplaceType: 'Presencial',
  });
  assert.equal(byId.ij_i2222222222bbbbbbbbbb.location, "L'Hospitalet de Llobregat");
  assert.equal(r.metadata.skippedPartTime, 1);
  assert.equal(r.metadata.pagesVisited, 3);
  assert.equal(r.metadata.stopReason, 'no_new_results');
  assert.equal(r.metadata.filtersActive.locationActive, true);
  assert.equal(r.metadata.filtersActive.datePostedActive, true);
  const first = new URL(visited.find((u) => u.includes('/jobsearch/')));
  assert.equal(first.searchParams.get('provinceIds'), '9');
  assert.equal(first.searchParams.get('sinceDate'), '_7_DAYS');
});

test('busqueda: respeta MAX_RESULTS y MAX_PAGES', async (t) => {
  const { page } = await withPage(t, fakeInfoJobs);
  const r1 = await collectQuery(page, 'x', FILTERS, { ...FAST, maxResults: 1 });
  assert.equal(r1.jobs.length, 1);
  assert.equal(r1.metadata.stopReason, 'max_results_reached');
  const r2 = await collectQuery(page, 'x', FILTERS, { ...FAST, maxPages: 1 });
  assert.equal(r2.metadata.pagesVisited, 1);
  assert.equal(r2.metadata.stopReason, 'max_pages_reached');
});

test('multi-query: misma forma que LinkedIn, acumula queries y familias', async (t) => {
  const { page } = await withPage(t, fakeInfoJobs);
  const r = await collectInfoJobsSearches(page, [
    { query: 'Director de Operaciones', family: 'operations' },
    { query: 'Head of Operations', family: 'operations' },
  ], FILTERS, { ...FAST, maxPagesPerSearch: 1 });
  assert.equal(r.metadata.searches.completed, 2);
  assert.equal(r.metadata.results.uniqueResults, 2);
  assert.equal(r.metadata.results.duplicatesRemoved, 2);
  const acme = r.jobs.find((j) => j.company === 'ACME');
  assert.deepEqual(acme.matchedQueries, ['Director de Operaciones', 'Head of Operations']);
  assert.deepEqual(acme.matchedFamilies, ['operations']);
});

test('detalle: JSON-LD JobPosting si la oferta lo trae (descripcion, salario)', async (t) => {
  const { page } = await withPage(t, fakeInfoJobs);
  const d = await fetchInfoJobsDetail(page, { jobId: 'ij_i1111111111aaaaaaaaaa', url: 'https://www.infojobs.net/barcelona/director-de-operaciones/of-i1111111111aaaaaaaaaa' });
  assert.equal(d.detailExtraction.status, 'description_extracted');
  assert.equal(d.detailExtraction.method, 'json_ld');
  assert.match(d.description, /^Buscamos Director\/a de Operaciones/);
  assert.match(d.description, /- Gestión de P&L/);
  assert.equal(d.company, 'ACME');
  assert.equal(d.employmentType, 'Full-time');
  assert.match(d.salary, /^40\.000 - 50\.000 EUR \/ año$/);
});

test('detalle: estructura real de InfoJobs (cabecera + Descripcion + Requisitos)', async (t) => {
  const { page } = await withPage(t, fakeInfoJobs);
  const d = await fetchInfoJobsDetail(page, { jobId: 'ij_i2222222222bbbbbbbbbb', url: 'https://www.infojobs.net/x/y/of-i2222222222bbbbbbbbbb' });
  assert.equal(d.detailExtraction.method, 'dom');
  assert.equal(d.detailExtraction.status, 'description_extracted');
  assert.match(d.description, /^Buscamos Director\/a de Operaciones/);
  assert.match(d.description, /Requisitos:\nEstudios mínimos: Grado\nConocimientos necesarios: Lean, SAP$/);
  assert.ok(!d.description.includes('Otra oferta que no es esta'));
  assert.equal(d.company, 'Globex');
  assert.equal(d.location, "L'Hospitalet de Llobregat (Barcelona)");
  assert.equal(d.workplaceType, 'Híbrido');
  assert.equal(d.salary, '45.000€ - 55.000€ Bruto/año');
  assert.equal(d.experienceMin, 'Al menos 5 años');
  assert.equal(d.contractType, 'Contrato indefinido, jornada completa');
  assert.equal(d.employmentType, 'Full-time');
});

test('CAPTCHA: se detiene con SecurityChallengeError y diagnostico de InfoJobs', async (t) => {
  const { page } = await withPage(t, (url) => (/infojobs\.net$/.test(url.hostname)
    ? '<html><body><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x" width="400" height="400"></iframe></body></html>'
    : '<html><body></body></html>'));
  await assert.rejects(
    collectQuery(page, 'x', FILTERS, { ...FAST }),
    (err) => err.name === 'SecurityChallengeError' && err.challengeDiagnostic.platform === 'infojobs' && err.challengeDiagnostic.signal === 'dom:datadome',
  );
});

test('extractores autocontenidos: pagina vacia no rompe', async (t) => {
  const { page } = await withPage(t, () => '<html><body><p>Sin resultados</p></body></html>');
  await page.goto('https://www.infojobs.net/vacio');
  assert.deepEqual((await page.evaluate(extractSearchCardsDom)).jobs, []);
  const d = await page.evaluate(extractOfferDetailDom);
  assert.equal(d.description, null);
  assert.equal(d.method, null);
});

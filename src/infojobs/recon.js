'use strict';

// Reconocimiento de InfoJobs: `npm run recon:infojobs`
//
// Script de UN SOLO USO para construir el collector de InfoJobs sobre la web real.
// Abre Chromium VISIBLE con el mismo ./browser-profile del hunt, hace una busqueda
// con los filtros del hunt (Barcelona, jornada completa, ultima semana), abre un par
// de ofertas y guarda lo que ve en  recon/infojobs/<fecha>/  (gitignored):
//
//   summary.json          URLs, conteos, candidatos de selectores, señales de challenge
//   search.html           HTML de la pagina de resultados (sin scripts de terceros)
//   search.png            captura completa
//   offer-1.html / .png   idem para cada oferta abierta
//   network/*.json        respuestas JSON que la propia web pidio a infojobs.net
//
// NO toca el repositorio de jobs, NO llama a OpenAI, NO envia notificaciones.
// Si aparece un CAPTCHA, NO se resuelve solo: se espera a que lo resuelvas a mano
// en la ventana (hasta 3 minutos) y despues sigue.

require('../env').loadProjectEnv();

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { BROWSER_PROFILE_DIR } = require('../config');
const { acquireLock, releaseLock } = require('../domain/huntLock');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SEARCH_KEYWORD = process.argv[2] || 'Operations Manager';
// Barcelona en el filtro de provincias de InfoJobs. A confirmar con este recon.
const SEARCH_URL = 'https://www.infojobs.net/jobsearch/search-results/list.xhtml?' + new URLSearchParams({
  keyword: SEARCH_KEYWORD,
  provinceIds: '9',
  sinceDate: '_7_DAYS',
}).toString();
const OFFERS_TO_OPEN = 2;
const CHALLENGE_WAIT_MS = 180000;
const MAX_NETWORK_FILES = 40;
const MAX_NETWORK_BYTES = 400000;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function log(m) {
  console.error('[recon] ' + m);
}

// Señales genericas de anti-bot / CAPTCHA. Solo para avisar y esperar.
async function challengeSignals(page) {
  return page.evaluate(() => {
    const found = [];
    const url = location.href.toLowerCase();
    if (/captcha|challenge|blocked|distil|perimeterx|datadome/.test(url)) found.push('url:' + url.slice(0, 120));
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      const src = (f.getAttribute('src') || '').toLowerCase();
      if (/captcha|datadome|geetest|hcaptcha|recaptcha|challenge/.test(src)) found.push('iframe:' + src.slice(0, 120));
    }
    const text = (document.body && document.body.innerText || '').slice(0, 5000);
    const m = text.match(/(eres humano o un robot|actividad poco habitual|hacer clic para comprobar|verifica que eres humano|no soy un robot|i'?m not a robot|verify you are human|acceso bloqueado|access denied|unusual traffic|tr[aá]fico inusual|press (?:&|and) hold|mant[eé]n pulsado)/i);
    if (m) found.push('text:' + m[0]);
    return found;
  }).catch(() => []);
}

async function waitOutChallenge(page, where) {
  let signals = await challengeSignals(page);
  if (!signals.length) return [];
  log(`CHALLENGE en ${where}: ${signals.join(' | ')}`);
  log('Resolvelo A MANO en la ventana del navegador. Espero hasta 3 minutos...');
  const deadline = Date.now() + CHALLENGE_WAIT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (!(await challengeSignals(page)).length) {
      log('Challenge resuelto, sigo.');
      return signals;
    }
  }
  log('El challenge sigue presente; guardo lo que hay igualmente.');
  return signals;
}

async function acceptCookies(page) {
  const candidates = [
    '#didomi-notice-agree-button',
    'button#onetrust-accept-btn-handler',
    'button:has-text("Aceptar y cerrar")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Aceptar")',
  ];
  for (const sel of candidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(800);
      return sel;
    }
  }
  return null;
}

// HTML liviano: fuera scripts ejecutables, estilos y contenido de SVG. Se conservan
// los <script> de datos (JSON-LD y JSON embebido), que es donde suele vivir la info util.
async function cleanHtml(page) {
  return page.evaluate(() => {
    const doc = document.documentElement.cloneNode(true);
    doc.querySelectorAll('script').forEach((s) => {
      const type = (s.getAttribute('type') || '').toLowerCase();
      const keep = type.includes('json') || (s.id && /data|state|next/i.test(s.id));
      if (!keep) s.remove();
    });
    doc.querySelectorAll('style, noscript, link[rel="stylesheet"]').forEach((n) => n.remove());
    doc.querySelectorAll('svg').forEach((n) => { n.innerHTML = ''; });
    return '<!doctype html>\n' + doc.outerHTML;
  });
}

// Pistas de estructura: links a ofertas y la cadena de clases de sus contenedores.
async function describeSearchPage(page) {
  return page.evaluate(() => {
    const offerLinks = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({ a, href: a.href }))
      .filter((x) => /infojobs\.net\/.+\/of-[a-z0-9]{10,}/i.test(x.href));
    const uniqueHrefs = Array.from(new Set(offerLinks.map((x) => x.href.split('?')[0])));
    const ancestry = (el) => {
      const chain = [];
      for (let e = el, i = 0; e && i < 6; e = e.parentElement, i += 1) {
        chain.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 4).join('.') : ''}`);
      }
      return chain;
    };
    const samples = offerLinks.slice(0, 3).map((x) => ({
      href: x.href,
      text: (x.a.innerText || '').trim().slice(0, 120),
      ancestry: ancestry(x.a),
      cardText: (x.a.closest('li, article, [class*="card" i], [class*="Card"]') || x.a.parentElement || x.a).innerText.trim().slice(0, 600),
    }));
    const pagination = Array.from(document.querySelectorAll('a[href*="page="], button[aria-label*="siguiente" i], a[aria-label*="siguiente" i], [class*="pagination" i] a, [class*="Pagination"] a'))
      .slice(0, 15)
      .map((e) => ({ tag: e.tagName.toLowerCase(), text: (e.innerText || '').trim().slice(0, 30), href: e.getAttribute('href'), aria: e.getAttribute('aria-label'), cls: typeof e.className === 'string' ? e.className.slice(0, 120) : null }));
    const resultCountText = (document.body.innerText.match(/[\d.]+\s+ofertas?[^\n]{0,60}/i) || [null])[0];
    const filterTexts = Array.from(document.querySelectorAll('[class*="filter" i], [class*="Filter"]'))
      .slice(0, 10).map((e) => (e.innerText || '').trim().slice(0, 200));
    const dataScripts = Array.from(document.querySelectorAll('script')).filter((s) => (s.getAttribute('type') || '').includes('json') || s.id)
      .map((s) => ({ id: s.id || null, type: s.getAttribute('type'), length: (s.textContent || '').length }));
    return { offerLinkCount: offerLinks.length, uniqueOfferUrls: uniqueHrefs, samples, pagination, resultCountText, filterTexts, dataScripts };
  });
}

async function describeOfferPage(page) {
  return page.evaluate(() => {
    const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map((s) => { try { return JSON.parse(s.textContent); } catch (e) { return { parseError: true, raw: s.textContent.slice(0, 500) }; } });
    const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 20)
      .map((h) => ({ tag: h.tagName.toLowerCase(), text: h.innerText.trim().slice(0, 100), cls: typeof h.className === 'string' ? h.className.slice(0, 100) : null }));
    // Bloque de texto mas largo: candidato a descripcion.
    let best = null;
    for (const e of Array.from(document.querySelectorAll('div, section, article'))) {
      const t = (e.innerText || '').trim();
      if (t.length < 300 || e.querySelectorAll('div, section, article').length > 12) continue;
      if (!best || t.length > best.length) best = { length: t.length, id: e.id || null, cls: typeof e.className === 'string' ? e.className.slice(0, 160) : null, preview: t.slice(0, 400) };
    }
    return { url: location.href, title: document.title, jsonLd: ld, headings, descriptionCandidate: best };
  });
}

async function main() {
  const outDir = path.join(PROJECT_ROOT, 'recon', 'infojobs', stamp());
  const netDir = path.join(outDir, 'network');
  fs.mkdirSync(netDir, { recursive: true });

  try {
    acquireLock();
  } catch (e) {
    if (e.code === 'LOCK_HELD') {
      log('Hay un hunt corriendo (usa el mismo navegador). Proba cuando termine.');
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  const summary = { keyword: SEARCH_KEYWORD, requestedUrl: SEARCH_URL, startedAt: new Date().toISOString(), search: null, offers: [], challenges: [], network: [] };
  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, { headless: false, channel: 'chromium', viewport: null });
  try {
    const page = context.pages()[0] || (await context.newPage());

    page.on('response', async (res) => {
      try {
        if (summary.network.length >= MAX_NETWORK_FILES) return;
        const url = res.url();
        if (!/infojobs\.net/i.test(new URL(url).hostname)) return;
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('json')) return;
        const body = await res.text();
        const file = `${String(summary.network.length + 1).padStart(2, '0')}.json`;
        fs.writeFileSync(path.join(netDir, file), body.slice(0, MAX_NETWORK_BYTES), 'utf8');
        summary.network.push({ file, url: url.slice(0, 400), status: res.status(), bytes: body.length });
      } catch (_) { /* respuesta no legible: se ignora */ }
    });

    log('Abriendo infojobs.net ...');
    await page.goto('https://www.infojobs.net/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    summary.challenges.push(...(await waitOutChallenge(page, 'home')));
    summary.cookieButton = await acceptCookies(page);
    summary.loggedInHint = await page.locator('a[href*="logout"], a[href*="mi-cuenta"], [class*="avatar" i]').first().isVisible({ timeout: 1500 }).catch(() => false);

    log('Buscando: ' + SEARCH_KEYWORD);
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    summary.challenges.push(...(await waitOutChallenge(page, 'search')));
    await acceptCookies(page);
    // Scroll para que se hidraten tarjetas perezosas.
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(500);
    }
    summary.search = { finalUrl: page.url(), title: await page.title(), ...(await describeSearchPage(page)) };
    fs.writeFileSync(path.join(outDir, 'search.html'), await cleanHtml(page), 'utf8');
    await page.screenshot({ path: path.join(outDir, 'search.png'), fullPage: true }).catch(() => {});
    log(`Resultados: ${summary.search.uniqueOfferUrls.length} ofertas detectadas`);

    const toOpen = summary.search.uniqueOfferUrls.slice(0, OFFERS_TO_OPEN);
    for (let i = 0; i < toOpen.length; i += 1) {
      log(`Abriendo oferta ${i + 1}/${toOpen.length}`);
      await page.goto(toOpen[i], { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      summary.challenges.push(...(await waitOutChallenge(page, `offer-${i + 1}`)));
      summary.offers.push(await describeOfferPage(page));
      fs.writeFileSync(path.join(outDir, `offer-${i + 1}.html`), await cleanHtml(page), 'utf8');
      await page.screenshot({ path: path.join(outDir, `offer-${i + 1}.png`), fullPage: true }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  } catch (err) {
    summary.error = err && err.message ? err.message : String(err);
    log('Error: ' + summary.error);
    process.exitCode = 1;
  } finally {
    summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    await context.close().catch(() => {});
    releaseLock();
  }

  log('Listo. Carpeta generada:');
  console.log(outDir);
  log('Comprimila (clic derecho > Enviar a > Carpeta comprimida) y adjuntala en el chat.');
}

main();

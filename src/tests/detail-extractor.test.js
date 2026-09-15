'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readJobDescription } = require('../linkedin/descriptionExtractor');
const { collectJobDetail } = require('../linkedin/detailCollector');

const text = 'Responsibilities include coordinating delivery and managing operational execution. '.repeat(8);
const settings = { detailTimeoutMs: 250, expansionTimeoutMs: 500, shortTextWaitMs: 100 };

for (const headless of [false, true]) {
  test(`Extractor HEADLESS=${headless}, DOM local sin red`, async t => {
    const browser = await chromium.launch({ headless, channel: 'chromium' });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    const read = () => readJobDescription(page, '123', settings);

    await t.test('primera copia hidden, segunda visible', async () => {
      await page.setContent(`<div id="JobDetails_AboutTheJob_123" hidden>${text.repeat(2)}</div><div id="JobDetails_AboutTheJob_123">${text}</div>`);
      const r = await read();
      assert.equal(r.description, text.trim());
      assert.equal(r.diagnostics.status, 'description_extracted');
      assert.equal(r.diagnostics.candidateCount, 2);
    });
    await t.test('elige contenido mas completo y excluye otra oferta', async () => {
      await page.setContent(`<div id="JobDetails_AboutTheJob_456">${text.repeat(4)}</div><div class="jobs-description-content__text">short</div><div id="job-details">${text}</div>`);
      assert.equal((await read()).description, text.trim());
    });
    await t.test('espera descripcion tardia', async () => {
      await page.setContent('<main>Loading</main>');
      await page.evaluate(value => setTimeout(() => {
        const e = document.createElement('div'); e.id = 'job-details'; e.textContent = value; document.body.append(e);
      }, 60), text);
      assert.equal((await read()).description, text.trim());
    });
    await t.test('espera reemplazo de texto parcial', async () => {
      await page.setContent('<div id="job-details">Loading description</div>');
      await page.evaluate(value => setTimeout(() => { document.getElementById('job-details').textContent = value; }, 40), text);
      assert.equal((await read()).description, text.trim());
    });
    await t.test('Show more oculto + visible, confirma expansion real', async () => {
      await page.setContent(`<button onclick="window.wrong=true">Show more</button>
        <div class="jobs-description__content"><div data-testid="expandable-text-box">Short preview</div>
        <button hidden onclick="window.wrong=true">Show more</button>
        <button id="expand">Show more</button></div>`);
      await page.evaluate(value => {
        document.getElementById('expand').onclick = event => {
          document.querySelector('[data-testid="expandable-text-box"]').textContent = value;
          event.target.textContent = 'Show less';
        };
      }, text);
      const r = await read();
      assert.equal(r.description, text.trim());
      assert.equal(r.diagnostics.expansion.clicked, true);
      assert.equal(r.diagnostics.expansion.confirmed, true);
      assert.equal(await page.evaluate(() => !!window.wrong), false);
    });
    await t.test('no inventa confirmacion cuando el boton no expande', async () => {
      await page.setContent('<div class="jobs-description__content"><div data-testid="expandable-text-box">Short</div><button>Show more</button></div>');
      const r = await read();
      assert.equal(r.diagnostics.expansion.confirmed, false);
      assert.equal(r.diagnostics.status, 'description_too_short');
      assert.ok(r.diagnostics.errors.includes('description_expansion_unconfirmed'));
      assert.equal(r.diagnostics.completenessStatus, 'description_expansion_failed');
      assert.equal(r.diagnostics.descriptionCompleteness, 'unconfirmed');
    });
    await t.test('DOM global muta tras deteccion: conserva boton del root y excluye Premium/perfil', async () => {
      await page.setContent(`<button onclick="window.wrong=true">more</button>
        <a href="https://www.linkedin.com/premium/survey/">Show more</a>
        <div id="JobDetails_AboutTheJob_123"><div data-testid="expandable-text-box">${text}</div>
        <button id="expand" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">more</button></div>
        <a href="https://www.linkedin.com/in/person/">… more</a><button onclick="window.wrong=true">Show more</button>`);
      let mutated = false;
      const changingPage = new Proxy(page, { get(target, key) {
        if (key === 'evaluateHandle') return async (fn, args) => {
          const handle = await target.evaluateHandle(fn, args);
          if (args.resolveControl) {
            await target.evaluate(() => {
              document.body.firstElementChild.remove();
              const b = document.createElement('button'); b.textContent = 'Show more'; b.onclick = () => { window.wrong = true; };
              document.body.prepend(b, b.cloneNode(true));
            });
            mutated = true;
          }
          return handle;
        };
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      } });
      const r = await readJobDescription(changingPage, '123', settings);
      assert.equal(mutated, true);
      assert.equal(await page.evaluate(() => !!window.wrong), false);
      assert.equal(r.diagnostics.expansion.confirmed, true);
      assert.equal(r.diagnostics.descriptionCompleteness, 'full');
      assert.equal(r.diagnostics.completenessStatus, 'description_full');
    });
    for (const mutation of ['move', 'rename', 'disable', 'replace']) {
      await t.test(`control ${mutation} despues de deteccion no recibe click`, async () => {
        await page.setContent(`<div id="JobDetails_AboutTheJob_123"><div data-testid="expandable-text-box">${text} … more</div>
          <button id="expand" onclick="window.wrong=true">Show more</button></div>`);
        await page.evaluate(() => { window.wrong = false; });
        const changingPage = new Proxy(page, { get(target, key) {
          if (key === 'evaluateHandle') return async (fn, args) => {
            const handle = await target.evaluateHandle(fn, args);
            if (args.resolveControl) await target.evaluate(kind => {
              const b = document.getElementById('expand');
              if (kind === 'move') document.body.append(b);
              if (kind === 'rename') b.textContent = 'Retry Premium';
              if (kind === 'disable') b.disabled = true;
              if (kind === 'replace') b.replaceWith(b.cloneNode(true));
            }, mutation);
            return handle;
          };
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
        } });
        const r = await readJobDescription(changingPage, '123', settings);
        assert.equal(await page.evaluate(() => window.wrong), false);
        assert.equal(r.diagnostics.expansion.confirmed, false);
        assert.equal(r.diagnostics.completenessStatus, 'description_expansion_failed');
        assert.equal(r.diagnostics.descriptionCompleteness, 'unconfirmed');
      });
    }
    await t.test('residuo sin control se limpia pero completitud queda unconfirmed', async () => {
      await page.setContent(`<div id="job-details">${text} ... more</div>`);
      const r = await read();
      assert.equal(r.description, text.trim());
      assert.equal(r.diagnostics.expansion.found, false);
      assert.equal(r.diagnostics.expansion.attempted, false);
      assert.equal(r.diagnostics.expansionSuffixDetected, true);
      assert.equal(r.diagnostics.descriptionCompleteness, 'unconfirmed');
      assert.equal(r.diagnostics.completenessStatus, 'description_unexpanded');
      assert.equal(r.diagnostics.status, 'description_extracted');
    });
    await t.test('confirmacion con recorte restante no afirma full', async () => {
      await page.setContent(`<div id="job-details"><div data-testid="expandable-text-box" style="height:20px;overflow:hidden;width:200px">${text}</div>
        <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Show more</button></div>`);
      const r = await read();
      assert.equal(r.diagnostics.expansion.confirmed, true);
      assert.equal(r.diagnostics.descriptionCompleteness, 'unconfirmed');
    });
    await t.test('enlace de navegacion dentro del root tampoco es expansion', async () => {
      await page.setContent(`<div id="job-details">${text}<a href="https://www.linkedin.com/premium/">Show more</a></div>`);
      const r = await read();
      assert.equal(r.diagnostics.expansion.attempted, false);
      assert.equal(r.diagnostics.descriptionCompleteness, 'unconfirmed');
    });
    await t.test('variante SDUI real: boton visual aria-hidden con ellipsis more', async () => {
      await page.setContent(`<div id="JobDetails_AboutTheJob_123"><span data-testid="expandable-text-box">${text}<button aria-hidden="true" data-testid="expandable-text-button">\u2026 more</button></span></div>`);
      await page.evaluate(() => {
        document.querySelector('button').onclick = event => { event.target.remove(); };
      });
      const r = await read();
      assert.equal(r.description, text.trim());
      assert.equal(r.diagnostics.expansion.clicked, true);
      assert.equal(r.diagnostics.expansion.confirmed, true);
    });
    await t.test('etiqueta accesible Click to see more description', async () => {
      await page.setContent('<div class="jobs-description__content"><div data-testid="expandable-text-box">Short</div><button aria-label="Click to see more description">+</button></div>');
      await page.evaluate(value => { document.querySelector('button').onclick = e => {
        document.querySelector('[data-testid="expandable-text-box"]').textContent = value; e.target.remove();
      }; }, text);
      assert.equal((await read()).description, text.trim());
    });
    await t.test('espera boton tardio si el contenido esta recortado', async () => {
      await page.setContent(`<div id="JobDetails_AboutTheJob_123"><div data-testid="expandable-text-box" style="height:30px;overflow:hidden;width:220px">${text}</div></div>`);
      await page.evaluate(() => setTimeout(() => {
        const button = document.createElement('button'); button.textContent = '\u2026 more';
        button.onclick = () => { document.querySelector('[data-testid="expandable-text-box"]').style.height = 'auto'; button.remove(); };
        document.getElementById('JobDetails_AboutTheJob_123').append(button);
      }, 60));
      const r = await read();
      assert.equal(r.description, text.trim());
      assert.equal(r.diagnostics.expansion.confirmed, true);
      assert.equal(r.diagnostics.clippedAfterExpansion, false);
    });
    await t.test('ningun contenedor: timeout con diagnostico de ausencia', async () => {
      await page.setContent('<p>No description container</p>');
      const r = await read();
      assert.equal(r.description, null);
      assert.equal(r.diagnostics.status, 'detail_load_timeout');
      assert.ok(r.diagnostics.errors.includes('description_not_found'));
    });
    await t.test('main y expandable generico no son descripcion', async () => {
      await page.setContent(`<main>${text}<div data-testid="expandable-text-box">${text}</div></main>`);
      assert.equal((await read()).description, null);
    });
    await t.test('texto menor a 300 queda diagnosticado', async () => {
      await page.setContent('<div class="jobs-description-content__text">A short job.</div>');
      assert.equal((await read()).diagnostics.status, 'description_too_short');
    });
    await t.test('ausencia explicita no se confunde con timeout', async () => {
      await page.setContent('<div role="alert">This job is no longer available</div>');
      assert.equal((await read()).diagnostics.status, 'description_not_found');
    });
    await t.test('autenticacion se eleva con diagnostico', async () => {
      await page.setContent('<input name="session_password">');
      await assert.rejects(read(), e => e.name === 'AuthenticationError' && e.detailDiagnostics.status === 'auth_or_challenge');
    });
    await t.test('challenge se eleva con diagnostico', async () => {
      await page.setContent('<div role="alert">This job is no longer available</div><p>Security verification</p>');
      await assert.rejects(read(), e => e.name === 'SecurityChallengeError' && e.detailDiagnostics.status === 'auth_or_challenge');
    });
    await t.test('collector normal conserva diagnostico sin debug y URL directa', async () => {
      await page.route('https://www.linkedin.com/jobs/view/123/?test=direct', route => route.fulfill({ contentType: 'text/html', body: `<main><div id="job-details">${text}</div></main>` }));
      const url = 'https://www.linkedin.com/jobs/view/123/?test=direct';
      const r = await collectJobDetail(page, { jobId: '123', title: 'Role', url }, { directUrl: true, ...settings });
      assert.equal(page.url(), url);
      assert.equal(r.detail.description, text.trim());
      assert.equal(r.detail.detailExtraction.status, 'description_extracted');
      assert.equal(r.diagnostics[0].status, 'description_extracted');
    });
  });
}

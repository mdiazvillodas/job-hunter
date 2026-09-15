'use strict';

// DOM local en Chromium real, sin red ni perfil persistente de LinkedIn.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { firstVisible, getSearchInput } = require('../linkedin/searchControls');

const labels = ['City, state, or zip code', 'Search by title, skill, or company'];

for (const headless of [false, true]) {
  test(`Controles iniciales HEADLESS=${headless}`, async (t) => {
    const browser = await chromium.launch({ headless, channel: 'chromium' });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route('**/*', route => route.abort());

    for (const label of labels) {
      await t.test(`${label}: primera copia hidden, segunda visible`, async () => {
        await page.setContent(`<input hidden aria-label="${label}"><input aria-label="${label}">`);
        const input = await getSearchInput(page, label);
        await input.fill('test');
        assert.equal(await page.locator('input').nth(0).inputValue(), '');
        assert.equal(await page.locator('input').nth(1).inputValue(), 'test');
      });

      await t.test(`${label}: layout compacto oculta todas las copias`, async () => {
        await page.setViewportSize({ width: 784, height: 497 });
        await page.setContent(`<style>@media(max-width: 1000px){.location{display:none}}</style>
          <div class="location"><input aria-label="${label}"></div>`);
        assert.equal(await page.locator('input').isVisible(), false);
        const input = await getSearchInput(page, label);
        await input.fill('test');
        assert.equal(await input.inputValue(), 'test');
        assert.deepEqual(page.viewportSize(), { width: 1440, height: 900 });
      });
    }

    await t.test('control visible: conserva el viewport existente', async () => {
      await page.setViewportSize({ width: 1100, height: 700 });
      await page.setContent(`<input aria-label="${labels[0]}">`);
      await (await getSearchInput(page, labels[0])).fill('Barcelona');
      assert.deepEqual(page.viewportSize(), { width: 1100, height: 700 });
    });

    await t.test('control ausente: falla explicitamente sin cambiar filtros o viewport', async () => {
      await page.setContent('<input value="original">');
      const size = page.viewportSize();
      await assert.rejects(getSearchInput(page, labels[0], { timeout: 100 }), /control de busqueda no disponible/);
      assert.equal(await page.locator('input').inputValue(), 'original');
      assert.deepEqual(page.viewportSize(), size);
    });

    await t.test('control oculto aun en desktop: falla sin forzar interaccion', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.setContent(`<input hidden aria-label="${labels[0]}" value="original">`);
      await assert.rejects(getSearchInput(page, labels[0], { timeout: 100 }), /control de busqueda no disponible/);
      assert.equal(await page.locator('input').inputValue(), 'original');
    });

    await t.test('sugerencias, botones y dialogos: descarta primeras copias ocultas', async () => {
      await page.setContent(`<div hidden><button>All filters</button><div role="option">Barcelona</div>
        <div role="dialog"><button>Show results</button></div></div>
        <button>All filters</button><div role="option">Barcelona</div>
        <div role="dialog"><button>Show results</button></div>`);
      await firstVisible(page, 'button:has-text("All filters")').click({ timeout: 1000 });
      await firstVisible(page, '[role="option"]').click({ timeout: 1000 });
      const modal = firstVisible(page, '[role="dialog"]');
      await firstVisible(modal, 'button:has-text("Show results")').click({ timeout: 1000 });
      assert.equal(await modal.isVisible(), true);
    });
  });
}

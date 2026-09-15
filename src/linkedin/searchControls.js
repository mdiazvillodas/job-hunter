// LinkedIn conserva copias ocultas de los controles en su DOM responsive.
function firstVisible(root, selector) {
  return root.locator(selector).filter({ visible: true }).first();
}

async function getSearchInput(page, label, { timeout = 15000 } = {}) {
  const selector = `input[aria-label="${label}"]`;
  const input = firstVisible(page, selector);
  try {
    await page.locator(selector).first().waitFor({ state: 'attached', timeout });
    if (!(await input.isVisible())) {
      // Con viewport:null Chromium headless puede arrancar a 784px de ancho.
      // El layout compacto oculta TODOS los inputs de ubicacion; :visible no basta.
      const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      if (size.width < 1440) {
        await page.setViewportSize({ width: 1440, height: Math.max(size.height, 900) });
      }
    }
    await input.waitFor({ state: 'visible', timeout });
  } catch (cause) {
    // No continuar con una ubicacion/query anterior si falta el control.
    throw new Error(`LinkedIn: control de busqueda no disponible: ${label}`, { cause });
  }
  return input;
}

module.exports = { firstVisible, getSearchInput };

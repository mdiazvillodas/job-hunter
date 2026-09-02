const { chromium } = require('playwright');
const { BROWSER_PROFILE_DIR } = require('./src/runtime');

(async () => {
  const context = await chromium.launchPersistentContext(
    BROWSER_PROFILE_DIR,
    {
      headless: false,
      channel: 'chromium',
      viewport: null,
    }
  );

  const page = await context.newPage();

  await page.goto('https://www.linkedin.com', {
    waitUntil: 'domcontentloaded',
  });

  console.log('Chrome abierto en LinkedIn.');
  console.log('Podés cerrar la ventana cuando termines la prueba.');
})();

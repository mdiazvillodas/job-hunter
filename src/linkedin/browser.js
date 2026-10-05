const { chromium } = require('playwright');

// Unico punto que abre el Chromium gestionado. Los consumidores (hunt, ventana
// manual, Market Discovery) toman el lock del navegador antes de llamarlo.
// `extra` permite ajustes por plataforma (p. ej. idioma de InfoJobs) sin abrir
// un segundo camino hacia Playwright.
async function launchManagedBrowser(profileDir, extra = {}) {
  return chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chromium',
    viewport: null,
    ...extra,
  });
}

async function launchLinkedInBrowser(profileDir) {
  return launchManagedBrowser(profileDir);
}

async function getInitialPage(context) {
  const pages = context.pages();
  return pages[0] || context.newPage();
}

async function waitForBrowserClose(context) {
  await new Promise((resolve) => {
    context.once('close', resolve);
  });
}

module.exports = {
  getInitialPage,
  launchManagedBrowser,
  launchLinkedInBrowser,
  waitForBrowserClose,
};

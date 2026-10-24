const { chromium } = require('playwright');
const { HEADLESS } = require('../config');

async function launchLinkedInBrowser(profileDir, { headless = HEADLESS } = {}) {
  return chromium.launchPersistentContext(profileDir, {
    headless,
    channel: 'chromium',
    viewport: null,
  });
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
  launchLinkedInBrowser,
  waitForBrowserClose,
};

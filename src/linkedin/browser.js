const { chromium } = require('playwright');
const { HEADLESS } = require('../config');

async function launchLinkedInBrowser(profileDir, { headless = HEADLESS } = {}) {
  return chromium.launchPersistentContext(profileDir, {
    headless,
    channel: 'chromium',
    // Match the Oracle virtual desktop; keep local Windows behavior unchanged.
    ...(process.platform === 'linux' && process.env.DISPLAY ? { args: ['--window-size=1440,900'] } : {}),
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

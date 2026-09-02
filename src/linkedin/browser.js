const { chromium } = require('playwright');

async function launchLinkedInBrowser(profileDir) {
  return chromium.launchPersistentContext(profileDir, {
    headless: false,
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

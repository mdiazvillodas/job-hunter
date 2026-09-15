'use strict';

// Mock del lanzamiento: no abre Chromium ni accede a LinkedIn o al perfil.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

// Default invertido: headless salvo que se pida explicitamente HEADLESS="false".
const cases = [
  ['true', true],
  ['false', false],
  [undefined, true],
  ['', true],
  ['unexpected', true],
  ['1', true],
  ['0', true],
  ['yes', true],
  [' TRUE ', true],
  [' False ', false],
];

for (const [raw, expected] of cases) {
  test(`HEADLESS=${JSON.stringify(raw)} -> headless=${expected}`, async (t) => {
    const original = process.env.HEADLESS;
    const configPath = require.resolve('../config');
    const browserPath = require.resolve('../linkedin/browser');
    const cachedConfig = require.cache[configPath];
    const cachedBrowser = require.cache[browserPath];
    t.after(() => {
      if (original === undefined) delete process.env.HEADLESS;
      else process.env.HEADLESS = original;
      delete require.cache[configPath];
      delete require.cache[browserPath];
      if (cachedConfig) require.cache[configPath] = cachedConfig;
      if (cachedBrowser) require.cache[browserPath] = cachedBrowser;
    });

    if (raw === undefined) delete process.env.HEADLESS;
    else process.env.HEADLESS = raw;
    delete require.cache[configPath];
    delete require.cache[browserPath];

    const context = {};
    const launch = t.mock.method(chromium, 'launchPersistentContext', async () => context);
    const config = require('../config');
    const { launchLinkedInBrowser } = require('../linkedin/browser');
    assert.equal(config.HEADLESS, expected);
    assert.equal(config.BROWSER_PROFILE_DIR, path.resolve(__dirname, '../../browser-profile'));
    assert.equal(await launchLinkedInBrowser(config.BROWSER_PROFILE_DIR), context);
    assert.equal(launch.mock.callCount(), 1);
    assert.deepEqual(launch.mock.calls[0].arguments, [config.BROWSER_PROFILE_DIR, {
      headless: expected,
      channel: 'chromium',
      viewport: null,
    }]);
  });
}

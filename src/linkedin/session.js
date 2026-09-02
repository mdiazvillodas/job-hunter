const { AuthenticationError, SecurityChallengeError } = require('./errors');

const CHALLENGE_URL_PATTERNS = [
  '/checkpoint/',
  '/challenge/',
  '/uas/login-submit',
  '/captcha',
];

const CHALLENGE_TEXT_PATTERNS = [
  /captcha/i,
  /security verification/i,
  /verificaci[o\u00f3]n de seguridad/i,
  /checkpoint/i,
  /confirm your identity/i,
  /confirma tu identidad/i,
];

async function detectSecurityChallenge(page) {
  const url = page.url().toLowerCase();
  if (CHALLENGE_URL_PATTERNS.some((pattern) => url.includes(pattern))) {
    throw new SecurityChallengeError(
      'LinkedIn presento un checkpoint, CAPTCHA o desafio de seguridad. Se detuvo la automatizacion.'
    );
  }

  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  if (CHALLENGE_TEXT_PATTERNS.some((pattern) => pattern.test(bodyText))) {
    throw new SecurityChallengeError(
      'LinkedIn presento un checkpoint, CAPTCHA o desafio de seguridad. Se detuvo la automatizacion.'
    );
  }
}

async function assertAuthenticatedSession(context, page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await detectSecurityChallenge(page);

  const url = page.url().toLowerCase();
  if (url.includes('/login') || url.includes('/signup')) {
    throw new AuthenticationError(
      'No se detecto una sesion autenticada de LinkedIn en ./browser-profile. No se automatizo login.'
    );
  }

  const cookies = await context.cookies('https://www.linkedin.com');
  const hasSessionCookie = cookies.some((cookie) => cookie.name === 'li_at');
  const hasAuthenticatedUi = await page
    .locator('a[href*="/feed/"], a[href*="/in/"], nav[aria-label]')
    .first()
    .isVisible({ timeout: 5000 })
    .catch(() => false);

  if (!hasSessionCookie && !hasAuthenticatedUi) {
    throw new AuthenticationError(
      'No se pudo confirmar una sesion autenticada de LinkedIn en ./browser-profile.'
    );
  }
}

module.exports = {
  assertAuthenticatedSession,
  detectSecurityChallenge,
};

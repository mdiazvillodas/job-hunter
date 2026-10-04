const { AuthenticationError, SecurityChallengeError } = require('./errors');
const {
  DOM_SIGNALS,
  AUTH_SIGNALS,
  CHALLENGE_MESSAGE,
  evaluateChallenge,
  toChallengeDiagnostic,
  toAuthDiagnostic,
} = require('./challengeSignals');

// Pregunta al DOM por los nodos propios del challenge. Cada selector se
// consulta por separado para saber CUAL disparo, que es lo que despues permite
// distinguir un authwall de un CAPTCHA en el diagnostico.
async function collectDomSignals(page, timeoutMs = 1000) {
  const found = [];
  for (const signal of DOM_SIGNALS) {
    const visible = await page.locator(signal.selector).first()
      .isVisible({ timeout: timeoutMs })
      .catch(() => false);
    if (visible) found.push(signal.id);
  }
  return found;
}

// Lanza SecurityChallengeError SOLO ante una señal concluyente (ver
// ./challengeSignals.js). El error lleva `challengeDiagnostic` para que el
// pipeline pueda decir despues por que se detuvo, sin volver a mirar la pagina.
async function detectSecurityChallenge(page, context = {}) {
  const url = page.url();

  // 1) URL: concluyente y gratis, se comprueba primero.
  let evaluation = evaluateChallenge({ url });

  // 2) DOM: tambien concluyente. Solo se consulta si la URL no decidio.
  if (!evaluation) {
    const domSignals = await collectDomSignals(page);
    if (domSignals.length) evaluation = evaluateChallenge({ url, domSignals });
  }

  // 3) Texto: ultimo recurso y solo con frases completas de verificacion.
  // Aqui es donde vivia el falso positivo: buscar /checkpoint/i sobre el body
  // entero convertia cualquier oferta que hablara de "project checkpoints" en
  // un challenge y abortaba el run.
  if (!evaluation) {
    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (bodyText) evaluation = evaluateChallenge({ url, text: bodyText });
  }

  if (!evaluation) return null;

  const error = new SecurityChallengeError(CHALLENGE_MESSAGE);
  error.challengeDiagnostic = toChallengeDiagnostic(evaluation, context);
  throw error;
}

async function assertAuthenticatedSession(context, page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await detectSecurityChallenge(page);

  const url = page.url().toLowerCase();
  const loginRedirect = url.includes('/login');
  const signupRedirect = url.includes('/signup');
  if (loginRedirect || signupRedirect) {
    // La evidencia es la propia navegacion, y se sabe CUAL de las dos fue.
    const error = new AuthenticationError(
      'No se detecto una sesion autenticada de LinkedIn en ./browser-profile. No se automatizo login.'
    );
    error.challengeDiagnostic = toAuthDiagnostic({
      signal: loginRedirect ? AUTH_SIGNALS.LOGIN_REDIRECT : AUTH_SIGNALS.SIGNUP_REDIRECT,
      url: page.url(),
      stage: 'session_check',
    });
    throw error;
  }

  const cookies = await context.cookies('https://www.linkedin.com');
  const hasSessionCookie = cookies.some((cookie) => cookie.name === 'li_at');
  const hasAuthenticatedUi = await page
    .locator('a[href*="/feed/"], a[href*="/in/"], nav[aria-label]')
    .first()
    .isVisible({ timeout: 5000 })
    .catch(() => false);

  if (!hasSessionCookie && !hasAuthenticatedUi) {
    // Evidencia por ausencia: ni cookie de sesion ni UI de usuario logueado.
    const error = new AuthenticationError(
      'No se pudo confirmar una sesion autenticada de LinkedIn en ./browser-profile.'
    );
    error.challengeDiagnostic = toAuthDiagnostic({
      signal: AUTH_SIGNALS.SESSION_UNCONFIRMED,
      url: page.url(),
      stage: 'session_check',
    });
    throw error;
  }
}

module.exports = {
  assertAuthenticatedSession,
  detectSecurityChallenge,
};

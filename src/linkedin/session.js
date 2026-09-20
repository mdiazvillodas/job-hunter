const { AuthenticationError, SecurityChallengeError } = require('./errors');
const {
  CHALLENGE_STAGES,
  DOM_SIGNALS,
  DOM_SIGNAL_SELECTOR,
  DOM_FALLBACK_SIGNAL,
  LOGIN_DOM_SELECTOR,
  CHALLENGE_MESSAGE,
  evaluateChallenge,
  evaluateLogin,
  toChallengeDiagnostic,
} = require('./challengeSignals');

// Sonda de DOM en DOS tiempos, porque esto se ejecuta muchas veces por run
// (una por pagina de resultados y varias por oferta):
//   1) UNA consulta combinada. En el caso normal -no hay challenge- ese es el
//      unico coste, en lugar de un probe por selector.
//   2) Solo si la combinada dice que si, se clasifica cual fue, y ya sin
//      espera: los nodos estan en el DOM, preguntar de nuevo es inmediato.
// Si la combinada acierta pero la clasificacion no sabe nombrar la señal, se
// devuelve igualmente un challenge generico: detectar no puede depender de
// poder etiquetar.
async function collectDomSignals(page, timeoutMs = 1000) {
  const anyVisible = await page.locator(DOM_SIGNAL_SELECTOR).first()
    .isVisible({ timeout: timeoutMs })
    .catch(() => false);
  if (!anyVisible) return [];

  const found = [];
  for (const signal of DOM_SIGNALS) {
    const visible = await page.locator(signal.selector).first()
      .isVisible({ timeout: 0 })
      .catch(() => false);
    if (visible) found.push(signal.id);
  }
  return found.length ? found : [DOM_FALLBACK_SIGNAL];
}

// Lanza SecurityChallengeError SOLO ante una señal concluyente (ver
// ./challengeSignals.js). El error lleva `challengeDiagnostic` para que el
// pipeline pueda decir despues por que y donde se detuvo, sin volver a mirar
// la pagina.
//
// `context.stage` debe ser una etapa de CHALLENGE_STAGES: es lo que acaba
// convertido en una frase fija para el usuario en la notificacion de cierre.
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

// Un authwall NO es un challenge: significa que no hay sesion. Se detecta
// aparte y produce AuthenticationError, para que el usuario reciba "inicia
// sesion" y no "resolve una verificacion manual".
async function detectLoginWall(page) {
  const url = page.url();
  const byUrl = evaluateLogin({ url });
  if (byUrl) return byUrl;
  const visible = await page.locator(LOGIN_DOM_SELECTOR).first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  return visible ? evaluateLogin({ url, domSignals: ['dom:authwall'] }) : null;
}

async function assertAuthenticatedSession(context, page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await detectSecurityChallenge(page, { stage: CHALLENGE_STAGES.SESSION });

  if (await detectLoginWall(page)) {
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
  detectLoginWall,
};

'use strict';

// FUENTE UNICA DE VERDAD de las señales de challenge de LinkedIn.
//
// Por que existe este modulo: habia dos definiciones independientes (el
// detector del hunt y el del servicio de sesion) que ya habian divergido. Aqui
// viven las reglas; los dos callers las consumen y no vuelven a redefinirlas.
//
// Modulo PURO: no conoce Playwright, no navega, no lee ficheros. Recibe lo que
// el caller ya observo (url, texto, coincidencias de DOM) y decide.
//
// Principio de diseño: SEÑALES, no vocabulario.
//   Una palabra generica dentro del body completo NO puede abortar un run. El
//   detector anterior marcaba /checkpoint/i sobre todo el body, asi que una
//   oferta que dijera "project checkpoints" mataba la ejecucion entera. Una
//   señal valida tiene que ser algo que NO aparece en una oferta de empleo
//   redactada normalmente: una ruta de seguridad, un nodo de DOM propio del
//   challenge, o una frase completa de verificacion.

const MAX_EXCERPT_CHARS = 80;
const MAX_URL_CHARS = 200;

// --- 1) SEÑALES DE URL -----------------------------------------------------
// Rutas que solo aparecen cuando LinkedIn ya te saco del flujo normal.
const URL_SIGNALS = [
  { id: 'url:checkpoint', test: (url) => url.includes('/checkpoint/') },
  { id: 'url:challenge', test: (url) => url.includes('/challenge/') },
  { id: 'url:captcha', test: (url) => url.includes('/captcha') },
  { id: 'url:login_submit', test: (url) => url.includes('/uas/login-submit') },
  { id: 'url:authwall', test: (url) => url.includes('/authwall') },
  // Segmento de ruta, no la palabra suelta: /verification si aparece como path.
  { id: 'url:verification', test: (url) => /\/verification(?:\/|\?|$)/.test(url) },
];

// --- 2) SEÑALES DE DOM -----------------------------------------------------
// Nodos que pertenecen al propio challenge. Ninguno existe en una pagina de
// oferta normal, asi que su sola presencia visible es concluyente.
const DOM_SIGNALS = [
  { id: 'dom:captcha_internal', selector: '#captcha-internal, #captcha-challenge' },
  { id: 'dom:recaptcha_frame', selector: 'iframe[src*="recaptcha"], iframe[title*="captcha" i]' },
  { id: 'dom:checkpoint_form', selector: 'form[action*="checkpoint"], form[action*="challenge"]' },
  { id: 'dom:challenge_dialog', selector: '.challenge-dialog, #challenge-dialog, [data-test-id="challenge"]' },
  { id: 'dom:authwall', selector: '.authwall, .authwall-join-form' },
];

// --- 3) SEÑALES DE TEXTO ---------------------------------------------------
// FRASES COMPLETAS de verificacion, no palabras sueltas. Cada una tiene que
// resultar inverosimil dentro de la descripcion de una oferta.
//
// Deliberadamente NO estan: "checkpoint", "checkpoints", "captcha" a secas ni
// "security check" a secas. Son vocabulario corriente en ofertas de gestion de
// proyectos, data centers e ingenieria, y fueron la causa de los falsos
// positivos.
const TEXT_SIGNALS = [
  { id: 'text:security_verification', pattern: /security verification|verificaci[oó]n de seguridad/i },
  { id: 'text:confirm_identity', pattern: /confirm your identity|confirma tu identidad|verify your identity|verifica tu identidad/i },
  { id: 'text:quick_security_check', pattern: /(?:let'?s do a )?quick security check|comprobaci[oó]n de seguridad r[aá]pida/i },
  { id: 'text:unusual_activity', pattern: /detected unusual activity|actividad inusual en tu cuenta/i },
  { id: 'text:human_verification', pattern: /i'?m not a robot|no soy un robot|verify (?:that )?you(?:'?re| are) (?:a )?human|verifica que eres humano/i },
  // CAPTCHA solo EN CONTEXTO de challenge, nunca la palabra aislada.
  { id: 'text:captcha_context', pattern: /(?:complete|solve|enter)(?: the)? captcha|captcha (?:challenge|verification)|completa(?: el)? captcha|resuelve(?: el)? captcha/i },
];

// --- 4) SEÑALES DE AUTENTICACION -------------------------------------------
// Un AuthenticationError NO es un challenge: nadie esta pidiendo que demuestres
// ser humano, simplemente no hay sesion. Pero el pipeline lo trata igual como
// motivo de parada (isChallenge), asi que el summary tiene que poder decir cual
// de los dos fue.
//
// Cada id se corresponde con una evidencia que el caller YA observo. Ninguno se
// deduce ni se rellena por defecto: si no hay evidencia, el id lo dice.
const AUTH_SIGNALS = {
  LOGIN_REDIRECT: 'auth:login_redirect',            // la navegacion acabo en /login
  SIGNUP_REDIRECT: 'auth:signup_redirect',          // la navegacion acabo en /signup
  SESSION_UNCONFIRMED: 'auth:session_unconfirmed',  // ni cookie li_at ni UI autenticada
  DETAIL_REQUIRED: 'auth:detail_required',          // el detalle de la oferta pidio login
  UNSPECIFIED: 'auth:unspecified',                  // error de auth sin evidencia
};

const AUTH_SIGNAL_IDS = Object.values(AUTH_SIGNALS);

// Parada por challenge de la que no quedo evidencia. Existe a proposito: es
// distinto de "no hubo parada" (null) y de "hubo parada y se sabe por que".
const CHALLENGE_UNSPECIFIED = 'challenge:unspecified';

// Recorta y limpia el fragmento que se va a persistir. Como el texto que se
// guarda es SIEMPRE la coincidencia de un patron propio, no puede arrastrar
// datos de la oferta; aun asi se sanea por si el patron creciera.
function sanitizeExcerpt(value) {
  if (typeof value !== 'string' || !value) return null;
  const cleaned = value
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\d{4,}/g, '[num]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_EXCERPT_CHARS ? cleaned.slice(0, MAX_EXCERPT_CHARS - 1) + '…' : cleaned;
}

// URL segura para diagnostico: origen + ruta, SIN query ni fragmento (un
// checkpoint lleva tokens en la query) y con los segmentos opacos largos
// reemplazados, que es donde LinkedIn mete identificadores de sesion.
function safeUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname
      .split('/')
      .map((segment) => (segment.length > 24 && !segment.includes('.') ? '[id]' : segment))
      .join('/');
    const out = `${parsed.origin}${path}`;
    return out.length > MAX_URL_CHARS ? out.slice(0, MAX_URL_CHARS - 1) + '…' : out;
  } catch (_) {
    // Una URL no parseable no se propaga tal cual.
    return null;
  }
}

// evaluateChallenge({ url, text, domSignals })
//   url        -> page.url() (opcional)
//   text       -> texto visible ya leido por el caller (opcional)
//   domSignals -> ids de DOM_SIGNALS que el caller comprobo visibles (opcional)
//
// Devuelve null si no hay challenge, o el diagnostico de la PRIMERA señal que
// coincide. El orden es deliberado: url y dom son concluyentes y baratas; el
// texto va al final porque es la unica con riesgo de interpretacion.
function evaluateChallenge(input = {}) {
  const url = typeof input.url === 'string' ? input.url.toLowerCase() : '';
  if (url) {
    const hit = URL_SIGNALS.find((signal) => signal.test(url));
    if (hit) return { source: 'url', signal: hit.id, excerpt: null, url: safeUrl(input.url) };
  }

  const dom = Array.isArray(input.domSignals) ? input.domSignals : [];
  if (dom.length) {
    const known = DOM_SIGNALS.find((signal) => dom.includes(signal.id));
    if (known) return { source: 'dom', signal: known.id, excerpt: null, url: safeUrl(input.url) };
  }

  const text = typeof input.text === 'string' ? input.text : '';
  if (text) {
    for (const signal of TEXT_SIGNALS) {
      const match = text.match(signal.pattern);
      if (match) {
        return { source: 'text', signal: signal.id, excerpt: sanitizeExcerpt(match[0]), url: safeUrl(input.url) };
      }
    }
  }

  return null;
}

// Diagnostico listo para persistir: solo campos acotados y seguros.
function toChallengeDiagnostic(evaluation, context = {}) {
  if (!evaluation) return null;
  const diagnostic = {
    source: evaluation.source,
    signal: evaluation.signal,
    at: context.at || new Date().toISOString(),
  };
  if (evaluation.url) diagnostic.url = evaluation.url;
  if (evaluation.excerpt) diagnostic.excerpt = evaluation.excerpt;
  if (typeof context.stage === 'string' && context.stage) diagnostic.stage = context.stage;
  if (context.jobId != null) diagnostic.jobId = String(context.jobId);
  return diagnostic;
}

// Diagnostico de un AuthenticationError. Misma forma y mismas garantias que el
// de challenge: la URL pasa por safeUrl, asi que la query nunca viaja.
function toAuthDiagnostic(input = {}) {
  const signal = AUTH_SIGNAL_IDS.includes(input.signal) ? input.signal : AUTH_SIGNALS.UNSPECIFIED;
  return toChallengeDiagnostic(
    { source: 'auth', signal, excerpt: null, url: safeUrl(input.url) },
    { at: input.at, stage: input.stage, jobId: input.jobId },
  );
}

// Diagnostico de la parada, venga el error de donde venga. Unico sitio que
// decide que hacer cuando el error NO trae evidencia: dejar constancia
// explicita en lugar de null, para no volver a tener un run detenido "porque
// si". Nunca inventa un motivo: dice que no lo sabe.
function toStopDiagnostic(error, context = {}) {
  if (!error) return null;
  if (error.challengeDiagnostic) {
    const diagnostic = { ...error.challengeDiagnostic };
    if (!diagnostic.stage && context.stage) diagnostic.stage = context.stage;
    if (context.jobId != null) diagnostic.jobId = String(context.jobId);
    return diagnostic;
  }
  const signal = error.name === 'AuthenticationError' ? AUTH_SIGNALS.UNSPECIFIED : CHALLENGE_UNSPECIFIED;
  return toChallengeDiagnostic({ source: 'unspecified', signal, excerpt: null, url: null }, context);
}

// Selector unico para preguntarle al navegador una sola vez si hay algun nodo
// de challenge visible, cuando al caller no le interesa cual.
const DOM_SIGNAL_SELECTOR = DOM_SIGNALS.map((signal) => signal.selector).join(', ');

const CHALLENGE_MESSAGE = 'LinkedIn presento un checkpoint, CAPTCHA o desafio de seguridad. Se detuvo la automatizacion.';

module.exports = {
  URL_SIGNALS,
  DOM_SIGNALS,
  TEXT_SIGNALS,
  AUTH_SIGNALS,
  CHALLENGE_UNSPECIFIED,
  DOM_SIGNAL_SELECTOR,
  CHALLENGE_MESSAGE,
  MAX_EXCERPT_CHARS,
  sanitizeExcerpt,
  safeUrl,
  evaluateChallenge,
  toChallengeDiagnostic,
  toAuthDiagnostic,
  toStopDiagnostic,
};

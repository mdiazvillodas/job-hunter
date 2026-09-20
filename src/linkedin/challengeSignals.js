'use strict';

// FUENTE UNICA DE VERDAD de las señales con las que LinkedIn nos saca del flujo
// normal, y de como se nombran las etapas en las que eso puede pasar.
//
// Por que existe este modulo: habia dos definiciones independientes (el
// detector del hunt y el del servicio de sesion) que ya habian divergido. Aqui
// viven las reglas; los dos callers las consumen y no vuelven a redefinirlas.
//
// Modulo PURO: no conoce Playwright, no navega, no lee ficheros. Recibe lo que
// el caller ya observo (url, texto, coincidencias de DOM) y decide.
//
// Principio de diseño 1: SEÑALES, no vocabulario.
//   Una palabra generica dentro del body completo NO puede abortar un run. El
//   detector anterior marcaba /checkpoint/i sobre todo el body, asi que una
//   oferta que dijera "project checkpoints" mataba la ejecucion entera. Una
//   señal valida tiene que ser algo que NO aparece en una oferta de empleo
//   redactada normalmente: una ruta de seguridad, un nodo de DOM propio del
//   challenge, o una frase completa de verificacion.
//
// Principio de diseño 2: CHALLENGE no es LOGIN.
//   Un challenge es una verificacion manual de seguridad: hay que resolverla a
//   mano en el navegador. Un authwall (o /login, /signup) significa otra cosa
//   distinta: simplemente no hay sesion y hay que iniciarla. Al usuario se le
//   pide una accion diferente en cada caso, asi que son dos familias de
//   señales separadas y NUNCA se mezclan.

const MAX_EXCERPT_CHARS = 80;
const MAX_URL_CHARS = 200;

// --- ETAPAS ----------------------------------------------------------------
// Vocabulario CERRADO y deliberadamente corto de "donde estabamos" cuando
// LinkedIn interrumpio. Es lo unico del diagnostico que llega a ver el usuario
// (traducido a una frase fija en notifications/runOutcome), asi que no puede
// crecer sin una decision explicita.
const CHALLENGE_STAGES = Object.freeze({
  SESSION: 'session_verification',   // comprobacion de la sesion persistida
  DISCOVERY: 'discovery',            // busqueda y paginacion de resultados
  DETAIL: 'detail_collection',       // apertura de una oferta concreta
  ANALYSIS: 'analysis',              // fase de analisis de una oferta
});

const KNOWN_STAGES = new Set(Object.values(CHALLENGE_STAGES));

function isKnownStage(value) {
  return typeof value === 'string' && KNOWN_STAGES.has(value);
}

// --- 1) SEÑALES DE URL (CHALLENGE) -----------------------------------------
// Rutas que solo aparecen cuando LinkedIn exige una verificacion manual.
// authwall NO esta aqui a proposito: es falta de sesion, no un challenge.
const URL_SIGNALS = [
  { id: 'url:checkpoint', test: (url) => url.includes('/checkpoint/') },
  { id: 'url:challenge', test: (url) => url.includes('/challenge/') },
  { id: 'url:captcha', test: (url) => url.includes('/captcha') },
  // login-submit rechazado: LinkedIn no deja pasar y pide verificacion. Se
  // evalua ANTES que las señales de login, que tambien casarian con el.
  { id: 'url:login_submit', test: (url) => url.includes('/uas/login-submit') },
  // Segmento de ruta, no la palabra suelta: /verification si aparece como path.
  { id: 'url:verification', test: (url) => /\/verification(?:\/|\?|$)/.test(url) },
];

// --- 2) SEÑALES DE DOM (CHALLENGE) -----------------------------------------
// Nodos que pertenecen al propio challenge. Ninguno existe en una pagina de
// oferta normal, asi que su sola presencia visible es concluyente.
const DOM_SIGNALS = [
  { id: 'dom:captcha_internal', selector: '#captcha-internal, #captcha-challenge' },
  { id: 'dom:recaptcha_frame', selector: 'iframe[src*="recaptcha"], iframe[title*="captcha" i]' },
  { id: 'dom:checkpoint_form', selector: 'form[action*="checkpoint"], form[action*="challenge"]' },
  { id: 'dom:challenge_dialog', selector: '.challenge-dialog, #challenge-dialog, [data-test-id="challenge"]' },
];

// Selector unico para preguntarle al navegador UNA sola vez si hay algun nodo
// de challenge visible. Es la consulta que se paga en el caso comun (no hay
// challenge); la clasificacion por señal solo se hace si esta dice que si.
const DOM_SIGNAL_SELECTOR = DOM_SIGNALS.map((signal) => signal.selector).join(', ');

// La sonda combinada vio un nodo pero la clasificacion posterior no supo cual.
// Es un challenge igual: la deteccion no puede depender de poder nombrarlo.
const DOM_FALLBACK_SIGNAL = 'dom:challenge';

// --- 3) SEÑALES DE TEXTO (CHALLENGE) ---------------------------------------
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

// --- 4) SEÑALES DE LOGIN ---------------------------------------------------
// Familia SEPARADA: "no hay sesion", no "resolve una verificacion". Aqui vive
// authwall, que es exactamente eso: LinkedIn pide autenticarse para seguir.
const LOGIN_URL_SIGNALS = [
  { id: 'url:authwall', test: (url) => url.includes('/authwall') },
  { id: 'url:login', test: (url) => url.includes('/login') },
  { id: 'url:signup', test: (url) => url.includes('/signup') },
];

const LOGIN_DOM_SIGNALS = [
  { id: 'dom:authwall', selector: '.authwall, .authwall-join-form' },
];

const LOGIN_DOM_SELECTOR = LOGIN_DOM_SIGNALS.map((signal) => signal.selector).join(', ');

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
    if (dom.includes(DOM_FALLBACK_SIGNAL)) {
      return { source: 'dom', signal: DOM_FALLBACK_SIGNAL, excerpt: null, url: safeUrl(input.url) };
    }
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

// evaluateLogin({ url, domSignals }) -> null | { source, signal, url }
// "Hace falta iniciar sesion". Nunca devuelve un challenge, y el caller debe
// preguntar primero por evaluateChallenge: /uas/login-submit casa con ambas
// familias y gana el challenge.
function evaluateLogin(input = {}) {
  const url = typeof input.url === 'string' ? input.url.toLowerCase() : '';
  if (url) {
    const hit = LOGIN_URL_SIGNALS.find((signal) => signal.test(url));
    if (hit) return { source: 'url', signal: hit.id, url: safeUrl(input.url) };
  }
  const dom = Array.isArray(input.domSignals) ? input.domSignals : [];
  if (dom.length) {
    const known = LOGIN_DOM_SIGNALS.find((signal) => dom.includes(signal.id));
    if (known) return { source: 'dom', signal: known.id, url: safeUrl(input.url) };
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
  // Solo etapas del vocabulario cerrado: una etiqueta libre no puede colarse
  // hasta la notificacion que lee el usuario.
  if (isKnownStage(context.stage)) diagnostic.stage = context.stage;
  if (context.jobId != null) diagnostic.jobId = String(context.jobId);
  return diagnostic;
}

const CHALLENGE_MESSAGE = 'LinkedIn presento un checkpoint, CAPTCHA o desafio de seguridad. Se detuvo la automatizacion.';

module.exports = {
  CHALLENGE_STAGES,
  isKnownStage,
  URL_SIGNALS,
  DOM_SIGNALS,
  TEXT_SIGNALS,
  DOM_SIGNAL_SELECTOR,
  DOM_FALLBACK_SIGNAL,
  LOGIN_URL_SIGNALS,
  LOGIN_DOM_SIGNALS,
  LOGIN_DOM_SELECTOR,
  CHALLENGE_MESSAGE,
  MAX_EXCERPT_CHARS,
  sanitizeExcerpt,
  safeUrl,
  evaluateChallenge,
  evaluateLogin,
  toChallengeDiagnostic,
};

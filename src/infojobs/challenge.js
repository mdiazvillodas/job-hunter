'use strict';

// Deteccion de CAPTCHA / anti-bot en InfoJobs. Mismo principio que LinkedIn
// (src/linkedin/challengeSignals.js): SEÑALES concluyentes, no vocabulario.
// Si aparece, el collector se detiene. NUNCA se intenta resolver ni evadir.
//
// evaluateInfoJobsChallenge es PURO (testeable sin navegador).
// detectInfoJobsChallenge mira la pagina y lanza SecurityChallengeError.

const { SecurityChallengeError } = require('../linkedin/errors');
const { TEXT_SIGNALS, safeUrl, sanitizeExcerpt, toChallengeDiagnostic } = require('../linkedin/challengeSignals');

// Rutas / hosts propios de una pantalla de verificacion o bloqueo.
const URL_SIGNALS = [
  { id: 'url:captcha', test: (url) => /captcha/.test(url) },
  { id: 'url:challenge', test: (url) => /\/challenge(?:\/|\?|$)/.test(url) },
  { id: 'url:blocked', test: (url) => /\/(?:blocked|block|access-denied)(?:\/|\?|$)/.test(url) },
];

// Nodos de los proveedores de anti-bot habituales. Ninguno existe en una oferta.
// Deliberadamente NO esta reCAPTCHA: su variante invisible (v3) pinta un iframe
// visible en paginas normales y convertiria cualquier oferta en un "challenge".
const DOM_SIGNALS = [
  { id: 'dom:datadome', selector: 'iframe[src*="datadome" i], iframe[src*="captcha-delivery" i]' },
  { id: 'dom:geetest', selector: '.geetest_holder, .geetest_panel, iframe[src*="geetest" i]' },
  { id: 'dom:hcaptcha_challenge', selector: 'iframe[src*="hcaptcha" i][title*="challenge" i]' },
  { id: 'dom:px_captcha', selector: '#px-captcha' },
];

// Frases completas de pantallas de bloqueo, ademas de las genericas de LinkedIn.
const EXTRA_TEXT_SIGNALS = [
  // Pantalla real de InfoJobs (vista en el recon): "¿Eres humano o un robot?" + reCAPTCHA.
  { id: 'text:human_or_robot', pattern: /eres (?:un )?humano o (?:un )?robot|are you (?:a )?human or (?:a )?robot/i },
  { id: 'text:access_blocked', pattern: /acceso (?:ha sido )?bloqueado|tu acceso ha sido bloqueado|access to this page has been denied/i },
  { id: 'text:unusual_traffic', pattern: /tr[aá]fico inusual desde tu red|unusual traffic from your (?:computer )?network/i },
  { id: 'text:press_and_hold', pattern: /press (?:&|and) hold|mant[eé]n pulsado el bot[oó]n/i },
];

const CHALLENGE_MESSAGE = 'InfoJobs presento un CAPTCHA o bloqueo anti-bot. Se detuvo la automatizacion de InfoJobs.';

function evaluateInfoJobsChallenge(input = {}) {
  const rawUrl = typeof input.url === 'string' ? input.url : '';
  const url = rawUrl.toLowerCase();
  if (url) {
    const hit = URL_SIGNALS.find((s) => s.test(url));
    if (hit) return { source: 'url', signal: hit.id, excerpt: null, url: safeUrl(rawUrl) };
  }
  const dom = Array.isArray(input.domSignals) ? input.domSignals : [];
  const domHit = DOM_SIGNALS.find((s) => dom.includes(s.id));
  if (domHit) return { source: 'dom', signal: domHit.id, excerpt: null, url: safeUrl(rawUrl) };

  const text = typeof input.text === 'string' ? input.text : '';
  if (text) {
    for (const signal of [...EXTRA_TEXT_SIGNALS, ...TEXT_SIGNALS]) {
      const match = text.match(signal.pattern);
      if (match) return { source: 'text', signal: signal.id, excerpt: sanitizeExcerpt(match[0]), url: safeUrl(rawUrl) };
    }
  }
  return null;
}

async function collectDomSignals(page) {
  const found = [];
  for (const signal of DOM_SIGNALS) {
    const visible = await page.locator(signal.selector).first().isVisible({ timeout: 500 }).catch(() => false);
    if (visible) found.push(signal.id);
  }
  return found;
}

async function detectInfoJobsChallenge(page, context = {}) {
  const url = page.url();
  let evaluation = evaluateInfoJobsChallenge({ url });
  if (!evaluation) {
    const domSignals = await collectDomSignals(page);
    if (domSignals.length) evaluation = evaluateInfoJobsChallenge({ url, domSignals });
  }
  if (!evaluation) {
    // Solo el principio del body: una pantalla de bloqueo es corta, y asi el texto
    // de una oferta larga no puede disparar un falso positivo desde el final.
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (text) evaluation = evaluateInfoJobsChallenge({ url, text: text.slice(0, 3000) });
  }
  if (!evaluation) return null;

  const error = new SecurityChallengeError(CHALLENGE_MESSAGE);
  error.challengeDiagnostic = { ...toChallengeDiagnostic(evaluation, context), platform: 'infojobs' };
  throw error;
}

module.exports = {
  URL_SIGNALS,
  DOM_SIGNALS,
  EXTRA_TEXT_SIGNALS,
  CHALLENGE_MESSAGE,
  evaluateInfoJobsChallenge,
  detectInfoJobsChallenge,
};

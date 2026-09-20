'use strict';

// Notificacion ntfy del CIERRE de un hunt. Complementa (NO reemplaza) las
// notificaciones por high match de ./ntfy.js, que siguen intactas.
//
// Invariantes:
//   - SIDE EFFECT INFORMATIVO: notifyRunOutcome NUNCA rechaza ni cambia el
//     estado terminal del run.
//   - La notificacion de cierre NO lleva Click (ni LinkedIn, ni UI, ni nada):
//     es informativa, no navega a ningun lado.
//   - Solo se usan metricas REALES del summary del pipeline. Una metrica
//     ausente se omite; no se inventa ni se rellena con 0.
//   - stoppedByChallenge NO se presenta como "terminado".
//   - Una cancelacion pedida por el usuario NO notifica nada: quien la pidio
//     esta delante de la UI y ya vio el resultado. Tampoco se disfraza de
//     terminada ni de interrumpida.
//   - Nunca se filtran secretos ni paths en el mensaje de error.

const path = require('path');

const { getNtfyConfig, defaultSend, HIGH_MATCH_THRESHOLD } = require('./ntfy');
const { CHALLENGE_STAGES } = require('../linkedin/challengeSignals');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// Resultado de un run, a efectos de NOTIFICACION (no del hunt).
const COMPLETED = 'completed';
const INTERRUPTED = 'interrupted';
const FAILED = 'failed';
const CANCELLED = 'cancelled';

// Prioridades ntfy: el cierre normal es informativo; una interrupcion merece
// mas atencion porque puede requerir accion manual (resolver un challenge).
const PRIORITY_COMPLETED = 'default';
const PRIORITY_PROBLEM = 'high';

const MAX_ERROR_CHARS = 180;
// Secretos que podrian aparecer en un mensaje de error antes de llegar a ntfy.
const SECRET_ENV_KEYS = ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'HUNT_TRIGGER_TOKEN'];

// Codigos de error del hunt que describen una INTERRUPCION (algo que el usuario
// puede resolver en la PC), no un fallo del pipeline.
const INTERRUPTION_CODES = new Set(['CHECKPOINT_REQUIRED', 'LOGIN_REQUIRED']);

// Explicacion del challenge segun la ETAPA en la que LinkedIn corto.
//
// Mapa CERRADO: la unica parte del diagnostico que llega al usuario es la
// clave, y de ella sale una frase fija escrita aqui. Nunca se interpola nada
// del diagnostico —ni url, ni selector, ni texto de la pagina, ni jobId— asi
// que no hay forma de que el contenido de LinkedIn llegue a una notificacion.
// Una etapa desconocida cae en CHALLENGE_GENERIC.
const CHALLENGE_STAGE_TEXTS = Object.freeze({
  [CHALLENGE_STAGES.SESSION]: 'LinkedIn pidió una verificación manual al comprobar la sesión.',
  [CHALLENGE_STAGES.DISCOVERY]: 'LinkedIn pidió una verificación manual durante la búsqueda de ofertas.',
  [CHALLENGE_STAGES.DETAIL]: 'LinkedIn pidió una verificación manual mientras analizaba una oferta.',
  [CHALLENGE_STAGES.ANALYSIS]: 'LinkedIn pidió una verificación manual durante el análisis de una oferta.',
});

const CHALLENGE_GENERIC = 'LinkedIn pidió una verificación de seguridad y el hunt se detuvo.';
// authwall / sesion caida: NO es una verificacion, es falta de sesion. El
// usuario tiene que hacer algo distinto, asi que se le dice algo distinto.
const LOGIN_REQUIRED_TEXT = 'LinkedIn pidió iniciar sesión y el hunt se detuvo.';
const GENERIC_FAILURE_TEXT = 'El hunt no pudo completarse.';

function errorCode(error) {
  return error && typeof error.code === 'string' ? error.code : null;
}

// Etapa del challenge, por cualquiera de sus dos caminos: el summary del
// pipeline (se alcanzo a cerrar) o el error que aborto el run antes.
// Devuelve SIEMPRE una clave conocida del mapa, o null.
function challengeStageText({ summary = null, error = null } = {}) {
  for (const holder of [summary, error]) {
    const stage = holder && holder.challenge && holder.challenge.stage;
    if (typeof stage === 'string' && Object.prototype.hasOwnProperty.call(CHALLENGE_STAGE_TEXTS, stage)) {
      return CHALLENGE_STAGE_TEXTS[stage];
    }
  }
  return null;
}

// Un challenge de LinkedIn, por cualquiera de sus dos caminos: el flag que el
// pipeline devuelve cuando alcanzo a cerrar un summary, o la excepcion que
// aborta el run antes de producirlo.
function isChallengeStop({ summary = null, error = null } = {}) {
  if (errorCode(error) === 'CHECKPOINT_REQUIRED') return true;
  return !!(summary && summary.stoppedByChallenge === true);
}

// cancelled   -> el usuario pidio detener el hunt (no se notifica)
// completed   -> el pipeline termino su recorrido normal
// interrupted -> challenge de LinkedIn o sesion caida (con o sin summary)
// failed      -> cualquier otro fallo / el hunt no pudo producir un summary
function classifyRunOutcome({ status = null, summary = null, error = null } = {}) {
  if (status === 'CANCELLED') return CANCELLED;
  if (isChallengeStop({ summary, error })) return INTERRUPTED;
  if (error) return INTERRUPTION_CODES.has(errorCode(error)) ? INTERRUPTED : FAILED;
  if (status === 'FAILED') return FAILED;
  if (!summary) return FAILED; // sin summary y sin error no se asume exito
  return COMPLETED;
}

// Mensaje de error breve y seguro: sin secretos, sin paths absolutos del
// proyecto, sin stack, en una sola linea y acotado.
// La entrada esperada ya viene saneada por huntRunManager ({code, message});
// esto es defensa en profundidad, no la unica barrera.
function safeErrorMessage(error, options = {}) {
  if (!error) return '';
  const env = options.env || process.env;
  const extra = Array.isArray(options.redact) ? options.redact : [];
  let msg = typeof error === 'string' ? error : (error && error.message) || String(error);
  const secrets = SECRET_ENV_KEYS.map((key) => env[key]).concat(extra);
  for (const value of secrets) {
    if (value && String(value).length >= 8) msg = msg.split(String(value)).join('[redacted]');
  }
  msg = msg.split(PROJECT_ROOT).join('.');
  msg = msg.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (msg.length > MAX_ERROR_CHARS) msg = msg.slice(0, MAX_ERROR_CHARS - 1).trimEnd() + '…';
  return msg;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// "42 min" / "38 s" / "1 h 5 min". null si no hay dato.
function formatDuration(ms) {
  const total = num(ms);
  if (total === null || total < 0) return null;
  const seconds = Math.round(total / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// Lineas de metricas. Cada una se emite SOLO si el dato existe de verdad.
// Los contadores que serian ruido en 0 (matches, errores) se omiten en 0.
function metricLines(summary, threshold = HIGH_MATCH_THRESHOLD) {
  if (!summary || typeof summary !== 'object') return [];
  const discovery = summary.discovery || {};
  const analysis = summary.analysis || {};
  const notifications = summary.notifications || {};
  const durations = summary.durations || {};
  const lines = [];

  const unique = num(discovery.uniqueResults);
  if (unique !== null) lines.push(`${unique} ofertas encontradas`);

  const fresh = num(discovery.newJobs);
  if (fresh !== null) lines.push(`${fresh} nuevas`);

  const analyzed = num(analysis.analyzed);
  if (analyzed !== null) lines.push(`${analyzed} analizadas`);

  // eligible = high matches detectados en ESTE run (enviados, ya notificados o fallidos).
  const highMatches = num(notifications.eligible);
  if (highMatches !== null && highMatches > 0) lines.push(`🔥 ${highMatches} matches ≥${threshold}`);

  const failed = num(analysis.failed);
  if (failed !== null && failed > 0) lines.push(`⚠️ ${failed} con error de análisis`);

  const duration = formatDuration(durations.totalMs);
  if (duration) lines.push(`Duración: ${duration}`);

  return lines;
}

// Construye el mensaje ntfy de cierre. NUNCA incluye la propiedad `click`.
// Devuelve null cuando el outcome no debe notificarse (cancelacion).
function buildRunOutcomeNotification({ outcome, summary = null, error = null, threshold = HIGH_MATCH_THRESHOLD, challenge = false, redact = [] } = {}) {
  if (outcome === CANCELLED) return null;
  const lines = metricLines(summary, threshold);

  if (outcome === COMPLETED) {
    return {
      title: '✅ Job Hunter terminado',
      body: lines.length ? lines.join('\n') : 'Hunt terminado.',
      priority: PRIORITY_COMPLETED,
    };
  }

  // Cabecera: la explicacion mas precisa que se pueda dar con informacion
  // SEGURA. Con etapa conocida, la frase de esa etapa; si no, la generica de
  // siempre. Un login requerido no se disfraza de verificacion.
  let head;
  if (challenge) head = challengeStageText({ summary, error }) || CHALLENGE_GENERIC;
  else if (errorCode(error) === 'LOGIN_REQUIRED') head = LOGIN_REQUIRED_TEXT;
  else head = GENERIC_FAILURE_TEXT;
  const detail = safeErrorMessage(error, { redact });
  const body = [head];
  if (detail && detail !== head) body.push(detail);
  if (lines.length) body.push('', ...lines);
  body.push('', 'Las ofertas ya guardadas se conservan.');

  return {
    title: '❌ Job Hunter interrumpido',
    body: body.join('\n'),
    priority: PRIORITY_PROBLEM,
  };
}

// Notificador de cierre. Mismo contrato defensivo que createHighMatchNotifier:
// devuelve siempre un {status} y jamas rechaza.
//
//   settings -> bloque notifications.ntfy de user.json (mismo que high match)
//   send     -> inyectable; por defecto POST real
function createRunOutcomeNotifier(options = {}) {
  const config = options.config || getNtfyConfig(options.settings);
  const send = options.send || defaultSend;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const threshold = typeof options.threshold === 'number' ? options.threshold
    : typeof config.threshold === 'number' ? config.threshold : HIGH_MATCH_THRESHOLD;
  // El topic tambien es un dato sensible: no debe viajar dentro de un mensaje.
  const redact = [config.topic].filter(Boolean);

  async function notifyRunOutcome(input = {}) {
    let outcome = FAILED;
    try {
      outcome = classifyRunOutcome(input);
      // Decision de producto: una cancelacion pedida por el usuario no notifica.
      if (outcome === CANCELLED) return { status: 'skipped', outcome };
      if (!config.enabled) return { status: 'disabled', outcome };
      if (config.configError) {
        log(`configuracion invalida, no se envia el cierre: ${config.configError}`);
        return { status: 'misconfigured', outcome, error: config.configError };
      }

      const message = buildRunOutcomeNotification({
        outcome,
        summary: input.summary || null,
        error: input.error || null,
        challenge: isChallengeStop(input),
        threshold,
        redact,
      });
      if (!message) return { status: 'skipped', outcome };
      await send(config.url, message);
      log(`ntfy cierre enviado: ${outcome}`);
      return { status: 'sent', outcome };
    } catch (err) {
      const message = safeErrorMessage(err, { redact });
      log(`ntfy cierre fallido: ${message}`);
      return { status: 'failed', outcome, error: message };
    }
  }

  return { notifyRunOutcome, config, threshold };
}

module.exports = {
  COMPLETED,
  INTERRUPTED,
  FAILED,
  CANCELLED,
  PRIORITY_COMPLETED,
  PRIORITY_PROBLEM,
  SECRET_ENV_KEYS,
  CHALLENGE_STAGE_TEXTS,
  CHALLENGE_GENERIC,
  LOGIN_REQUIRED_TEXT,
  GENERIC_FAILURE_TEXT,
  challengeStageText,
  isChallengeStop,
  classifyRunOutcome,
  safeErrorMessage,
  formatDuration,
  metricLines,
  buildRunOutcomeNotification,
  createRunOutcomeNotifier,
};

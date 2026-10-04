'use strict';

// Notificacion ntfy del CIERRE de un hunt. Complementa (NO reemplaza) las
// notificaciones por high match de ./ntfy.js, que siguen intactas.
//
// Invariantes:
//   - SIDE EFFECT INFORMATIVO: notifyRunOutcome NUNCA rechaza ni cambia el
//     exit code del hunt.
//   - La notificacion de cierre NO lleva Click (ni LinkedIn, ni UI, ni nada):
//     es informativa, no navega a ningun lado.
//   - Solo se usan metricas REALES del summary del pipeline. Una metrica
//     ausente se omite; no se inventa ni se rellena con 0.
//   - stoppedByChallenge NO se presenta como "terminado". El contrato del
//     trigger no cambia (para el trigger eso sigue siendo un run 'success'):
//     la distincion vive solo en el texto de la notificacion.
//   - Nunca se filtran secretos ni paths en el mensaje de error.

const path = require('path');

const { getNtfyConfig, defaultSend, HIGH_MATCH_THRESHOLD } = require('./ntfy');
const { sourceLabel } = require('../domain/sources');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// Resultado de un run, a efectos de NOTIFICACION (no del trigger).
const COMPLETED = 'completed';
const INTERRUPTED = 'interrupted';
const FAILED = 'failed';

// Prioridades ntfy: el cierre normal es informativo; una interrupcion merece
// mas atencion porque puede requerir accion manual (resolver un challenge).
const PRIORITY_COMPLETED = 'default';
const PRIORITY_PROBLEM = 'high';

const MAX_ERROR_CHARS = 180;
const SECRET_ENV_KEYS = ['OPENAI_API_KEY', 'HUNT_TRIGGER_TOKEN', 'TELEGRAM_BOT_TOKEN', 'NTFY_TOPIC'];

// completed   -> el pipeline termino su recorrido normal
// interrupted -> se corto por un challenge de LinkedIn (con o sin summary)
// failed      -> excepcion / el hunt no pudo producir un summary
function classifyRunOutcome({ summary = null, error = null, challenge = false } = {}) {
  if (challenge) return INTERRUPTED;
  if (error) return FAILED;
  if (!summary) return FAILED;
  if (summary.stoppedByChallenge === true) return INTERRUPTED;
  return COMPLETED;
}

// Mensaje de error breve y seguro: sin secretos, sin paths absolutos del
// proyecto, sin stack, en una sola linea y acotado.
function safeErrorMessage(error, env = process.env) {
  if (!error) return '';
  let msg = typeof error === 'string' ? error : (error && error.message) || String(error);
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
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

// Una linea por plataforma cuando el hunt recorrio varias (summary.sources):
//   "LinkedIn: 109 encontradas · 34 nuevas · 27 analizadas"
//   "InfoJobs: ❌ interrumpido (verificación de seguridad)"
function sourceLines(summary) {
  const sources = summary && summary.sources && typeof summary.sources === 'object' ? summary.sources : null;
  if (!sources) return [];
  return Object.entries(sources).map(([id, src]) => {
    const label = (src && src.label) || sourceLabel(id);
    if (!src || src.status === 'failed') return `${label}: ⚠️ error, no se completó`;
    const d = src.discovery || {};
    const a = src.analysis || {};
    const parts = [];
    if (num(d.uniqueResults) !== null) parts.push(`${d.uniqueResults} encontradas`);
    if (num(d.newJobs) !== null) parts.push(`${d.newJobs} nuevas`);
    if (num(a.analyzed) !== null) parts.push(`${a.analyzed} analizadas`);
    const metrics = parts.join(' · ');
    if (src.status === 'interrupted') return `${label}: ❌ interrumpido (verificación de seguridad)${metrics ? ' · ' + metrics : ''}`;
    return `${label}: ${metrics || 'sin datos'}`;
  });
}

// Lineas globales cuando hay desglose por plataforma: los totales que no se repiten arriba.
function globalLines(summary, threshold = HIGH_MATCH_THRESHOLD) {
  return metricLines(summary, threshold).filter((l) => /^(🔥|⚠️|Duración)/.test(l));
}

function interruptedPlatforms(summary) {
  const sources = summary && summary.sources ? summary.sources : null;
  if (!sources) return [];
  return Object.entries(sources)
    .filter(([, src]) => src && src.status === 'interrupted')
    .map(([id, src]) => (src && src.label) || sourceLabel(id));
}

// Construye el mensaje ntfy de cierre. NUNCA incluye la propiedad `click`.
function buildRunOutcomeNotification({ outcome, summary = null, error = null, env = process.env } = {}) {
  const perSource = sourceLines(summary);
  const lines = perSource.length ? [...perSource, ...globalLines(summary)] : metricLines(summary);

  if (outcome === COMPLETED) {
    return {
      title: '✅ Job Hunter terminado',
      body: lines.length ? lines.join('\n') : 'Hunt terminado.',
      priority: PRIORITY_COMPLETED,
    };
  }

  const stopped = interruptedPlatforms(summary);
  const who = stopped.length ? stopped.join(' y ') : 'LinkedIn';
  const head = outcome === INTERRUPTED
    ? `${who} pidió una verificación de seguridad y el hunt se detuvo${stopped.length && perSource.length > stopped.length ? ' en esa plataforma' : ''}.`
    : 'El hunt no pudo completarse.';
  const detail = safeErrorMessage(error, env);
  const body = [head];
  if (detail) body.push(detail);
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
function createRunOutcomeNotifier(options = {}) {
  const config = options.config || getNtfyConfig(options.env || process.env);
  const send = options.send || defaultSend;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const env = options.env || process.env;

  async function notifyRunOutcome(input = {}) {
    let outcome = COMPLETED;
    try {
      outcome = classifyRunOutcome(input);
      if (!config.enabled) return { status: 'disabled', outcome };
      if (config.configError) {
        log(`configuracion invalida, no se envia el cierre: ${config.configError}`);
        return { status: 'misconfigured', outcome, error: config.configError };
      }

      const message = buildRunOutcomeNotification({
        outcome,
        summary: input.summary || null,
        error: input.error || null,
        env,
      });
      await send(config.url, message);
      log(`ntfy cierre enviado: ${outcome}`);
      return { status: 'sent', outcome };
    } catch (err) {
      const message = safeErrorMessage(err, env);
      log(`ntfy cierre fallido: ${message}`);
      return { status: 'failed', outcome, error: message };
    }
  }

  return { notifyRunOutcome, config };
}

module.exports = {
  COMPLETED,
  INTERRUPTED,
  FAILED,
  PRIORITY_COMPLETED,
  PRIORITY_PROBLEM,
  classifyRunOutcome,
  safeErrorMessage,
  formatDuration,
  metricLines,
  sourceLines,
  buildRunOutcomeNotification,
  createRunOutcomeNotifier,
};

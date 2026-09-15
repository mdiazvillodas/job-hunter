'use strict';

// Notificaciones push por ntfy (https://ntfy.sh). SIDE EFFECT INFORMATIVO:
// no es feedback, no ensena nada al sistema y no puede tirar abajo un hunt.
//
// Invariantes:
//   - Un fallo de ntfy NUNCA se propaga: notifyHighMatch resuelve siempre.
//   - highMatchNotifiedAt se persiste SOLO despues de una respuesta exitosa.
//   - La elegibilidad la decide el caller sobre el analisis del run actual;
//     este modulo no escanea el repositorio.

// Umbral de "high match". Es una CONSTANTE DE DOMINIO, no una env var:
// define que significa un match alto (el emoji y el copy de la notificacion
// dependen de ello) y no es un parametro de despliegue. Cambiarlo es un
// cambio de producto, con su test. Ver README de notificaciones.
const HIGH_MATCH_THRESHOLD = 90;

const DEFAULT_BASE_URL = 'https://ntfy.sh';
const NTFY_PRIORITY = 'high';
const REQUEST_TIMEOUT_MS = 10000;

// Un topic de ntfy es un identificador simple; se valida para no construir
// URLs raras a partir de una env mal escrita.
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

function readBool(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === 'true';
}

// Lee la configuracion desde el entorno. NUNCA lanza: devuelve el motivo por el
// que no se puede notificar para que el caller lo loguee y siga.
function getNtfyConfig(env = process.env) {
  const enabled = readBool(env.NTFY_ENABLED);
  if (!enabled) return { enabled: false, configError: null, url: null, topic: null, baseUrl: null };

  const topic = (env.NTFY_TOPIC || '').trim();
  const baseUrl = (env.NTFY_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');

  if (!topic) return { enabled: true, configError: 'NTFY_TOPIC ausente', url: null, topic: null, baseUrl };
  if (!TOPIC_RE.test(topic)) return { enabled: true, configError: 'NTFY_TOPIC invalido', url: null, topic: null, baseUrl };
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) {
    return { enabled: true, configError: 'NTFY_BASE_URL invalido', url: null, topic, baseUrl };
  }

  return { enabled: true, configError: null, url: `${baseUrl}/${topic}`, topic, baseUrl };
}

function scoreOf(job) {
  const s = job && job.aiAnalysis ? job.aiAnalysis.overallMatchScore : null;
  return typeof s === 'number' && Number.isFinite(s) ? s : null;
}

function isHighMatch(job, threshold = HIGH_MATCH_THRESHOLD) {
  const s = scoreOf(job);
  return s !== null && s >= threshold;
}

function wasAlreadyNotified(job) {
  return !!(job && job.highMatchNotifiedAt);
}

// URL exacta de la oferta. Se prefiere job.url persistida; solo se reconstruye
// desde jobId cuando la URL falta, y unicamente en la forma canonica conocida.
// Si no hay nada confiable devuelve null (la notificacion sale sin Click).
function jobClickUrl(job) {
  if (!job) return null;
  const raw = typeof job.url === 'string' ? job.url.trim() : '';
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' && !u.username && !u.password
          && /(^|\.)linkedin\.com$/i.test(u.hostname)
          && /^\/jobs\/view\/\d+\/?$/.test(u.pathname)) {
        return u.toString();
      }
    } catch { /* URL invalida: se intenta reconstruir abajo */ }
  }
  if (typeof job.jobId === 'string' && /^\d+$/.test(job.jobId)) {
    return `https://www.linkedin.com/jobs/view/${job.jobId}/`;
  }
  return null;
}

// Mensaje compacto para pantalla de iPhone. Sin reasoning ni explicacion.
function buildHighMatchNotification(job) {
  const score = scoreOf(job);
  const title = (job && job.title) || 'Oferta sin titulo';
  const company = (job && job.company) || 'Empresa no informada';
  return {
    title: `🔥 Match ${score} — ${title}`,
    body: `${company}\nRating: ${score}/100`,
    click: jobClickUrl(job),
    priority: NTFY_PRIORITY,
  };
}

// POST real a ntfy. Los headers de ntfy son ASCII-only, por eso Title va en
// X-Title codificado en RFC 2047 (UTF-8 base64): asi el emoji y los acentos
// llegan intactos. El body viaja como UTF-8 en el cuerpo, sin restriccion.
function encodeHeaderValue(value) {
  const s = String(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

async function defaultSend(url, message) {
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: encodeHeaderValue(message.title),
    Priority: message.priority || NTFY_PRIORITY,
  };
  if (message.click) headers.Click = message.click;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: message.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
  return { ok: true, status: res.status };
}

// Crea el notificador que consume el pipeline.
//   markNotified(jobId) -> persiste highMatchNotifiedAt (solo tras exito)
//   send(url, message)  -> inyectable; por defecto POST real
// El resultado es siempre un objeto {status}: nunca rechaza.
function createHighMatchNotifier(options = {}) {
  const config = options.config || getNtfyConfig(options.env || process.env);
  const send = options.send || defaultSend;
  const markNotified = options.markNotified || (() => {});
  const log = typeof options.log === 'function' ? options.log : () => {};
  const threshold = typeof options.threshold === 'number' ? options.threshold : HIGH_MATCH_THRESHOLD;

  let configErrorLogged = false;

  async function notifyHighMatch(job) {
    try {
      if (!isHighMatch(job, threshold)) return { status: 'below_threshold' };

      const jobId = job.jobId;
      const score = scoreOf(job);
      log(`high match detected: ${jobId} score=${score}`);

      if (wasAlreadyNotified(job)) {
        log(`already notified: ${jobId}`);
        return { status: 'already_notified' };
      }
      if (!config.enabled) return { status: 'disabled' };
      if (config.configError) {
        // Se loguea una sola vez por run: es un problema de configuracion, no por job.
        if (!configErrorLogged) {
          log(`configuracion invalida, no se envian notificaciones: ${config.configError}`);
          configErrorLogged = true;
        }
        return { status: 'misconfigured', error: config.configError };
      }

      const message = buildHighMatchNotification(job);
      await send(config.url, message);

      // Solo aca, con ntfy confirmado, se persiste la marca.
      markNotified(jobId);
      log(`ntfy sent: ${jobId}`);
      return { status: 'sent', jobId, score };
    } catch (err) {
      // Un fallo de ntfy no marca el job: queda reintentable en hunts futuros.
      const message = err && err.message ? err.message : String(err);
      log(`ntfy failed: ${job && job.jobId} ${message}`);
      return { status: 'failed', jobId: job && job.jobId, error: message };
    }
  }

  return { notifyHighMatch, config, threshold };
}

module.exports = {
  HIGH_MATCH_THRESHOLD,
  DEFAULT_BASE_URL,
  getNtfyConfig,
  isHighMatch,
  wasAlreadyNotified,
  jobClickUrl,
  buildHighMatchNotification,
  encodeHeaderValue,
  defaultSend,
  createHighMatchNotifier,
};

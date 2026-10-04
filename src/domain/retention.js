'use strict';

// Politica de retencion del Inbox (TTL). Reglas PURAS: no leen ni escriben disco,
// no conocen el repositorio y reciben el "ahora" por parametro (tests deterministas).
//
// Regla unica:
//   una oferta que lleva >= 7 dias corridos en NUESTRO sistema y que NUNCA fue
//   abierta por el usuario se elimina. Cualquier evidencia de haber sido abierta
//   -aunque sea una sola vez- la protege para siempre.
//
// "Leida alguna vez" es un hecho historico MONOTONICO: una vez verdadero nunca
// vuelve a ser falso. Por eso se mira evidencia ACUMULADA (readAt + eventos
// append-only + timestamps de decision) y nunca el status actual como unica fuente:
// el status es un valor mutable y podria retroceder; la evidencia no.
//
// El eje de tiempo es userState.firstSeenAt = cuando la oferta entro a nuestro
// sistema (lo setea createJobRecord y mergeDiscovery NO lo toca). Deliberadamente
// NO se usan analysisCompletedAt, la fecha de publicacion de LinkedIn ni el mtime
// del archivo: ninguno responde "cuando entro" ni "cuando la abri".

const TTL_DAYS = 7;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

// Estados que implican interaccion del usuario. Se protegen EXPLICITAMENTE aunque
// la lectura ya este implicita en ellos: es una red de seguridad contra registros
// historicos donde la marca de lectura falte (existen: descartes sin readAt).
const PROTECTED_STATUSES = Object.freeze(['read', 'interested', 'applied', 'discarded', 'priority']);

// Timestamps de decision. Su sola presencia prueba que la oferta se abrio alguna vez.
const DECISION_TIMESTAMPS = Object.freeze(['readAt', 'interestedAt', 'appliedAt', 'discardedAt', 'priorityAt']);

function parseMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Normaliza el "ahora" aceptando Date, epoch ms o ISO string.
function toMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return parseMs(value);
}

// Momento en que la oferta entro al sistema. null = desconocido (=> fail-safe).
function firstSeenAtMs(job) {
  if (!job || typeof job !== 'object') return null;
  const us = job.userState;
  if (!us || typeof us !== 'object') return null;
  return parseMs(us.firstSeenAt);
}

// Hecho historico monotonico: ¿esta oferta fue abierta ALGUNA vez?
// Se acepta cualquiera de las cuatro evidencias; basta una.
function hasEverBeenRead(job) {
  if (!job || typeof job !== 'object') return false;
  const us = job.userState && typeof job.userState === 'object' ? job.userState : {};

  // 1. Marca directa de lectura.
  if (parseMs(us.readAt) !== null) return true;

  // 2. Historial append-only: un evento 'read' nunca se borra ni se reescribe.
  const events = Array.isArray(job.feedbackEvents) ? job.feedbackEvents : [];
  if (events.some((e) => e && e.type === 'read')) return true;

  // 3. Status que implica interaccion.
  if (PROTECTED_STATUSES.indexOf(us.status) !== -1) return true;

  // 4. Cualquier timestamp de decision: decidir exige haber abierto.
  if (DECISION_TIMESTAMPS.some((k) => parseMs(us[k]) !== null)) return true;

  return false;
}

// Protecciones que van MAS ALLA de la lectura. Se listan aparte para que el motivo
// quede explicito en el reporte y para no depender de que un estado implique el otro.
function protectionReason(job) {
  if (!job || typeof job !== 'object') return 'invalid_record';
  if (hasEverBeenRead(job)) return 'read_at_least_once';
  // Una oferta cerrada es un hecho del mercado, no una decision: igual se conserva.
  if (job.availability === 'closed') return 'applications_closed';
  if (firstSeenAtMs(job) === null) return 'unknown_first_seen';
  return null;
}

function isProtectedFromTtl(job) {
  return protectionReason(job) !== null;
}

// Edad en ms desde que entro al sistema. null si no se puede determinar.
function ageMs(job, now) {
  const seen = firstSeenAtMs(job);
  const nowMs = toMs(now);
  if (seen === null || nowMs === null) return null;
  return nowMs - seen;
}

// ¿Elegible para borrado por TTL? Fail-safe en todos los bordes: ante cualquier
// duda (registro raro, timestamp ilegible, "ahora" invalido) se CONSERVA.
function isExpiredByTtl(job, now) {
  if (isProtectedFromTtl(job)) return false;
  const age = ageMs(job, now);
  if (age === null) return false;
  return age >= TTL_MS;
}

// Devuelve los jobs elegibles. No muta nada ni decide como borrarlos.
function selectExpiredJobs(jobs, now) {
  const list = Array.isArray(jobs) ? jobs : [];
  return list.filter((j) => isExpiredByTtl(j, now));
}

function selectExpiredJobIds(jobs, now) {
  return selectExpiredJobs(jobs, now).map((j) => j.jobId);
}

module.exports = {
  TTL_DAYS,
  TTL_MS,
  PROTECTED_STATUSES,
  DECISION_TIMESTAMPS,
  firstSeenAtMs,
  hasEverBeenRead,
  protectionReason,
  isProtectedFromTtl,
  ageMs,
  isExpiredByTtl,
  selectExpiredJobs,
  selectExpiredJobIds,
};

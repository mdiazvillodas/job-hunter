'use strict';

// MD7.1 — enriquecimiento de detalle para Market Discovery.
//
// Adaptador FINO sobre `collectJobDetail` de LinkedIn: abre UNA oferta en la
// MISMA pagina/sesion que ya posee MD7, extrae la descripcion con los selectores
// existentes y la normaliza para MD4. No abre navegadores, no crea contextos, no
// toma ni libera propiedad, no escribe estado de Hunter y no usa el pipeline ni
// el Analyzer normal.
//
// Se invoca SOLO cuando un candidato ya deduplicado llega a su turno de
// evaluacion: una oferta unica recibe como mucho un intento de detalle.

const { MAX_DESCRIPTION_CHARS, sanitizeText } = require('./semanticContract');

const DETAIL_OUTCOMES = Object.freeze({
  DETAIL_AVAILABLE: 'DETAIL_AVAILABLE',
  DETAIL_UNAVAILABLE: 'DETAIL_UNAVAILABLE',
  DETAIL_FAILED: 'DETAIL_FAILED',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  CHECKPOINT_REQUIRED: 'CHECKPOINT_REQUIRED',
  CANCELLED: 'CANCELLED',
});
// Interrupciones que DEBEN cortar la corrida, nunca degradarse a un fallo comun.
const INTERRUPTING = Object.freeze([DETAIL_OUTCOMES.LOGIN_REQUIRED, DETAIL_OUTCOMES.CHECKPOINT_REQUIRED, DETAIL_OUTCOMES.CANCELLED]);

function isCancellation(error) {
  return !!error && (error.name === 'AbortError' || error.name === 'HuntCancelledError');
}
function throwIfCancelled(signal) {
  if (!signal || !signal.aborted) return;
  const error = new Error('Market Discovery detail cancelled.');
  error.name = 'AbortError';
  throw error;
}

function createDetailEnricher(options = {}) {
  const collectDetail = options.collectDetail
    || ((page, listingJob, opts) => require('../linkedin/detailCollector').collectJobDetail(page, listingJob, opts));

  // enrich(posting, context) -> { outcome, description, descriptionAvailable, ... }
  async function enrich(posting, context = {}) {
    const { page, signal } = context;
    const base = { postingKey: posting && posting.key, postingId: posting && posting.postingId, description: null, descriptionAvailable: false, descriptionLength: 0 };
    try {
      throwIfCancelled(signal);
      if (!page) return { ...base, outcome: DETAIL_OUTCOMES.DETAIL_FAILED, reason: 'no shared page available' };
      if (!posting || (!posting.postingId && !posting.url)) {
        return { ...base, outcome: DETAIL_OUTCOMES.DETAIL_UNAVAILABLE, reason: 'posting has no canonical identity' };
      }
      // Se navega con la MISMA pagina compartida. Un solo intento: sin reintentos.
      const result = await collectDetail(page, { jobId: posting.postingId, url: posting.url, title: posting.title, company: posting.company, location: posting.location }, {});
      throwIfCancelled(signal);
      const detail = (result && result.detail) || {};
      // Misma normalizacion y mismo tope que ya aplica MD4 a una descripcion.
      const description = sanitizeText(detail.description, MAX_DESCRIPTION_CHARS);
      if (!description) {
        return { ...base, outcome: DETAIL_OUTCOMES.DETAIL_UNAVAILABLE, reason: 'no description found on the posting' };
      }
      return {
        ...base,
        outcome: DETAIL_OUTCOMES.DETAIL_AVAILABLE,
        description,
        descriptionAvailable: true,
        descriptionLength: description.length,
        // La ubicacion del detalle se conserva como dato de la oferta, pero NUNCA
        // redefine el alcance de la busqueda: la geografia configurada manda.
        detailLocation: sanitizeText(detail.location, 200),
        reason: null,
      };
    } catch (error) {
      if (isCancellation(error)) return { ...base, outcome: DETAIL_OUTCOMES.CANCELLED, reason: 'cancelled' };
      // Un challenge NUNCA se degrada a DETAIL_FAILED: interrumpe la corrida.
      if (error && error.name === 'SecurityChallengeError') return { ...base, outcome: DETAIL_OUTCOMES.CHECKPOINT_REQUIRED, reason: 'checkpoint' };
      if (error && error.name === 'AuthenticationError') return { ...base, outcome: DETAIL_OUTCOMES.LOGIN_REQUIRED, reason: 'login' };
      // Fallo ordinario: se reporta el hecho, no el detalle del error.
      return { ...base, outcome: DETAIL_OUTCOMES.DETAIL_FAILED, reason: 'detail could not be collected' };
    }
  }

  return { enrich };
}

module.exports = { createDetailEnricher, DETAIL_OUTCOMES, INTERRUPTING };

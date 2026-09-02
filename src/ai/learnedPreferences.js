'use strict';

// Foundation de learned preferences (Milestone 7).
// NO usa ML ni OpenAI. Agrega feedback historico de forma DETERMINISTA y produce
// candidatos de preferencia cercanos a los motivos controlados.
//
// Regla clave (no aprender con un solo rechazo):
//   1 evento    -> tier 'signal'      (confidence low)
//   2-3 eventos -> tier 'emerging'    (confidence medium)
//   4+ eventos  -> tier 'established' (confidence high)
// Los thresholds viven en domain/feedbackConfig.js.
//
// IMPORTANTE: en este milestone NO se conecta al analyzer. Solo genera el reporte.

const { JOB_STATES } = require('../domain/feedbackConfig');
const { dimensionOf, tierForCount, confidenceForCount } = require('../domain/feedbackConfig');

// Extrae los eventos de descarte (con reasons) desde una lista de jobs.
function collectDiscardEvents(jobs) {
  const events = [];
  for (const job of jobs || []) {
    for (const ev of job.feedbackEvents || []) {
      if (ev.type === JOB_STATES.DISCARDED && Array.isArray(ev.reasons)) {
        events.push(ev);
      }
    }
  }
  return events;
}

// Cuenta ocurrencias por reason key en un conjunto de eventos de descarte.
function countReasons(discardEvents) {
  const counts = new Map();
  for (const ev of discardEvents) {
    for (const key of ev.reasons) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

// Produce los candidatos de preferencia aprendida a partir de jobs (o de eventos ya extraidos).
function computeLearnedPreferences(jobs) {
  const discardEvents = collectDiscardEvents(jobs);
  const counts = countReasons(discardEvents);

  const preferences = Array.from(counts.entries())
    .map(([key, count]) => ({
      key,
      dimension: dimensionOf(key),
      direction: 'avoid', // los descartes generan senal de "evitar"; 'seek' se agregara luego
      count,
      tier: tierForCount(count),
      confidence: confidenceForCount(count),
      evidence: { source: 'user_feedback', events: count },
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    generatedAt: new Date().toISOString(),
    totalDiscardEvents: discardEvents.length,
    preferences,
  };
}

module.exports = {
  computeLearnedPreferences,
  collectDiscardEvents,
  countReasons,
};

'use strict';

// Une el summary de LinkedIn con el resultado de InfoJobs en UN summary con el
// mismo contrato de siempre (huntRunManager, notificaciones, Telegram y la UI
// lo leen sin saber cuantas plataformas corrieron).
//
//   - Los contadores de nivel superior son la SUMA de ambas plataformas.
//   - stoppedByChallenge / challenge siguen siendo los de LinkedIn: son los que
//     piden una accion en la sesion de LinkedIn. InfoJobs informa lo suyo en
//     sources.infojobs y NUNCA convierte un hunt en fallido o interrumpido.
//   - sources.<plataforma> lleva el desenlace y los contadores de cada una.
//
// Modulo PURO.

const { SOURCES } = require('../domain/sources');

const SUMMED = {
  discovery: ['queriesExecuted', 'rawResults', 'uniqueResults', 'duplicatesRemoved', 'newJobs', 'existingJobs'],
  analysis: ['requiringAnalysis', 'alreadyAnalyzed', 'processed', 'analyzed', 'failed', 'skipped', 'detailsFetched', 'target'],
  persistence: ['created', 'updated', 'unchanged'],
  notifications: ['eligible', 'sent', 'alreadyNotified', 'failed'],
  usageTotals: ['promptTokens', 'completionTokens', 'cachedTokens', 'totalTokens'],
  durations: ['discoveryMs', 'detailsMs', 'analysisMs', 'totalMs'],
};

function add(a, b) {
  const x = Number.isFinite(a) ? a : null;
  const y = Number.isFinite(b) ? b : null;
  if (x === null && y === null) return a ?? b ?? null;
  return (x || 0) + (y || 0);
}

function sumBlock(base = {}, extra = {}, keys) {
  const out = { ...base };
  for (const key of keys) out[key] = add(base[key], extra[key]);
  return out;
}

function tagQueries(perQuery, source) {
  return Array.isArray(perQuery) ? perQuery.map((q) => ({ ...q, source })) : [];
}

// Resumen por plataforma: lo justo para saber que paso en cada una.
function sourceOutcome(summary, extra = {}) {
  if (!summary) return { status: extra.status || 'failed', ...extra };
  return {
    status: summary.stoppedByChallenge ? 'stopped_by_challenge' : 'completed',
    challenge: summary.challenge || null,
    discovery: {
      queriesExecuted: summary.discovery.queriesExecuted ?? null,
      uniqueResults: summary.discovery.uniqueResults ?? null,
      newJobs: summary.discovery.newJobs ?? null,
    },
    analysis: {
      analyzed: summary.analysis.analyzed ?? null,
      failed: summary.analysis.failed ?? null,
      stopReason: summary.analysis.stopReason ?? null,
    },
    ...extra,
  };
}

// infojobs: null (apagado) | { summary } | { error, challenge }
function combineSummaries(linkedin, infojobs) {
  // InfoJobs apagado: el summary de siempre, sin un solo campo nuevo.
  if (!infojobs) return linkedin;
  const ij = infojobs.summary || null;
  const ijOutcome = ij
    ? sourceOutcome(ij)
    : sourceOutcome(null, {
      status: infojobs.challenge ? 'stopped_by_challenge' : 'failed',
      challenge: infojobs.challenge || null,
      error: infojobs.error || null,
    });

  const combined = { ...linkedin };
  if (ij) {
    for (const [block, keys] of Object.entries(SUMMED)) combined[block] = sumBlock(linkedin[block], ij[block], keys);
    combined.discovery.perQuery = [
      ...tagQueries(linkedin.discovery.perQuery, SOURCES.LINKEDIN),
      ...tagQueries(ij.discovery.perQuery, SOURCES.INFOJOBS),
    ];
    combined.usageTotals.model = linkedin.usageTotals.model || ij.usageTotals.model || null;
    combined.analysis.analysisEnabled = linkedin.analysis.analysisEnabled || ij.analysis.analysisEnabled;
    combined.jobs = [...(linkedin.jobs || []), ...(ij.jobs || [])];
  }
  combined.sources = {
    [SOURCES.LINKEDIN]: sourceOutcome(linkedin),
    [SOURCES.INFOJOBS]: ijOutcome,
  };
  return combined;
}

module.exports = { combineSummaries, sourceOutcome };

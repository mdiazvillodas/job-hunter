'use strict';

// Combina los resultados de cada plataforma de un hunt en UN summary.
//
// El summary combinado conserva EXACTAMENTE la forma que ya consumen el trigger,
// la notificacion de cierre y el reporte --debug (discovery/analysis/persistence/
// notifications/usageTotals/durations/jobs, sumados), y agrega `sources` con el
// detalle de cada plataforma. Modulo PURO.
//
// Entrada: [{ source, summary }  |  { source, error, challenge }]
//   summary   -> lo que devolvio runPipeline para esa plataforma
//   error     -> la plataforma se corto antes de producir summary
//   challenge -> ese corte fue un challenge/login (no un fallo de codigo)

const { sourceLabel } = require('../domain/sources');

const SUMMED = {
  discovery: ['queriesExecuted', 'rawResults', 'uniqueResults', 'duplicatesRemoved', 'newJobs', 'existingJobs'],
  analysis: ['requiringAnalysis', 'alreadyAnalyzed', 'processed', 'analyzed', 'failed', 'skipped', 'detailsFetched',
    'detailFetchAttempts', 'detailsWithUsableDescription', 'detailsWithoutUsableDescription', 'skippedDueToMissingDescription'],
  persistence: ['created', 'updated', 'unchanged'],
  notifications: ['eligible', 'sent', 'alreadyNotified', 'failed'],
  usageTotals: ['promptTokens', 'completionTokens', 'cachedTokens', 'totalTokens'],
  durations: ['discoveryMs', 'detailsMs', 'analysisMs', 'totalMs'],
};

// Suma solo valores numericos reales. Si ninguna plataforma tiene el dato, queda null
// (la notificacion omite metricas ausentes en vez de inventar un 0).
function sumField(parts, section, field) {
  let total = null;
  for (const p of parts) {
    const v = p && p[section] ? p[section][field] : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) total = (total || 0) + v;
  }
  return total;
}

function sourceStatus(entry) {
  if (entry.summary) return entry.summary.stoppedByChallenge ? 'interrupted' : 'completed';
  return entry.challenge ? 'interrupted' : 'failed';
}

function safeMessage(error) {
  if (!error) return null;
  return String(error.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 300);
}

function combineSummaries(entries, meta = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const summaries = list.map((e) => e.summary).filter(Boolean);

  const combined = {
    runId: meta.runId || (summaries[0] && summaries[0].runId) || null,
    startedAt: meta.startedAt || (summaries[0] && summaries[0].startedAt) || null,
    finishedAt: meta.finishedAt || new Date().toISOString(),
    stoppedByChallenge: false,
    challenge: null,
  };

  for (const [section, fields] of Object.entries(SUMMED)) {
    combined[section] = {};
    for (const f of fields) combined[section][f] = sumField(summaries, section, f);
  }
  combined.analysis.analysisEnabled = summaries.some((s) => s.analysis && s.analysis.analysisEnabled);
  combined.analysis.detailExtractionCounts = summaries.reduce((acc, s) => {
    const counts = (s.analysis && s.analysis.detailExtractionCounts) || {};
    for (const [k, v] of Object.entries(counts)) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {});
  combined.usageTotals.model = (summaries.find((s) => s.usageTotals && s.usageTotals.model) || { usageTotals: {} }).usageTotals.model || null;
  if (typeof meta.totalMs === 'number') combined.durations.totalMs = meta.totalMs;
  combined.retention = (summaries.find((s) => s.retention) || {}).retention || null;
  combined.detailDiagnostics = summaries.flatMap((s) => s.detailDiagnostics || []);
  combined.jobs = summaries.flatMap((s) => s.jobs || []);

  combined.sources = {};
  for (const entry of list) {
    const status = sourceStatus(entry);
    const s = entry.summary || null;
    const challenge = s ? s.challenge || null : (entry.challengeDiagnostic || null);
    if (status === 'interrupted') {
      combined.stoppedByChallenge = true;
      if (!combined.challenge) combined.challenge = challenge ? { platform: entry.source, ...challenge } : { platform: entry.source };
    }
    combined.sources[entry.source] = {
      label: sourceLabel(entry.source),
      status,
      error: s ? null : safeMessage(entry.error),
      discovery: s ? s.discovery : null,
      analysis: s ? { analyzed: s.analysis.analyzed, failed: s.analysis.failed, skipped: s.analysis.skipped } : null,
      notifications: s ? s.notifications : null,
      durations: s ? s.durations : null,
      challenge,
    };
  }
  return combined;
}

module.exports = { combineSummaries, sourceStatus };

'use strict';

// Plataformas de origen de las ofertas (LinkedIn, InfoJobs).
//
// Cada oferta guarda `source`. Los registros anteriores a este campo no lo tienen
// y son todos de LinkedIn: ausente equivale a 'linkedin' (no se migra el repositorio).
//
// Identidad: el jobId de LinkedIn es su id numerico de siempre. Los de InfoJobs
// llevan el prefijo 'ij_' para que nunca colisionen con uno de LinkedIn en el
// LocalRepository (un archivo por jobId).

const SOURCES = Object.freeze({
  LINKEDIN: 'linkedin',
  INFOJOBS: 'infojobs',
});

const SOURCE_LABELS = Object.freeze({
  [SOURCES.LINKEDIN]: 'LinkedIn',
  [SOURCES.INFOJOBS]: 'InfoJobs',
});

// Orden de ejecucion por defecto en un hunt.
const DEFAULT_SOURCES = Object.freeze([SOURCES.LINKEDIN, SOURCES.INFOJOBS]);

const INFOJOBS_JOB_ID_PREFIX = 'ij_';

function isKnownSource(value) {
  return Object.values(SOURCES).includes(value);
}

function sourceOf(job) {
  if (job && isKnownSource(job.source)) return job.source;
  if (job && typeof job.jobId === 'string' && job.jobId.startsWith(INFOJOBS_JOB_ID_PREFIX)) return SOURCES.INFOJOBS;
  return SOURCES.LINKEDIN;
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || SOURCE_LABELS[SOURCES.LINKEDIN];
}

// "linkedin,infojobs" -> ['linkedin','infojobs']. Ignora valores desconocidos y
// duplicados. Vacio, ausente o sin ningun valor valido -> todas las plataformas.
function parseSources(value) {
  const list = String(value == null ? '' : value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(isKnownSource);
  const unique = Array.from(new Set(list));
  return unique.length ? unique : DEFAULT_SOURCES.slice();
}

module.exports = {
  SOURCES,
  SOURCE_LABELS,
  DEFAULT_SOURCES,
  INFOJOBS_JOB_ID_PREFIX,
  isKnownSource,
  sourceOf,
  sourceLabel,
  parseSources,
};

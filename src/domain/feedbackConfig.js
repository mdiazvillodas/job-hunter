'use strict';

// Configuracion centralizada del sistema de estado + feedback + learning (Milestone 7).
// Todo lo ajustable (estados, motivos, dimensiones, thresholds) vive aqui.

// Estados controlados = DECISIONES DE MARIANO (independientes de la decision del AI: YES/MAYBE/NO).
const JOB_STATES = Object.freeze({
  NEW: 'new',
  READ: 'read',
  INTERESTED: 'interested',
  DISCARDED: 'discarded',
  APPLIED: 'applied',
  PRIORITY: 'priority',
});
const ALL_STATES = Object.freeze(Object.values(JOB_STATES));

// Dimensiones para separar "no puedo" (professional_fit) de "no quiero" (interest).
// 'both' cuando puede ser cualquiera; 'unknown' cuando no se puede atribuir.
const DIMENSION = Object.freeze({
  INTEREST: 'interest',
  PROFESSIONAL_FIT: 'professional_fit',
  BOTH: 'both',
  UNKNOWN: 'unknown',
});

// Motivos controlados de descarte + su dimension probable.
// No se fuerza que cada motivo pertenezca a una unica categoria cuando hay ambiguedad ('both').
const FEEDBACK_REASONS = Object.freeze([
  { key: 'role_type', dimension: DIMENSION.INTEREST },
  { key: 'too_commercial', dimension: DIMENSION.INTEREST },
  { key: 'too_sales_driven', dimension: DIMENSION.INTEREST },
  { key: 'too_product', dimension: DIMENSION.INTEREST },
  { key: 'too_project_management', dimension: DIMENSION.INTEREST },
  { key: 'insufficient_ownership', dimension: DIMENSION.INTEREST },
  { key: 'insufficient_seniority', dimension: DIMENSION.BOTH },
  { key: 'too_senior', dimension: DIMENSION.PROFESSIONAL_FIT },
  { key: 'insufficient_technical_fit', dimension: DIMENSION.PROFESSIONAL_FIT },
  { key: 'insufficient_business_fit', dimension: DIMENSION.PROFESSIONAL_FIT },
  { key: 'industry', dimension: DIMENSION.INTEREST },
  { key: 'company', dimension: DIMENSION.INTEREST },
  { key: 'location', dimension: DIMENSION.BOTH },
  { key: 'compensation', dimension: DIMENSION.INTEREST },
  { key: 'employment_type', dimension: DIMENSION.BOTH },
  { key: 'work_environment', dimension: DIMENSION.INTEREST },
  { key: 'repetitive_work', dimension: DIMENSION.INTEREST },
  { key: 'low_interest', dimension: DIMENSION.INTEREST },
  { key: 'other', dimension: DIMENSION.UNKNOWN },
]);

const REASON_KEYS = Object.freeze(FEEDBACK_REASONS.map((r) => r.key));
const REASON_BY_KEY = Object.freeze(
  FEEDBACK_REASONS.reduce((acc, r) => {
    acc[r.key] = r;
    return acc;
  }, {})
);

function isValidReason(key) {
  return Object.prototype.hasOwnProperty.call(REASON_BY_KEY, key);
}

function dimensionOf(key) {
  return REASON_BY_KEY[key] ? REASON_BY_KEY[key].dimension : DIMENSION.UNKNOWN;
}

// Thresholds de learning. Centralizados y faciles de cambiar.
// Una sola decision NO debe convertirse en preferencia fuerte.
const LEARNING_THRESHOLDS = Object.freeze({
  signalMin: 1, //   1 evento       -> signal
  emergingMin: 2, //  2-3 eventos    -> emerging
  establishedMin: 4, // 4+ eventos   -> established
});

function tierForCount(count) {
  if (count >= LEARNING_THRESHOLDS.establishedMin) return 'established';
  if (count >= LEARNING_THRESHOLDS.emergingMin) return 'emerging';
  if (count >= LEARNING_THRESHOLDS.signalMin) return 'signal';
  return 'none';
}

const CONFIDENCE_BY_TIER = Object.freeze({
  none: 'none',
  signal: 'low',
  emerging: 'medium',
  established: 'high',
});

function confidenceForCount(count) {
  return CONFIDENCE_BY_TIER[tierForCount(count)];
}

module.exports = {
  JOB_STATES,
  ALL_STATES,
  DIMENSION,
  FEEDBACK_REASONS,
  REASON_KEYS,
  REASON_BY_KEY,
  isValidReason,
  dimensionOf,
  LEARNING_THRESHOLDS,
  tierForCount,
  confidenceForCount,
  CONFIDENCE_BY_TIER,
};

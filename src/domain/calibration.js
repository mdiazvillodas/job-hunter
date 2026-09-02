'use strict';

// Compara la decision del AI analyzer (YES/MAYBE/NO) con la decision del usuario
// (userState + feedback) y produce una senal de calibracion.
// Regla general: NO inferir una senal si no hay informacion suficiente -> 'unknown'.

const { JOB_STATES, dimensionOf, DIMENSION } = require('./feedbackConfig');

const POSITIVE_USER_STATES = [JOB_STATES.INTERESTED, JOB_STATES.APPLIED, JOB_STATES.PRIORITY];

const SIGNALS = Object.freeze({
  AI_OVERESTIMATED_INTEREST: 'ai_overestimated_interest',
  AI_UNDERESTIMATED_INTEREST: 'ai_underestimated_interest',
  AI_OVERESTIMATED_PROFESSIONAL_FIT: 'ai_overestimated_professional_fit',
  AI_UNDERESTIMATED_PROFESSIONAL_FIT: 'ai_underestimated_professional_fit',
  AI_CORRECT: 'ai_correct',
  UNKNOWN: 'unknown',
});

function computeCalibrationSignal(job) {
  const aiDecision = job && job.aiAnalysis && job.aiAnalysis.decision ? job.aiAnalysis.decision : null;
  const userStatus = job && job.userState ? job.userState.status : null;
  const reasons = job && job.feedback && Array.isArray(job.feedback.reasons) ? job.feedback.reasons : [];
  const comment = job && job.feedback ? job.feedback.comment : null;

  let calibrationSignal = SIGNALS.UNKNOWN;

  // Sin decision del AI no se puede calibrar.
  if (aiDecision) {
    if (userStatus === JOB_STATES.DISCARDED) {
      if (aiDecision === 'NO') {
        calibrationSignal = SIGNALS.AI_CORRECT; // ambos negativos
      } else if (aiDecision === 'YES') {
        const anyProf = reasons.some((r) => dimensionOf(r) === DIMENSION.PROFESSIONAL_FIT);
        const anyInterest = reasons.some((r) => dimensionOf(r) === DIMENSION.INTEREST);
        if (anyProf && !anyInterest) {
          calibrationSignal = SIGNALS.AI_OVERESTIMATED_PROFESSIONAL_FIT;
        } else if (anyInterest && !anyProf) {
          calibrationSignal = SIGNALS.AI_OVERESTIMATED_INTEREST;
        } else {
          calibrationSignal = SIGNALS.UNKNOWN; // motivos mixtos/ambiguos/ausentes
        }
      } else {
        calibrationSignal = SIGNALS.UNKNOWN; // MAYBE + discarded: senal insuficiente
      }
    } else if (POSITIVE_USER_STATES.includes(userStatus)) {
      if (aiDecision === 'NO') {
        // El usuario quiere la oferta pese al NO del AI -> interes subestimado.
        calibrationSignal = SIGNALS.AI_UNDERESTIMATED_INTEREST;
      } else {
        calibrationSignal = SIGNALS.AI_CORRECT; // YES/MAYBE + accion positiva
      }
    } else {
      calibrationSignal = SIGNALS.UNKNOWN; // new/read: sin decision del usuario
    }
  }

  return {
    jobId: job ? job.jobId : null,
    aiDecision,
    userStatus,
    reasons: reasons.slice(),
    comment,
    calibrationSignal,
  };
}

module.exports = {
  computeCalibrationSignal,
  SIGNALS,
  POSITIVE_USER_STATES,
};

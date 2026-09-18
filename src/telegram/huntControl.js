'use strict';

// Adaptador entre Telegram y la AUTORIDAD del hunt.
//
// Telegram no ejecuta el pipeline ni duplica su logica: habla con el MISMO
// huntRunManager que usan la UI y el scheduler, en el mismo proceso. Asi el
// lock compartido, la concurrencia, el progreso, la cancelacion y el estado
// del run siguen viviendo en un solo lugar.
//
// La otra mitad de su trabajo es de SEGURIDAD: traduce lo que ocurre dentro
// del producto a un resultado de DOMINIO acotado. El router de comandos nunca
// ve un Error, ni un code interno arbitrario, ni un stack: solo uno de los
// resultados enumerados aqui. Nada que no este en esta lista puede llegar a
// un chat de Telegram.

// Estados del hunt que el manager considera "en curso".
const ACTIVE_STATUSES = new Set(['STARTING', 'RUNNING']);

// Motivos por los que el producto rechaza iniciar un hunt AHORA. Cada uno tiene
// una respuesta fija y util en ./commands.js; ninguno expone detalles internos.
const BLOCKED_CODES = new Set([
  'SETUP_REQUIRED',
  'LOGIN_REQUIRED',
  'CHECKPOINT_REQUIRED',
  'SESSION_WINDOW_OPEN',
  'APP_SHUTTING_DOWN',
]);

function num(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function createHuntControl(options = {}) {
  const huntRunManager = options.huntRunManager;
  const log = typeof options.log === 'function' ? options.log : () => {};
  if (!huntRunManager || typeof huntRunManager.start !== 'function' || typeof huntRunManager.getStatus !== 'function') {
    throw new TypeError('huntRunManager es obligatorio.');
  }

  // -> { result: 'started' | 'already_running' | 'blocked' | 'error', code? }
  async function startHunt() {
    try {
      const accepted = await huntRunManager.start();
      return { result: 'started', runId: (accepted && accepted.runId) || null };
    } catch (error) {
      const code = error && typeof error.code === 'string' ? error.code : null;
      if (code === 'HUNT_ALREADY_RUNNING') return { result: 'already_running' };
      if (BLOCKED_CODES.has(code)) return { result: 'blocked', code };
      // Cualquier otra cosa es un problema LOCAL: se loguea aca (con el code,
      // nunca con el mensaje ni el stack) y por Telegram sale una negativa
      // generica.
      log('no se pudo iniciar el hunt: ' + (code || 'error_desconocido'));
      return { result: 'error' };
    }
  }

  // -> { available, huntRunning, analyzed, target }
  // Lee la MISMA fuente que consulta la UI, asi que un hunt lanzado desde la
  // UI o desde el scheduler tambien se ve "ejecutandose" aqui.
  function getStatus() {
    try {
      const status = huntRunManager.getStatus();
      const progress = (status && status.progress) || {};
      const huntRunning = ACTIVE_STATUSES.has(status && status.status);
      return {
        available: true,
        huntRunning,
        analyzed: huntRunning ? num(progress.analysisCompleted) : null,
        target: huntRunning ? num(progress.analysisTarget) : null,
      };
    } catch (error) {
      log('no se pudo leer el estado del hunt.');
      return { available: false, huntRunning: false, analyzed: null, target: null };
    }
  }

  return { startHunt, getStatus };
}

module.exports = { ACTIVE_STATUSES, BLOCKED_CODES, createHuntControl };

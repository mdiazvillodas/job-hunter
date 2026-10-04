'use strict';

// Cliente del trigger service LOCAL (src/trigger/server.js).
//
// El listener de Telegram NO ejecuta src/hunt.js ni duplica la logica del
// trigger: se limita a hablar con el mismo endpoint HTTP que usa n8n. Asi el
// lock compartido, la concurrencia, el historial de runs y el comando fijo
// siguen viviendo en un solo lugar.
//
// Siempre contra loopback (127.0.0.1): nada de esto se expone a Internet.
// HUNT_TRIGGER_HOST puede ser 0.0.0.0 (direccion de bind, no de conexion), por
// eso el host de salida es fijo.

const DEFAULT_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 5000;

function resolveTriggerBaseUrl(env = process.env) {
  const port = Number(env.HUNT_TRIGGER_PORT) || DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

function createTriggerClient(options = {}) {
  const env = options.env || process.env;
  const baseUrl = (options.baseUrl || resolveTriggerBaseUrl(env)).replace(/\/+$/, '');
  const token = options.token !== undefined ? options.token : env.HUNT_TRIGGER_TOKEN;
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  async function request(method, pathname, opts = {}) {
    const headers = {};
    if (opts.auth && token) headers.Authorization = 'Bearer ' + token;
    const res = await fetchImpl(baseUrl + pathname, {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json };
  }

  // POST /run. Devuelve un resultado de DOMINIO, ya clasificado; el caller no
  // ve status codes ni cuerpos, para que nada de eso llegue a Telegram.
  async function startHunt() {
    try {
      const { status, json } = await request('POST', '/run', { auth: true });
      if (status === 202) return { result: 'started', runId: (json && json.runId) || null };
      if (status === 409) return { result: 'already_running' };
      if (status === 401) return { result: 'unauthorized' };
      return { result: 'error', status };
    } catch (err) {
      // Trigger apagado, puerto cerrado, timeout: para el usuario es lo mismo.
      return { result: 'unavailable' };
    }
  }

  // GET /health (sin auth). huntRunning = run lanzado por el trigger;
  // lockBusy = lock compartido (incluye un `npm run hunt` manual).
  async function getStatus() {
    try {
      const { status, json } = await request('GET', '/health');
      if (status !== 200 || !json || json.ok !== true) return { available: false, huntRunning: false };
      const running = json.busy === true || json.huntRunning === true || json.lockBusy === true;
      return { available: true, huntRunning: running };
    } catch (err) {
      return { available: false, huntRunning: false };
    }
  }

  return { startHunt, getStatus, baseUrl };
}

module.exports = {
  DEFAULT_PORT,
  resolveTriggerBaseUrl,
  createTriggerClient,
};

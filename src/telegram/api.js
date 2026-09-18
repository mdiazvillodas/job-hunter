'use strict';

// Cliente minimo de la Telegram Bot API. Solo fetch nativo, sin dependencias.
//
// Invariantes:
//   - El token viaja en la URL (lo exige la API) pero NUNCA sale de este modulo:
//     todo mensaje de error pasa por redactToken() antes de propagarse.
//   - Conexiones SALIENTES unicamente. No hay webhook, no se abre ningun puerto,
//     no hace falta dominio, tunel ni exponer nada a Internet.
//   - Un error de red no se traga: se propaga clasificado para que el caller
//     decida reintentar con backoff.

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 15000;
const REDACTED = '[token]';

class TelegramApiError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = info.status ?? null;             // HTTP status, si hubo respuesta
    this.errorCode = info.errorCode ?? null;       // error_code de Telegram
    this.network = info.network === true;          // true => reintentable
  }
}

// Saca el token de cualquier texto antes de loguearlo o propagarlo.
function redactToken(text, token) {
  if (text == null) return text;
  let out = String(text);
  if (token) {
    out = out.split(String(token)).join(REDACTED);
    // Tambien la forma /bot<token>/ por si aparece en una URL de un error de red.
    out = out.replace(/\/bot[0-9]+:[A-Za-z0-9_-]+/g, '/bot' + REDACTED);
  }
  return out.replace(/\/bot[0-9]+:[A-Za-z0-9_-]+/g, '/bot' + REDACTED);
}

function createTelegramApi(options = {}) {
  const token = options.token;
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetch || ((...args) => globalThis.fetch(...args));
  const defaultTimeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!token) throw new Error('El token del bot de Telegram no esta configurado.');

  // call(method, params, { timeoutMs, signal })
  // Resuelve con el `result` de Telegram; lanza TelegramApiError ya redactado.
  async function call(method, params = {}, callOptions = {}) {
    const url = `${baseUrl}/bot${token}/${method}`;
    const timeoutMs = callOptions.timeoutMs || defaultTimeoutMs;

    // El signal externo (parada del servicio) se combina con el timeout propio.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callOptions.signal
      ? AbortSignal.any([timeoutSignal, callOptions.signal])
      : timeoutSignal;

    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal,
      });
    } catch (err) {
      // Red caida, DNS, timeout, abort: reintentable (salvo abort explicito, que
      // el caller distingue por su propio signal).
      throw new TelegramApiError(redactToken(err && err.message ? err.message : String(err), token), {
        network: true,
      });
    }

    let body = null;
    try {
      body = await res.json();
    } catch (err) {
      throw new TelegramApiError(`respuesta no-JSON de Telegram (HTTP ${res.status})`, { status: res.status });
    }

    if (!res.ok || !body || body.ok !== true) {
      const description = (body && body.description) || `HTTP ${res.status}`;
      throw new TelegramApiError(redactToken(description, token), {
        status: res.status,
        errorCode: body && body.error_code ? body.error_code : null,
      });
    }

    return body.result;
  }

  return {
    call,
    redact: (text) => redactToken(text, token),
    getMe: (opts) => call('getMe', {}, opts),
    getUpdates: (params, opts) => call('getUpdates', params, opts),
    sendMessage: (params, opts) => call('sendMessage', params, opts),
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  TelegramApiError,
  redactToken,
  createTelegramApi,
};

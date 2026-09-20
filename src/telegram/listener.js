'use strict';

// Listener del bot por LONG POLLING (getUpdates), dentro del proceso de la UI.
//
// Por que long polling y no webhook:
//   la PC solo hace conexiones SALIENTES hacia api.telegram.org. No se abre
//   ningun puerto, no hace falta dominio, tunel, VPN ni exponer nada.
//
// Invariantes:
//   - Autorizacion antes que comando (ver ./commands.js).
//   - offset correcto y PERSISTIDO: un update confirmado no vuelve a
//     procesarse, ni siquiera despues de cerrar o actualizar Job Hunter.
//     Ademas hay un guard de ids recientes en memoria, porque si la red se
//     corta ANTES de confirmar, Telegram reenvia el update y no queremos
//     disparar dos hunts.
//   - ARRANQUE EN FRIO: sin offset persistido se descarta el backlog. Un /hunt
//     enviado con la PC apagada no puede lanzar una busqueda al encender.
//   - Un update que falle no bloquea la cola: se loguea y se avanza igual.
//   - Errores de red -> backoff exponencial acotado, sin ruido y sin quemar CPU.
//   - stop() corta la request en curso y sale limpio.
//   - Nunca se imprime el token.

const { handleUpdate } = require('./commands');

const DEFAULT_POLL_TIMEOUT_SEC = 30;
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
const SEEN_LIMIT = 500;

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }
  });
}

function createListener(options = {}) {
  const api = options.api;
  const huntControl = options.huntControl;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const onUpdate = options.handleUpdate || handleUpdate;
  const pollTimeoutSec = Number.isFinite(options.pollTimeoutSec) ? options.pollTimeoutSec : DEFAULT_POLL_TIMEOUT_SEC;
  const sleep = options.sleep || defaultSleep;
  const maxBackoffMs = options.maxBackoffMs || MAX_BACKOFF_MS;
  const allowedUserId = options.allowedUserId;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  // Origen de la ventana de frescura: un comando de accion anterior a el se
  // considera una orden vieja que quedo en la cola de Telegram mientras la PC
  // estaba apagada, y no se ejecuta.
  //
  // Normalmente lo INYECTA telegramService, que es su dueño: la ventana es de
  // la instalacion, no de este objeto, y por eso sobrevive a los restart con
  // los que se reconcilia la configuracion. El fallback es solo para un
  // listener suelto (tests, uso directo).
  const sessionStartedAt = Number.isFinite(options.sessionStartedAt) ? options.sessionStartedAt : now();
  // Persistencia del offset. Inyectable; un fallo suyo nunca detiene el loop.
  const persistOffset = typeof options.persistOffset === 'function' ? options.persistOffset : () => {};

  let offset = Number.isInteger(options.initialOffset) ? options.initialOffset : null;
  // primed = ya se decidio que hacer con el backlog previo al arranque.
  let primed = offset !== null;
  let failures = 0;
  let running = false;
  const controller = new AbortController();

  // Guard anti-reproceso: ids recientes en orden de llegada, acotado.
  const seen = new Set();
  const seenOrder = [];
  function remember(updateId) {
    seen.add(updateId);
    seenOrder.push(updateId);
    while (seenOrder.length > SEEN_LIMIT) seen.delete(seenOrder.shift());
  }

  function advanceOffset(nextOffset) {
    if (!Number.isInteger(nextOffset) || (offset !== null && nextOffset <= offset)) return;
    offset = nextOffset;
    try { persistOffset(offset); } catch (_) { log('no se pudo guardar el offset; se continua en memoria'); }
  }

  async function reply(answer) {
    if (!answer || answer.chatId == null) return;
    try {
      await api.sendMessage({
        chat_id: answer.chatId,
        text: answer.text,
        reply_markup: answer.replyMarkup,
      }, { signal: controller.signal });
    } catch (err) {
      log('no pude responder: ' + err.message);
    }
  }

  async function processUpdate(update) {
    const updateId = update && update.update_id;
    if (Number.isFinite(updateId)) {
      if (seen.has(updateId)) {
        log(`update ${updateId} duplicado, ignorado`);
        return;
      }
      remember(updateId);
    }
    const answer = await onUpdate(update, {
      huntControl,
      allowedUserId,
      sessionStartedAt,
      now: now(),
      maxCommandAgeMs: options.maxCommandAgeMs,
      sessionGraceMs: options.sessionGraceMs,
    });
    if (!answer) {
      log('update ignorado');
      return;
    }
    log(answer.log);
    await reply(answer);
  }

  // Arranque en frio: se averigua cual es el ultimo update encolado y se salta
  // TODO lo anterior sin ejecutarlo. Es la diferencia entre "el bot arranca" y
  // "el bot obedece ordenes de ayer".
  async function primeOffset() {
    const updates = await api.getUpdates({ offset: -1, timeout: 0, limit: 1 }, {
      timeoutMs: 15000,
      signal: controller.signal,
    });
    primed = true;
    const list = Array.isArray(updates) ? updates : [];
    const last = list.length ? list[list.length - 1] : null;
    if (last && Number.isInteger(last.update_id)) {
      advanceOffset(last.update_id + 1);
      log('arranque en frio: se descarta el backlog de Telegram');
    }
    return 0;
  }

  // Un ciclo de polling. Devuelve cuantos updates llegaron (para los tests).
  async function pollOnce() {
    if (!primed) return primeOffset();

    const params = { timeout: pollTimeoutSec, allowed_updates: ['message'] };
    if (offset !== null) params.offset = offset;

    const updates = await api.getUpdates(params, {
      // El timeout de la request debe superar al del long poll del servidor.
      timeoutMs: (pollTimeoutSec + 10) * 1000,
      signal: controller.signal,
    });

    for (const update of Array.isArray(updates) ? updates : []) {
      try {
        await processUpdate(update);
      } catch (err) {
        // Un update envenenado no puede frenar la cola.
        log('error procesando update: ' + err.message);
      } finally {
        if (Number.isInteger(update && update.update_id)) advanceOffset(update.update_id + 1);
      }
    }
    return Array.isArray(updates) ? updates.length : 0;
  }

  async function run() {
    running = true;
    while (running) {
      try {
        await pollOnce();
        failures = 0;
      } catch (err) {
        if (!running || controller.signal.aborted) break;
        failures += 1;
        const wait = Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), maxBackoffMs);
        log(`error de red (${failures}): ${err.message}. Reintento en ${Math.round(wait / 1000)}s`);
        await sleep(wait, controller.signal);
      }
    }
    running = false;
  }

  function stop() {
    running = false;
    controller.abort();
  }

  return {
    run,
    stop,
    pollOnce,
    get offset() { return offset; },
    get failures() { return failures; },
    get running() { return running; },
    get sessionStartedAt() { return sessionStartedAt; },
  };
}

module.exports = { createListener, DEFAULT_POLL_TIMEOUT_SEC, FIRST_BACKOFF_MS, MAX_BACKOFF_MS, SEEN_LIMIT };

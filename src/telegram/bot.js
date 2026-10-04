'use strict';

// npm run telegram
//
// Listener del bot por LONG POLLING (getUpdates). Proceso independiente y
// persistente, como la UI y el trigger.
//
// Por que long polling y no webhook:
//   la PC solo hace conexiones SALIENTES hacia api.telegram.org. No se abre
//   ningun puerto, no hace falta dominio, tunel ni exponer nada a Internet.
//
// Invariantes:
//   - Autorizacion antes que comando (ver ./commands.js).
//   - offset correcto: un update confirmado no vuelve a procesarse. Ademas hay
//     un guard de ids recientes, porque si la red se corta ANTES de confirmar,
//     Telegram reenvia el update y no queremos disparar dos hunts.
//   - Un update que falle no bloquea la cola: se loguea y se avanza igual.
//   - Errores de red -> backoff exponencial, sin ruido y sin quemar CPU.
//   - Ctrl+C corta la request en curso y sale limpio.
//   - Nunca se imprime el token.

require('../env').loadProjectEnv();

const { createTelegramApi } = require('./api');
const { createTriggerClient } = require('./triggerClient');
const { handleUpdate, parseAllowedUserId } = require('./commands');
const { createTelegramStateStore } = require('./state');

const DEFAULT_POLL_TIMEOUT_SEC = 30;
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
const SEEN_LIMIT = 500;

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }
  });
}

function createListener(options = {}) {
  const api = options.api;
  const trigger = options.trigger;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const onUpdate = options.handleUpdate || handleUpdate;
  const pollTimeoutSec = Number.isFinite(options.pollTimeoutSec) ? options.pollTimeoutSec : DEFAULT_POLL_TIMEOUT_SEC;
  const sleep = options.sleep || defaultSleep;
  const maxBackoffMs = options.maxBackoffMs || MAX_BACKOFF_MS;
  const allowedUserId = options.allowedUserId;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  // Momento de arranque de ESTA sesion de escucha. Un comando de accion
  // anterior a el es una orden vieja que quedo en la cola de Telegram
  // mientras la PC estaba apagada, y no se ejecuta.
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

  // El offset nunca retrocede: retroceder seria pedirle a Telegram que
  // reenvie comandos ya ejecutados.
  function advanceOffset(nextOffset) {
    if (!Number.isInteger(nextOffset) || (offset !== null && nextOffset <= offset)) return;
    offset = nextOffset;
    try { persistOffset(offset); } catch (e) { log('no se pudo guardar el offset; se continua en memoria'); }
  }

  async function reply(update, answer) {
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
      trigger,
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
    await reply(update, answer);
  }

  // Arranque en frio (sin offset persistido): se averigua cual es el ultimo
  // update encolado y se salta TODO lo anterior sin ejecutarlo.
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
    get sessionStartedAt() { return sessionStartedAt; },
  };
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN no esta definido (ni en .env ni en el entorno).');
    process.exitCode = 1;
    return;
  }

  const allowedUserId = parseAllowedUserId(process.env.TELEGRAM_ALLOWED_USER_ID);
  const api = createTelegramApi({ token });
  const trigger = createTriggerClient();
  const log = (m) => console.log('[telegram] ' + m);

  let me;
  try {
    me = await api.getMe();
  } catch (err) {
    console.error('ERROR: no pude hablar con la Telegram Bot API: ' + err.message);
    process.exitCode = 1;
    return;
  }

  console.log(`job-hunter-telegram (long polling) conectado como @${me.username}`);
  console.log(`  trigger local: ${trigger.baseUrl}`);
  if (allowedUserId) {
    console.log(`  usuario autorizado: ${allowedUserId}`);
  } else {
    console.log('  AVISO: TELEGRAM_ALLOWED_USER_ID no esta configurado.');
    console.log('         Ningun usuario puede ejecutar comandos todavia.');
    console.log('         Ejecuta `npm run telegram:whoami` y copia tu id al .env.');
  }
  console.log('  Comandos: /start /hunt /status');
  console.log('  Ctrl+C para detener.');

  // Offset persistido: un update ya atendido no vuelve a ejecutarse tras un
  // reinicio, y el arranque en frio descarta el backlog acumulado.
  const stateStore = createTelegramStateStore({ log: (m) => console.log('[telegram] ' + m) });
  const listener = createListener({
    api,
    trigger,
    allowedUserId,
    log,
    initialOffset: stateStore.getNextUpdateId(),
    persistOffset: (value) => stateStore.setNextUpdateId(value),
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log('\n[telegram] deteniendo listener...');
    listener.stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await listener.run();
  console.log('[telegram] listener detenido.');
}

module.exports = { createListener, DEFAULT_POLL_TIMEOUT_SEC, MAX_BACKOFF_MS, SEEN_LIMIT };

if (require.main === module) {
  main();
}

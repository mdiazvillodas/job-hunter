'use strict';

// Componente gestionado EN PROCESO, dentro del servidor de la UI. Es el dueño
// del ciclo de vida del listener y de todo el onboarding de Telegram.
//
// Por que en proceso y no otro proceso Node:
//   el scheduler ya es un actor de fondo de larga vida en este mismo proceso y
//   habla directamente con huntRunManager. Telegram tiene esa misma forma, con
//   un bucle de red en lugar de un temporizador. Un proceso aparte necesitaria
//   su propio acceso al token, su propia supervision y su propio apagado, y
//   tendria que llegar a la autoridad del hunt por HTTP.
//
// Invariantes:
//   - Desactivado o sin configurar => CERO trafico hacia Telegram.
//   - Un unico listener por instalacion: el lock de la UI garantiza un solo
//     proceso, y start() es idempotente dentro de el.
//   - La deteccion de cuenta y el listener NUNCA sondean a la vez: dos
//     consumidores de getUpdates sobre el mismo token se roban los mensajes.
//   - Un fallo de Telegram (red, token revocado) deja el servicio en ERROR
//     pero no afecta a la UI, al scheduler ni a un hunt en curso.
//   - Nada de lo que devuelve este modulo contiene el token.

const { createTelegramApi } = require('./api');
const { createListener } = require('./listener');
const { createHuntControl } = require('./huntControl');
const { createTelegramSecretStore, isWellFormedToken } = require('./telegramSecret');
const { createTelegramStateStore } = require('./telegramState');
const { getUserConfig } = require('../config/userConfig');
const { saveUserConfigFile } = require('../config/searchSettings');
const {
  toEditableTelegram,
  getTelegramSettings,
  applyBotIdentity,
  applyLinkedAccount,
  applyTelegramEnabled,
  applyUnlinkedAccount,
} = require('../config/telegramSettings');

// Ventana de frescura para la deteccion de cuenta: solo cuentan los mensajes
// que la usuaria manda DURANTE el onboarding. Un /hunt de hace tres dias en el
// backlog no puede convertirse en una cuenta autorizada.
const DETECTION_WINDOW_MS = 10 * 60 * 1000;
const DETECTION_LIMIT = 100;
const MAX_TEXT_CHARS = 80;

const STATE_STOPPED = 'STOPPED';
const STATE_RUNNING = 'RUNNING';
const STATE_ERROR = 'ERROR';

function serviceError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

function shortText(text) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  return raw.length > MAX_TEXT_CHARS ? raw.slice(0, MAX_TEXT_CHARS - 1) + '…' : raw;
}

// Agrupa los updates FRESCOS de chat PRIVADO por remitente. Devuelve tambien el
// mayor update_id visto, para poder saltarlo tras vincular.
function extractCandidates(updates, options = {}) {
  const since = Number.isFinite(options.since) ? options.since : 0;
  const byUser = new Map();
  let maxUpdateId = null;
  for (const update of Array.isArray(updates) ? updates : []) {
    if (Number.isInteger(update && update.update_id)) {
      maxUpdateId = maxUpdateId === null ? update.update_id : Math.max(maxUpdateId, update.update_id);
    }
    const message = (update && (update.message || update.edited_message)) || null;
    const from = message && message.from;
    if (!from || from.id == null) continue;
    // Solo chats privados: un mensaje en un grupo jamas produce un candidato.
    if (!message.chat || message.chat.type !== 'private') continue;
    // Solo mensajes de la ventana de onboarding.
    const dateMs = Number.isFinite(message.date) ? message.date * 1000 : null;
    if (dateMs === null || dateMs < since) continue;

    const userId = String(from.id);
    const entry = byUser.get(userId) || { userId, displayName: null, username: null, lastText: null, messages: 0 };
    entry.displayName = from.first_name || entry.displayName || from.username || null;
    entry.username = from.username || entry.username;
    const text = shortText(message.text);
    if (text) entry.lastText = text;
    entry.messages += 1;
    byUser.set(userId, entry);
  }
  return { candidates: [...byUser.values()], maxUpdateId };
}

function createTelegramService(options = {}) {
  const huntRunManager = options.huntRunManager;
  const secretStore = options.secretStore || createTelegramSecretStore();
  const stateStore = options.stateStore || createTelegramStateStore();
  const readConfig = options.readConfig || getUserConfig;
  const saveConfig = options.saveConfig || saveUserConfigFile;
  const apiFactory = options.createApi || createTelegramApi;
  const listenerFactory = options.createListener || createListener;
  const clock = options.clock || (() => Date.now());
  const log = typeof options.log === 'function' ? options.log : (m) => console.log('[telegram] ' + m);
  if (!huntRunManager) throw new TypeError('huntRunManager es obligatorio.');

  // El adaptador se construye cuando hace falta de verdad (al arrancar un
  // listener), no al crear el servicio: crear el servidor de la UI no puede
  // depender de que el control remoto este en condiciones de funcionar.
  let huntControl = null;
  function control() {
    if (!huntControl) huntControl = createHuntControl({ huntRunManager, log });
    return huntControl;
  }

  let listener = null;
  let loop = null;
  let state = STATE_STOPPED;
  let lastError = null;
  // Resultado de la ultima deteccion, EN MEMORIA: vincular solo acepta una
  // cuenta que esta deteccion haya ofrecido.
  let detection = null;

  function settings() {
    try { return getTelegramSettings(readConfig()); }
    catch (_) { return { enabled: false, allowedUserId: null, account: null, bot: null }; }
  }

  function api() {
    const token = secretStore.readToken(); // SIEMPRE del disco, nunca cacheado
    if (!token) throw serviceError('TELEGRAM_TOKEN_REQUIRED', 'Configurá el token del bot antes de continuar.');
    return apiFactory({ token });
  }

  /* ---------------- ciclo de vida ---------------- */

  function isRunning() {
    return !!listener;
  }

  // Arranca el listener si (y solo si) la configuracion lo permite.
  // Idempotente: llamarlo dos veces no crea dos bucles.
  function start() {
    if (listener) return getStatus();
    const config = settings();
    if (!config.enabled || !config.allowedUserId || !secretStore.isConfigured()) {
      state = STATE_STOPPED;
      return getStatus();
    }
    let client;
    let commands;
    try { client = api(); commands = control(); }
    catch (error) {
      state = STATE_ERROR;
      lastError = 'No se pudo preparar la conexión con Telegram.';
      log('no se pudo crear el cliente de Telegram');
      return getStatus();
    }
    listener = listenerFactory({
      api: client,
      huntControl: commands,
      allowedUserId: config.allowedUserId,
      initialOffset: stateStore.getNextUpdateId(),
      persistOffset: (value) => stateStore.setNextUpdateId(value),
      log: (message) => log(message),
    });
    state = STATE_RUNNING;
    lastError = null;
    // El bucle vive por su cuenta: un fallo suyo no puede tumbar el arranque
    // de la UI ni propagarse a quien llamo a start().
    loop = listener.run().catch((error) => {
      state = STATE_ERROR;
      lastError = 'La conexión con Telegram se interrumpió.';
      log('el listener termino con error');
    });
    log('control remoto activo');
    return getStatus();
  }

  async function stop() {
    if (!listener) { state = STATE_STOPPED; return getStatus(); }
    const current = listener;
    const pending = loop;
    listener = null;
    loop = null;
    current.stop();
    try { await pending; } catch (_) { /* el bucle ya se estaba cerrando */ }
    state = STATE_STOPPED;
    log('control remoto detenido');
    return getStatus();
  }

  // Parada + arranque SECUENCIALES: el bucle viejo esta muerto antes de que
  // nazca el nuevo, asi que nunca hay dos consumidores de getUpdates.
  async function restart() {
    await stop();
    return start();
  }

  function getStatus() {
    const config = settings();
    const editable = (() => {
      try { return toEditableTelegram(readConfig()); }
      catch (_) { return { enabled: false, linked: false, account: null, bot: null }; }
    })();
    return {
      enabled: editable.enabled,
      linked: editable.linked,
      tokenConfigured: secretStore.isConfigured(),
      bot: editable.bot,
      account: editable.account,
      listener: { state, error: lastError },
      // `ready` = todo lo necesario esta configurado, independientemente de si
      // el bucle esta vivo en este instante.
      ready: !!(config.enabled && config.allowedUserId && secretStore.isConfigured()),
    };
  }

  /* ---------------- onboarding ---------------- */

  // 1) Validar el token contra getMe y, SOLO si Telegram lo acepta, guardarlo.
  async function validateAndSaveToken(token) {
    if (!isWellFormedToken(token)) {
      throw serviceError('INVALID_TELEGRAM_TOKEN', 'El token del bot no tiene un formato válido.', 400);
    }
    let me;
    try {
      me = await apiFactory({ token: String(token).trim() }).getMe();
    } catch (error) {
      // El mensaje de Telegram ya viene redactado por api.js, pero aqui ni
      // siquiera se reenvia: la UI solo necesita saber que no sirve.
      throw serviceError('TELEGRAM_TOKEN_REJECTED', 'Telegram no aceptó ese token. Revisalo y probá de nuevo.', 400);
    }
    // El orden importa: primero el secreto, despues la identidad visible.
    secretStore.saveToken(token);
    saveConfig(applyBotIdentity(readConfig(), me));
    // Cambiar de bot invalida la cola pendiente del bot anterior.
    detection = null;
    log('bot validado y token guardado');
    return getStatus();
  }

  // 2) Detectar la cuenta. Requiere que el listener NO este sondeando.
  async function detectAccount() {
    if (listener) {
      throw serviceError('TELEGRAM_LISTENER_ACTIVE', 'Desactivá el control remoto antes de volver a detectar la cuenta.');
    }
    const since = clock() - DETECTION_WINDOW_MS;
    let updates;
    try {
      // Sin offset: se LEE lo pendiente sin confirmarlo, para no consumir
      // mensajes que el listener deberia ver despues.
      updates = await api().getUpdates({ timeout: 0, limit: DETECTION_LIMIT });
    } catch (error) {
      if (error.code) throw error;
      throw serviceError('TELEGRAM_UNAVAILABLE', 'No pude consultar Telegram. Revisá la conexión y probá de nuevo.', 502);
    }
    const { candidates, maxUpdateId } = extractCandidates(updates, { since });
    detection = {
      id: `det_${clock().toString(36)}`,
      candidates,
      maxUpdateId,
      createdAt: clock(),
    };
    return {
      detectionId: detection.id,
      // Solo datos que sirven para reconocerse; el id nunca se presenta como
      // algo que la usuaria deba entender ni recordar.
      candidates: candidates.map((c) => ({ userId: c.userId, displayName: c.displayName, username: c.username, lastText: c.lastText })),
    };
  }

  // 3) Vincular. Solo una cuenta ofrecida por la deteccion VIGENTE.
  function linkAccount(input = {}) {
    if (!detection || detection.id !== input.detectionId) {
      throw serviceError('TELEGRAM_DETECTION_EXPIRED', 'La detección caducó. Volvé a detectar tu cuenta.');
    }
    const candidate = detection.candidates.find((c) => c.userId === String(input.userId));
    if (!candidate) {
      throw serviceError('TELEGRAM_CANDIDATE_UNKNOWN', 'Esa cuenta no aparece en la detección actual.');
    }
    saveConfig(applyLinkedAccount(readConfig(), candidate));
    // El mensaje con el que la usuaria se identifico NO debe ejecutarse luego
    // como si fuera un comando: se salta todo lo visto durante la deteccion.
    if (Number.isInteger(detection.maxUpdateId)) stateStore.setNextUpdateId(detection.maxUpdateId + 1);
    detection = null;
    log('cuenta vinculada');
    return start();
  }

  async function setEnabled(enabled) {
    saveConfig(applyTelegramEnabled(readConfig(), enabled === true));
    return enabled === true ? restart() : stop();
  }

  async function unlinkAccount() {
    await stop();
    saveConfig(applyUnlinkedAccount(readConfig()));
    detection = null;
    return getStatus();
  }

  // Prueba operativa: manda un mensaje real a la cuenta vinculada. No usa el
  // listener, asi que no interfiere con el polling.
  async function sendTestMessage() {
    const config = settings();
    if (!config.allowedUserId) throw serviceError('TELEGRAM_ACCOUNT_REQUIRED', 'Vinculá tu cuenta de Telegram antes de probar.');
    try {
      await api().sendMessage({ chat_id: config.allowedUserId, text: '✅ Job Hunter conectado correctamente.' });
    } catch (error) {
      if (error.code === 'TELEGRAM_TOKEN_REQUIRED') throw error;
      throw serviceError('TELEGRAM_SEND_FAILED', 'No pude enviar el mensaje. Abrí el bot en Telegram y pulsá Start.', 502);
    }
    return { ok: true };
  }

  return {
    start,
    stop,
    restart,
    getStatus,
    isRunning,
    validateAndSaveToken,
    detectAccount,
    linkAccount,
    setEnabled,
    unlinkAccount,
    sendTestMessage,
  };
}

module.exports = {
  DETECTION_WINDOW_MS,
  DETECTION_LIMIT,
  STATE_STOPPED,
  STATE_RUNNING,
  STATE_ERROR,
  extractCandidates,
  createTelegramService,
};

'use strict';

// Router de comandos del bot. PURO respecto de Telegram: no hace requests a la
// Bot API; recibe un update y devuelve la respuesta a enviar (o null).
// Lo unico que toca el producto es el huntControl inyectado.
//
// Seguridad (regla dura, primero que cualquier comando):
//   - Solo message.from.id === allowedUserId puede ejecutar algo. Se autoriza
//     por USER id, no por chat id: aunque en un chat privado normalmente
//     coincidan, son conceptos distintos.
//   - Solo chat.type === 'private'. Grupos, supergrupos y canales se IGNORAN
//     en silencio: no se confirma siquiera que el bot responde ahi.
//   - Sin cuenta vinculada no hay usuario autorizado.
//   - Las respuestas nunca revelan ids, tokens, paths, topics, valores de
//     entorno, cookies, stacks ni mensajes de excepcion.

const TEXTS = {
  unauthorized: '⛔ No autorizado.',
  start: [
    '🤖 Job Hunter conectado.',
    '',
    'Usá /hunt para iniciar una búsqueda.',
    'Usá /status para consultar el estado.',
  ].join('\n'),
  huntStarted: '🚀 Hunt iniciado.',
  huntAlreadyRunning: '⏳ Ya hay un hunt ejecutándose.',
  unavailable: '❌ No pude contactar al Job Hunter en esta PC.',
  huntError: '❌ No pude iniciar el hunt.',
  statusAvailableIdle: '🟢 Job Hunter disponible\nHunt: inactivo',
  statusAvailableRunning: '🟢 Job Hunter disponible\nHunt: ejecutándose',
  statusUnavailable: '🔴 Job Hunter no disponible',
  staleAction: '⚠️ Ignoré una solicitud antigua de hunt.',
  unknown: 'No entendí. Comandos: /start, /hunt, /status',
};

// Respuesta FIJA por cada motivo por el que el producto no puede arrancar un
// hunt ahora. Nunca se reenvia el mensaje interno del error.
const BLOCKED_TEXTS = {
  LOGIN_REQUIRED: '🔐 Necesitás iniciar sesión en LinkedIn en la PC.',
  CHECKPOINT_REQUIRED: '🔐 LinkedIn pide una verificación manual en la PC.',
  SESSION_WINDOW_OPEN: '⚠️ Cerrá la ventana de LinkedIn abierta en la PC.',
  SETUP_REQUIRED: '⚙️ Job Hunter todavía no está configurado.',
  APP_SHUTTING_DOWN: TEXTS.unavailable,
};

// Comandos que PROVOCAN UNA ACCION. Solo estos exigen frescura: /start y
// /status son consultas y no pueden causar daño por llegar tarde.
const ACTION_COMMANDS = new Set(['hunt']);

// Telegram guarda los updates no entregados ~24h. Si la PC estuvo apagada,
// al arrancar el listener recibe el /hunt de anoche y, sin esta regla, lo
// ejecutaria: encender el ordenador no puede lanzar una busqueda que nadie
// pidio ahora.
//   1) el mensaje tiene que ser posterior al arranque de ESTA sesion;
//   2) y ademas no puede ser mas viejo que la ventana maxima, que protege
//      contra colas largas mientras el listener ya estaba vivo.
const MAX_COMMAND_AGE_MS = 10 * 60 * 1000;
// Tolerancia de reloj entre el servidor de Telegram y la PC.
const SESSION_GRACE_MS = 60 * 1000;

const BUTTON_HUNT = '🔎 Lanzar Hunt';
const BUTTON_STATUS = '📊 Estado';

// Reply keyboard (no inline): mas simple y robusto que los callback queries.
// Los botones mandan exactamente el mismo texto que ya entiende el router, asi
// que pulsar un boton y escribir el comando recorren el MISMO camino.
const REPLY_KEYBOARD = {
  keyboard: [[{ text: BUTTON_HUNT }, { text: BUTTON_STATUS }]],
  resize_keyboard: true,
  is_persistent: true,
};

// Solo numerico. Cualquier otra cosa (vacio, null, espacios) = sin configurar.
function parseAllowedUserId(raw) {
  const value = String(raw == null ? '' : raw).trim();
  return /^\d+$/.test(value) ? value : null;
}

// '/hunt', '/hunt@MiBot', ' /HUNT ' y los botones -> 'hunt'
function parseCommand(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  if (raw === BUTTON_HUNT) return 'hunt';
  if (raw === BUTTON_STATUS) return 'status';
  const m = raw.match(/^\/([A-Za-z_]+)(@[A-Za-z0-9_]+)?\b/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return ['start', 'hunt', 'status'].includes(name) ? name : null;
}

// { allowed, reason }: 'ok' | 'not_private' | 'forbidden_user' | 'not_configured'
function authorize(message, allowedUserId) {
  const chatType = message && message.chat && message.chat.type;
  if (chatType !== 'private') return { allowed: false, reason: 'not_private' };
  const allowed = parseAllowedUserId(allowedUserId);
  if (!allowed) return { allowed: false, reason: 'not_configured' };
  const fromId = message && message.from && message.from.id;
  if (fromId == null || String(fromId) !== allowed) return { allowed: false, reason: 'forbidden_user' };
  return { allowed: true, reason: 'ok' };
}

// Un comando de accion solo se ejecuta si es de AHORA. Sin fecha utilizable se
// considera viejo: ante la duda no se lanza un hunt.
function isFreshAction(message, deps = {}) {
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const sessionStartedAt = Number.isFinite(deps.sessionStartedAt) ? deps.sessionStartedAt : 0;
  const maxAgeMs = Number.isFinite(deps.maxCommandAgeMs) ? deps.maxCommandAgeMs : MAX_COMMAND_AGE_MS;
  const graceMs = Number.isFinite(deps.sessionGraceMs) ? deps.sessionGraceMs : SESSION_GRACE_MS;

  const seconds = message && message.date;
  if (!Number.isFinite(seconds)) return false;
  const sentAt = seconds * 1000;
  if (now - sentAt > maxAgeMs) return false;
  if (sentAt < sessionStartedAt - graceMs) return false;
  return true;
}

async function runHuntCommand(huntControl) {
  const outcome = await huntControl.startHunt();
  switch (outcome.result) {
    case 'started': return { text: TEXTS.huntStarted, log: 'hunt:started' };
    case 'already_running': return { text: TEXTS.huntAlreadyRunning, log: 'hunt:already_running' };
    case 'blocked': return {
      text: BLOCKED_TEXTS[outcome.code] || TEXTS.huntError,
      log: 'hunt:blocked:' + outcome.code,
    };
    default: return { text: TEXTS.huntError, log: 'hunt:error' };
  }
}

// El progreso solo se muestra si AMBOS valores son reales; si falta uno, la
// linea se omite en vez de inventar un numero.
function statusText(status) {
  if (!status.huntRunning) return TEXTS.statusAvailableIdle;
  const analyzed = status.analyzed;
  const target = status.target;
  if (!Number.isFinite(analyzed) || !Number.isFinite(target) || target <= 0) return TEXTS.statusAvailableRunning;
  return `${TEXTS.statusAvailableRunning}\nAnalizadas: ${analyzed}/${target}`;
}

async function runStatusCommand(huntControl) {
  const status = await huntControl.getStatus();
  if (!status || !status.available) return { text: TEXTS.statusUnavailable, log: 'status:unavailable' };
  return { text: statusText(status), log: status.huntRunning ? 'status:running' : 'status:idle' };
}

// handleUpdate(update, { huntControl, allowedUserId })
//   -> { chatId, text, replyMarkup?, log } para responder
//   -> null para ignorar sin responder
async function handleUpdate(update, deps = {}) {
  const message = update && update.message;
  if (!message || typeof message.text !== 'string') return null; // solo mensajes de texto

  const auth = authorize(message, deps.allowedUserId);
  const chatId = message.chat && message.chat.id;

  if (!auth.allowed) {
    // Fuera de un chat privado no se responde NADA.
    if (auth.reason === 'not_private') return null;
    return { chatId, text: TEXTS.unauthorized, log: 'denied:' + auth.reason };
  }

  const command = parseCommand(message.text);
  // Frescura ANTES de ejecutar: el boton recorre este mismo camino, asi que un
  // "🔎 Lanzar Hunt" viejo queda cubierto igual que un /hunt viejo.
  if (ACTION_COMMANDS.has(command) && !isFreshAction(message, deps)) {
    return { chatId, text: TEXTS.staleAction, replyMarkup: REPLY_KEYBOARD, log: 'hunt:stale' };
  }

  let reply;
  if (command === 'start') reply = { text: TEXTS.start, log: 'start' };
  else if (command === 'hunt') reply = await runHuntCommand(deps.huntControl);
  else if (command === 'status') reply = await runStatusCommand(deps.huntControl);
  else reply = { text: TEXTS.unknown, log: 'unknown_command' };

  // El teclado viaja con toda respuesta autorizada: si el usuario lo oculto,
  // vuelve solo. Nunca se manda a un usuario no autorizado.
  return { chatId, text: reply.text, replyMarkup: REPLY_KEYBOARD, log: reply.log };
}

module.exports = {
  TEXTS,
  ACTION_COMMANDS,
  MAX_COMMAND_AGE_MS,
  SESSION_GRACE_MS,
  isFreshAction,
  BLOCKED_TEXTS,
  BUTTON_HUNT,
  BUTTON_STATUS,
  REPLY_KEYBOARD,
  parseAllowedUserId,
  parseCommand,
  authorize,
  statusText,
  handleUpdate,
};

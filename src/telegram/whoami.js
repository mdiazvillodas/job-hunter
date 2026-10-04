'use strict';

// npm run telegram:whoami
//
// Muestra que usuarios le escribieron al bot, para que puedas copiar TU
// Telegram User ID a mano en .env (TELEGRAM_ALLOWED_USER_ID).
//
// - Usa TELEGRAM_BOT_TOKEN, pero NUNCA lo imprime.
// - Solo muestra informacion segura: user id, first_name, username y el texto
//   del mensaje (recortado) para que puedas reconocerte.
// - NO escribe en .env ni en ningun archivo.
// - No confirma updates (llama a getUpdates sin offset), asi que no le roba
//   mensajes al listener si llegara a estar corriendo.

require('../env').loadProjectEnv();

const { createTelegramApi } = require('./api');

const MAX_TEXT_CHARS = 80;
const NO_UPDATES_MESSAGE = [
  'No encontré mensajes. Abrí el bot en Telegram, pulsá Start y mandale un',
  'mensaje, por ejemplo: hola. Después volvé a ejecutar este comando.',
].join('\n');

function shortText(text) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  return raw.length > MAX_TEXT_CHARS ? raw.slice(0, MAX_TEXT_CHARS - 1) + '…' : raw;
}

// Agrupa los updates por usuario remitente, conservando el ultimo mensaje visto.
// Devuelve [{ id, firstName, username, chatType, lastText, messages }].
function extractUsers(updates) {
  const byUser = new Map();
  for (const update of Array.isArray(updates) ? updates : []) {
    const message = (update && (update.message || update.edited_message)) || null;
    const from = message && message.from;
    if (!from || from.id == null) continue;

    const id = String(from.id);
    const entry = byUser.get(id) || {
      id,
      firstName: from.first_name || null,
      username: from.username || null,
      chatType: (message.chat && message.chat.type) || null,
      lastText: null,
      messages: 0,
    };
    entry.firstName = from.first_name || entry.firstName;
    entry.username = from.username || entry.username;
    entry.chatType = (message.chat && message.chat.type) || entry.chatType;
    const text = shortText(message.text);
    if (text) entry.lastText = text;
    entry.messages += 1;
    byUser.set(id, entry);
  }
  return [...byUser.values()];
}

function formatUsers(users) {
  const lines = [];
  users.forEach((u, i) => {
    if (i > 0) lines.push('');
    lines.push(`  Telegram User ID: ${u.id}`);
    lines.push(`  first_name:       ${u.firstName || '—'}`);
    lines.push(`  username:         ${u.username ? '@' + u.username : '—'}`);
    lines.push(`  chat:             ${u.chatType || '—'}`);
    lines.push(`  ultimo mensaje:   ${u.lastText ? '"' + u.lastText + '"' : '—'}`);
  });
  return lines.join('\n');
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN no esta definido (ni en .env ni en el entorno).');
    process.exitCode = 1;
    return;
  }

  const api = createTelegramApi({ token });

  let me;
  try {
    me = await api.getMe();
  } catch (err) {
    console.error('ERROR: no pude hablar con la Telegram Bot API: ' + err.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Bot: @${me.username} (id ${me.id})`);

  let updates;
  try {
    // Sin offset: lee lo pendiente sin confirmarlo.
    updates = await api.getUpdates({ timeout: 0, limit: 100 });
  } catch (err) {
    console.error('ERROR: no pude leer los updates: ' + err.message);
    process.exitCode = 1;
    return;
  }

  const users = extractUsers(updates);
  if (!users.length) {
    console.log('');
    console.log(NO_UPDATES_MESSAGE);
    return;
  }

  console.log('');
  console.log(users.length === 1
    ? 'Usuario que le escribió al bot:'
    : `Usuarios que le escribieron al bot (${users.length}):`);
  console.log('');
  console.log(formatUsers(users));
  console.log('');
  console.log('Copiá TU Telegram User ID a mano en el archivo .env:');
  console.log('');
  console.log('  TELEGRAM_ALLOWED_USER_ID=<id>');
  console.log('');
  console.log('(este comando no modifica .env)');
}

module.exports = { extractUsers, formatUsers, shortText, NO_UPDATES_MESSAGE, MAX_TEXT_CHARS };

if (require.main === module) {
  main();
}

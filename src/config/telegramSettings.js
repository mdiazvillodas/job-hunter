'use strict';

// Configuracion NO SECRETA de Telegram, dentro de runtime-data/config/user.json.
//
// Reparto de responsabilidades (fijado en la auditoria de arquitectura):
//   - aqui:  enabled, allowedUserId, identidad visible del bot y de la cuenta.
//   - .env:  TELEGRAM_BOT_TOKEN (ver ./telegramSecret.js).
//   - runtime-data/telegram/state.json: offset de polling (ver ./telegramState.js).
//
// Modulo puro: no lee ni escribe ficheros. El caller persiste el resultado con
// saveUserConfigFile(), igual que el resto de Configuracion.

const { validateUserConfig } = require('./userConfig');
const { SearchSettingsError } = require('./searchSettings');

// Un user id de Telegram es un entero positivo; se guarda como STRING para no
// depender de la precision de Number en ids grandes.
const USER_ID_RE = /^\d{1,20}$/;

function normalizeUserId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return USER_ID_RE.test(trimmed) ? trimmed : null;
}

function text(value, limit = 120) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
}

function readAccount(value) {
  if (!value || typeof value !== 'object') return null;
  const displayName = text(value.displayName);
  const username = text(value.username, 64);
  if (!displayName && !username) return null;
  return { displayName, username };
}

function readBot(value) {
  if (!value || typeof value !== 'object') return null;
  const username = text(value.username, 64);
  const id = normalizeUserId(value.id);
  if (!username && !id) return null;
  return { id, username };
}

// Vista publica del bloque telegram. NUNCA incluye el token ni lo deriva.
// Un bloque ausente se presenta como desactivado, nunca como un error de
// configuracion: las instalaciones anteriores siguen siendo validas.
function toEditableTelegram(config) {
  const telegram = (config && config.telegram) || {};
  const account = readAccount(telegram.account);
  const bot = readBot(telegram.bot);
  return {
    enabled: telegram.enabled === true,
    linked: !!normalizeUserId(telegram.allowedUserId),
    account,
    bot,
  };
}

// Configuracion efectiva para el listener. Sin cuenta vinculada no hay nadie
// autorizado, por mucho que enabled sea true.
function getTelegramSettings(config) {
  const telegram = (config && config.telegram) || {};
  const allowedUserId = normalizeUserId(telegram.allowedUserId);
  return {
    enabled: telegram.enabled === true,
    allowedUserId,
    account: readAccount(telegram.account),
    bot: readBot(telegram.bot),
  };
}

function mergeTelegram(currentConfig, patch) {
  const current = (currentConfig && currentConfig.telegram) || {};
  const next = { ...current, ...patch };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  return validateUserConfig({ ...currentConfig, telegram: next });
}

// Identidad visible del bot, tras un getMe correcto. No guarda el token.
function applyBotIdentity(currentConfig, me) {
  const username = text(me && me.username, 64);
  const id = normalizeUserId(me && me.id);
  if (!username && !id) throw new SearchSettingsError('Telegram no devolvió una identidad de bot utilizable.');
  return mergeTelegram(currentConfig, { bot: { id, username } });
}

// Vinculacion explicita de la cuenta autorizada. Activa el control remoto:
// con bot validado y cuenta elegida por el usuario ya no falta nada.
function applyLinkedAccount(currentConfig, candidate) {
  const allowedUserId = normalizeUserId(candidate && candidate.userId);
  if (!allowedUserId) throw new SearchSettingsError('La cuenta de Telegram no es válida.');
  const account = readAccount({
    displayName: (candidate && candidate.displayName) || (candidate && candidate.username) || 'Cuenta de Telegram',
    username: candidate && candidate.username,
  });
  return mergeTelegram(currentConfig, { enabled: true, allowedUserId, account });
}

// Activar/desactivar sin perder la vinculacion: desactivar no desvincula, para
// que volver a activarlo no obligue a repetir todo el onboarding.
function applyTelegramEnabled(currentConfig, enabled) {
  if (typeof enabled !== 'boolean') throw new SearchSettingsError('Cuerpo invalido.');
  if (enabled && !getTelegramSettings(currentConfig).allowedUserId) {
    throw new SearchSettingsError('Vinculá tu cuenta de Telegram antes de activar el control remoto.');
  }
  return mergeTelegram(currentConfig, { enabled });
}

// Olvida la cuenta vinculada (y por tanto desactiva). La identidad del bot se
// conserva: el token sigue siendo valido y solo cambia quien puede mandar.
function applyUnlinkedAccount(currentConfig) {
  return mergeTelegram(currentConfig, { enabled: false, allowedUserId: undefined, account: undefined });
}

module.exports = {
  USER_ID_RE,
  normalizeUserId,
  toEditableTelegram,
  getTelegramSettings,
  applyBotIdentity,
  applyLinkedAccount,
  applyTelegramEnabled,
  applyUnlinkedAccount,
};

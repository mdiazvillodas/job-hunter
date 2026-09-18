'use strict';

const fs = require('fs');
const { USER_CONFIG_PATH } = require('../runtime');
const { ConfigurationRequiredError } = require('./configurationError');

function invalid(field) {
  throw new ConfigurationRequiredError(`El campo ${field} falta o no es valido en config/user.json.`);
}

// Bloque OPCIONAL: un user.json anterior a esta funcionalidad no lo tiene y
// debe seguir validando. Ausente significa notificaciones desactivadas, de modo
// que actualizar el producto nunca empieza a enviar avisos por su cuenta.
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
function validateNotifications(config) {
  if (config.notifications === undefined) return;
  if (!config.notifications || typeof config.notifications !== 'object' || Array.isArray(config.notifications)) invalid('notifications');
  const ntfy = config.notifications.ntfy;
  if (ntfy === undefined) return;
  if (!ntfy || typeof ntfy !== 'object' || Array.isArray(ntfy)) invalid('notifications.ntfy');
  if (ntfy.enabled !== undefined && typeof ntfy.enabled !== 'boolean') invalid('notifications.ntfy.enabled');
  if (ntfy.topic !== undefined && typeof ntfy.topic !== 'string') invalid('notifications.ntfy.topic');
  if (ntfy.baseUrl !== undefined && typeof ntfy.baseUrl !== 'string') invalid('notifications.ntfy.baseUrl');
  if (ntfy.threshold !== undefined && (!Number.isInteger(ntfy.threshold) || ntfy.threshold < 50 || ntfy.threshold > 100)) {
    invalid('notifications.ntfy.threshold');
  }
  // Activarlo exige un topic utilizable: no se guarda una configuracion que no
  // podria enviar nada.
  if (ntfy.enabled === true && (!ntfy.topic || !NTFY_TOPIC_RE.test(ntfy.topic.trim()))) invalid('notifications.ntfy.topic');
}

// Bloque OPCIONAL: igual que notifications, un user.json anterior a esta
// funcionalidad no lo tiene y debe seguir validando. Ausente significa control
// remoto desactivado, de modo que actualizar el producto nunca deja el bot
// escuchando por su cuenta.
// El TOKEN NO VIVE AQUI: es un secreto y se guarda en el .env de la raiz.
const TELEGRAM_USER_ID_RE = /^\d{1,20}$/;
function validateTelegramIdentity(value, field) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) invalid(field);
  for (const key of ['displayName', 'username']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') invalid(`${field}.${key}`);
  }
  if (value.id !== undefined && value.id !== null && !TELEGRAM_USER_ID_RE.test(String(value.id))) invalid(`${field}.id`);
}
function validateTelegram(config) {
  if (config.telegram === undefined) return;
  const telegram = config.telegram;
  if (!telegram || typeof telegram !== 'object' || Array.isArray(telegram)) invalid('telegram');
  if (telegram.enabled !== undefined && typeof telegram.enabled !== 'boolean') invalid('telegram.enabled');
  if (telegram.allowedUserId !== undefined && telegram.allowedUserId !== null
      && !TELEGRAM_USER_ID_RE.test(String(telegram.allowedUserId))) invalid('telegram.allowedUserId');
  validateTelegramIdentity(telegram.account, 'telegram.account');
  validateTelegramIdentity(telegram.bot, 'telegram.bot');
  if (telegram.token !== undefined) invalid('telegram.token (el token no se guarda en user.json)');
  // Activarlo exige una cuenta vinculada: sin ella no habria nadie autorizado
  // y el listener escucharia sin poder obedecer a nadie.
  if (telegram.enabled === true && !TELEGRAM_USER_ID_RE.test(String(telegram.allowedUserId))) invalid('telegram.allowedUserId');
}

function validateUserConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) invalid('root');
  if (!config.identity || typeof config.identity !== 'object') invalid('identity');
  if (typeof config.identity.name !== 'string' || !config.identity.name.trim()) invalid('identity.name');
  if (typeof config.identity.linkedinUrl !== 'string' || !/^https:\/\/(www\.)?linkedin\.com\/in\//i.test(config.identity.linkedinUrl)) {
    invalid('identity.linkedinUrl');
  }
  if (!config.search || typeof config.search !== 'object') invalid('search');
  if (!Array.isArray(config.search.locations) || !config.search.locations.length || config.search.locations.some((v) => typeof v !== 'string' || !v.trim())) {
    invalid('search.locations');
  }
  if (!Array.isArray(config.search.queryGroups) || !config.search.queryGroups.length) invalid('search.queryGroups');
  if (config.search.targetAnalyzedJobs === undefined) config.search.targetAnalyzedJobs = 20;
  if (!Number.isInteger(config.search.targetAnalyzedJobs) || config.search.targetAnalyzedJobs < 1 || config.search.targetAnalyzedJobs > 50) {
    invalid('search.targetAnalyzedJobs');
  }
  for (const group of config.search.queryGroups) {
    if (!group || typeof group.family !== 'string' || typeof group.label !== 'string' || !Array.isArray(group.queries)) {
      invalid('search.queryGroups');
    }
    if (group.queries.some((query) => !query || typeof query.query !== 'string' || !query.query.trim())) {
      invalid('search.queryGroups[].queries');
    }
  }
  const hasActiveQuery = config.search.queryGroups.some((group) =>
    group.enabled && group.queries.some((query) => query.enabled)
  );
  if (!hasActiveQuery) invalid('search.queryGroups (se requiere al menos una query activa)');
  if (config.search.modalities !== undefined && !Array.isArray(config.search.modalities)) invalid('search.modalities');
  validateNotifications(config);
  validateTelegram(config);
  return config;
}

function loadUserConfig(filePath = USER_CONFIG_PATH) {
  if (!fs.existsSync(filePath)) {
    throw new ConfigurationRequiredError('Falta config/user.json.');
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new ConfigurationRequiredError(`config/user.json no es JSON valido: ${error.message}`);
  }
  return validateUserConfig(config);
}

function getUserConfig() {
  return loadUserConfig();
}

function toPublicUserConfig(config) {
  return { name: config.identity.name, linkedinUrl: config.identity.linkedinUrl };
}

// Notificaciones efectivas: ausente equivale a desactivado.
function getNotificationSettings(config) {
  const ntfy = config && config.notifications && config.notifications.ntfy;
  return ntfy && typeof ntfy === 'object' ? ntfy : { enabled: false };
}

module.exports = { getUserConfig, loadUserConfig, validateUserConfig, toPublicUserConfig, getNotificationSettings, ConfigurationRequiredError };

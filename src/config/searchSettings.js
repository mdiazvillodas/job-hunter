'use strict';

// Edicion de la configuracion de busqueda desde Configuracion.
//
// INVARIANTE CENTRAL: la estructura completa de queryGroups se conserva.
// El editor de la UI solo edita el TEXTO de las queries de cada grupo y el
// interruptor del grupo; identidad (family), rotulo, prioridad y orden nunca
// se tocan, y ningun grupo puede desaparecer, fusionarse ni sobrescribir a otro
// como efecto de guardar.
//
// Modulo puro: no lee ni escribe ficheros. El caller persiste el resultado.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { USER_CONFIG_PATH } = require('../runtime');
const { validateUserConfig } = require('./userConfig');

class SearchSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SearchSettingsError';
    this.code = 'INVALID_SEARCH_SETTINGS';
    this.statusCode = 400;
    this.expose = true;
  }
}

const ALLOWED_MODALITIES = new Set(['onsite', 'hybrid', 'remote']);

// Vista editable: un grupo por bloque, con sus queries como texto.
function toEditableSearch(config) {
  const search = config.search;
  return {
    targetAnalyzedJobs: search.targetAnalyzedJobs,
    locations: search.locations.slice(),
    modalities: (search.modalities || []).slice(),
    queryGroups: search.queryGroups.map((group) => ({
      family: group.family,
      label: group.label,
      enabled: group.enabled !== false,
      queries: group.queries.map((item) => item.query),
    })),
  };
}

function cleanLines(value, groupLabel) {
  if (!Array.isArray(value)) throw new SearchSettingsError(`Las queries de "${groupLabel}" deben ser una lista.`);
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw new SearchSettingsError(`Query invalida en "${groupLabel}".`);
    const query = raw.trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out;
}

// Aplica la edicion sobre la configuracion actual SIN perder nada fuera del
// alcance del editor. Devuelve una configuracion nueva ya validada.
function applySearchSettings(currentConfig, input) {
  if (!input || typeof input !== 'object') throw new SearchSettingsError('Cuerpo invalido.');
  const current = currentConfig.search;

  const target = Number(input.targetAnalyzedJobs);
  if (!Number.isInteger(target) || target < 1 || target > 50) {
    throw new SearchSettingsError('El objetivo de análisis debe ser un entero entre 1 y 50.');
  }

  if (!Array.isArray(input.locations)) throw new SearchSettingsError('Las ubicaciones deben ser una lista.');
  const locations = [];
  for (const raw of input.locations) {
    if (typeof raw !== 'string') throw new SearchSettingsError('Ubicacion invalida.');
    const value = raw.trim();
    if (value && !locations.includes(value)) locations.push(value);
  }
  if (!locations.length) throw new SearchSettingsError('Indicá al menos una ubicación.');

  if (!Array.isArray(input.modalities) || input.modalities.some((m) => !ALLOWED_MODALITIES.has(m))) {
    throw new SearchSettingsError('Modalidades invalidas.');
  }

  if (!Array.isArray(input.queryGroups)) throw new SearchSettingsError('Los grupos deben ser una lista.');

  // Todo grupo enviado debe existir; ningun grupo existente puede omitirse.
  const known = new Map(current.queryGroups.map((g) => [g.family, g]));
  const incoming = new Map();
  for (const group of input.queryGroups) {
    if (!group || typeof group.family !== 'string') throw new SearchSettingsError('Grupo sin identificador.');
    if (!known.has(group.family)) throw new SearchSettingsError(`El grupo "${group.family}" no existe.`);
    if (incoming.has(group.family)) throw new SearchSettingsError(`El grupo "${group.family}" viene duplicado.`);
    incoming.set(group.family, group);
  }
  const missing = current.queryGroups.filter((g) => !incoming.has(g.family)).map((g) => g.family);
  if (missing.length) {
    throw new SearchSettingsError(`Faltan grupos en el guardado: ${missing.join(', ')}. No se guarda para no perderlos.`);
  }

  // Se conserva el ORDEN original y toda la metadata del grupo.
  const queryGroups = current.queryGroups.map((group) => {
    const edit = incoming.get(group.family);
    const previous = new Map(group.queries.map((item) => [item.query.toLowerCase(), item]));
    const queries = cleanLines(edit.queries, group.label).map((query) => {
      const prior = previous.get(query.toLowerCase());
      // Una query que sigue existiendo conserva su estado; una nueva nace activa.
      return { query, enabled: prior ? prior.enabled !== false : true };
    });
    return {
      ...group,
      enabled: edit.enabled !== false,
      queries,
    };
  });

  const next = {
    ...currentConfig,
    search: { ...current, targetAnalyzedJobs: target, locations, modalities: input.modalities.slice(), queryGroups },
  };

  // La validacion existente exige al menos una query activa en algun grupo.
  return validateUserConfig(next);
}

// Escritura atomica: un guardado interrumpido no deja user.json corrupto.
function saveUserConfigFile(config, filePath = USER_CONFIG_PATH) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), '.' + path.basename(filePath) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, filePath);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return config;
}

// Vista editable de notificaciones. Un bloque ausente se presenta como
// desactivado, nunca como un error de configuracion.
function toEditableNotifications(config) {
  const ntfy = (config.notifications && config.notifications.ntfy) || {};
  return {
    enabled: ntfy.enabled === true,
    topic: typeof ntfy.topic === 'string' ? ntfy.topic : '',
    baseUrl: typeof ntfy.baseUrl === 'string' && ntfy.baseUrl ? ntfy.baseUrl : 'https://ntfy.sh',
    threshold: Number.isInteger(ntfy.threshold) ? ntfy.threshold : 90,
  };
}

// Aplica la edicion conservando el resto de la configuracion intacta.
function applyNotificationSettings(currentConfig, input) {
  if (!input || typeof input !== 'object') throw new SearchSettingsError('Cuerpo invalido.');
  const enabled = input.enabled === true;
  const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : 'https://ntfy.sh';
  const threshold = Number(input.threshold);

  if (!Number.isInteger(threshold) || threshold < 50 || threshold > 100) {
    throw new SearchSettingsError('El umbral debe ser un entero entre 50 y 100.');
  }
  if (enabled && !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
    throw new SearchSettingsError('Indicá un topic válido (letras, números, guiones).');
  }
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) {
    throw new SearchSettingsError('La URL del servidor no es válida.');
  }

  const next = {
    ...currentConfig,
    notifications: { ...(currentConfig.notifications || {}), ntfy: { enabled, topic, baseUrl, threshold } },
  };
  return validateUserConfig(next);
}

module.exports = { toEditableSearch, applySearchSettings, toEditableNotifications, applyNotificationSettings, saveUserConfigFile, SearchSettingsError, ALLOWED_MODALITIES };

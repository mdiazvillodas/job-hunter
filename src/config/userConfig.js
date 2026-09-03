'use strict';

const fs = require('fs');
const { USER_CONFIG_PATH } = require('../runtime');
const { ConfigurationRequiredError } = require('./configurationError');

function invalid(field) {
  throw new ConfigurationRequiredError(`El campo ${field} falta o no es valido en config/user.json.`);
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

module.exports = { getUserConfig, loadUserConfig, validateUserConfig, toPublicUserConfig, ConfigurationRequiredError };

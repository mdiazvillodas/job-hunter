'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { PROJECT_ROOT, USER_CONFIG_PATH, PROFILE_DIR } = require('../runtime');
const { loadUserConfig, validateUserConfig } = require('../config/userConfig');
const { parseDotEnv } = require('../runtime');
const { generateProfiles, validateProfileDraft, DEFAULT_PROFILE_MODEL } = require('../ai/profileBuilder');

const ALLOWED_MODALITIES = new Set(['onsite', 'hybrid', 'remote']);

class SetupValidationError extends Error {
  constructor(message, code = 'INVALID_SETUP_INPUT', statusCode = 400) {
    super(message);
    this.name = 'SetupValidationError';
    this.code = code;
    this.statusCode = statusCode;
    this.expose = true;
  }
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new SetupValidationError(`${field} es obligatorio.`);
  return value.trim();
}

function buildUserConfig(input) {
  const name = requireString(input && input.name, 'Nombre');
  const linkedinUrl = requireString(input && input.linkedinUrl, 'LinkedIn URL');
  const location = requireString(input && input.location, 'Ubicacion');
  if (!Array.isArray(input.queries)) throw new SetupValidationError('Roles/queries debe ser un array.');
  const queries = input.queries.map((value) => requireString(value, 'Rol/query'));
  if (!queries.length) throw new SetupValidationError('Debe indicar al menos un rol/query.');
  if (!Array.isArray(input.modalities) || input.modalities.some((value) => !ALLOWED_MODALITIES.has(value))) {
    throw new SetupValidationError('Modalidades invalidas.');
  }
  return validateUserConfig({
    identity: { name, linkedinUrl },
    search: {
      locations: [location],
      modalities: input.modalities.slice(),
      queryGroups: [{
        family: 'user',
        label: 'User targets',
        enabled: true,
        priority: 1,
        queries: queries.map((query) => ({ query, enabled: true })),
      }],
    },
  });
}

function updateEnvValue(text, name, value) {
  const line = `${name}=${JSON.stringify(value)}`;
  const matcher = new RegExp(`^[ \\t]*(?:export\\s+)?${name}\\s*=.*(?:\\r?\\n|$)`, 'gm');
  let replaced = false;
  const consolidated = text.replace(matcher, (match) => {
    if (replaced) return '';
    replaced = true;
    const newline = match.endsWith('\r\n') ? '\r\n' : match.endsWith('\n') ? '\n' : '';
    return line + newline;
  });
  if (replaced) return consolidated;
  const separator = text && !text.endsWith('\n') ? '\n' : '';
  return `${text}${separator}${line}\n`;
}

function isValidJsonObjectFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return !!value && typeof value === 'object' && !Array.isArray(value);
  } catch (_) {
    return false;
  }
}

function promoteProfilesAtomically(profileDir, artifacts, fileSystem = fs) {
  fileSystem.mkdirSync(profileDir, { recursive: true });
  const transactionId = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const names = ['careerContext', 'profile', 'matchingProfile'];
  const entries = names.map((name) => ({
    name,
    target: path.join(profileDir, `${name}.json`),
    stage: path.join(profileDir, `.${name}.${transactionId}.stage`),
    backup: path.join(profileDir, `.${name}.${transactionId}.backup`),
  }));
  const promoted = [];
  try {
    for (const entry of entries) {
      fileSystem.writeFileSync(entry.stage, JSON.stringify(artifacts[entry.name], null, 2) + '\n', 'utf8');
      const staged = JSON.parse(fileSystem.readFileSync(entry.stage, 'utf8'));
      if (!staged || typeof staged !== 'object' || Array.isArray(staged)) throw new Error('Invalid staged profile');
    }
    for (const entry of entries) {
      if (fileSystem.existsSync(entry.target)) fileSystem.renameSync(entry.target, entry.backup);
    }
    for (const entry of entries) {
      fileSystem.renameSync(entry.stage, entry.target);
      promoted.push(entry);
    }
  } catch (error) {
    for (const entry of promoted) if (fileSystem.existsSync(entry.target)) fileSystem.unlinkSync(entry.target);
    for (const entry of entries) {
      if (fileSystem.existsSync(entry.backup)) {
        if (fileSystem.existsSync(entry.target)) fileSystem.unlinkSync(entry.target);
        fileSystem.renameSync(entry.backup, entry.target);
      }
      if (fileSystem.existsSync(entry.stage)) fileSystem.unlinkSync(entry.stage);
    }
    throw error;
  }
  for (const entry of entries) {
    if (fileSystem.existsSync(entry.backup)) {
      try { fileSystem.unlinkSync(entry.backup); } catch (_) { /* Perfil confirmado; backup residual recuperable. */ }
    }
  }
}

function createSetupService(options = {}) {
  const userConfigPath = options.userConfigPath || USER_CONFIG_PATH;
  const envPath = options.envPath || path.join(PROJECT_ROOT, '.env');
  const profileDir = options.profileDir || PROFILE_DIR;
  const processEnv = options.processEnv || process.env;
  const draftPath = options.draftPath || path.join(profileDir, 'draft.json');
  const profileTransport = options.profileTransport;
  const profileFileSystem = options.profileFileSystem || fs;

  function readEnvValues() {
    return fs.existsSync(envPath) ? parseDotEnv(fs.readFileSync(envPath, 'utf8')) : {};
  }

  function getOpenAiRuntimeConfig() {
    const envValues = readEnvValues();
    return {
      apiKey: (typeof processEnv.OPENAI_API_KEY === 'string' && processEnv.OPENAI_API_KEY.trim()) || envValues.OPENAI_API_KEY || '',
      model: processEnv.OPENAI_PROFILE_MODEL || envValues.OPENAI_PROFILE_MODEL || processEnv.OPENAI_MODEL || envValues.OPENAI_MODEL || DEFAULT_PROFILE_MODEL,
    };
  }

  function readOpenAiKeyConfigured() {
    if (typeof processEnv.OPENAI_API_KEY === 'string' && processEnv.OPENAI_API_KEY.trim()) return true;
    if (!fs.existsSync(envPath)) return false;
    const parsed = readEnvValues();
    return typeof parsed.OPENAI_API_KEY === 'string' && !!parsed.OPENAI_API_KEY.trim();
  }

  function readUserConfigOrNull() {
    if (!fs.existsSync(userConfigPath)) return null;
    try {
      return loadUserConfig(userConfigPath);
    } catch (_) {
      throw new SetupValidationError(
        'La configuracion de usuario existe pero es invalida.',
        'INVALID_USER_CONFIGURATION',
        409
      );
    }
  }

  function getStatus() {
    const config = readUserConfigOrNull();
    const userConfig = !!config;
    const openAiKey = readOpenAiKeyConfigured();
    const profile = isValidJsonObjectFile(path.join(profileDir, 'profile.json'));
    const matchingProfile = isValidJsonObjectFile(path.join(profileDir, 'matchingProfile.json'));
    const careerContext = isValidJsonObjectFile(path.join(profileDir, 'careerContext.json'));
    const profileDraft = fs.existsSync(draftPath);
    let profileDraftValid = false;
    if (config && profileDraft) {
      try {
        const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
        validateProfileDraft(draft, config.identity.name);
        profileDraftValid = true;
      } catch (_) { profileDraftValid = false; }
    }
    return {
      userConfig,
      openAiKey,
      profile,
      matchingProfile,
      careerContext,
      profileDraft,
      profileDraftValid,
      readyForProfileSetup: userConfig && openAiKey,
      readyForHunt: userConfig && openAiKey && profile && matchingProfile && careerContext,
    };
  }

  function getEditableSetup() {
    const config = readUserConfigOrNull();
    if (!config) return { name: '', linkedinUrl: '', location: '', queries: [], modalities: [], openAiKeyConfigured: readOpenAiKeyConfigured() };
    return {
      name: config.identity.name,
      linkedinUrl: config.identity.linkedinUrl,
      location: config.search.locations[0],
      queries: config.search.queryGroups.flatMap((group) => group.queries.map((item) => item.query)),
      modalities: config.search.modalities || [],
      openAiKeyConfigured: readOpenAiKeyConfigured(),
    };
  }

  function saveUserConfig(input) {
    const config = buildUserConfig(input);
    atomicWrite(userConfigPath, JSON.stringify(config, null, 2) + '\n');
    return getEditableSetup();
  }

  function saveOpenAiKey(value) {
    if (value === undefined || value === null || value === '') return { openAiKeyConfigured: readOpenAiKeyConfigured() };
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new SetupValidationError('OpenAI API key invalida.');
    const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    atomicWrite(envPath, updateEnvValue(current, 'OPENAI_API_KEY', value.trim()));
    return { openAiKeyConfigured: true };
  }

  function getProfileDraft() {
    if (!fs.existsSync(draftPath)) return null;
    let draft;
    try { draft = JSON.parse(fs.readFileSync(draftPath, 'utf8')); } catch (_) {
      throw new SetupValidationError('El borrador de perfil existe pero es inválido.', 'INVALID_PROFILE_DRAFT', 409);
    }
    const config = readUserConfigOrNull();
    validateProfileDraft(draft, config && config.identity.name);
    return draft;
  }

  async function generateProfileDraft(input) {
    const config = readUserConfigOrNull();
    if (!config) throw new SetupValidationError('Falta una configuración de usuario válida.', 'USER_CONFIG_REQUIRED', 409);
    const openAi = getOpenAiRuntimeConfig();
    if (!openAi.apiKey) throw new SetupValidationError('Falta configurar OPENAI_API_KEY.', 'OPENAI_API_KEY_REQUIRED', 409);
    const draft = await generateProfiles(input || {}, {
      apiKey: openAi.apiKey,
      model: openAi.model,
      candidateName: config.identity.name,
      transport: profileTransport,
    });
    atomicWrite(draftPath, JSON.stringify(draft, null, 2) + '\n');
    return draft;
  }

  function confirmProfileDraft() {
    const draft = getProfileDraft();
    if (!draft) throw new SetupValidationError('No existe un borrador de perfil para confirmar.', 'PROFILE_DRAFT_REQUIRED', 409);
    promoteProfilesAtomically(profileDir, draft, profileFileSystem);
    fs.unlinkSync(draftPath);
    return { confirmed: true };
  }

  function deleteProfileDraft() {
    if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
    return { deleted: true };
  }

  return { getStatus, getEditableSetup, saveUserConfig, saveOpenAiKey, getProfileDraft, generateProfileDraft, confirmProfileDraft, deleteProfileDraft, paths: { userConfigPath, envPath, profileDir, draftPath } };
}

module.exports = { createSetupService, buildUserConfig, updateEnvValue, atomicWrite, isValidJsonObjectFile, promoteProfilesAtomically, SetupValidationError };

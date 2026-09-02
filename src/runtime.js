'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function parseDotEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function loadDotEnv(filePath = path.join(PROJECT_ROOT, '.env')) {
  if (!fs.existsSync(filePath)) return;
  const values = parseDotEnv(fs.readFileSync(filePath, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function resolveDataDir(value = process.env.JOB_HUNTER_DATA_DIR) {
  if (!value) return path.join(PROJECT_ROOT, 'runtime-data');
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(PROJECT_ROOT, value);
}

const dataDir = resolveDataDir();
const configDir = path.join(dataDir, 'config');
const profileDir = path.join(dataDir, 'profile');

module.exports = {
  PROJECT_ROOT,
  DATA_DIR: dataDir,
  BROWSER_PROFILE_DIR: path.join(dataDir, 'browser-profile'),
  JOBS_DIR: path.join(dataDir, 'jobs'),
  RUNS_DIR: path.join(dataDir, 'runs'),
  FEEDBACK_DIR: path.join(dataDir, 'feedback'),
  CONFIG_DIR: configDir,
  USER_CONFIG_PATH: path.join(configDir, 'user.json'),
  PROFILE_DIR: profileDir,
  parseDotEnv,
  loadDotEnv,
  resolveDataDir,
};

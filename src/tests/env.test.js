'use strict';

// Tests de la carga de .env (src/env.js).
// Regla central: el entorno del proceso SIEMPRE gana sobre el archivo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadProjectEnv, DEFAULT_ENV_FILE } = require('../env');

function withEnvFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-hunter-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('define variables del .env que no estan en el entorno', () => {
  const file = withEnvFile('TELEGRAM_BOT_TOKEN=abc123\nTELEGRAM_ALLOWED_USER_ID=42\n');
  const env = {};
  const result = loadProjectEnv({ file, env });

  assert.strictEqual(result.exists, true);
  assert.strictEqual(env.TELEGRAM_BOT_TOKEN, 'abc123');
  assert.strictEqual(env.TELEGRAM_ALLOWED_USER_ID, '42');
  assert.deepStrictEqual(result.applied.sort(), ['TELEGRAM_ALLOWED_USER_ID', 'TELEGRAM_BOT_TOKEN']);
  assert.deepStrictEqual(result.kept, []);
});

test('el entorno del proceso tiene precedencia sobre el .env', () => {
  const file = withEnvFile('OPENAI_API_KEY=del-archivo\nNTFY_TOPIC=del-archivo\n');
  const env = { OPENAI_API_KEY: 'del-entorno' };
  const result = loadProjectEnv({ file, env });

  assert.strictEqual(env.OPENAI_API_KEY, 'del-entorno');
  assert.strictEqual(env.NTFY_TOPIC, 'del-archivo');
  assert.deepStrictEqual(result.kept, ['OPENAI_API_KEY']);
  assert.deepStrictEqual(result.applied, ['NTFY_TOPIC']);
});

test('una variable definida vacia en el entorno tambien gana', () => {
  const file = withEnvFile('NTFY_TOPIC=del-archivo\n');
  const env = { NTFY_TOPIC: '' };
  loadProjectEnv({ file, env });

  assert.strictEqual(env.NTFY_TOPIC, '');
});

test('preserva variables del entorno que no estan en el .env', () => {
  const file = withEnvFile('SOLO_ARCHIVO=1\n');
  const env = { PATH: '/usr/bin', HUNT_TRIGGER_TOKEN: 'tok' };
  loadProjectEnv({ file, env });

  assert.strictEqual(env.PATH, '/usr/bin');
  assert.strictEqual(env.HUNT_TRIGGER_TOKEN, 'tok');
  assert.strictEqual(env.SOLO_ARCHIVO, '1');
});

test('sin archivo .env no lanza y no toca el entorno', () => {
  const file = path.join(os.tmpdir(), 'job-hunter-env-inexistente', '.env');
  const env = { HEADLESS: 'false' };
  const result = loadProjectEnv({ file, env });

  assert.strictEqual(result.exists, false);
  assert.strictEqual(result.error, null);
  assert.deepStrictEqual(result.applied, []);
  assert.deepStrictEqual(env, { HEADLESS: 'false' });
});

test('soporta CRLF, comentarios y lineas vacias', () => {
  const file = withEnvFile('# comentario\r\n\r\nNTFY_ENABLED=true\r\n# otro\r\nNTFY_TOPIC=mi-topic\r\n');
  const env = {};
  loadProjectEnv({ file, env });

  assert.strictEqual(env.NTFY_ENABLED, 'true');
  assert.strictEqual(env.NTFY_TOPIC, 'mi-topic');
});

test('es idempotente: la segunda carga no cambia nada', () => {
  const file = withEnvFile('NTFY_TOPIC=mi-topic\n');
  const env = {};
  loadProjectEnv({ file, env });
  const second = loadProjectEnv({ file, env });

  assert.strictEqual(env.NTFY_TOPIC, 'mi-topic');
  assert.deepStrictEqual(second.applied, []);
  assert.deepStrictEqual(second.kept, ['NTFY_TOPIC']);
});

test('el resumen expone nombres, nunca valores', () => {
  const file = withEnvFile('TELEGRAM_BOT_TOKEN=secreto-que-no-debe-aparecer\n');
  const env = {};
  const result = loadProjectEnv({ file, env });

  assert.ok(!JSON.stringify(result).includes('secreto-que-no-debe-aparecer'));
  assert.deepStrictEqual(result.applied, ['TELEGRAM_BOT_TOKEN']);
});

test('por defecto apunta al .env de la raiz del proyecto', () => {
  assert.strictEqual(path.basename(DEFAULT_ENV_FILE), '.env');
  assert.strictEqual(
    path.resolve(DEFAULT_ENV_FILE),
    path.resolve(__dirname, '..', '..', '.env')
  );
});

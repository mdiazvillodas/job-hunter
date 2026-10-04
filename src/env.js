'use strict';

// Carga del archivo .env SIN dependencias externas.
//
// Hasta ahora el proyecto solo leia process.env (variables de usuario de Windows
// via setx, o el entorno que le pasa el trigger al hunt). Este modulo agrega el
// .env local como fuente ADICIONAL, sin cambiar esa semantica:
//
// Invariantes:
//   - El entorno del proceso GANA. Una variable ya definida (setx, shell, n8n,
//     el `env: process.env` que el trigger le pasa al hunt) NUNCA se pisa.
//   - Si no hay .env, no pasa nada: todo sigue funcionando como antes.
//   - Nunca se loguean VALORES, solo nombres de variables.
//   - Idempotente: llamarlo dos veces no cambia el resultado.
//   - Best effort: un .env ilegible o un Node sin parser nativo avisan y siguen;
//     no tiran abajo un hunt.
//
// Parseo: util.parseEnv (nativo desde Node 20.12, mismo parser que --env-file).
// La PRECEDENCIA la aplica este modulo explicitamente, no Node, para que sea
// una regla del proyecto y no un detalle de implementacion de la runtime.

const fs = require('fs');
const path = require('path');
const util = require('util');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV_FILE = path.join(PROJECT_ROOT, '.env');

let warned = false;

function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(`[env] ${message}`);
}

// Devuelve un resumen SIN valores:
//   { file, exists, applied: [nombres], kept: [nombres], error }
//   applied = tomadas del .env;  kept = ya estaban en el entorno y ganaron.
function loadProjectEnv(options = {}) {
  const file = options.file || DEFAULT_ENV_FILE;
  const env = options.env || process.env;
  const result = { file, exists: false, applied: [], kept: [], error: null };

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Sin .env no hay nada que hacer: es el caso normal en un entorno donde las
    // variables vienen del sistema. Cualquier otro error se avisa y se sigue.
    if (err.code !== 'ENOENT') {
      result.error = err.code || 'READ_ERROR';
      warnOnce(`no se pudo leer ${file} (${result.error}); se usa solo el entorno del proceso`);
    }
    return result;
  }
  result.exists = true;

  if (typeof util.parseEnv !== 'function') {
    result.error = 'NO_PARSER';
    warnOnce('esta version de Node no expone util.parseEnv (se requiere >= 20.12); se ignora el .env');
    return result;
  }

  let parsed;
  try {
    parsed = util.parseEnv(raw);
  } catch (err) {
    result.error = 'PARSE_ERROR';
    warnOnce(`no se pudo parsear ${file}; se usa solo el entorno del proceso`);
    return result;
  }

  for (const key of Object.keys(parsed)) {
    // "Definida" incluye cadena vacia: si alguien exporto la variable vacia a
    // proposito, esa decision del entorno manda sobre el archivo.
    if (env[key] !== undefined) {
      result.kept.push(key);
      continue;
    }
    env[key] = parsed[key];
    result.applied.push(key);
  }

  return result;
}

module.exports = {
  DEFAULT_ENV_FILE,
  loadProjectEnv,
};

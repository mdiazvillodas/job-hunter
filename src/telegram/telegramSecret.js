'use strict';

// Custodia del TELEGRAM_BOT_TOKEN. Reutiliza el mecanismo de secretos que ya
// existe para OPENAI_API_KEY: una sola clave del .env de la raiz, reescrita de
// forma atomica y NO destructiva (updateEnvValue conserva el resto del fichero).
//
// Invariantes:
//   - El token se lee SIEMPRE del disco en el momento de usarlo. No se usa el
//     snapshot de process.env de arranque, porque Configuracion debe poder
//     cambiar el token sin reiniciar Job Hunter.
//   - readToken() es la UNICA forma de obtener el valor. Nada de lo que este
//     modulo expone hacia la UI contiene el token.
//   - El .env de la raiz sobrevive a una actualizacion del producto (el package
//     nunca lo incluye), asi que el token configurado por la usuaria persiste.

const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT, parseDotEnv } = require('../runtime');
const { updateEnvValue, atomicWrite } = require('../setup/setupService');

const ENV_KEY = 'TELEGRAM_BOT_TOKEN';
// Forma de un token de BotFather: <id numerico>:<secreto>. Se valida antes de
// tocar la red o el disco, para no guardar basura ni construir URLs raras.
const TOKEN_RE = /^\d{5,20}:[A-Za-z0-9_-]{30,}$/;

function isWellFormedToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value.trim());
}

function createTelegramSecretStore(options = {}) {
  const envPath = options.envPath || path.join(PROJECT_ROOT, '.env');
  const processEnv = options.processEnv || process.env;
  const fileSystem = options.fs || fs;

  function readEnvValues() {
    if (!fileSystem.existsSync(envPath)) return {};
    try { return parseDotEnv(fileSystem.readFileSync(envPath, 'utf8')); }
    catch (_) { return {}; } // un .env ilegible no puede tirar abajo el servicio
  }

  // El entorno del proceso gana sobre el fichero, igual que en loadDotEnv().
  function readToken() {
    const fromProcess = typeof processEnv[ENV_KEY] === 'string' ? processEnv[ENV_KEY].trim() : '';
    if (fromProcess) return fromProcess;
    const fromFile = readEnvValues()[ENV_KEY];
    return typeof fromFile === 'string' && fromFile.trim() ? fromFile.trim() : null;
  }

  function isConfigured() {
    return !!readToken();
  }

  // Escribe el token conservando cualquier otra clave del .env intacta.
  // El caller solo debe llamar aqui DESPUES de validar el token contra getMe:
  // un token rechazado nunca se persiste.
  function saveToken(value) {
    if (!isWellFormedToken(value)) {
      const error = new Error('El token del bot no tiene un formato válido.');
      error.code = 'INVALID_TELEGRAM_TOKEN';
      error.statusCode = 400;
      error.expose = true;
      throw error;
    }
    const token = value.trim();
    const current = fileSystem.existsSync(envPath) ? fileSystem.readFileSync(envPath, 'utf8') : '';
    atomicWrite(envPath, updateEnvValue(current, ENV_KEY, token));
    // El proceso vivo debe ver el token nuevo sin reiniciar.
    processEnv[ENV_KEY] = token;
    return { tokenConfigured: true };
  }

  return { readToken, isConfigured, saveToken, envPath, ENV_KEY };
}

module.exports = { ENV_KEY, TOKEN_RE, isWellFormedToken, createTelegramSecretStore };

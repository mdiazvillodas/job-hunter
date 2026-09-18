'use strict';

// Estado de polling de Telegram: el proximo update_id a pedir.
//
// Por que importa: Telegram retiene los updates no confirmados ~24h. Si se
// pierde el offset, un /hunt que la usuaria mando con la PC apagada se
// reprocesaria al arrancar y lanzaria un hunt que nadie pidio ahora. Por eso
// el offset se persiste en runtime-data (sobrevive a una actualizacion) y el
// arranque en frio descarta explicitamente el backlog (ver listener).
//
// Invariantes:
//   - Escritura atomica (temp + rename): un corte no deja el fichero corrupto.
//   - Un fallo de lectura o escritura NUNCA se propaga: el listener sigue
//     funcionando en memoria y como mucho reprocesa un update, que es
//     idempotente en el destino (un /hunt duplicado choca con el lock).
//   - No guarda nada mas: ni token, ni ids de usuario, ni textos de mensajes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { TELEGRAM_STATE_PATH } = require('../runtime');

function createTelegramStateStore(options = {}) {
  const filePath = options.filePath || TELEGRAM_STATE_PATH;
  const fileSystem = options.fs || fs;
  const log = typeof options.log === 'function' ? options.log : () => {};

  // null = nunca se guardo un offset (arranque en frio).
  function getNextUpdateId() {
    try {
      if (!fileSystem.existsSync(filePath)) return null;
      const value = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
      const next = value && value.nextUpdateId;
      return Number.isInteger(next) && next >= 0 ? next : null;
    } catch (_) {
      log('no se pudo leer el estado de Telegram; se reanuda desde el backlog actual');
      return null;
    }
  }

  function setNextUpdateId(value) {
    if (!Number.isInteger(value) || value < 0) return false;
    const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
      fileSystem.writeFileSync(temp, JSON.stringify({ nextUpdateId: value }, null, 2) + '\n', 'utf8');
      fileSystem.renameSync(temp, filePath);
      return true;
    } catch (_) {
      log('no se pudo guardar el offset de Telegram; se continua en memoria');
      try { if (fileSystem.existsSync(temp)) fileSystem.unlinkSync(temp); } catch (_) { /* residuo inofensivo */ }
      return false;
    }
  }

  function clear() {
    try { if (fileSystem.existsSync(filePath)) fileSystem.unlinkSync(filePath); return true; }
    catch (_) { return false; }
  }

  return { getNextUpdateId, setNextUpdateId, clear, filePath };
}

module.exports = { createTelegramStateStore };

'use strict';

// Estado de polling de Telegram: el proximo update_id a pedir.
//
// Por que importa: Telegram retiene los updates no confirmados ~24h. Hasta
// ahora el listener arrancaba con offset=null y sin memoria en disco, asi que
// tras un reinicio podia volver a procesar un update ya atendido y disparar un
// segundo hunt. Persistir el offset cierra esa ventana.
//
// Invariantes:
//   - Escritura atomica (temp + rename): un corte no deja el fichero corrupto.
//   - Un fallo de lectura o escritura NUNCA se propaga: el listener sigue
//     funcionando en memoria y como mucho reprocesa un update, que ademas es
//     idempotente en destino (un /hunt duplicado choca con el lock del hunt).
//   - No guarda nada mas: ni token, ni ids de usuario, ni textos de mensajes.
//
// Ubicacion: ./state/telegram.json en la raiz del proyecto, junto al resto del
// estado local (runs/, browser-profile/). Esta en .gitignore.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_STATE_PATH = path.join(PROJECT_ROOT, 'state', 'telegram.json');

function createTelegramStateStore(options = {}) {
  const filePath = options.filePath || DEFAULT_STATE_PATH;
  const fileSystem = options.fs || fs;
  const log = typeof options.log === 'function' ? options.log : () => {};

  // null = nunca se guardo un offset (arranque en frio).
  function getNextUpdateId() {
    try {
      if (!fileSystem.existsSync(filePath)) return null;
      const value = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
      const next = value && value.nextUpdateId;
      return Number.isInteger(next) && next >= 0 ? next : null;
    } catch (e) {
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
    } catch (e) {
      log('no se pudo guardar el offset de Telegram; se continua en memoria');
      try { if (fileSystem.existsSync(temp)) fileSystem.unlinkSync(temp); } catch (e2) { /* residuo inofensivo */ }
      return false;
    }
  }

  function clear() {
    try { if (fileSystem.existsSync(filePath)) fileSystem.unlinkSync(filePath); return true; }
    catch (e) { return false; }
  }

  return { getNextUpdateId, setNextUpdateId, clear, filePath };
}

module.exports = { DEFAULT_STATE_PATH, createTelegramStateStore };

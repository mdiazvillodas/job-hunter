'use strict';

// Capa de persistencia. Interfaz de repositorio pensada para poder reemplazar
// LocalRepository -> PostgresRepository sin cambiar la logica de negocio (jobService).
//
// Interfaz (contrato):
//   save(job) -> job         (upsert por jobId)
//   get(jobId) -> job|null
//   has(jobId) -> boolean
//   getAll() -> job[]
//   delete(jobId) -> boolean
//
// LocalRepository: un archivo JSON por job en <dir>/<jobId>.json (facil de inspeccionar a mano).

const fs = require('fs');
const path = require('path');

function safeJobFileName(jobId) {
  // jobIds de LinkedIn son numericos, pero saneamos por robustez.
  return String(jobId).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
}

function createLocalRepository(options = {}) {
  const dir = options.dir || path.join(__dirname, 'jobs');

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function fileFor(jobId) {
    return path.join(dir, safeJobFileName(jobId));
  }

  function save(job) {
    if (!job || !job.jobId) throw new Error('repository.save: job.jobId requerido.');
    ensureDir();
    fs.writeFileSync(fileFor(job.jobId), JSON.stringify(job, null, 2), 'utf8');
    return job;
  }

  function get(jobId) {
    const file = fileFor(jobId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`repository.get: JSON invalido para job ${jobId}: ${e.message}`);
    }
  }

  function has(jobId) {
    return fs.existsSync(fileFor(jobId));
  }

  function getAll() {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  }

  function del(jobId) {
    const file = fileFor(jobId);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  return {
    kind: 'local',
    dir,
    save,
    get,
    has,
    getAll,
    delete: del,
  };
}

module.exports = {
  createLocalRepository,
};

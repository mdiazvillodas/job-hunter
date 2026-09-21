'use strict';

// MD7 — persistencia auditable de una corrida de Market Discovery.
//
// TODO vive bajo DATA_DIR/market-discovery/runs/<runId>/. Nunca toca jobs, runs
// ni configuracion de Hunter.
//
// No reutiliza el repositorio de MD1 a proposito: aquel publica UN snapshot
// inmutable de perfil+semillas con validacion estricta de ese schema, mientras
// aqui hacen falta varios artefactos por corrida escritos en distintos momentos.
// Lo que si se reutiliza es su politica de seguridad: id sin rutas, rechazo de
// enlaces simbolicos y escritura atomica.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assert } = require('./domain');

const SCHEMA_VERSION = 1;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Lista cerrada: el nombre de archivo NUNCA viene de fuera.
const ARTIFACTS = Object.freeze({
  manifest: 'manifest.json',
  profileMap: 'profile-map.json',
  seedPlan: 'seed-plan.json',
  exploration: 'exploration.json',
  proposal: 'proposal.json',
  result: 'result.json',
});

function createMarketDiscoveryRunStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || require('../runtime').DATA_DIR);
  const root = path.join(dataDir, 'market-discovery', 'runs');

  // Ningun tramo de la ruta configurada puede ser un enlace: se rechaza antes de crear.
  function assertSafePath(target, create) {
    for (let dir = dataDir; ; dir = path.dirname(dir)) {
      if (fs.existsSync(dir)) assert(!fs.lstatSync(dir).isSymbolicLink(), 'linked data path');
      if (path.dirname(dir) === dir) break;
    }
    const segments = [dataDir, path.join(dataDir, 'market-discovery'), root, target].filter(Boolean);
    for (const dir of segments) {
      if (!fs.existsSync(dir)) {
        if (!create) return false;
        fs.mkdirSync(dir, { recursive: true });
      }
      const stat = fs.lstatSync(dir);
      assert(!stat.isSymbolicLink() && stat.isDirectory(), 'linked market discovery directory');
    }
    return true;
  }

  function runDir(runId) {
    assert(typeof runId === 'string' && RUN_ID_PATTERN.test(runId), 'invalid run id');
    const dir = path.join(root, runId);
    // Defensa en profundidad: el id ya no admite separadores ni "..".
    assert(path.resolve(dir) === path.join(root, runId) && path.dirname(path.resolve(dir)) === root, 'run id escapes the run directory');
    return dir;
  }

  function fileFor(runId, artifact) {
    assert(Object.prototype.hasOwnProperty.call(ARTIFACTS, artifact), `unknown artifact: ${artifact}`);
    return path.join(runDir(runId), ARTIFACTS[artifact]);
  }

  // Escritura atomica: temporal + rename, igual que el resto del proyecto.
  function writeArtifact(runId, artifact, payload) {
    const file = fileFor(runId, artifact);
    assertSafePath(runDir(runId), true);
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...payload }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return file;
  }

  // Identidad de corrida create-only: dos corridas no pueden compartir carpeta.
  function createRun(runId, manifest) {
    const dir = runDir(runId);
    assertSafePath(root, true);
    fs.mkdirSync(dir, { recursive: false });
    writeArtifact(runId, 'manifest', manifest);
    return dir;
  }

  function readArtifact(runId, artifact) {
    const file = fileFor(runId, artifact);
    if (!assertSafePath(runDir(runId), false) || !fs.existsSync(file)) return null;
    assert(!fs.lstatSync(file).isSymbolicLink(), 'linked artifact');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }

  function readRun(runId) {
    const manifest = readArtifact(runId, 'manifest');
    if (!manifest) return null;
    const result = readArtifact(runId, 'result');
    const proposal = readArtifact(runId, 'proposal');
    return {
      runId, manifest, result,
      proposalAvailable: proposal !== null,
      artifacts: Object.keys(ARTIFACTS).filter((name) => fs.existsSync(fileFor(runId, name))),
    };
  }

  function exists(runId) { return fs.existsSync(fileFor(runId, 'manifest')); }

  // Resumen de las corridas persistidas, de la mas reciente a la mas antigua.
  // SOLO LECTURA y con campos acotados: sirve para que la pantalla pueda volver
  // a mostrar la ultima exploracion despues de reiniciar la aplicacion, cuando
  // el estado en memoria ya no la recuerda. Un id que no cumpla el patron, o una
  // carpeta sin manifiesto legible, simplemente se ignora.
  function listRuns(limit = 20) {
    if (!fs.existsSync(root)) return [];
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
      const manifest = readArtifact(entry.name, 'manifest');
      if (!manifest) continue;
      runs.push({
        runId: entry.name,
        status: typeof manifest.status === 'string' ? manifest.status : null,
        reason: typeof manifest.reason === 'string' ? manifest.reason : null,
        startedAt: typeof manifest.startedAt === 'string' ? manifest.startedAt : null,
        finishedAt: typeof manifest.finishedAt === 'string' ? manifest.finishedAt : null,
        proposalAvailable: readArtifact(entry.name, 'proposal') !== null,
      });
    }
    // Orden determinista: por inicio descendente y, a igualdad, por id.
    runs.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || ''))
      || String(b.runId).localeCompare(String(a.runId)));
    return runs.slice(0, Math.max(0, limit));
  }

  return { createRun, writeArtifact, readArtifact, readRun, listRuns, exists, paths: { root }, ARTIFACTS, SCHEMA_VERSION };
}

module.exports = { createMarketDiscoveryRunStore, ARTIFACTS, RUN_ID_PATTERN, SCHEMA_VERSION };

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SCHEMA_VERSION, hash, freeze, assert, keys, validateProfile, validateSeeds } = require('./domain');

// Only immutable MD1/MD2 snapshots. No jobs, vocabulary or proposal application yet.
function createRepository(options = {}) {
  const dataDir = path.resolve(options.dataDir || require('../runtime').DATA_DIR);
  const root = path.join(dataDir, 'market-discovery');
  function safeDirectories(create) {
    // Reject links anywhere along the configured path before creating directories.
    for (let dir = dataDir; ; dir = path.dirname(dir)) {
      if (fs.existsSync(dir)) assert(!fs.lstatSync(dir).isSymbolicLink(), 'linked data path');
      if (path.dirname(dir) === dir) break;
    }
    for (const dir of [dataDir, root]) {
      if (!fs.existsSync(dir)) { if (!create) return false; fs.mkdirSync(dir, { recursive: true }); }
      assert(!fs.lstatSync(dir).isSymbolicLink() && fs.lstatSync(dir).isDirectory(), 'linked persistence directory');
    }
    return true;
  }
  function fileFor(id) {
    assert(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id), 'snapshot id');
    return path.join(root, id + '.json');
  }
  function validate(snapshot) {
    keys(snapshot, ['schemaVersion', 'id', 'profileHash', 'profile', 'seeds'], 'snapshot');
    assert(snapshot && snapshot.schemaVersion === SCHEMA_VERSION, 'snapshot version');
    fileFor(snapshot.id); validateProfile(snapshot.profile); validateSeeds(snapshot.seeds);
    assert(snapshot.profileHash === hash(snapshot.profile), 'snapshot profile hash');
    const sources = new Set([...snapshot.profile.targetResponsibilities, ...snapshot.profile.demonstratedCapabilities].flatMap(f => f.sources));
    assert(snapshot.seeds.every(seed => seed.sources.every(source => sources.has(source))), 'seed references outside profile');
    return snapshot;
  }
  function save(id, profile, seeds) {
    const file = fileFor(id);
    const snapshot = validate(JSON.parse(JSON.stringify({ schemaVersion: SCHEMA_VERSION, id, profileHash: hash(profile), profile, seeds })));
    safeDirectories(true);
    const temp = path.join(root, '.snapshot-' + crypto.randomBytes(12).toString('hex') + '.tmp');
    try {
      fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      // Atomic create-only publication: an existing run snapshot cannot be replaced.
      fs.linkSync(temp, file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return freeze(snapshot);
  }
  function get(id) {
    const file = fileFor(id);
    if (!safeDirectories(false) || !fs.existsSync(file)) return null;
    assert(!fs.lstatSync(file).isSymbolicLink(), 'linked snapshot');
    const snapshot = validate(JSON.parse(fs.readFileSync(file, 'utf8')));
    assert(snapshot.id === id, 'snapshot identity');
    return freeze(snapshot);
  }
  return { save, get };
}
module.exports = { createRepository };

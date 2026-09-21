'use strict';

// MD8 — aplicar una propuesta de Market Discovery a las queries de Hunter.
//
// Semantica aprobada: REEMPLAZO explicito, nunca fusion, nunca automatico.
//
// TODO ocurre sobre ficheros de fixture en un directorio temporal: este test
// NUNCA toca la configuracion real del usuario.
//
// Determinista: sin LinkedIn, sin Chromium, sin OpenAI, sin red.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createProposalApplyService, ProposalApplyError, MARKET_DISCOVERY_FAMILY } = require('../marketDiscovery/proposalApply');

let passed = 0;
const roots = [];
function test(name, fn) { fn(); passed += 1; console.log('[PASS] ' + name); }
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md8-')); roots.push(dir); return dir; }

// Configuracion COMPLETA: incluye bloques que la propuesta no debe tocar.
const baseConfig = () => ({
  identity: { name: 'Example Person', linkedinUrl: 'https://www.linkedin.com/in/example' },
  search: {
    targetAnalyzedJobs: 20,
    locations: ['Example region'],
    modalities: ['hybrid'],
    queryGroups: [{
      family: 'user', label: 'User targets', enabled: true, priority: 1,
      queries: [{ query: 'Old query one', enabled: true }, { query: 'Old query two', enabled: true }],
    }],
  },
  notifications: { ntfy: { enabled: true, topic: 'example-topic', threshold: 80 } },
  telegram: { enabled: false, allowedUserId: null },
});

const proposalWith = (expressions, extra = {}) => ({
  proposalId: 'p_' + expressions.length,
  applied: false,
  selectedQueries: expressions.map((expression) => ({ expression, provenance: ['OBSERVED_TERM'] })),
  warnings: [],
  ...extra,
});

// Store en memoria con el mismo contrato que runStore para los dos artefactos usados.
function fakeStore(proposal) {
  let artifact = proposal ? { runId: 'r1', proposal } : null;
  return {
    readArtifact: (runId, name) => (name === 'proposal' ? artifact : null),
    writeArtifact: (runId, name, payload) => { if (name === 'proposal') artifact = payload; },
    current: () => artifact,
  };
}

// Servicio sobre un user.json REAL pero en un directorio temporal.
function serviceWith(proposal, config = baseConfig()) {
  const dir = temp();
  const userConfigPath = path.join(dir, 'user.json');
  fs.writeFileSync(userConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  const store = fakeStore(proposal);
  const service = createProposalApplyService({ runStore: store, userConfigPath });
  return { service, store, userConfigPath, read: () => JSON.parse(fs.readFileSync(userConfigPath, 'utf8')) };
}

(async () => {
  console.log('\n### Vista previa: que va a cambiar');

  test('1. la vista previa describe el REEMPLAZO sin escribir nada', () => {
    const { service, read } = serviceWith(proposalWith(['New query A', 'Old query one']));
    const before = JSON.stringify(read());
    const preview = service.preview('r1');
    assert.equal(preview.change.mode, 'REPLACE');
    assert.equal(preview.applied, false);
    assert.equal(preview.applicable, true);
    assert.deepEqual(preview.change.current.map((q) => q.query), ['Old query one', 'Old query two']);
    assert.deepEqual(preview.change.proposed.map((q) => q.query), ['New query A', 'Old query one']);
    assert.deepEqual(preview.change.added.map((q) => q.query), ['New query A']);
    assert.deepEqual(preview.change.removed.map((q) => q.query), ['Old query two'], 'lo que se pierde se nombra');
    assert.deepEqual(preview.change.kept.map((q) => q.query), ['Old query one']);
    assert.equal(JSON.stringify(read()), before, 'la vista previa no escribe');
  });

  console.log('\n### Aplicar: reemplazo explicito');

  test('2. aplicar REEMPLAZA las queries y marca la propuesta como aplicada', () => {
    const { service, store, read } = serviceWith(proposalWith(['New query A', 'New query B']));
    const result = service.apply('r1');
    assert.equal(result.applied, true);
    assert.equal(result.changed, true);
    const config = read();
    assert.equal(config.search.queryGroups.length, 1, 'un solo grupo: reemplazo, no fusion');
    assert.equal(config.search.queryGroups[0].family, MARKET_DISCOVERY_FAMILY);
    assert.deepEqual(config.search.queryGroups[0].queries.map((q) => q.query), ['New query A', 'New query B']);
    assert.ok(!JSON.stringify(config).includes('Old query'), 'las queries anteriores ya no estan');
    assert.equal(store.current().proposal.applied, true, 'applied:true tras escribir la configuracion');
    assert.ok(store.current().proposal.appliedAt, 'queda constancia de cuando');
  });

  test('3. TODO ajuste ajeno a las queries se conserva intacto', () => {
    const config = baseConfig();
    const { service, read } = serviceWith(proposalWith(['New query A']), config);
    service.apply('r1');
    const after = read();
    assert.deepEqual(after.identity, config.identity, 'identidad intacta');
    assert.deepEqual(after.notifications, config.notifications, 'notificaciones intactas');
    assert.deepEqual(after.telegram, config.telegram, 'telegram intacto');
    assert.deepEqual(after.search.locations, config.search.locations, 'ubicaciones intactas');
    assert.deepEqual(after.search.modalities, config.search.modalities, 'modalidades intactas');
    assert.equal(after.search.targetAnalyzedJobs, config.search.targetAnalyzedJobs);
  });

  test('4. un bloque futuro desconocido tambien sobrevive', () => {
    const config = { ...baseConfig(), futureFeature: { keepMe: true, nested: [1, 2, 3] } };
    const { service, read } = serviceWith(proposalWith(['New query A']), config);
    service.apply('r1');
    assert.deepEqual(read().futureFeature, { keepMe: true, nested: [1, 2, 3] });
  });

  console.log('\n### Fallo seguro');

  test('5. una propuesta VACIA no puede borrar el portafolio del usuario', () => {
    const { service, read } = serviceWith(proposalWith([]));
    const before = JSON.stringify(read());
    let error;
    try { service.apply('r1'); } catch (e) { error = e; }
    assert.ok(error instanceof ProposalApplyError);
    assert.equal(error.code, 'PROPOSAL_EMPTY');
    assert.equal(JSON.stringify(read()), before, 'la configuracion no se toco');
  });

  test('6. sin propuesta se responde NOT_FOUND y no se escribe', () => {
    const { service, read } = serviceWith(null);
    const before = JSON.stringify(read());
    let error;
    try { service.apply('r1'); } catch (e) { error = e; }
    assert.equal(error.code, 'PROPOSAL_NOT_FOUND');
    assert.equal(error.statusCode, 404);
    assert.equal(JSON.stringify(read()), before);
  });

  test('7. si la escritura falla, la configuracion previa queda intacta', () => {
    const dir = temp();
    const userConfigPath = path.join(dir, 'user.json');
    const original = baseConfig();
    fs.writeFileSync(userConfigPath, JSON.stringify(original, null, 2) + '\n', 'utf8');
    const store = fakeStore(proposalWith(['New query A']));
    const service = createProposalApplyService({
      runStore: store,
      userConfigPath,
      writeUserConfig: () => { throw new Error('disk full'); },
    });
    let error;
    try { service.apply('r1'); } catch (e) { error = e; }
    assert.ok(error, 'el fallo se propaga');
    assert.deepEqual(JSON.parse(fs.readFileSync(userConfigPath, 'utf8')), original, 'configuracion previa intacta');
    assert.equal(store.current().proposal.applied, false, 'la propuesta NO se marca aplicada si no se escribio');
  });

  test('8. una propuesta que produciria configuracion invalida se rechaza ANTES de escribir', () => {
    const { service, store, read } = serviceWith(proposalWith(['   ']));
    const before = JSON.stringify(read());
    let error;
    try { service.apply('r1'); } catch (e) { error = e; }
    assert.ok(error, 'no se aplica');
    assert.equal(JSON.stringify(read()), before);
    assert.equal(store.current().proposal.applied, false);
  });

  console.log('\n### Idempotencia');

  test('9. aplicar dos veces la misma propuesta no vuelve a escribir', () => {
    const { service, read } = serviceWith(proposalWith(['New query A', 'New query B']));
    const first = service.apply('r1');
    assert.equal(first.changed, true);
    const afterFirst = JSON.stringify(read());
    const second = service.apply('r1');
    assert.equal(second.applied, true);
    assert.equal(second.changed, false);
    assert.equal(second.reason, 'already_applied');
    assert.equal(JSON.stringify(read()), afterFirst, 'la configuracion no cambia en la segunda vez');
  });

  test('10. reaplicar tras una edicion manual vuelve a imponer la propuesta', () => {
    const { service, userConfigPath, read } = serviceWith(proposalWith(['New query A']));
    service.apply('r1');
    // El usuario edita a mano despues de aplicar.
    const edited = read();
    edited.search.queryGroups[0].queries.push({ query: 'Manual addition', enabled: true });
    fs.writeFileSync(userConfigPath, JSON.stringify(edited, null, 2) + '\n', 'utf8');
    const again = service.apply('r1');
    assert.equal(again.changed, true, 'ya no coincide: se vuelve a aplicar');
    assert.deepEqual(read().search.queryGroups[0].queries.map((q) => q.query), ['New query A']);
  });

  console.log('\n### Sin efectos colaterales');

  test('11. aplicar no arranca hunt, no relanza exploracion y no notifica', () => {
    const source = fs.readFileSync(path.join(__dirname, '../marketDiscovery/proposalApply.js'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['runPipeline', 'huntRunManager', 'startHunt', 'notify', 'ntfy', 'telegram', 'fetch(', 'explore(']) {
      assert.ok(!code.includes(forbidden), 'apply must not reach: ' + forbidden);
    }
  });

  test('12. el grupo escrito es exactamente uno y es propiedad de Market Discovery', () => {
    const { service, read } = serviceWith(proposalWith(['A', 'B', 'C']));
    service.apply('r1');
    const groups = read().search.queryGroups;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].family, MARKET_DISCOVERY_FAMILY);
    assert.equal(groups[0].enabled, true);
    assert.equal(groups[0].queries.length, 3);
    assert.ok(groups[0].queries.every((q) => q.enabled === true));
  });

  test('13. expresiones duplicadas se colapsan de forma determinista', () => {
    const { service, read } = serviceWith(proposalWith(['Alpha', 'alpha', 'Beta']));
    service.apply('r1');
    assert.deepEqual(read().search.queryGroups[0].queries.map((q) => q.query), ['Alpha', 'Beta']);
  });

  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nMD8 Apply: ${passed} tests passed`);
})().catch((error) => {
  for (const dir of roots) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* noop */ } }
  console.error('\n[FAIL]', error && error.stack ? error.stack : error);
  process.exit(1);
});

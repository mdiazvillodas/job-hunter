'use strict';

// Fase 2A: setup local. Sólo usa servidor loopback y archivos temporales ficticios.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { createLocalRepository } = require('../data/jobRepository');
const { createJobService } = require('../services/jobService');
const { loadUserConfig } = require('../config/userConfig');
const { createSetupService } = require('../setup/setupService');
const { startServer } = require('../ui/server');

let passed = 0;
let failed = 0;
function ok(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' - ' + detail : ''}`); }
}

function request(server, method, pathname, body) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, method, path: pathname, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function requestRaw(server, method, pathname, body, contentType) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: address.port, method, path: pathname,
      headers: contentType ? { 'Content-Type': contentType } : {},
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function validInput(overrides = {}) {
  return {
    name: 'Taylor Example',
    linkedinUrl: 'https://www.linkedin.com/in/taylor-example/',
    location: 'Example City',
    queries: ['Operations Manager', 'Strategy & Operations'],
    modalities: ['hybrid', 'remote'],
    ...overrides,
  };
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-phase2a-'));
  const configDir = path.join(root, 'config');
  const userConfigPath = path.join(configDir, 'user.json');
  const envPath = path.join(root, '.env');
  const profileDir = path.join(root, 'profile');
  const setupService = createSetupService({ userConfigPath, envPath, profileDir, processEnv: {} });
  const repository = createLocalRepository({ dir: path.join(root, 'jobs') });
  const server = startServer({ port: 0, setupService, jobService: createJobService(repository), repository });
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    ok('servidor UI escucha sólo en 127.0.0.1', server.address().address === '127.0.0.1');

    const setupPage = await request(server, 'GET', '/setup');
    ok('/setup se sirve sin user.json', setupPage.status === 200 && /setupForm/.test(setupPage.text));

    const initial = await request(server, 'GET', '/api/setup/status');
    ok('status inicial tiene todos los flags en false', initial.status === 200 && Object.values(initial.json).every((value) => value === false));
    ok('readyForHunt false sin perfiles', initial.json.readyForHunt === false);
    ok('.env inexistente se detecta como key no configurada', !fs.existsSync(envPath) && initial.json.openAiKey === false);

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(userConfigPath, '{broken', 'utf8');
    const corruptConfig = await request(server, 'GET', '/api/setup/status');
    ok('user.json corrupto devuelve error controlado', corruptConfig.status === 409 && corruptConfig.json.code === 'INVALID_USER_CONFIGURATION');
    ok('error de user.json corrupto no expone contenido ni path local', !corruptConfig.text.includes('{broken') && !corruptConfig.text.includes(root));

    fs.writeFileSync(userConfigPath, '{}', 'utf8');
    const invalidSchema = await request(server, 'GET', '/api/setup');
    ok('user.json con schema inválido no se trata como ausente', invalidSchema.status === 409 && invalidSchema.json.code === 'INVALID_USER_CONFIGURATION');

    const saved = await request(server, 'PUT', '/api/setup/user-config', validInput({ path: 'C:\\outside\\user.json' }));
    ok('guardar user config válido crea user.json', saved.status === 200 && fs.existsSync(userConfigPath));
    const stored = loadUserConfig(userConfigPath);
    ok('user.json escrito pasa el validator existente', stored.identity.name === 'Taylor Example');
    ok('roles simples se convierten a queryGroups', stored.search.queryGroups.length === 1 && stored.search.queryGroups[0].queries.length === 2);
    ok('groups y queries tienen enabled:true explícito', stored.search.queryGroups[0].enabled === true && stored.search.queryGroups[0].queries.every((query) => query.enabled === true));
    ok('location se guarda como array de una principal', JSON.stringify(stored.search.locations) === JSON.stringify(['Example City']));
    ok('modalities se guardan sin crear filtros nuevos', JSON.stringify(stored.search.modalities) === JSON.stringify(['hybrid', 'remote']) && !('modality' in stored.search.queryGroups[0]));
    ok('request no puede elegir path de escritura', !fs.existsSync('C:\\outside\\user.json') && setupService.paths.userConfigPath === userConfigPath);

    await request(server, 'PUT', '/api/setup/user-config', validInput({ name: 'Updated Example', queries: ['Program Manager'] }));
    ok('update de user config existente funciona', loadUserConfig(userConfigPath).identity.name === 'Updated Example');

    const fakeKey1 = 'fake-test-key-one';
    const keySaved = await request(server, 'PUT', '/api/setup/openai-key', { openAiKey: fakeKey1 });
    const envAfterFirst = fs.readFileSync(envPath, 'utf8');
    ok('guardar API key crea .env inexistente', keySaved.status === 200 && /^OPENAI_API_KEY="fake-test-key-one"\n$/.test(envAfterFirst));

    await request(server, 'PUT', '/api/setup/openai-key', { openAiKey: 'fake-test-key-two' });
    const envAfterSingleReplace = fs.readFileSync(envPath, 'utf8');
    ok('actualizar una única API key mantiene una sola definición', (envAfterSingleReplace.match(/^(?:export\s+)?OPENAI_API_KEY=/gm) || []).length === 1);

    fs.writeFileSync(envPath, '# keep this comment\nOPENAI_API_KEY=old-one\nOTHER_VALUE=preserved\nexport OPENAI_API_KEY=old-two\n\nOPENAI_API_KEY=old-three\n', 'utf8');
    await request(server, 'PUT', '/api/setup/openai-key', { openAiKey: 'fake-test-key-three' });
    const envAfterReplace = fs.readFileSync(envPath, 'utf8');
    ok('múltiples API keys se consolidan en una sola', (envAfterReplace.match(/^(?:export\s+)?OPENAI_API_KEY=/gm) || []).length === 1 && envAfterReplace.includes('OPENAI_API_KEY="fake-test-key-three"'));
    ok('variante export OPENAI_API_KEY se elimina al consolidar', !/^export\s+OPENAI_API_KEY=/m.test(envAfterReplace));
    ok('actualizar API key preserva variables y comentarios', /# keep this comment/.test(envAfterReplace) && /OTHER_VALUE=preserved/.test(envAfterReplace));
    await request(server, 'PUT', '/api/setup/openai-key', { openAiKey: '' });
    ok('campo vacío conserva API key existente', fs.readFileSync(envPath, 'utf8') === envAfterReplace);

    const wrongContentType = await requestRaw(server, 'PUT', '/api/setup/openai-key', JSON.stringify({ openAiKey: 'not-saved' }), 'text/plain');
    ok('PUT setup rechaza Content-Type incorrecto con 415', wrongContentType.status === 415 && wrongContentType.json.error && !fs.readFileSync(envPath, 'utf8').includes('not-saved'));
    const invalidJson = await requestRaw(server, 'PUT', '/api/setup/user-config', '{invalid', 'application/json; charset=utf-8');
    ok('JSON HTTP inválido devuelve 400', invalidJson.status === 400);
    const oversized = await requestRaw(server, 'PUT', '/api/setup/user-config', 'x'.repeat(1000001), 'application/json');
    ok('request body excesivo devuelve error 4xx', oversized.status >= 400 && oversized.status < 500);

    const editable = await request(server, 'GET', '/api/setup');
    const status = await request(server, 'GET', '/api/setup/status');
    ok('setup existente devuelve configuración no secreta', editable.json.name === 'Updated Example' && editable.json.queries[0] === 'Program Manager' && editable.json.openAiKeyConfigured === true);
    ok('ningún endpoint devuelve la API key', ![saved, keySaved, editable, status].some((response) => response.text.includes('fake-test-key')));
    ok('readyForProfileSetup true con config y key', status.json.readyForProfileSetup === true);
    ok('readyForHunt sigue false si faltan perfiles', status.json.readyForHunt === false);

    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.json'), '', 'utf8');
    let profileStatus = await request(server, 'GET', '/api/setup/status');
    ok('perfil vacío produce flag false', profileStatus.json.profile === false);
    fs.writeFileSync(path.join(profileDir, 'profile.json'), '{broken', 'utf8');
    profileStatus = await request(server, 'GET', '/api/setup/status');
    ok('perfil con JSON corrupto produce flag false', profileStatus.json.profile === false);
    fs.writeFileSync(path.join(profileDir, 'profile.json'), '[]', 'utf8');
    profileStatus = await request(server, 'GET', '/api/setup/status');
    ok('perfil JSON array produce flag false', profileStatus.json.profile === false);
    fs.writeFileSync(path.join(profileDir, 'profile.json'), '{}', 'utf8');
    profileStatus = await request(server, 'GET', '/api/setup/status');
    ok('perfil JSON object produce flag true', profileStatus.json.profile === true && profileStatus.json.readyForHunt === false);
    for (const file of ['matchingProfile.json', 'careerContext.json']) fs.writeFileSync(path.join(profileDir, file), '{}', 'utf8');
    const ready = await request(server, 'GET', '/api/setup/status');
    ok('readyForHunt true con config, key y tres perfiles', ready.json.readyForHunt === true);

    const secret = 'fake-secret-that-must-not-leak';
    const failingSetupService = { saveOpenAiKey() { throw new Error(secret); } };
    const failingServer = startServer({ port: 0, setupService: failingSetupService, jobService: createJobService(repository), repository });
    await new Promise((resolve) => failingServer.once('listening', resolve));
    const originalConsoleError = console.error;
    const logged = [];
    console.error = (...args) => { logged.push(args.join(' ')); };
    let internalFailure;
    try {
      internalFailure = await request(failingServer, 'PUT', '/api/setup/openai-key', { openAiKey: secret });
    } finally {
      console.error = originalConsoleError;
      await new Promise((resolve) => failingServer.close(resolve));
    }
    ok('error interno devuelve 500 genérico sin API key', internalFailure.status === 500 && internalFailure.json.error === 'Error interno' && !internalFailure.text.includes(secret));
    ok('console.error de error interno no contiene API key', !logged.join('\n').includes(secret));

    const mainUi = await request(server, 'GET', '/');
    ok('baseline UI sigue sirviéndose', mainUi.status === 200 && /Job Hunter/.test(mainUi.text) && /setupNotice/.test(mainUi.text));

    const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-phase2a-import-'));
    const imported = spawnSync(process.execPath, ['-e', "require('./src/config'); require('./src/hunt'); require('./src/collect-linkedin-jobs'); require('./src/analyze-linkedin-jobs'); process.stdout.write('ok');"], { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', env: { ...process.env, JOB_HUNTER_DATA_DIR: importRoot } });
    ok('imports seguros sin configuración continúan funcionando', imported.status === 0 && imported.stdout === 'ok', imported.stderr);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run().catch((error) => { console.error(error); process.exitCode = 1; });

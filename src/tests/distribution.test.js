'use strict';

// Tests de distribuibilidad. No abren navegador, no ejecutan hunts y no llaman a OpenAI.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runtime = require('../runtime');

let passed = 0;
let failed = 0;
function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${name}${detail ? ' - ' + detail : ''}`);
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run() {
  const expectedDefault = path.join(runtime.PROJECT_ROOT, 'runtime-data');
  ok('data dir default bajo PROJECT_ROOT', runtime.resolveDataDir(undefined) === expectedDefault);

  const absolute = path.join(tempDir('jh-absolute-'), 'private-data');
  ok('data dir absoluto se conserva', runtime.resolveDataDir(absolute) === path.normalize(absolute));

  ok(
    'data dir relativo se resuelve contra PROJECT_ROOT',
    runtime.resolveDataDir(path.join('.', 'custom-data')) === path.join(runtime.PROJECT_ROOT, 'custom-data')
  );

  const envDir = tempDir('jh-env-');
  const envFile = path.join(envDir, '.env');
  fs.writeFileSync(
    envFile,
    '# comment\n\nDISTRIBUTION_PLAIN=value\nDISTRIBUTION_DOUBLE="quoted value"\nDISTRIBUTION_SINGLE=\'single value\'\nDISTRIBUTION_KEEP=file-value\n',
    'utf8'
  );
  process.env.DISTRIBUTION_KEEP = 'existing-value';
  let logCalls = 0;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => { logCalls += 1; };
  console.error = () => { logCalls += 1; };
  try {
    runtime.loadDotEnv(envFile);
    runtime.loadDotEnv(path.join(envDir, 'does-not-exist'));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  ok('env carga VARIABLE=value e ignora comentarios/vacios', process.env.DISTRIBUTION_PLAIN === 'value');
  ok('env soporta comillas dobles', process.env.DISTRIBUTION_DOUBLE === 'quoted value');
  ok('env soporta comillas simples', process.env.DISTRIBUTION_SINGLE === 'single value');
  ok('env no pisa process.env existente', process.env.DISTRIBUTION_KEEP === 'existing-value');
  ok('env inexistente se ignora', true);
  ok('env loader no escribe secretos en logs', logCalls === 0);
  delete process.env.DISTRIBUTION_PLAIN;
  delete process.env.DISTRIBUTION_DOUBLE;
  delete process.env.DISTRIBUTION_SINGLE;
  delete process.env.DISTRIBUTION_KEEP;

  const emptyDataDir = tempDir('jh-empty-data-');
  const profileModule = path.join(runtime.PROJECT_ROOT, 'src', 'ai', 'marianoProfile.js');
  const child = spawnSync(
    process.execPath,
    ['-e', `
      const profiles = require(${JSON.stringify(profileModule)});
      let result = { imported: true };
      try { profiles.getMarianoProfile(); }
      catch (error) { result = { ...result, name: error.name, code: error.code, message: error.message }; }
      process.stdout.write(JSON.stringify(result));
    `],
    { encoding: 'utf8', env: { ...process.env, JOB_HUNTER_DATA_DIR: emptyDataDir } }
  );
  let profileResult = {};
  try { profileResult = JSON.parse(child.stdout); } catch (_) { /* reported by assertions below */ }
  ok('modulo de perfiles se importa sin archivos personales', child.status === 0 && profileResult.imported === true);
  ok('perfil faltante devuelve CONFIGURATION_REQUIRED', profileResult.name === 'ConfigurationRequiredError' && profileResult.code === 'CONFIGURATION_REQUIRED');
  ok('perfil faltante no devuelve MODULE_NOT_FOUND', /todavia no esta configurado/i.test(profileResult.message || '') && !/MODULE_NOT_FOUND/.test(profileResult.message || ''));

  const examples = [
    '.env.example',
    path.join('src', 'config', 'user.example.json'),
    path.join('src', 'ai', 'profile.example.json'),
    path.join('src', 'ai', 'matchingProfile.example.json'),
    path.join('src', 'ai', 'careerContext.example.json'),
  ];
  ok('examples requeridos existen', examples.every((file) => fs.existsSync(path.join(runtime.PROJECT_ROOT, file))));

  const jsonExamples = examples.filter((file) => file.endsWith('.json'));
  let validJson = true;
  try {
    jsonExamples.forEach((file) => JSON.parse(fs.readFileSync(path.join(runtime.PROJECT_ROOT, file), 'utf8')));
  } catch (_) {
    validJson = false;
  }
  ok('examples JSON son validos', validJson);

  const exampleText = examples.map((file) => fs.readFileSync(path.join(runtime.PROJECT_ROOT, file), 'utf8')).join('\n');
  const forbidden = /Mariano D[ií]az Villodas|mdiazvillodas|sk-[A-Za-z0-9_-]{20,}/i;
  ok('examples no contienen identidad personal ni API keys plausibles', !forbidden.test(exampleText));

  const gitignore = fs.readFileSync(path.join(runtime.PROJECT_ROOT, '.gitignore'), 'utf8');
  ok('runtime-data esta cubierto por gitignore', /^runtime-data\/$/m.test(gitignore));
  ok('config real apunta a DATA_DIR/config/user.json', runtime.USER_CONFIG_PATH === path.join(runtime.DATA_DIR, 'config', 'user.json'));
  ok('perfiles reales apuntan a DATA_DIR/profile', runtime.PROFILE_DIR === path.join(runtime.DATA_DIR, 'profile'));

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAIL'} (${passed} passed, ${failed} failed) ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

run();

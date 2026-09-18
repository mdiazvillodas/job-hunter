'use strict';

// Phase 9 — almacenes de Telegram: configuracion (user.json), secreto (.env)
// y estado de polling (runtime-data/telegram/state.json).
// Sin red y sin tocar la instalacion real: todo va a directorios temporales.
// Ejecutar: node src/tests/phase9.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require('../config/telegramSettings');
const { validateUserConfig } = require('../config/userConfig');
const { createTelegramSecretStore, isWellFormedToken } = require('../telegram/telegramSecret');
const { createTelegramStateStore } = require('../telegram/telegramState');
const { parseDotEnv } = require('../runtime');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }
function throws(fn) { try { fn(); return false; } catch (_) { return true; } }

const VALID_TOKEN = '123456789:AAHrandomlookingsecretvalue_abcdefghij';

function baseConfig(extra) {
  return Object.assign({
    identity: { name: 'Mariana', linkedinUrl: 'https://www.linkedin.com/in/mariana/' },
    search: {
      targetAnalyzedJobs: 20,
      locations: ['Ciudad A'],
      modalities: ['remote'],
      queryGroups: [{ family: 'user', label: 'User targets', enabled: true, priority: 1, queries: [{ query: 'operations manager', enabled: true }] }],
    },
  }, extra || {});
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ------------------------------------------------------------------ */
section('Compatibilidad de user.json');

ok('1. un user.json sin bloque telegram sigue validando',
  !!validateUserConfig(baseConfig()));

ok('2. sin bloque, el control remoto queda desactivado',
  T.getTelegramSettings(baseConfig()).enabled === false
  && T.getTelegramSettings(baseConfig()).allowedUserId === null);

ok('3. sin bloque, la vista de Configuracion no rompe',
  T.toEditableTelegram(baseConfig()).enabled === false
  && T.toEditableTelegram(baseConfig()).linked === false);

ok('4. un bloque valido se acepta',
  !!validateUserConfig(baseConfig({ telegram: { enabled: true, allowedUserId: '4242', account: { displayName: 'Mariana', username: 'mariana' }, bot: { id: '99', username: 'mi_bot' } } })));

ok('5. activarlo sin cuenta vinculada se rechaza',
  throws(() => validateUserConfig(baseConfig({ telegram: { enabled: true } }))));

ok('6. un allowedUserId no numerico se rechaza',
  throws(() => validateUserConfig(baseConfig({ telegram: { enabled: false, allowedUserId: 'mariana' } }))));

ok('7. user.json NUNCA admite un token de Telegram',
  throws(() => validateUserConfig(baseConfig({ telegram: { enabled: false, token: VALID_TOKEN } }))));

ok('8. desactivado con cuenta vinculada es un estado valido',
  !!validateUserConfig(baseConfig({ telegram: { enabled: false, allowedUserId: '4242' } })));

/* ------------------------------------------------------------------ */
section('Transiciones de configuracion');

{
  const next = T.applyBotIdentity(baseConfig(), { id: 99, username: 'mi_bot', first_name: 'Mi Bot' });
  ok('9. validar el bot guarda su identidad visible',
    next.telegram.bot.username === 'mi_bot' && next.telegram.bot.id === '99');
  ok('10. validar el bot NO activa el control remoto por su cuenta',
    next.telegram.enabled !== true && T.toEditableTelegram(next).linked === false);
  ok('11. guardar la identidad del bot no guarda ningun token',
    !JSON.stringify(next).includes(VALID_TOKEN) && next.telegram.token === undefined);
}

{
  const withBot = T.applyBotIdentity(baseConfig(), { id: 99, username: 'mi_bot' });
  const linked = T.applyLinkedAccount(withBot, { userId: '4242', displayName: 'Mariana', username: 'mariana' });
  ok('12. vincular la cuenta activa el control remoto',
    linked.telegram.enabled === true && linked.telegram.allowedUserId === '4242');
  ok('13. se conserva la identidad del bot al vincular', linked.telegram.bot.username === 'mi_bot');
  ok('14. la vista muestra cuenta y bot sin exponer el id como dato de usuario',
    T.toEditableTelegram(linked).account.displayName === 'Mariana'
    && T.toEditableTelegram(linked).linked === true
    && T.toEditableTelegram(linked).account.allowedUserId === undefined);

  ok('15. un userId arbitrario no numerico no se puede vincular',
    throws(() => T.applyLinkedAccount(withBot, { userId: 'o-jose' })));

  const disabled = T.applyTelegramEnabled(linked, false);
  ok('16. desactivar no desvincula la cuenta',
    disabled.telegram.enabled === false && disabled.telegram.allowedUserId === '4242');
  ok('17. volver a activar no exige repetir el onboarding',
    T.applyTelegramEnabled(disabled, true).telegram.enabled === true);

  const unlinked = T.applyUnlinkedAccount(linked);
  ok('18. desvincular desactiva y olvida la cuenta',
    unlinked.telegram.enabled === false && unlinked.telegram.allowedUserId === undefined && !unlinked.telegram.account);
  ok('19. desvincular conserva el bot validado', unlinked.telegram.bot.username === 'mi_bot');
}

ok('20. activar sin cuenta vinculada se rechaza con un mensaje util',
  throws(() => T.applyTelegramEnabled(baseConfig(), true)));

ok('21. el id se normaliza a string para no perder precision',
  T.normalizeUserId(4242) === '4242' && T.normalizeUserId(' 4242 ') === '4242'
  && T.normalizeUserId('') === null && T.normalizeUserId('12a') === null);

/* ------------------------------------------------------------------ */
section('Secreto: TELEGRAM_BOT_TOKEN en el .env de la raiz');

ok('22. se valida la forma del token antes de tocar nada',
  isWellFormedToken(VALID_TOKEN) && !isWellFormedToken('no-es-un-token') && !isWellFormedToken('123:corto'));

{
  const dir = tempDir('jh-telegram-env-');
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, [
    '# comentario que debe sobrevivir',
    'OPENAI_API_KEY="sk-existente-1234567890"',
    'UI_PORT=4173',
    '',
  ].join('\n'), 'utf8');
  const processEnv = {};
  const store = createTelegramSecretStore({ envPath, processEnv });

  ok('23. sin token guardado, no hay token configurado', store.isConfigured() === false && store.readToken() === null);

  store.saveToken(VALID_TOKEN);
  const written = fs.readFileSync(envPath, 'utf8');
  const parsed = parseDotEnv(written);
  ok('24. el token se guarda en el .env de la raiz', parsed.TELEGRAM_BOT_TOKEN === VALID_TOKEN);
  ok('25. la escritura NO es destructiva: los demas secretos siguen intactos',
    parsed.OPENAI_API_KEY === 'sk-existente-1234567890' && parsed.UI_PORT === '4173');
  ok('26. los comentarios del .env se conservan', written.includes('# comentario que debe sobrevivir'));
  ok('27. el token queda disponible sin reiniciar el proceso', processEnv.TELEGRAM_BOT_TOKEN === VALID_TOKEN);

  // Lectura BAJO DEMANDA: otro proceso (Configuracion) reescribe el fichero y
  // un store sin snapshot debe ver el valor nuevo.
  const fresh = createTelegramSecretStore({ envPath, processEnv: {} });
  ok('28. el token se lee del disco, no de un snapshot de arranque', fresh.readToken() === VALID_TOKEN);

  const second = '987654321:BBotherrandomsecretvalue_klmnopqrstu';
  fresh.saveToken(second);
  ok('29. reemplazar el token sobreescribe una sola clave',
    parseDotEnv(fs.readFileSync(envPath, 'utf8')).TELEGRAM_BOT_TOKEN === second
    && parseDotEnv(fs.readFileSync(envPath, 'utf8')).OPENAI_API_KEY === 'sk-existente-1234567890');
  ok('30. no quedan claves TELEGRAM_BOT_TOKEN duplicadas',
    (fs.readFileSync(envPath, 'utf8').match(/^TELEGRAM_BOT_TOKEN=/gm) || []).length === 1);

  ok('31. un token mal formado no se persiste',
    throws(() => fresh.saveToken('cualquier-cosa'))
    && parseDotEnv(fs.readFileSync(envPath, 'utf8')).TELEGRAM_BOT_TOKEN === second);

  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tempDir('jh-telegram-env2-');
  const envPath = path.join(dir, '.env');
  const store = createTelegramSecretStore({ envPath, processEnv: {} });
  store.saveToken(VALID_TOKEN);
  ok('32. sin .env previo se crea uno con solo esta clave',
    parseDotEnv(fs.readFileSync(envPath, 'utf8')).TELEGRAM_BOT_TOKEN === VALID_TOKEN);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tempDir('jh-telegram-env3-');
  const envPath = path.join(dir, '.env');
  const store = createTelegramSecretStore({ envPath, processEnv: { TELEGRAM_BOT_TOKEN: VALID_TOKEN } });
  ok('33. un token del entorno del proceso tiene precedencia', store.readToken() === VALID_TOKEN && store.isConfigured());
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tempDir('jh-telegram-env4-');
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'esto no es\x00un env valido', 'utf8');
  const store = createTelegramSecretStore({ envPath, processEnv: {} });
  ok('34. un .env ilegible no rompe la lectura del token', store.readToken() === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
section('Estado de polling');

{
  const dir = tempDir('jh-telegram-state-');
  const filePath = path.join(dir, 'telegram', 'state.json');
  const store = createTelegramStateStore({ filePath });

  ok('35. arranque en frio: no hay offset persistido', store.getNextUpdateId() === null);

  store.setNextUpdateId(120);
  ok('36. el offset se persiste', store.getNextUpdateId() === 120);
  ok('37. se crea el directorio de estado bajo runtime-data', fs.existsSync(filePath));

  store.setNextUpdateId(121);
  ok('38. el offset avanza', store.getNextUpdateId() === 121);

  ok('39. el estado guardado NO contiene token, ids ni textos',
    (() => {
      const raw = fs.readFileSync(filePath, 'utf8');
      return Object.keys(JSON.parse(raw)).join(',') === 'nextUpdateId' && !raw.includes(VALID_TOKEN);
    })());

  ok('40. un offset invalido no se guarda',
    store.setNextUpdateId(-1) === false && store.setNextUpdateId('x') === false && store.getNextUpdateId() === 121);

  fs.writeFileSync(filePath, '{ roto', 'utf8');
  ok('41. un estado corrupto se trata como arranque en frio, no como error', store.getNextUpdateId() === null);

  ok('42. limpiar el estado no rompe', store.clear() === true && store.getNextUpdateId() === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // Disco de solo lectura simulado: escribir falla pero el servicio sigue vivo.
  const failing = createTelegramStateStore({
    filePath: path.join(tempDir('jh-telegram-state2-'), 'state.json'),
    fs: {
      existsSync: () => false,
      mkdirSync: () => { throw new Error('EACCES'); },
      writeFileSync: () => { throw new Error('EACCES'); },
      renameSync: () => {},
      readFileSync: () => '',
      unlinkSync: () => {},
    },
  });
  ok('43. un fallo de escritura del offset no se propaga', failing.setNextUpdateId(5) === false);
  ok('44. y la lectura sigue respondiendo', failing.getNextUpdateId() === null);
}

console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : 'FAILURES'} (${passed} passed, ${failed} failed) ===`);
if (failed) process.exitCode = 1;

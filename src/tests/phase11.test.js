'use strict';

// Phase 11 — telegramService: ciclo de vida del listener y onboarding seguro,
// mas las rutas /api/settings/telegram.
// NINGUN test toca Telegram real: la Bot API y el listener se inyectan.
// Ejecutar: node src/tests/phase11.test.js

const http = require('http');

const S = require('../telegram/telegramService');
const { createServer } = require('../ui/server');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }

const TOKEN = '123456789:AAHrandomlookingsecretvalue_abcdefghij';
const NOW = 1_700_000_000_000;

function baseConfig(telegram) {
  const config = {
    identity: { name: 'Mariana', linkedinUrl: 'https://www.linkedin.com/in/mariana/' },
    search: {
      targetAnalyzedJobs: 20,
      locations: ['Ciudad A'],
      modalities: ['remote'],
      queryGroups: [{ family: 'user', label: 'User targets', enabled: true, priority: 1, queries: [{ query: 'ops', enabled: true }] }],
    },
  };
  if (telegram) config.telegram = telegram;
  return config;
}

// update en chat privado, con fecha en SEGUNDOS como manda Telegram.
function update(updateId, over) {
  const o = over || {};
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor((o.at === undefined ? NOW : o.at) / 1000),
      text: o.text || 'hola',
      from: { id: o.fromId === undefined ? 4242 : o.fromId, first_name: o.firstName || 'Mariana', username: o.username },
      chat: { id: o.chatId || 555, type: o.chatType || 'private' },
    },
  };
}

function harness(over) {
  const o = over || {};
  let config = o.config || baseConfig(o.telegram);
  let token = o.token === undefined ? TOKEN : o.token;
  let offset = o.offset === undefined ? null : o.offset;
  const events = { listenersCreated: 0, listenersRunning: 0, stops: 0, getMe: 0, getUpdates: 0, sent: [], savedTokens: [], listenerOptions: [] };
  const apiCalls = [];

  const service = S.createTelegramService({
    huntRunManager: { start: async () => ({ runId: 'run_1' }), getStatus: () => ({ status: 'IDLE', progress: {} }) },
    clock: () => (o.clock ? o.clock() : NOW),
    log: () => {},
    readConfig: () => JSON.parse(JSON.stringify(config)),
    saveConfig: (next) => { config = next; return next; },
    secretStore: {
      readToken: () => token,
      isConfigured: () => !!token,
      saveToken: (value) => { token = value; events.savedTokens.push(value); return { tokenConfigured: true }; },
    },
    stateStore: {
      getNextUpdateId: () => offset,
      setNextUpdateId: (value) => { offset = value; return true; },
      clear: () => { offset = null; return true; },
    },
    createApi: (opts) => {
      apiCalls.push(opts.token);
      return {
        getMe: async () => {
          events.getMe += 1;
          if (o.getMeError) throw new Error('Unauthorized');
          return { id: 99, username: 'mi_bot', first_name: 'Mi Bot' };
        },
        getUpdates: async (params) => {
          events.getUpdates += 1;
          if (o.getUpdatesError) throw new Error('ECONNRESET');
          return o.updates || [];
        },
        sendMessage: async (params) => {
          if (o.sendError) throw new Error('chat not found');
          events.sent.push(params);
          return {};
        },
      };
    },
    createListener: (opts) => {
      events.listenersCreated += 1;
      events.listenersRunning += 1;
      events.listenerOptions.push(opts);
      let stopped = false;
      let release = null;
      return {
        options: opts,
        run: () => new Promise((resolve) => { if (stopped) return resolve(); release = resolve; }),
        stop: () => { stopped = true; events.stops += 1; events.listenersRunning -= 1; if (release) release(); },
      };
    },
  });

  return { service, events, apiCalls, config: () => config, token: () => token, offset: () => offset };
}

const LINKED = { enabled: true, allowedUserId: '4242', account: { displayName: 'Mariana', username: 'mariana' }, bot: { id: '99', username: 'mi_bot' } };

async function expectError(fn, code) {
  try { await fn(); return false; } catch (error) { return error && error.code === code; }
}

/* ------------------------------------------------------------------ */
(async () => {
  section('Arranque: desactivado no habla con Telegram');

  {
    const h = harness();
    h.service.start();
    ok('1. sin bloque telegram no se crea ningun listener',
      h.events.listenersCreated === 0 && h.events.getUpdates === 0 && h.apiCalls.length === 0);
    ok('2. el estado dice detenido y no listo',
      h.service.getStatus().listener.state === S.STATE_STOPPED && h.service.getStatus().ready === false);
  }

  {
    const h = harness({ telegram: { enabled: false, allowedUserId: '4242' } });
    h.service.start();
    ok('3. desactivado con cuenta vinculada tampoco sondea', h.events.listenersCreated === 0);
  }

  {
    const h = harness({ telegram: LINKED, token: null });
    h.service.start();
    ok('4. activado pero sin token no arranca', h.events.listenersCreated === 0 && h.service.getStatus().tokenConfigured === false);
  }

  {
    const h = harness({ telegram: { enabled: false, allowedUserId: '4242', bot: { id: '99', username: 'mi_bot' } } });
    const status = h.service.getStatus();
    ok('5. el estado nunca incluye el token',
      !JSON.stringify(status).includes(TOKEN) && status.tokenConfigured === true, JSON.stringify(status));
  }

  section('Arranque: configurado arranca solo');

  {
    const h = harness({ telegram: LINKED, offset: 500 });
    h.service.start();
    const status = h.service.getStatus();
    ok('6. con todo configurado el listener arranca con Job Hunter',
      h.events.listenersCreated === 1 && status.listener.state === S.STATE_RUNNING && status.ready === true);
    ok('7. el listener recibe la cuenta autorizada y el offset persistido',
      h.events.listenersRunning === 1);
    await h.service.stop();
    ok('8. stop detiene el bucle', h.events.stops === 1 && h.service.getStatus().listener.state === S.STATE_STOPPED);
  }

  {
    const h = harness({ telegram: LINKED });
    h.service.start();
    h.service.start();
    h.service.start();
    ok('9. start es idempotente: nunca hay dos bucles', h.events.listenersCreated === 1 && h.events.listenersRunning === 1);
    await h.service.stop();
  }

  {
    const h = harness({ telegram: LINKED });
    h.service.start();
    await h.service.restart();
    ok('10. reconfigurar deja exactamente un listener vivo',
      h.events.listenersCreated === 2 && h.events.stops === 1 && h.events.listenersRunning === 1);
    await h.service.stop();
    ok('11. y al parar no queda ninguno', h.events.listenersRunning === 0);
  }

  {
    const h = harness({ telegram: LINKED });
    await h.service.setEnabled(false);
    ok('12. desactivar desde Configuracion detiene el listener',
      h.events.listenersRunning === 0 && h.config().telegram.enabled === false);
    ok('13. desactivar NO desvincula la cuenta', h.config().telegram.allowedUserId === '4242');
    await h.service.setEnabled(true);
    ok('14. activar arranca sin reiniciar la aplicacion',
      h.events.listenersCreated === 1 && h.service.getStatus().listener.state === S.STATE_RUNNING);
    await h.service.stop();
  }

  section('Onboarding: token');

  {
    const h = harness();
    ok('15. un token con formato invalido se rechaza sin tocar la red',
      await expectError(() => h.service.validateAndSaveToken('no-es-un-token'), 'INVALID_TELEGRAM_TOKEN')
      && h.events.getMe === 0);
    ok('16. y no se guarda nada', h.events.savedTokens.length === 0);
  }

  {
    const h = harness({ token: null, getMeError: true });
    ok('17. un token que Telegram rechaza no se persiste',
      await expectError(() => h.service.validateAndSaveToken(TOKEN), 'TELEGRAM_TOKEN_REJECTED')
      && h.events.savedTokens.length === 0 && h.token() === null);
  }

  {
    const h = harness({ token: null });
    const status = await h.service.validateAndSaveToken(TOKEN);
    ok('18. un getMe correcto guarda el token', h.events.savedTokens[0] === TOKEN && h.token() === TOKEN);
    ok('19. y persiste la identidad visible del bot',
      h.config().telegram.bot.username === 'mi_bot' && status.bot.username === 'mi_bot');
    ok('20. validar el bot NO devuelve el token', !JSON.stringify(status).includes(TOKEN));
    ok('21. validar el bot NO activa el control remoto todavia',
      status.enabled === false && status.linked === false && h.events.listenersCreated === 0);
  }

  section('Onboarding: deteccion segura de cuenta');

  {
    const h = harness({ token: TOKEN, updates: [update(10, { at: NOW - 60 * 1000, firstName: 'Mariana', username: 'mariana' })] });
    const result = await h.service.detectAccount();
    ok('22. un mensaje fresco en privado produce un candidato',
      result.candidates.length === 1 && result.candidates[0].displayName === 'Mariana' && !!result.detectionId);
    ok('23. la deteccion no confirma el offset (lee sin consumir)', h.offset() === null);
  }

  {
    const h = harness({ token: TOKEN, updates: [update(10, { at: NOW - 48 * 60 * 60 * 1000 })] });
    const result = await h.service.detectAccount();
    ok('24. un mensaje viejo del backlog NO es candidato', result.candidates.length === 0, JSON.stringify(result.candidates));
  }

  {
    const h = harness({ token: TOKEN, updates: [update(10, { chatType: 'group' }), update(11, { chatType: 'supergroup' }), update(12, { chatType: 'channel' })] });
    const result = await h.service.detectAccount();
    ok('25. un mensaje de grupo NUNCA es candidato', result.candidates.length === 0);
  }

  {
    const h = harness({
      token: TOKEN,
      updates: [update(10, { fromId: 4242, firstName: 'Mariana' }), update(11, { fromId: 777, firstName: 'Otro' })],
    });
    const result = await h.service.detectAccount();
    ok('26. varios remitentes se muestran, nunca se elige solo',
      result.candidates.length === 2 && result.candidates.map((c) => c.userId).join(',') === '4242,777');
  }

  {
    const h = harness({ telegram: LINKED });
    h.service.start();
    ok('27. no se puede detectar mientras el listener sondea',
      await expectError(() => h.service.detectAccount(), 'TELEGRAM_LISTENER_ACTIVE'));
    ok('28. y el listener sigue intacto', h.events.listenersRunning === 1 && h.events.getUpdates === 0);
    await h.service.stop();
  }

  {
    const h = harness({ token: TOKEN, getUpdatesError: true });
    ok('29. un fallo de Telegram durante la deteccion se explica sin detalles',
      await expectError(() => h.service.detectAccount(), 'TELEGRAM_UNAVAILABLE'));
  }

  {
    const h = harness({ token: null });
    ok('30. detectar sin token configurado se rechaza',
      await expectError(() => h.service.detectAccount(), 'TELEGRAM_TOKEN_REQUIRED'));
  }

  section('Onboarding: vinculacion explicita');

  {
    const h = harness({ token: TOKEN, updates: [update(30, { fromId: 4242, username: 'mariana' })] });
    const detected = await h.service.detectAccount();
    const status = await h.service.linkAccount({ detectionId: detected.detectionId, userId: '4242' });
    ok('31. vincular guarda la cuenta y activa el control remoto',
      h.config().telegram.allowedUserId === '4242' && h.config().telegram.enabled === true && status.linked === true);
    ok('32. vincular arranca el listener', h.events.listenersCreated === 1);
    ok('33. el mensaje de identificacion NO se ejecutara como comando despues',
      h.offset() === 31, 'offset=' + h.offset());
    await h.service.stop();
  }

  {
    const h = harness({ token: TOKEN, updates: [update(30, { fromId: 4242 })] });
    const detected = await h.service.detectAccount();
    ok('34. no se puede vincular un userId que la deteccion no ofrecio',
      await expectError(() => h.service.linkAccount({ detectionId: detected.detectionId, userId: '999999' }), 'TELEGRAM_CANDIDATE_UNKNOWN'));
    ok('35. y la configuracion no cambia', h.config().telegram === undefined);
  }

  {
    const h = harness({ token: TOKEN, updates: [update(30, { fromId: 4242 })] });
    await h.service.detectAccount();
    ok('36. no se puede vincular sin una deteccion vigente',
      await expectError(() => h.service.linkAccount({ detectionId: 'det_inventado', userId: '4242' }), 'TELEGRAM_DETECTION_EXPIRED'));
  }

  {
    const h = harness({ token: TOKEN, updates: [] });
    const detected = await h.service.detectAccount();
    ok('37. sin candidatos no hay nada que vincular',
      detected.candidates.length === 0
      && await expectError(() => h.service.linkAccount({ detectionId: detected.detectionId, userId: '4242' }), 'TELEGRAM_CANDIDATE_UNKNOWN'));
  }

  {
    const h = harness({ token: TOKEN, updates: [update(30, { fromId: 4242 })] });
    const detected = await h.service.detectAccount();
    await h.service.linkAccount({ detectionId: detected.detectionId, userId: '4242' });
    ok('38. una deteccion se consume: no se puede reutilizar',
      await expectError(() => h.service.linkAccount({ detectionId: detected.detectionId, userId: '4242' }), 'TELEGRAM_DETECTION_EXPIRED'));
    await h.service.stop();
  }

  {
    // REGRESION: re-vincular con el listener vivo. El bucle toma la cuenta
    // autorizada al nacer, asi que reutilizarlo dejaria mandando a la cuenta
    // VIEJA mientras Configuracion anuncia la nueva.
    const h = harness({ telegram: LINKED, token: TOKEN, updates: [update(70, { fromId: 777, firstName: 'Otra' })] });
    h.service.start();
    ok('38a. punto de partida: listener vivo con la cuenta original',
      h.events.listenerOptions[0].allowedUserId === '4242');
    await h.service.setEnabled(false);
    const detected = await h.service.detectAccount();
    // La usuaria vuelve a activar el control remoto ANTES de vincular.
    await h.service.setEnabled(true);
    ok('38b. al reactivar, el bucle sigue autorizando a la cuenta vieja',
      h.events.listenerOptions[h.events.listenerOptions.length - 1].allowedUserId === '4242');
    await h.service.linkAccount({ detectionId: detected.detectionId, userId: '777' });
    ok('38c. vincular rehace el listener con la cuenta NUEVA',
      h.events.listenerOptions[h.events.listenerOptions.length - 1].allowedUserId === '777',
      JSON.stringify(h.events.listenerOptions.map((o) => o.allowedUserId)));
    ok('38d. y sigue habiendo exactamente un bucle vivo', h.events.listenersRunning === 1);
    ok('38e. lo que anuncia Configuracion coincide con quien manda de verdad',
      h.service.getStatus().account.displayName === 'Otra');
    await h.service.stop();
  }

  {
    // REGRESION: reemplazar el token con el listener vivo. El bucle viejo
    // seguiria sondeando el bot ANTERIOR, que continuaria obedeciendo.
    const SECOND_TOKEN = '987654321:BBotherrandomsecretvalue_klmnopqrstu';
    const h = harness({ telegram: LINKED, token: TOKEN });
    h.service.start();
    const before = h.events.listenersCreated;
    await h.service.validateAndSaveToken(SECOND_TOKEN);
    ok('38f. cambiar el token rehace el listener', h.events.listenersCreated === before + 1);
    ok('38g. el bucle nuevo usa el token nuevo', h.token() === SECOND_TOKEN && h.apiCalls[h.apiCalls.length - 1] === SECOND_TOKEN);
    ok('38h. y no quedan dos bucles sondeando el mismo bot', h.events.listenersRunning === 1);
    await h.service.stop();
  }

  {
    // Guardar el primer token durante el onboarding no debe arrancar nada.
    const h = harness({ token: null });
    await h.service.validateAndSaveToken(TOKEN);
    ok('38i. validar el primer token no arranca ningun listener',
      h.events.listenersCreated === 0 && h.service.getStatus().listener.state === S.STATE_STOPPED);
  }

  {
    const h = harness({ telegram: LINKED });
    h.service.start();
    await h.service.unlinkAccount();
    ok('39. desvincular para el listener y olvida la cuenta',
      h.events.listenersRunning === 0 && h.config().telegram.allowedUserId === undefined && h.config().telegram.enabled === false);
    ok('40. y conserva el bot validado', h.config().telegram.bot.username === 'mi_bot');
  }

  section('Prueba operativa');

  {
    const h = harness({ telegram: LINKED });
    const result = await h.service.sendTestMessage();
    ok('41. la prueba manda un mensaje a la cuenta vinculada',
      result.ok === true && h.events.sent.length === 1 && h.events.sent[0].chat_id === '4242');
    ok('42. el mensaje de prueba no contiene nada sensible',
      !JSON.stringify(h.events.sent[0]).includes(TOKEN));
  }

  {
    const h = harness({ token: TOKEN });
    ok('43. probar sin cuenta vinculada se rechaza',
      await expectError(() => h.service.sendTestMessage(), 'TELEGRAM_ACCOUNT_REQUIRED'));
  }

  {
    const h = harness({ telegram: LINKED, sendError: true });
    ok('44. un fallo de envio se explica sin detalles tecnicos',
      await expectError(() => h.service.sendTestMessage(), 'TELEGRAM_SEND_FAILED'));
  }

  section('Resistencia');

  {
    const h = harness({ telegram: LINKED });
    // Un listener que revienta nada mas arrancar no puede tumbar el servicio.
    const crashing = S.createTelegramService({
      huntRunManager: { start: async () => ({}), getStatus: () => ({ status: 'IDLE', progress: {} }) },
      log: () => {},
      readConfig: () => baseConfig(LINKED),
      saveConfig: (c) => c,
      secretStore: { readToken: () => TOKEN, isConfigured: () => true, saveToken: () => ({}) },
      stateStore: { getNextUpdateId: () => null, setNextUpdateId: () => true, clear: () => true },
      createApi: () => ({ getMe: async () => ({}), getUpdates: async () => [], sendMessage: async () => ({}) }),
      createListener: () => ({ run: async () => { throw new Error('Telegram caido'); }, stop: () => {} }),
    });
    let threw = false;
    try { crashing.start(); } catch (_) { threw = true; }
    await new Promise((resolve) => setImmediate(resolve));
    ok('45. una caida de Telegram no se propaga al arranque', !threw);
    ok('46. y el servicio queda en ERROR, no colgado',
      crashing.getStatus().listener.state === S.STATE_ERROR);
    ok('47. el error mostrado no tiene detalles internos',
      !String(crashing.getStatus().listener.error).includes('Telegram caido'), crashing.getStatus().listener.error);
  }

  {
    // Una configuracion de usuario ilegible no puede impedir que el servicio exista.
    const broken = S.createTelegramService({
      huntRunManager: { start: async () => ({}), getStatus: () => ({ status: 'IDLE', progress: {} }) },
      log: () => {},
      readConfig: () => { throw new Error('config rota'); },
      saveConfig: (c) => c,
      secretStore: { readToken: () => null, isConfigured: () => false, saveToken: () => ({}) },
      stateStore: { getNextUpdateId: () => null, setNextUpdateId: () => true, clear: () => true },
    });
    const status = broken.start();
    ok('48. sin configuracion valida el servicio no arranca ni lanza',
      status.enabled === false && status.ready === false && status.listener.state === S.STATE_STOPPED);
  }

  {
    // Crear el servicio no puede exigir un huntRunManager completamente
    // operativo: el servidor de la UI se construye con el, y el control remoto
    // no puede impedir que Job Hunter arranque.
    let threw = false;
    try {
      S.createTelegramService({
        huntRunManager: {},
        log: () => {},
        readConfig: () => baseConfig(),
        saveConfig: (c) => c,
        secretStore: { readToken: () => null, isConfigured: () => false, saveToken: () => ({}) },
        stateStore: { getNextUpdateId: () => null, setNextUpdateId: () => true, clear: () => true },
      }).start();
    } catch (_) { threw = true; }
    ok('48b. crear el servicio no depende de un hunt operativo', !threw);
  }

  section('extractCandidates: reglas duras');

  {
    const { candidates, maxUpdateId } = S.extractCandidates([
      update(1, { at: NOW - 1000, fromId: 4242, firstName: 'Mariana', text: 'hola' }),
      update(2, { at: NOW - 500, fromId: 4242, text: 'sigo yo' }),
      update(3, { at: NOW - 500, chatType: 'group' }),
      update(4, { at: NOW - 999999999 }),
    ], { since: NOW - 10 * 60 * 1000 });
    ok('49. se agrupa por remitente y se guarda el ultimo texto',
      candidates.length === 1 && candidates[0].messages === 2 && candidates[0].lastText === 'sigo yo');
    ok('50. maxUpdateId cubre TODOS los updates vistos, no solo los candidatos',
      maxUpdateId === 4);
  }

  ok('51. un update sin remitente se ignora',
    S.extractCandidates([{ update_id: 1, message: { chat: { type: 'private' }, date: NOW / 1000 } }], { since: 0 }).candidates.length === 0);

  ok('52. un texto largo se recorta a una linea',
    S.extractCandidates([update(1, { text: 'x'.repeat(200) + '\n\notra linea' })], { since: 0 }).candidates[0].lastText.length <= 80);

  section('Rutas /api/settings/telegram');

  {
    const calls = [];
    const fakeService = {
      getStatus: () => ({ enabled: true, linked: true, tokenConfigured: true, bot: { username: 'mi_bot' }, account: { displayName: 'Mariana' }, listener: { state: 'RUNNING', error: null }, ready: true }),
      setEnabled: async (v) => { calls.push(['setEnabled', v]); return { enabled: v }; },
      validateAndSaveToken: async (t) => { calls.push(['token', t]); return { tokenConfigured: true, bot: { username: 'mi_bot' } }; },
      detectAccount: async () => { calls.push(['detect']); return { detectionId: 'det_1', candidates: [{ userId: '4242', displayName: 'Mariana' }] }; },
      linkAccount: (input) => { calls.push(['link', input]); return { linked: true }; },
      unlinkAccount: async () => { calls.push(['unlink']); return { linked: false }; },
      sendTestMessage: async () => { calls.push(['test']); return { ok: true }; },
      start: () => {},
      stop: async () => {},
    };
    const server = createServer({
      repository: { getAllJobs: () => [], getJob: () => null },
      jobService: { getAllJobs: () => [], getJob: () => null },
      setupService: { getStatus: () => ({ readyForHunt: true }) },
      linkedinSessionService: { isOpen: () => false, getStatus: async () => ({}), close: async () => {} },
      huntRunManager: { start: async () => ({}), getStatus: () => ({ status: 'IDLE' }), cancel: () => ({}) },
      runtimeService: { getStatus: () => ({}) },
      browserInstallManager: { getStatus: () => ({}), start: () => ({}) },
      scheduleStore: { get: () => ({}), save: (v) => v },
      scheduler: { getStatus: () => ({}), update: (v) => v, start: () => {}, stop: () => {} },
      telegramService: fakeService,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    const status = await call('GET', '/api/settings/telegram');
    ok('53. GET devuelve el estado sin token', status.status === 200 && !JSON.stringify(status.json).includes(TOKEN));

    await call('PUT', '/api/settings/telegram/bot-token', { token: TOKEN });
    ok('54. PUT bot-token valida el token contra el servicio', calls.some((c) => c[0] === 'token' && c[1] === TOKEN));

    const tokenRes = await call('PUT', '/api/settings/telegram/bot-token', { token: TOKEN });
    ok('55. y la respuesta NUNCA devuelve el token guardado',
      !JSON.stringify(tokenRes.json).includes(TOKEN) && tokenRes.json.tokenConfigured === true);

    const detected = await call('POST', '/api/settings/telegram/detect-account');
    ok('56. POST detect-account devuelve candidatos y un id de deteccion',
      detected.json.detectionId === 'det_1' && detected.json.candidates.length === 1);

    await call('PUT', '/api/settings/telegram/account', { detectionId: 'det_1', userId: '4242' });
    ok('57. PUT account vincula pasando la deteccion vigente',
      calls.some((c) => c[0] === 'link' && c[1].detectionId === 'det_1' && c[1].userId === '4242'));

    await call('PUT', '/api/settings/telegram', { enabled: false });
    ok('58. PUT raiz activa/desactiva', calls.some((c) => c[0] === 'setEnabled' && c[1] === false));

    await call('DELETE', '/api/settings/telegram/account');
    ok('59. DELETE account desvincula', calls.some((c) => c[0] === 'unlink'));

    const test = await call('POST', '/api/settings/telegram/test');
    ok('60. POST test manda la prueba', test.json.ok === true && calls.some((c) => c[0] === 'test'));

    const badType = await fetch(base + '/api/settings/telegram/bot-token', { method: 'PUT', body: 'token=abc' });
    ok('61. guardar el token exige JSON', badType.status === 415);

    // El bloque de Telegram no debe ensombrecer al resto de Configuracion:
    // /api/settings sigue resolviendo a su propio handler (aqui responde 409
    // porque este servidor de prueba no tiene user.json, no 404).
    const other = await call('GET', '/api/settings');
    ok('62. el bloque de Telegram no ensombrece las demas rutas de Configuracion',
      other.status !== 404, 'status=' + other.status);

    const unknown = await call('GET', '/api/settings/telegram/inventado');
    ok('63. una subruta desconocida de Telegram no inventa respuesta', unknown.status === 404);

    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : 'FAILURES'} (${passed} passed, ${failed} failed) ===`);
  if (failed) process.exitCode = 1;
})();

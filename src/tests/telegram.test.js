'use strict';

// Tests del bot de Telegram (control remoto del Job Hunter).
// Deterministas: NUNCA se habla con Telegram real, ni con el trigger real,
// ni se ejecuta un hunt. Todo es inyectado.

const test = require('node:test');
const assert = require('node:assert');

const { createTelegramApi, redactToken, TelegramApiError } = require('../telegram/api');
const { createTriggerClient, resolveTriggerBaseUrl } = require('../telegram/triggerClient');
const {
  TEXTS,
  BUTTON_HUNT,
  BUTTON_STATUS,
  REPLY_KEYBOARD,
  parseAllowedUserId,
  parseCommand,
  authorize,
  handleUpdate,
} = require('../telegram/commands');
const { createListener } = require('../telegram/bot');

const FAKE_TOKEN = '8000000:AAH-ESTE-TOKEN-ES-FALSO-PERO-SECRETO';
const ALLOWED = '123456789';
const OTHER_USER = '987654321';

// ---------- fixtures ----------

function privateMessage(text, fromId = ALLOWED, updateId = 1) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      from: { id: Number(fromId), first_name: 'Mariano', username: 'mariano' },
      chat: { id: Number(fromId), type: 'private' },
      text,
    },
  };
}

function chatMessage(text, chatType, updateId = 1) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      from: { id: Number(ALLOWED), first_name: 'Mariano' },
      chat: { id: -1001234567890, type: chatType },
      text,
    },
  };
}

function fakeTrigger(overrides = {}) {
  const calls = [];
  return {
    calls,
    startHunt: async () => { calls.push('startHunt'); return overrides.startHunt || { result: 'started', runId: 'run_x' }; },
    getStatus: async () => { calls.push('getStatus'); return overrides.getStatus || { available: true, huntRunning: false }; },
  };
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// ================= API =================

test('redactToken saca el token de cualquier texto', () => {
  const texto = `fallo en https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`;
  const limpio = redactToken(texto, FAKE_TOKEN);
  assert.ok(!limpio.includes(FAKE_TOKEN));
  assert.ok(limpio.includes('[token]'));
});

test('un error de red nunca expone el token y es reintentable', async () => {
  const api = createTelegramApi({
    token: FAKE_TOKEN,
    fetch: async (url) => { throw new Error('fetch failed for ' + url); },
  });
  await assert.rejects(
    () => api.getUpdates({}),
    (err) => {
      assert.ok(err instanceof TelegramApiError);
      assert.strictEqual(err.network, true);
      assert.ok(!err.message.includes(FAKE_TOKEN), 'el mensaje de error filtro el token');
      return true;
    }
  );
});

test('un error de Telegram propaga la descripcion sin el token', async () => {
  const api = createTelegramApi({
    token: FAKE_TOKEN,
    fetch: async () => jsonResponse(401, { ok: false, error_code: 401, description: 'Unauthorized' }),
  });
  await assert.rejects(
    () => api.getMe(),
    (err) => {
      assert.strictEqual(err.errorCode, 401);
      assert.ok(err.message.includes('Unauthorized'));
      assert.ok(!err.message.includes(FAKE_TOKEN));
      return true;
    }
  );
});

test('la api devuelve el result y manda el token en la URL, no en el body', async () => {
  let captured = null;
  const api = createTelegramApi({
    token: FAKE_TOKEN,
    fetch: async (url, init) => { captured = { url, init }; return jsonResponse(200, { ok: true, result: [{ update_id: 7 }] }); },
  });
  const result = await api.getUpdates({ offset: 5 });
  assert.deepStrictEqual(result, [{ update_id: 7 }]);
  assert.ok(captured.url.endsWith('/getUpdates'));
  assert.ok(!captured.init.body.includes(FAKE_TOKEN));
  assert.deepStrictEqual(JSON.parse(captured.init.body), { offset: 5 });
});

test('crear la api sin token falla explicitamente', () => {
  assert.throws(() => createTelegramApi({ token: '' }), /TELEGRAM_BOT_TOKEN/);
});

// ================= whoami =================

const { extractUsers, shortText, NO_UPDATES_MESSAGE } = require('../telegram/whoami');

test('whoami extrae usuarios de los updates', () => {
  const users = extractUsers([
    privateMessage('hola', ALLOWED, 1),
    privateMessage('/start', ALLOWED, 2),
  ]);
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].id, ALLOWED);
  assert.strictEqual(users[0].firstName, 'Mariano');
  assert.strictEqual(users[0].username, 'mariano');
  assert.strictEqual(users[0].chatType, 'private');
  assert.strictEqual(users[0].lastText, '/start');
  assert.strictEqual(users[0].messages, 2);
});

test('whoami lista varios usuarios por separado', () => {
  const users = extractUsers([
    privateMessage('hola', ALLOWED, 1),
    privateMessage('hola', OTHER_USER, 2),
  ]);
  assert.deepStrictEqual(users.map((u) => u.id).sort(), [ALLOWED, OTHER_USER].sort());
});

test('whoami ignora updates sin remitente', () => {
  assert.deepStrictEqual(extractUsers([{ update_id: 1 }, { update_id: 2, message: {} }, null]), []);
  assert.deepStrictEqual(extractUsers(undefined), []);
});

test('whoami recorta textos largos a una linea', () => {
  const texto = shortText('a'.repeat(200) + '\nsegunda linea');
  assert.ok(texto.length <= 80);
  assert.ok(!texto.includes('\n'));
});

test('whoami tiene un mensaje claro cuando no hay updates', () => {
  assert.ok(NO_UPDATES_MESSAGE.includes('No encontré mensajes'));
  assert.ok(NO_UPDATES_MESSAGE.includes('Start'));
});

// ================= parsing =================

test('parseCommand entiende comandos, menciones al bot y botones', () => {
  assert.strictEqual(parseCommand('/start'), 'start');
  assert.strictEqual(parseCommand('  /HUNT  '), 'hunt');
  assert.strictEqual(parseCommand('/status@JobHunterBot'), 'status');
  assert.strictEqual(parseCommand(BUTTON_HUNT), 'hunt');
  assert.strictEqual(parseCommand(BUTTON_STATUS), 'status');
  assert.strictEqual(parseCommand('/deploy'), null);
  assert.strictEqual(parseCommand('hola'), null);
  assert.strictEqual(parseCommand(''), null);
  assert.strictEqual(parseCommand(undefined), null);
});

test('parseAllowedUserId solo acepta un id numerico', () => {
  assert.strictEqual(parseAllowedUserId('123456789'), '123456789');
  assert.strictEqual(parseAllowedUserId(' 123456789 '), '123456789');
  assert.strictEqual(parseAllowedUserId(123456789), '123456789');
  assert.strictEqual(parseAllowedUserId(''), null);
  assert.strictEqual(parseAllowedUserId(undefined), null);
  assert.strictEqual(parseAllowedUserId('<id>'), null);
  assert.strictEqual(parseAllowedUserId('123 456'), null);
});

// ================= autorizacion =================

test('autoriza al usuario configurado en chat privado', () => {
  const { message } = privateMessage('/hunt');
  assert.deepStrictEqual(authorize(message, ALLOWED), { allowed: true, reason: 'ok' });
});

test('rechaza a otro usuario aunque escriba en privado', () => {
  const { message } = privateMessage('/hunt', OTHER_USER);
  assert.deepStrictEqual(authorize(message, ALLOWED), { allowed: false, reason: 'forbidden_user' });
});

test('rechaza grupos, supergrupos y canales incluso desde el usuario autorizado', () => {
  for (const tipo of ['group', 'supergroup', 'channel']) {
    const { message } = chatMessage('/hunt', tipo);
    assert.deepStrictEqual(authorize(message, ALLOWED), { allowed: false, reason: 'not_private' }, tipo);
  }
});

test('sin TELEGRAM_ALLOWED_USER_ID no hay usuario autorizado', () => {
  const { message } = privateMessage('/hunt');
  assert.deepStrictEqual(authorize(message, ''), { allowed: false, reason: 'not_configured' });
  assert.deepStrictEqual(authorize(message, undefined), { allowed: false, reason: 'not_configured' });
});

test('la autorizacion mira from.id, no chat.id', () => {
  // chat.id del usuario autorizado, pero el mensaje lo manda otro.
  const message = {
    from: { id: Number(OTHER_USER) },
    chat: { id: Number(ALLOWED), type: 'private' },
    text: '/hunt',
  };
  assert.strictEqual(authorize(message, ALLOWED).allowed, false);
});

// ================= comandos =================

test('/start responde con el saludo y el teclado', async () => {
  const trigger = fakeTrigger();
  const reply = await handleUpdate(privateMessage('/start'), { trigger, allowedUserId: ALLOWED });
  assert.strictEqual(reply.text, TEXTS.start);
  assert.deepStrictEqual(reply.replyMarkup, REPLY_KEYBOARD);
  assert.strictEqual(reply.chatId, Number(ALLOWED));
  assert.deepStrictEqual(trigger.calls, []); // /start no toca el trigger
});

test('el teclado ofrece exactamente los dos botones', () => {
  assert.deepStrictEqual(REPLY_KEYBOARD.keyboard, [[{ text: BUTTON_HUNT }, { text: BUTTON_STATUS }]]);
  assert.strictEqual(REPLY_KEYBOARD.resize_keyboard, true);
});

test('/hunt autorizado dispara el trigger y confirma', async () => {
  const trigger = fakeTrigger();
  const reply = await handleUpdate(privateMessage('/hunt'), { trigger, allowedUserId: ALLOWED });
  assert.strictEqual(reply.text, TEXTS.huntStarted);
  assert.deepStrictEqual(trigger.calls, ['startHunt']);
});

test('el boton Lanzar Hunt hace exactamente lo mismo que /hunt', async () => {
  const porComando = await handleUpdate(privateMessage('/hunt'), { trigger: fakeTrigger(), allowedUserId: ALLOWED });
  const porBoton = await handleUpdate(privateMessage(BUTTON_HUNT), { trigger: fakeTrigger(), allowedUserId: ALLOWED });
  assert.strictEqual(porBoton.text, porComando.text);
  assert.strictEqual(porBoton.log, porComando.log);
});

test('el boton Estado hace exactamente lo mismo que /status', async () => {
  const porComando = await handleUpdate(privateMessage('/status'), { trigger: fakeTrigger(), allowedUserId: ALLOWED });
  const porBoton = await handleUpdate(privateMessage(BUTTON_STATUS), { trigger: fakeTrigger(), allowedUserId: ALLOWED });
  assert.strictEqual(porBoton.text, porComando.text);
  assert.strictEqual(porBoton.log, porComando.log);
});

test('/hunt con un hunt en curso avisa sin iniciar otro', async () => {
  const trigger = fakeTrigger({ startHunt: { result: 'already_running' } });
  const reply = await handleUpdate(privateMessage('/hunt'), { trigger, allowedUserId: ALLOWED });
  assert.strictEqual(reply.text, TEXTS.huntAlreadyRunning);
});

test('/hunt sin trigger disponible lo dice sin detalles tecnicos', async () => {
  const trigger = fakeTrigger({ startHunt: { result: 'unavailable' } });
  const reply = await handleUpdate(privateMessage('/hunt'), { trigger, allowedUserId: ALLOWED });
  assert.strictEqual(reply.text, TEXTS.triggerUnavailable);
  assert.ok(!/8787|127\.0\.0\.1|Bearer|token/i.test(reply.text));
});

test('un error local del trigger no se explica por Telegram', async () => {
  const trigger = fakeTrigger({ startHunt: { result: 'unauthorized' } });
  const reply = await handleUpdate(privateMessage('/hunt'), { trigger, allowedUserId: ALLOWED });
  assert.strictEqual(reply.text, TEXTS.huntError);
  assert.ok(!/token|unauthorized|401/i.test(reply.text));
  assert.strictEqual(reply.log, 'hunt:error:unauthorized'); // el detalle queda en el log local
});

test('/status idle', async () => {
  const trigger = fakeTrigger({ getStatus: { available: true, huntRunning: false } });
  const reply = await handleUpdate(privateMessage('/status'), { trigger, allowedUserId: ALLOWED });
  assert.strictEqual(reply.text, '🟢 Job Hunter disponible\nHunt: inactivo');
});

test('/status running', async () => {
  const trigger = fakeTrigger({ getStatus: { available: true, huntRunning: true } });
  const reply = await handleUpdate(privateMessage('/status'), { trigger, allowedUserId: ALLOWED });
  assert.strictEqual(reply.text, '🟢 Job Hunter disponible\nHunt: ejecutándose');
});

test('/status con el trigger caido', async () => {
  const trigger = fakeTrigger({ getStatus: { available: false, huntRunning: false } });
  const reply = await handleUpdate(privateMessage('/status'), { trigger, allowedUserId: ALLOWED });
  assert.strictEqual(reply.text, TEXTS.statusUnavailable);
});

test('un usuario no autorizado recibe el rechazo y no ejecuta nada', async () => {
  const trigger = fakeTrigger();
  const reply = await handleUpdate(privateMessage('/hunt', OTHER_USER), { trigger, allowedUserId: ALLOWED });
  assert.strictEqual(reply.text, TEXTS.unauthorized);
  assert.deepStrictEqual(trigger.calls, []);
  assert.strictEqual(reply.replyMarkup, undefined); // sin teclado para desconocidos
});

test('el rechazo no revela ids ni configuracion', async () => {
  const reply = await handleUpdate(privateMessage('/hunt', OTHER_USER), { trigger: fakeTrigger(), allowedUserId: ALLOWED });
  assert.strictEqual(reply.text, '⛔ No autorizado.');
  assert.ok(!reply.text.includes(ALLOWED));
  assert.ok(!reply.text.includes(OTHER_USER));
});

test('sin id configurado nadie ejecuta nada', async () => {
  const trigger = fakeTrigger();
  const reply = await handleUpdate(privateMessage('/hunt'), { trigger, allowedUserId: '' });
  assert.strictEqual(reply.text, TEXTS.unauthorized);
  assert.deepStrictEqual(trigger.calls, []);
});

test('en un grupo el bot no responde NADA', async () => {
  const trigger = fakeTrigger();
  for (const tipo of ['group', 'supergroup', 'channel']) {
    const reply = await handleUpdate(chatMessage('/hunt', tipo), { trigger, allowedUserId: ALLOWED });
    assert.strictEqual(reply, null, tipo);
  }
  assert.deepStrictEqual(trigger.calls, []);
});

test('un texto desconocido no ejecuta comandos', async () => {
  const trigger = fakeTrigger();
  const reply = await handleUpdate(privateMessage('borrá todo'), { trigger, allowedUserId: ALLOWED });
  assert.strictEqual(reply.text, TEXTS.unknown);
  assert.deepStrictEqual(trigger.calls, []);
});

test('los updates que no son mensajes de texto se ignoran', async () => {
  const deps = { trigger: fakeTrigger(), allowedUserId: ALLOWED };
  assert.strictEqual(await handleUpdate({ update_id: 1 }, deps), null);
  assert.strictEqual(await handleUpdate({ update_id: 1, message: { chat: { type: 'private' } } }, deps), null);
  assert.strictEqual(await handleUpdate(null, deps), null);
});

// ================= trigger client =================

test('el trigger client apunta siempre a loopback', () => {
  assert.strictEqual(resolveTriggerBaseUrl({}), 'http://127.0.0.1:8787');
  assert.strictEqual(resolveTriggerBaseUrl({ HUNT_TRIGGER_PORT: '9999' }), 'http://127.0.0.1:9999');
  // HUNT_TRIGGER_HOST es direccion de BIND (puede ser 0.0.0.0): no se usa para conectar.
  assert.strictEqual(resolveTriggerBaseUrl({ HUNT_TRIGGER_HOST: '0.0.0.0' }), 'http://127.0.0.1:8787');
});

test('startHunt manda POST /run con el bearer token', async () => {
  let captured = null;
  const client = createTriggerClient({
    baseUrl: 'http://127.0.0.1:8787',
    token: 'token-local',
    fetch: async (url, init) => { captured = { url, init }; return jsonResponse(202, { ok: true, runId: 'run_abc', status: 'started' }); },
  });
  const r = await client.startHunt();
  assert.deepStrictEqual(r, { result: 'started', runId: 'run_abc' });
  assert.strictEqual(captured.url, 'http://127.0.0.1:8787/run');
  assert.strictEqual(captured.init.method, 'POST');
  assert.strictEqual(captured.init.headers.Authorization, 'Bearer token-local');
});

test('startHunt traduce 409 a already_running', async () => {
  const client = createTriggerClient({ token: 't', fetch: async () => jsonResponse(409, { ok: false, error: 'hunt_already_running' }) });
  assert.deepStrictEqual(await client.startHunt(), { result: 'already_running' });
});

test('startHunt traduce 401 a unauthorized', async () => {
  const client = createTriggerClient({ token: 't', fetch: async () => jsonResponse(401, { ok: false, error: 'unauthorized' }) });
  assert.deepStrictEqual(await client.startHunt(), { result: 'unauthorized' });
});

test('startHunt con el trigger apagado devuelve unavailable', async () => {
  const client = createTriggerClient({ token: 't', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepStrictEqual(await client.startHunt(), { result: 'unavailable' });
});

test('getStatus lee /health sin auth', async () => {
  let captured = null;
  const client = createTriggerClient({
    token: 't',
    fetch: async (url, init) => { captured = { url, init }; return jsonResponse(200, { ok: true, huntRunning: false, lockBusy: false, busy: false }); },
  });
  const r = await client.getStatus();
  assert.deepStrictEqual(r, { available: true, huntRunning: false });
  assert.ok(captured.url.endsWith('/health'));
  assert.strictEqual(captured.init.headers.Authorization, undefined);
});

test('getStatus ve ocupado un hunt del trigger', async () => {
  const client = createTriggerClient({ token: 't', fetch: async () => jsonResponse(200, { ok: true, huntRunning: true, lockBusy: true, busy: true }) });
  assert.deepStrictEqual(await client.getStatus(), { available: true, huntRunning: true });
});

test('getStatus ve ocupado un hunt manual (solo lock)', async () => {
  const client = createTriggerClient({ token: 't', fetch: async () => jsonResponse(200, { ok: true, huntRunning: false, lockBusy: true, busy: true }) });
  assert.deepStrictEqual(await client.getStatus(), { available: true, huntRunning: true });
});

test('getStatus con el trigger caido devuelve no disponible', async () => {
  const client = createTriggerClient({ token: 't', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepStrictEqual(await client.getStatus(), { available: false, huntRunning: false });
});

// ================= listener (long polling) =================

function listenerHarness(options = {}) {
  const sent = [];
  const logs = [];
  const handled = [];
  const api = {
    getUpdates: options.getUpdates,
    sendMessage: async (params) => { sent.push(params); },
  };
  const listener = createListener({
    api,
    trigger: options.trigger || fakeTrigger(),
    allowedUserId: options.allowedUserId || ALLOWED,
    log: (m) => logs.push(m),
    sleep: options.sleep || (async () => {}),
    maxBackoffMs: options.maxBackoffMs,
    handleUpdate: options.handleUpdate || (async (update, deps) => { handled.push(update.update_id); return handleUpdate(update, deps); }),
    initialOffset: options.initialOffset === undefined ? 0 : options.initialOffset,
    persistOffset: options.persistOffset,
    sessionStartedAt: options.sessionStartedAt,
  });
  return { listener, sent, logs, handled };
}

test('el listener avanza el offset despues de procesar', async () => {
  const requests = [];
  const h = listenerHarness({
    getUpdates: async (params) => {
      requests.push(params);
      return requests.length === 1 ? [privateMessage('/start', ALLOWED, 10), privateMessage('/start', ALLOWED, 11)] : [];
    },
  });
  await h.listener.pollOnce();
  assert.strictEqual(h.listener.offset, 12);
  await h.listener.pollOnce();
  // Un listener ya arrancado parte de su offset conocido. El arranque en frio
  // (sin offset) ya no trae el backlog: lo descarta, y tiene test propio en
  // telegram-freshness.test.js.
  assert.strictEqual(requests[0].offset, 0);
  assert.strictEqual(requests[1].offset, 12);
});

test('el listener pide solo mensajes y usa long polling', async () => {
  const requests = [];
  const h = listenerHarness({ getUpdates: async (params) => { requests.push(params); return []; } });
  await h.listener.pollOnce();
  assert.deepStrictEqual(requests[0].allowed_updates, ['message']);
  assert.ok(requests[0].timeout >= 10, 'el timeout de long polling deberia ser generoso');
});

test('el mismo update NO se procesa dos veces aunque Telegram lo reenvie', async () => {
  const update = privateMessage('/hunt', ALLOWED, 42);
  const trigger = fakeTrigger();
  const h = listenerHarness({ trigger, getUpdates: async () => [update] });

  await h.listener.pollOnce();
  await h.listener.pollOnce(); // reenvio del mismo update_id

  assert.deepStrictEqual(h.handled, [42]);
  assert.deepStrictEqual(trigger.calls, ['startHunt'], 'un reenvio no puede disparar un segundo hunt');
  assert.strictEqual(h.sent.length, 1);
});

test('el listener responde al chat correcto con el teclado', async () => {
  const h = listenerHarness({ getUpdates: async () => [privateMessage('/start', ALLOWED, 1)] });
  await h.listener.pollOnce();
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].chat_id, Number(ALLOWED));
  assert.strictEqual(h.sent[0].text, TEXTS.start);
  assert.deepStrictEqual(h.sent[0].reply_markup, REPLY_KEYBOARD);
});

test('el listener no responde nada a un grupo', async () => {
  const h = listenerHarness({ getUpdates: async () => [chatMessage('/hunt', 'group', 5)] });
  await h.listener.pollOnce();
  assert.strictEqual(h.sent.length, 0);
  assert.strictEqual(h.listener.offset, 6, 'igual se confirma el update para no releerlo');
});

test('un update envenenado no bloquea la cola', async () => {
  const h = listenerHarness({
    getUpdates: async () => [privateMessage('/start', ALLOWED, 1)],
    handleUpdate: async () => { throw new Error('handler roto'); },
  });
  await h.listener.pollOnce();
  assert.strictEqual(h.listener.offset, 2);
  assert.ok(h.logs.some((l) => l.includes('error procesando update')));
});

test('un fallo al responder no tumba el listener', async () => {
  const listener = createListener({
    api: {
      getUpdates: async () => [privateMessage('/start', ALLOWED, 1)],
      sendMessage: async () => { throw new Error('Telegram 429'); },
    },
    trigger: fakeTrigger(),
    allowedUserId: ALLOWED,
  });
  await listener.pollOnce();
  assert.strictEqual(listener.offset, 2);
});

test('ante errores de red reintenta con backoff exponencial y se recupera', async () => {
  const waits = [];
  let calls = 0;
  let listener;
  listener = createListener({
    api: {
      getUpdates: async () => {
        calls += 1;
        if (calls <= 3) throw new TelegramApiError('fetch failed', { network: true });
        listener.stop();
        return [];
      },
      sendMessage: async () => {},
    },
    trigger: fakeTrigger(),
    allowedUserId: ALLOWED,
    sleep: async (ms) => { waits.push(ms); },
  });
  await listener.run();
  assert.deepStrictEqual(waits, [1000, 2000, 4000]);
  assert.strictEqual(listener.failures, 0, 'el contador se resetea tras un poll exitoso');
});

test('el backoff tiene techo', async () => {
  const waits = [];
  let calls = 0;
  let listener;
  listener = createListener({
    api: {
      getUpdates: async () => {
        calls += 1;
        if (calls > 6) listener.stop();
        throw new TelegramApiError('fetch failed', { network: true });
      },
      sendMessage: async () => {},
    },
    trigger: fakeTrigger(),
    allowedUserId: ALLOWED,
    maxBackoffMs: 5000,
    sleep: async (ms) => { waits.push(ms); },
  });
  await listener.run();
  assert.ok(waits.every((w) => w <= 5000));
  assert.ok(waits.includes(5000));
});

test('stop corta el loop sin lanzar', async () => {
  let listener;
  listener = createListener({
    api: {
      getUpdates: async () => { listener.stop(); return []; },
      sendMessage: async () => {},
    },
    trigger: fakeTrigger(),
    allowedUserId: ALLOWED,
  });
  await listener.run(); // si no terminara, el test timeoutea
  assert.ok(true);
});

test('los logs del listener no contienen secretos', async () => {
  const h = listenerHarness({
    getUpdates: async () => [privateMessage('/hunt', ALLOWED, 1)],
    trigger: fakeTrigger({ startHunt: { result: 'unauthorized' } }),
  });
  await h.listener.pollOnce();
  const todo = h.logs.join('\n') + '\n' + JSON.stringify(h.sent);
  assert.ok(!todo.includes(FAKE_TOKEN));
  assert.ok(!/Bearer/.test(todo));
});

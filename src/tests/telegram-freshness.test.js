'use strict';

// Telegram: offset persistido y frescura de comandos de accion.
//
// Dos agujeros confirmados por el forense del 19-sep:
//   A) un /hunt enviado con la PC apagada quedaba en la cola de Telegram y se
//      ejecutaba al encender;
//   B) el offset vivia solo en memoria, asi que un reinicio podia reprocesar
//      un update ya atendido.
//
// NINGUN test toca Telegram real ni el trigger real.
// Ejecutar: node --test src/tests/telegram-freshness.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../telegram/commands');
const { createListener } = require('../telegram/bot');
const { createTelegramStateStore } = require('../telegram/state');

const ALLOWED = '4242';
const NOW = 1_700_000_000_000;
const SESSION_START = NOW - 5 * 60 * 1000;

let seq = 900;
function message(text, over = {}) {
  const id = over.updateId === undefined ? (seq += 1) : over.updateId;
  const msg = {
    message_id: id,
    text,
    from: { id: Number(over.fromId === undefined ? ALLOWED : over.fromId), first_name: 'Mariana' },
    chat: { id: 555, type: over.chatType || 'private' },
  };
  if (over.date !== null) msg.date = Math.floor((over.at === undefined ? NOW - 1000 : over.at) / 1000);
  return { update_id: id, message: msg };
}

function fakeTrigger(over = {}) {
  const calls = { start: 0, status: 0 };
  return {
    calls,
    startHunt: async () => { calls.start += 1; return over.start || { result: 'started' }; },
    getStatus: async () => { calls.status += 1; return over.status || { available: true, huntRunning: false }; },
  };
}

async function route(update, over = {}) {
  const trigger = over.trigger || fakeTrigger(over);
  const answer = await C.handleUpdate(update, {
    trigger,
    allowedUserId: 'allowedUserId' in over ? over.allowedUserId : ALLOWED,
    sessionStartedAt: 'sessionStartedAt' in over ? over.sessionStartedAt : SESSION_START,
    now: 'now' in over ? over.now : NOW,
  });
  return { answer, trigger };
}

function fakeApi(pages) {
  const requests = []; const sent = []; let i = 0;
  return {
    requests,
    sent,
    getUpdates: async (params, opts) => {
      requests.push(params);
      const page = pages[i]; i += 1;
      if (page === undefined) {
        return new Promise((_, reject) => {
          const signal = opts && opts.signal;
          if (signal) signal.addEventListener('abort', () => reject(new Error('stop')), { once: true });
        });
      }
      return page;
    },
    sendMessage: async (params) => { sent.push(params); return {}; },
  };
}

/* ---------- 1-3: comandos de accion frescos y viejos ---------- */

test('1. /hunt nuevo ejecuta exactamente una vez', async () => {
  const { answer, trigger } = await route(message('/hunt', { at: NOW - 2000 }));
  assert.equal(trigger.calls.start, 1);
  assert.equal(answer.text, '🚀 Hunt iniciado.');
});

test('2. /hunt enviado antes de arrancar el listener NO ejecuta', async () => {
  const { answer, trigger } = await route(message('/hunt', { at: SESSION_START - 8 * 60 * 60 * 1000 }));
  assert.equal(trigger.calls.start, 0);
  assert.equal(answer.text, '⚠️ Ignoré una solicitud antigua de hunt.');
});

test('3. el boton "Lanzar Hunt" viejo tampoco ejecuta', async () => {
  const { trigger } = await route(message(C.BUTTON_HUNT, { at: SESSION_START - 3 * 60 * 60 * 1000 }));
  assert.equal(trigger.calls.start, 0);
});

test('3b. el boton reciente si ejecuta', async () => {
  const { trigger } = await route(message(C.BUTTON_HUNT, { at: NOW - 3000 }));
  assert.equal(trigger.calls.start, 1);
});

test('3c. un /hunt retenido 30 min con el listener vivo tampoco ejecuta', async () => {
  const { trigger } = await route(message('/hunt', { at: NOW - 30 * 60 * 1000 }), { sessionStartedAt: NOW - 60 * 60 * 1000 });
  assert.equal(trigger.calls.start, 0);
});

test('3d. dentro de la ventana de 10 min si ejecuta', async () => {
  const { trigger } = await route(message('/hunt', { at: NOW - 9 * 60 * 1000 }), { sessionStartedAt: NOW - 60 * 60 * 1000 });
  assert.equal(trigger.calls.start, 1);
});

test('3e. una desviacion de reloj de 20s no bloquea un comando legitimo', async () => {
  const { trigger } = await route(message('/hunt', { at: SESSION_START - 20 * 1000 }));
  assert.equal(trigger.calls.start, 1);
});

test('3f. sin fecha utilizable NO se ejecuta', async () => {
  const { trigger } = await route(message('/hunt', { date: null }));
  assert.equal(trigger.calls.start, 0);
});

/* ---------- 4-6: offset persistido ---------- */

test('4. reinicio con offset persistido: se pide desde el update siguiente', async () => {
  const update = message('/hunt', { at: NOW - 1000, updateId: 700 });
  let saved = null;
  const first = createListener({
    api: fakeApi([[update]]), trigger: fakeTrigger(), allowedUserId: ALLOWED,
    initialOffset: 0, persistOffset: (v) => { saved = v; }, now: () => NOW, sessionStartedAt: NOW - 60_000,
  });
  await first.pollOnce();
  // El offset se persiste al procesar, ANTES de que la siguiente llamada a
  // getUpdates lo confirme: si el proceso muere justo aqui, el reinicio ya
  // sabe por donde iba.
  assert.equal(saved, 701);

  // Al reiniciar se pide 701, asi que Telegram nunca reentrega el 700.
  const api = fakeApi([[]]);
  const trigger = fakeTrigger();
  const second = createListener({
    api, trigger, allowedUserId: ALLOWED,
    initialOffset: saved, persistOffset: () => {}, now: () => NOW, sessionStartedAt: NOW - 60_000,
  });
  await second.pollOnce();
  assert.equal(api.requests[0].offset, 701);
  assert.equal(trigger.calls.start, 0);
});

test('4b. el guard en memoria evita el doble proceso dentro de la misma sesion', async () => {
  const update = message('/hunt', { at: NOW - 1000, updateId: 800 });
  const trigger = fakeTrigger();
  const listener = createListener({
    api: fakeApi([[update], [update]]), trigger, allowedUserId: ALLOWED,
    initialOffset: 800, persistOffset: () => {}, now: () => NOW, sessionStartedAt: NOW - 60_000,
  });
  await listener.pollOnce();
  await listener.pollOnce();
  assert.equal(trigger.calls.start, 1);
});

test('5. crash despues de procesar: el offset ya estaba en disco', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-tg-'));
  const store = createTelegramStateStore({ filePath: path.join(dir, 'state', 'telegram.json') });
  assert.equal(store.getNextUpdateId(), null);
  store.setNextUpdateId(701);
  const reopened = createTelegramStateStore({ filePath: store.filePath });
  assert.equal(reopened.getNextUpdateId(), 701);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('6. el offset nunca retrocede', async () => {
  const listener = createListener({
    api: fakeApi([[message('/status', { at: NOW - 1000, updateId: 5 })]]),
    trigger: fakeTrigger(), allowedUserId: ALLOWED,
    initialOffset: 500, now: () => NOW, sessionStartedAt: NOW - 60_000,
  });
  await listener.pollOnce();
  assert.equal(listener.offset, 500);
});

/* ---------- 7-8: estado ausente o corrupto ---------- */

test('7. state ausente: arranque en frio descarta el backlog sin ejecutarlo', async () => {
  const stale = message('/hunt', { at: NOW - 9 * 60 * 60 * 1000, updateId: 99 });
  const api = fakeApi([[stale], []]);
  const trigger = fakeTrigger();
  const listener = createListener({
    api, trigger, allowedUserId: ALLOWED, persistOffset: () => {}, now: () => NOW,
  });
  await listener.pollOnce();
  assert.equal(trigger.calls.start, 0);
  assert.equal(api.requests[0].offset, -1);
  assert.equal(listener.offset, 100);
});

test('8. state corrupto se trata como arranque en frio, no como error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-tg-'));
  const filePath = path.join(dir, 'telegram.json');
  fs.writeFileSync(filePath, '{ roto', 'utf8');
  const store = createTelegramStateStore({ filePath });
  assert.equal(store.getNextUpdateId(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('8b. un fallo de escritura del offset no rompe el listener', async () => {
  const listener = createListener({
    api: fakeApi([[message('/status', { at: NOW - 1000, updateId: 90 })]]),
    trigger: fakeTrigger(), allowedUserId: ALLOWED,
    initialOffset: 0, persistOffset: () => { throw new Error('disco lleno'); },
    now: () => NOW, sessionStartedAt: NOW - 60_000,
  });
  await listener.pollOnce();
  assert.equal(listener.offset, 91);
});

/* ---------- 9-13: lo que no debe cambiar ---------- */

test('9. /status sigue funcionando aunque sea viejo', async () => {
  const { answer, trigger } = await route(message('/status', { at: SESSION_START - 12 * 60 * 60 * 1000 }));
  assert.ok(answer.text.startsWith('🟢 Job Hunter disponible'));
  assert.equal(trigger.calls.status, 1);
});

test('10. /start sigue funcionando aunque sea viejo', async () => {
  const { answer } = await route(message('/start', { at: SESSION_START - 12 * 60 * 60 * 1000 }));
  assert.ok(answer.text.startsWith('🤖 Job Hunter conectado.'));
});

test('11. un usuario no autorizado sigue bloqueado', async () => {
  const { answer, trigger } = await route(message('/hunt', { fromId: '9999', at: NOW - 1000 }));
  assert.equal(answer.text, '⛔ No autorizado.');
  assert.equal(trigger.calls.start, 0);
});

test('12. un grupo sigue sin respuesta y sin ejecucion', async () => {
  for (const chatType of ['group', 'supergroup', 'channel']) {
    const { answer, trigger } = await route(message('/hunt', { chatType, at: NOW - 1000 }));
    assert.equal(answer, null);
    assert.equal(trigger.calls.start, 0);
  }
});

test('13. ningun texto del bot revela secretos ni rutas', () => {
  const texts = Object.values(C.TEXTS).join(' ');
  assert.ok(!/token|\.env|OPENAI|ntfy|topic|C:\\|stack|http/i.test(texts));
  assert.ok(texts.includes('antigua'));
});

test('13b. el estado guardado solo contiene nextUpdateId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-tg-'));
  const store = createTelegramStateStore({ filePath: path.join(dir, 'telegram.json') });
  store.setNextUpdateId(42);
  const raw = fs.readFileSync(store.filePath, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['nextUpdateId']);
  fs.rmSync(dir, { recursive: true, force: true });
});

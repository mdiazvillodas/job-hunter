'use strict';

// Phase 13 — frescura de comandos de Telegram.
//
// Telegram retiene los updates no entregados ~24h. Con offset persistido, al
// encender la PC el listener pedia ese offset y recibia el /hunt que la usuaria
// habia mandado anoche... y lo ejecutaba. Encender el ordenador no puede
// lanzar una busqueda que nadie pidio ahora.
//
// NINGUN test toca Telegram real.
// Ejecutar: node src/tests/phase13.test.js

const C = require('../telegram/commands');
const { createListener } = require('../telegram/listener');
const S = require('../telegram/telegramService');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }

const ALLOWED = '4242';
const NOW = 1_700_000_000_000;              // "ahora" fijo
const SESSION_START = NOW - 5 * 60 * 1000;  // el listener arranco hace 5 min

let seq = 900;
function message(text, over) {
  const o = over || {};
  const id = o.updateId === undefined ? (seq += 1) : o.updateId;
  const msg = {
    message_id: id,
    text,
    from: { id: Number(o.fromId === undefined ? ALLOWED : o.fromId), first_name: 'Mariana' },
    chat: { id: 555, type: o.chatType || 'private' },
  };
  if (o.date !== null) msg.date = Math.floor((o.at === undefined ? NOW - 1000 : o.at) / 1000);
  return { update_id: id, message: msg };
}

function huntControl(over) {
  const calls = { start: 0, status: 0 };
  return {
    calls,
    startHunt: async () => { calls.start += 1; return (over && over.start) || { result: 'started' }; },
    getStatus: () => { calls.status += 1; return (over && over.status) || { available: true, huntRunning: false }; },
  };
}

async function route(update, over) {
  const control = (over && over.huntControl) || huntControl(over);
  const answer = await C.handleUpdate(update, {
    huntControl: control,
    allowedUserId: over && 'allowedUserId' in over ? over.allowedUserId : ALLOWED,
    sessionStartedAt: over && 'sessionStartedAt' in over ? over.sessionStartedAt : SESSION_START,
    now: over && 'now' in over ? over.now : NOW,
  });
  return { answer, control };
}

(async () => {
  section('Comandos de accion: solo si son de ahora');

  {
    const { answer, control } = await route(message('/hunt', { at: NOW - 2000 }));
    ok('1. /hunt nuevo ejecuta exactamente una vez',
      control.calls.start === 1 && answer.text === '🚀 Hunt iniciado.');
  }

  {
    // El caso real: mandado anoche, con la PC apagada.
    const { answer, control } = await route(message('/hunt', { at: SESSION_START - 8 * 60 * 60 * 1000 }));
    ok('2. /hunt anterior al arranque del listener NO ejecuta', control.calls.start === 0);
    ok('3. y se avisa en vez de callar', answer.text === '⚠️ Ignoré una solicitud antigua de hunt.');
    ok('4. el aviso conserva el teclado', answer.replyMarkup === C.REPLY_KEYBOARD);
  }

  {
    const { control } = await route(message(C.BUTTON_HUNT, { at: SESSION_START - 3 * 60 * 60 * 1000 }));
    ok('5. el boton "Lanzar Hunt" viejo tampoco ejecuta', control.calls.start === 0);
  }

  {
    const { control } = await route(message(C.BUTTON_HUNT, { at: NOW - 3000 }));
    ok('6. el boton reciente si ejecuta', control.calls.start === 1);
  }

  {
    // Cola larga con el listener ya vivo: pasa el corte de sesion pero no el de edad.
    const { answer, control } = await route(message('/hunt', { at: NOW - 30 * 60 * 1000 }), { sessionStartedAt: NOW - 60 * 60 * 1000 });
    ok('7. un /hunt retenido 30 min tampoco ejecuta',
      control.calls.start === 0 && answer.text === '⚠️ Ignoré una solicitud antigua de hunt.');
  }

  {
    const { control } = await route(message('/hunt', { at: NOW - 9 * 60 * 1000 }), { sessionStartedAt: NOW - 60 * 60 * 1000 });
    ok('8. dentro de la ventana de 10 min si ejecuta', control.calls.start === 1);
  }

  {
    // Reloj de la PC adelantado respecto al de Telegram.
    const { control } = await route(message('/hunt', { at: SESSION_START - 20 * 1000 }));
    ok('9. una desviacion de reloj de 20s no bloquea un comando legitimo', control.calls.start === 1);
  }

  {
    const { control } = await route(message('/hunt', { date: null }));
    ok('10. sin fecha utilizable NO se ejecuta (ante la duda, no)', control.calls.start === 0);
  }

  section('Consultas: no necesitan frescura');

  {
    const { answer, control } = await route(message('/status', { at: SESSION_START - 12 * 60 * 60 * 1000 }));
    ok('11. /status viejo sigue respondiendo', answer.text.startsWith('🟢 Job Hunter disponible') && control.calls.status === 1);
  }

  {
    const { answer } = await route(message('/start', { at: SESSION_START - 12 * 60 * 60 * 1000 }));
    ok('12. /start viejo sigue respondiendo', answer.text.startsWith('🤖 Job Hunter conectado.'));
  }

  section('La frescura no debilita la autorizacion');

  {
    const { answer, control } = await route(message('/hunt', { fromId: '9999', at: NOW - 1000 }));
    ok('13. un usuario no autorizado sigue bloqueado',
      answer.text === '⛔ No autorizado.' && control.calls.start === 0);
  }

  {
    const { answer, control } = await route(message('/hunt', { chatType: 'group', at: NOW - 1000 }));
    ok('14. un grupo sigue sin respuesta y sin ejecucion', answer === null && control.calls.start === 0);
  }

  {
    const texts = Object.values(C.TEXTS).join(' ');
    ok('15. el aviso de comando viejo no revela nada sensible',
      !/token|\.env|OPENAI|ntfy|topic|C:\\|http/i.test(C.TEXTS.staleAction) && texts.includes('antigua'));
  }

  section('Politica: reglas puras');

  ok('16. isFreshAction exige fecha, sesion y ventana',
    C.isFreshAction({ date: Math.floor((NOW - 1000) / 1000) }, { now: NOW, sessionStartedAt: SESSION_START }) === true
    && C.isFreshAction({ date: Math.floor((SESSION_START - 3600_000) / 1000) }, { now: NOW, sessionStartedAt: SESSION_START }) === false
    && C.isFreshAction({}, { now: NOW, sessionStartedAt: SESSION_START }) === false);

  ok('17. solo /hunt es comando de accion',
    C.ACTION_COMMANDS.has('hunt') && !C.ACTION_COMMANDS.has('status') && !C.ACTION_COMMANDS.has('start'));

  section('Integracion con el listener');

  function api(pages) {
    const requests = []; const sent = []; let i = 0;
    return { requests, sent,
      getUpdates: async (p, o) => {
        requests.push(p);
        const page = pages[i]; i += 1;
        if (page === undefined) return new Promise((_, reject) => {
          const s = o && o.signal;
          if (s) s.addEventListener('abort', () => reject(new Error('stop')), { once: true });
        });
        return page;
      },
      sendMessage: async (p) => { sent.push(p); return {}; } };
  }

  {
    // Reinicio con offset persistido y un /hunt de anoche todavia en cola:
    // era exactamente el agujero que quedaba abierto.
    const stale = message('/hunt', { at: NOW - 9 * 60 * 60 * 1000, updateId: 500 });
    const a = api([[stale]]);
    const control = huntControl();
    const listener = createListener({
      api: a, huntControl: control, allowedUserId: ALLOWED,
      initialOffset: 500, persistOffset: () => {},
      now: () => NOW, sessionStartedAt: NOW,
    });
    await listener.pollOnce();
    ok('18. con offset persistido, el /hunt de anoche YA NO se ejecuta', control.calls.start === 0);
    ok('19. y se contesta avisando', a.sent.length === 1 && a.sent[0].text === '⚠️ Ignoré una solicitud antigua de hunt.');
    ok('20. el offset avanza igual: no se reprocesa en el siguiente arranque', listener.offset === 501);
  }

  {
    const fresh = message('/hunt', { at: NOW - 2000, updateId: 600 });
    const a = api([[fresh]]);
    const control = huntControl();
    const listener = createListener({
      api: a, huntControl: control, allowedUserId: ALLOWED,
      initialOffset: 600, persistOffset: () => {},
      now: () => NOW, sessionStartedAt: NOW - 60 * 1000,
    });
    await listener.pollOnce();
    ok('21. un /hunt recien enviado sigue ejecutandose tras un reinicio', control.calls.start === 1);
  }

  {
    const listener = createListener({
      api: api([[]]), huntControl: huntControl(), allowedUserId: ALLOWED,
      initialOffset: 0, now: () => NOW,
    });
    ok('22. el listener registra su arranque de sesion', listener.sessionStartedAt === NOW);
  }

  {
    // Sin duplicados: el mismo update no se ejecuta dos veces aunque llegue otra vez.
    const fresh = message('/hunt', { at: NOW - 1000, updateId: 700 });
    const a = api([[fresh], [fresh]]);
    const control = huntControl();
    const listener = createListener({
      api: a, huntControl: control, allowedUserId: ALLOWED,
      initialOffset: 700, persistOffset: () => {}, now: () => NOW, sessionStartedAt: NOW - 60 * 1000,
    });
    await listener.pollOnce();
    await listener.pollOnce();
    ok('23. el reenvio del mismo update sigue sin duplicar el hunt', control.calls.start === 1);
  }

  section('La ventana de frescura sobrevive a un restart');

  // El listener se REHACE cada vez que cambia la configuracion de Telegram
  // (validar token, vincular cuenta, activar/desactivar). Si la ventana naciera
  // con cada listener, guardar Ajustes convertiria en "antigua" una orden que
  // la usuaria acababa de mandar. La ventana pertenece a la instalacion.

  const SERVICE_START = NOW - 3 * 60 * 60 * 1000; // Job Hunter lleva 3h abierto
  const TOKEN = '123456:AAeFGhIjKlMnOpQrStUvWxYz0123456789a';
  const LINKED = {
    enabled: true, allowedUserId: ALLOWED,
    account: { displayName: 'Mariana', username: 'mariana' },
    bot: { id: '99', username: 'mi_bot' },
  };

  function serviceHarness(over) {
    const o = over || {};
    let config = { telegram: JSON.parse(JSON.stringify(o.telegram || LINKED)) };
    let token = o.token === undefined ? TOKEN : o.token;
    let offset = o.offset === undefined ? null : o.offset;
    const events = { created: 0, running: 0, options: [], offsets: [] };
    const service = S.createTelegramService({
      huntRunManager: { start: async () => ({ runId: 'r' }), getStatus: () => ({ status: 'IDLE', progress: {} }) },
      clock: () => (o.clock ? o.clock() : NOW),
      sessionStartedAt: o.sessionStartedAt === undefined ? SERVICE_START : o.sessionStartedAt,
      log: () => {},
      readConfig: () => JSON.parse(JSON.stringify(config)),
      saveConfig: (next) => { config = next; return next; },
      secretStore: {
        readToken: () => token,
        isConfigured: () => !!token,
        saveToken: (value) => { token = value; return { tokenConfigured: true }; },
      },
      stateStore: {
        getNextUpdateId: () => offset,
        setNextUpdateId: (value) => { offset = value; events.offsets.push(value); return true; },
        clear: () => { offset = null; return true; },
      },
      createApi: () => ({
        getMe: async () => ({ id: 99, username: 'mi_bot', first_name: 'Mi Bot' }),
        getUpdates: async () => [],
        sendMessage: async () => ({}),
      }),
      createListener: (opts) => {
        events.created += 1;
        events.running += 1;
        events.options.push(opts);
        let stopped = false;
        let release = null;
        return {
          run: () => new Promise((resolve) => { if (stopped) return resolve(); release = resolve; }),
          stop: () => { stopped = true; events.running -= 1; if (release) release(); },
        };
      },
    });
    return { service, events, offset: () => offset };
  }

  {
    const h = serviceHarness();
    h.service.start();
    await h.service.restart();
    ok('24. un restart crea un listener nuevo, no dos vivos a la vez',
      h.events.created === 2 && h.events.running === 1);
    ok('25. y los dos reciben LA MISMA ventana de frescura',
      h.events.options[0].sessionStartedAt === SERVICE_START
      && h.events.options[1].sessionStartedAt === SERVICE_START,
      JSON.stringify(h.events.options.map((o) => o.sessionStartedAt)));
  }

  {
    // El caso real: /hunt hace 30 s, Ajustes guardado hace 10 s.
    const h = serviceHarness();
    h.service.start();
    await h.service.restart();
    const opts = h.events.options[1];
    const sentJustBefore = message('/hunt', { at: NOW - 30 * 1000 });
    const { control } = await route(sentJustBefore, { sessionStartedAt: opts.sessionStartedAt, now: NOW });
    ok('26. un /hunt enviado justo antes de guardar Ajustes SIGUE valiendo',
      control.calls.start === 1);
  }

  {
    // Y lo que era viejo sigue siendo viejo: la ventana no se ablanda.
    const h = serviceHarness();
    h.service.start();
    await h.service.restart();
    const opts = h.events.options[1];
    const lastNight = message('/hunt', { at: SERVICE_START - 6 * 60 * 60 * 1000 });
    const { answer, control } = await route(lastNight, { sessionStartedAt: opts.sessionStartedAt, now: NOW });
    ok('27. un /hunt anterior a abrir Job Hunter sigue rechazandose',
      control.calls.start === 0 && answer.text === C.TEXTS.staleAction);

    // Tambien el que es posterior al arranque pero lleva horas en la cola.
    const queued = message('/hunt', { at: NOW - 45 * 60 * 1000 });
    const queuedResult = await route(queued, { sessionStartedAt: opts.sessionStartedAt, now: NOW });
    ok('28. y uno retenido 45 min tampoco pasa por ser posterior al arranque',
      queuedResult.control.calls.start === 0);
  }

  {
    // Un restart no puede rebobinar el offset ni reprocesar lo confirmado.
    const h = serviceHarness({ offset: 900 });
    h.service.start();
    await h.service.restart();
    ok('29. el restart reutiliza el offset persistido, no lo rebobina',
      h.events.options[0].initialOffset === 900 && h.events.options[1].initialOffset === 900);
  }

  {
    // Sin offset persistido el listener sigue naciendo "sin cebar": es lo que
    // dispara el descarte del backlog en el primer poll.
    const h = serviceHarness({ offset: null });
    h.service.start();
    ok('30. arranque en frio: el listener nace sin offset', h.events.options[0].initialOffset === null);
  }

  {
    // Y el descarte de backlog en frio, sobre el listener REAL.
    const backlog = message('/hunt', { at: NOW - 9 * 60 * 60 * 1000, updateId: 800 });
    const a = api([[backlog], []]);
    const control = huntControl();
    const listener = createListener({
      api: a, huntControl: control, allowedUserId: ALLOWED,
      persistOffset: () => {}, now: () => NOW, sessionStartedAt: SERVICE_START,
    });
    await listener.pollOnce();
    ok('31. arranque en frio: el backlog se salta sin ejecutarlo ni contestarlo',
      control.calls.start === 0 && a.sent.length === 0 && listener.offset === 801);
  }

  {
    // Un servicio recien creado toma "ahora" como origen de la ventana, que es
    // exactamente el corte que protege el encendido de la PC.
    const h = serviceHarness({ sessionStartedAt: null });
    h.service.start();
    ok('32. sin ventana inyectada, el servicio usa su propio arranque',
      h.events.options[0].sessionStartedAt === NOW, String(h.events.options[0].sessionStartedAt));
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : 'FAILURES'} (${passed} passed, ${failed} failed) ===`);
  if (failed) process.exitCode = 1;
})();

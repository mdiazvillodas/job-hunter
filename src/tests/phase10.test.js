'use strict';

// Phase 10 — nucleo de Telegram: cliente de la Bot API, autorizacion, router
// de comandos, adaptador de hunt y listener de long polling.
// NINGUN test toca la red real: fetch y huntRunManager se inyectan siempre.
// Ejecutar: node src/tests/phase10.test.js

const { createTelegramApi, redactToken, TelegramApiError } = require('../telegram/api');
const C = require('../telegram/commands');
const { createHuntControl } = require('../telegram/huntControl');
const { createListener } = require('../telegram/listener');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n### ${t}`); }

const TOKEN = '123456789:AAHrandomlookingsecretvalue_abcdefghij';
const ALLOWED = '4242';

let nextUpdateId = 1000;
function privateMessage(text, fromId = ALLOWED, updateId) {
  const id = Number.isInteger(updateId) ? updateId : (nextUpdateId += 1);
  return { update_id: id, message: { message_id: id, text, from: { id: Number(fromId), first_name: 'Mariana' }, chat: { id: 555, type: 'private' } } };
}
function groupMessage(text, chatType = 'group', updateId) {
  const id = Number.isInteger(updateId) ? updateId : (nextUpdateId += 1);
  return { update_id: id, message: { message_id: id, text, from: { id: Number(ALLOWED) }, chat: { id: -100, type: chatType } } };
}

function fakeHuntControl(over) {
  const o = over || {};
  const calls = { start: 0, status: 0 };
  return {
    calls,
    startHunt: async () => { calls.start += 1; return o.start || { result: 'started', runId: 'run_1' }; },
    getStatus: () => { calls.status += 1; return o.status || { available: true, huntRunning: false, analyzed: null, target: null }; },
  };
}

async function handle(update, over) {
  const huntControl = (over && over.huntControl) || fakeHuntControl(over);
  const allowedUserId = over && 'allowedUserId' in over ? over.allowedUserId : ALLOWED;
  const answer = await C.handleUpdate(update, { huntControl, allowedUserId });
  return { answer, huntControl };
}

/* ------------------------------------------------------------------ */
section('Cliente de la Bot API: el token nunca sale');

ok('1. redactToken saca el token de cualquier texto',
  redactToken(`fallo en https://api.telegram.org/bot${TOKEN}/getMe`, TOKEN).includes('[token]')
  && !redactToken(`x ${TOKEN} y`, TOKEN).includes(TOKEN));

ok('2. redactToken tambien limpia un token que no es el propio',
  !redactToken('/bot999999:OTROTOKENsecretovalor_abcdefghijkl/getMe').includes('OTROTOKEN'));

ok('3. crear la api sin token falla explicitamente',
  (() => { try { createTelegramApi({}); return false; } catch (_) { return true; } })());

async function apiTransportChecks() {
  section('Cliente de la Bot API: transporte');
  {
    const calls = [];
    const api = createTelegramApi({
      token: TOKEN,
      fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ ok: true, result: { id: 7, username: 'mi_bot' } }) }; },
    });
    const me = await api.getMe();
    ok('3a. la api devuelve el result y manda el token en la URL, no en el body',
      me.username === 'mi_bot' && calls[0].url.includes(TOKEN) && !String(calls[0].init.body).includes(TOKEN));
  }

  {
    const api = createTelegramApi({
      token: TOKEN,
      fetch: async () => { throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getUpdates`); },
    });
    let error = null;
    try { await api.getUpdates({}); } catch (err) { error = err; }
    ok('3b. un error de red nunca expone el token y es reintentable',
      error && error.network === true && !error.message.includes(TOKEN) && error.message.includes('[token]'), error && error.message);
  }

  {
    const api = createTelegramApi({
      token: TOKEN,
      fetch: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error_code: 401, description: `Unauthorized for ${TOKEN}` }) }),
    });
    let error = null;
    try { await api.getMe(); } catch (err) { error = err; }
    ok('3c. un error de Telegram propaga la descripcion sin el token',
      error && error.errorCode === 401 && !error.message.includes(TOKEN) && error.message.includes('Unauthorized'), error && error.message);
  }

  {
    const api = createTelegramApi({
      token: TOKEN,
      fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }),
    });
    let error = null;
    try { await api.getMe(); } catch (err) { error = err; }
    ok('3d. una respuesta no-JSON se clasifica sin filtrar nada',
      error && error.name === 'TelegramApiError' && !error.message.includes(TOKEN));
  }
}

/* ------------------------------------------------------------------ */
section('Autorizacion');

ok('4. autoriza al usuario configurado en chat privado',
  C.authorize(privateMessage('/hunt').message, ALLOWED).allowed === true);

ok('5. rechaza a otro usuario aunque escriba en privado',
  C.authorize(privateMessage('/hunt', '9999').message, ALLOWED).reason === 'forbidden_user');

ok('6. rechaza grupos, supergrupos y canales incluso desde el usuario autorizado',
  ['group', 'supergroup', 'channel'].every((t) => C.authorize(groupMessage('/hunt', t).message, ALLOWED).reason === 'not_private'));

ok('7. sin cuenta vinculada no hay usuario autorizado',
  C.authorize(privateMessage('/hunt').message, null).reason === 'not_configured'
  && C.authorize(privateMessage('/hunt').message, '').reason === 'not_configured');

ok('8. la autorizacion mira from.id, no chat.id',
  C.authorize({ chat: { id: Number(ALLOWED), type: 'private' }, from: { id: 9999 } }, ALLOWED).allowed === false);

ok('9. parseAllowedUserId solo acepta un id numerico',
  C.parseAllowedUserId('4242') === '4242' && C.parseAllowedUserId(' 4242 ') === '4242'
  && C.parseAllowedUserId('# comentario') === null && C.parseAllowedUserId(undefined) === null);

/* ------------------------------------------------------------------ */
section('Comandos y botones');

ok('10. parseCommand entiende comandos, menciones al bot y botones',
  C.parseCommand('/hunt') === 'hunt' && C.parseCommand('/hunt@MiBot') === 'hunt'
  && C.parseCommand(' /STATUS ') === 'status' && C.parseCommand('/start') === 'start'
  && C.parseCommand(C.BUTTON_HUNT) === 'hunt' && C.parseCommand(C.BUTTON_STATUS) === 'status'
  && C.parseCommand('/borrar_todo') === null && C.parseCommand('hola') === null);

ok('11. el teclado ofrece exactamente los dos botones',
  C.REPLY_KEYBOARD.keyboard.length === 1 && C.REPLY_KEYBOARD.keyboard[0].length === 2
  && C.REPLY_KEYBOARD.keyboard[0][0].text === '🔎 Lanzar Hunt'
  && C.REPLY_KEYBOARD.keyboard[0][1].text === '📊 Estado');

(async () => {
  await apiTransportChecks();

  {
    const { answer } = await handle(privateMessage('/start'));
    ok('12. /start responde con el saludo probado y el teclado',
      answer.text === '🤖 Job Hunter conectado.\n\nUsá /hunt para iniciar una búsqueda.\nUsá /status para consultar el estado.'
      && answer.replyMarkup === C.REPLY_KEYBOARD && answer.chatId === 555, JSON.stringify(answer));
  }

  {
    const { answer, huntControl } = await handle(privateMessage('/hunt'));
    ok('13. /hunt autorizado inicia el hunt y confirma',
      answer.text === '🚀 Hunt iniciado.' && huntControl.calls.start === 1);
  }

  {
    const { answer, huntControl } = await handle(privateMessage(C.BUTTON_HUNT));
    ok('14. el boton Lanzar Hunt hace exactamente lo mismo que /hunt',
      answer.text === '🚀 Hunt iniciado.' && huntControl.calls.start === 1);
  }

  {
    const { answer, huntControl } = await handle(privateMessage(C.BUTTON_STATUS));
    ok('15. el boton Estado hace exactamente lo mismo que /status',
      answer.text.startsWith('🟢 Job Hunter disponible') && huntControl.calls.status === 1);
  }

  {
    const { answer, huntControl } = await handle(privateMessage('/hunt'), { start: { result: 'already_running' } });
    ok('16. /hunt con un hunt en curso avisa sin iniciar otro',
      answer.text === '⏳ Ya hay un hunt ejecutándose.' && huntControl.calls.start === 1);
  }

  {
    const { answer } = await handle(privateMessage('/hunt'), { start: { result: 'error' } });
    ok('17. un error local no se explica por Telegram', answer.text === '❌ No pude iniciar el hunt.');
  }

  /* --------------------------------------------------------------- */
  section('Motivos propios del producto instalable (mapa fijo D1)');

  const blockedCases = [
    ['LOGIN_REQUIRED', '🔐 Necesitás iniciar sesión en LinkedIn en la PC.'],
    ['CHECKPOINT_REQUIRED', '🔐 LinkedIn pide una verificación manual en la PC.'],
    ['SESSION_WINDOW_OPEN', '⚠️ Cerrá la ventana de LinkedIn abierta en la PC.'],
    ['SETUP_REQUIRED', '⚙️ Job Hunter todavía no está configurado.'],
    ['APP_SHUTTING_DOWN', '❌ No pude contactar al Job Hunter en esta PC.'],
  ];
  for (const [code, expected] of blockedCases) {
    const { answer } = await handle(privateMessage('/hunt'), { start: { result: 'blocked', code } });
    ok(`18.${code} responde con su texto fijo`, answer.text === expected, answer.text);
  }

  {
    const { answer } = await handle(privateMessage('/hunt'), { start: { result: 'blocked', code: 'ALGO_NUEVO' } });
    ok('19. un motivo desconocido cae en la negativa generica', answer.text === '❌ No pude iniciar el hunt.');
  }

  /* --------------------------------------------------------------- */
  section('/status y progreso');

  {
    const { answer } = await handle(privateMessage('/status'), { status: { available: true, huntRunning: false } });
    ok('20. /status inactivo', answer.text === '🟢 Job Hunter disponible\nHunt: inactivo');
  }

  {
    const { answer } = await handle(privateMessage('/status'), { status: { available: true, huntRunning: true, analyzed: 12, target: 20 } });
    ok('21. /status ejecutandose muestra el progreso real',
      answer.text === '🟢 Job Hunter disponible\nHunt: ejecutándose\nAnalizadas: 12/20', JSON.stringify(answer.text));
  }

  {
    const { answer } = await handle(privateMessage('/status'), { status: { available: true, huntRunning: true, analyzed: null, target: 20 } });
    ok('22. sin progreso real la linea se omite, no se inventa',
      answer.text === '🟢 Job Hunter disponible\nHunt: ejecutándose');
  }

  {
    const { answer } = await handle(privateMessage('/status'), { status: { available: true, huntRunning: true, analyzed: 3, target: 0 } });
    ok('23. un objetivo sin sentido no produce una linea absurda',
      answer.text === '🟢 Job Hunter disponible\nHunt: ejecutándose');
  }

  {
    const { answer } = await handle(privateMessage('/status'), { status: { available: false, huntRunning: false } });
    ok('24. /status con el producto no disponible', answer.text === '🔴 Job Hunter no disponible');
  }

  /* --------------------------------------------------------------- */
  section('Rechazos y silencio');

  {
    const { answer, huntControl } = await handle(privateMessage('/hunt', '9999'));
    ok('25. un usuario no autorizado recibe el rechazo y no ejecuta nada',
      answer.text === '⛔ No autorizado.' && huntControl.calls.start === 0);
    ok('26. el rechazo no revela ids ni configuracion',
      !answer.text.includes(ALLOWED) && !answer.text.includes('9999') && answer.replyMarkup === undefined);
  }

  {
    const { answer, huntControl } = await handle(privateMessage('/hunt'), { allowedUserId: null });
    ok('27. sin cuenta vinculada nadie ejecuta nada',
      answer.text === '⛔ No autorizado.' && huntControl.calls.start === 0);
  }

  for (const chatType of ['group', 'supergroup', 'channel']) {
    const { answer, huntControl } = await handle(groupMessage('/hunt', chatType));
    ok(`28.${chatType} el bot no responde NADA y no ejecuta nada`,
      answer === null && huntControl.calls.start === 0);
  }

  {
    const { answer, huntControl } = await handle(privateMessage('borrame la base de datos'));
    ok('29. un texto desconocido no ejecuta comandos',
      answer.text === 'No entendí. Comandos: /start, /hunt, /status' && huntControl.calls.start === 0);
  }

  {
    const results = await Promise.all([
      handle({ update_id: 3, message: { chat: { id: 1, type: 'private' }, from: { id: Number(ALLOWED) }, photo: [{}] } }),
      handle({ update_id: 4, edited_message: { text: '/hunt', chat: { id: 1, type: 'private' }, from: { id: Number(ALLOWED) } } }),
      handle({ update_id: 5 }),
    ]);
    ok('30. los updates que no son mensajes de texto se ignoran',
      results.every((r) => r.answer === null && r.huntControl.calls.start === 0));
  }

  {
    const texts = Object.values(C.TEXTS).concat(Object.values(C.BLOCKED_TEXTS)).join(' ');
    ok('31. ningun texto del bot menciona token, rutas, entorno ni topics',
      !/token|\.env|OPENAI|ntfy|topic|C:\\|stack|http/i.test(texts), texts.slice(0, 120));
  }

  /* --------------------------------------------------------------- */
  section('Adaptador del hunt: una sola autoridad');

  function fakeManager(over) {
    const o = over || {};
    const calls = { start: 0 };
    return {
      calls,
      start: async () => { calls.start += 1; if (o.startError) throw o.startError; return { runId: 'run_z' }; },
      getStatus: () => { if (o.statusError) throw o.statusError; return o.status || { status: 'IDLE', progress: {} }; },
    };
  }
  function operational(code) { const e = new Error('mensaje interno que no debe viajar'); e.code = code; return e; }

  {
    const manager = fakeManager();
    const control = createHuntControl({ huntRunManager: manager });
    const outcome = await control.startHunt();
    ok('32. iniciar un hunt llama al MISMO huntRunManager', outcome.result === 'started' && manager.calls.start === 1);
  }

  {
    const control = createHuntControl({ huntRunManager: fakeManager({ startError: operational('HUNT_ALREADY_RUNNING') }) });
    ok('33. un hunt en curso se traduce a already_running', (await control.startHunt()).result === 'already_running');
  }

  for (const code of ['SETUP_REQUIRED', 'LOGIN_REQUIRED', 'CHECKPOINT_REQUIRED', 'SESSION_WINDOW_OPEN', 'APP_SHUTTING_DOWN']) {
    const control = createHuntControl({ huntRunManager: fakeManager({ startError: operational(code) }) });
    const outcome = await control.startHunt();
    ok(`34.${code} se traduce a blocked con su codigo`, outcome.result === 'blocked' && outcome.code === code);
  }

  {
    const control = createHuntControl({ huntRunManager: fakeManager({ startError: new Error('ENOENT C:\\dev\\secreto') }) });
    const outcome = await control.startHunt();
    ok('35. un error inesperado no filtra su mensaje',
      outcome.result === 'error' && !JSON.stringify(outcome).includes('secreto'), JSON.stringify(outcome));
  }

  {
    const control = createHuntControl({ huntRunManager: fakeManager({ status: { status: 'RUNNING', progress: { analysisCompleted: 7, analysisTarget: 20 } } }) });
    const status = control.getStatus();
    ok('36. el estado sale de la misma autoridad, con progreso real',
      status.available && status.huntRunning && status.analyzed === 7 && status.target === 20, JSON.stringify(status));
  }

  {
    const control = createHuntControl({ huntRunManager: fakeManager({ status: { status: 'STARTING', progress: {} } }) });
    ok('37. un hunt arrancando ya cuenta como ejecutandose', control.getStatus().huntRunning === true);
  }

  {
    const control = createHuntControl({ huntRunManager: fakeManager({ status: { status: 'COMPLETED', progress: { analysisCompleted: 20, analysisTarget: 20 } } }) });
    const status = control.getStatus();
    ok('38. terminado es inactivo y no arrastra progreso',
      status.huntRunning === false && status.analyzed === null && status.target === null);
  }

  {
    const control = createHuntControl({ huntRunManager: fakeManager({ statusError: new Error('roto') }) });
    ok('39. si la autoridad no responde, el estado es no disponible', control.getStatus().available === false);
  }

  /* --------------------------------------------------------------- */
  section('Listener: offset, duplicados y backlog');

  // Cuando se agotan las paginas la peticion queda APARCADA hasta el stop(),
  // igual que un long poll real: el loop no gira en vacio.
  function fakeApi(pages) {
    const requests = [];
    const sent = [];
    let i = 0;
    return {
      requests,
      sent,
      getUpdates: async (params, opts) => {
        requests.push(params);
        const page = pages[i];
        i += 1;
        if (page === undefined) {
          return new Promise((resolve, reject) => {
            const signal = opts && opts.signal;
            if (signal && signal.aborted) return reject(new Error('aborted'));
            if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        if (page instanceof Error) throw page;
        return page;
      },
      sendMessage: async (params) => { sent.push(params); return {}; },
    };
  }

  {
    const api = fakeApi([[privateMessage('/status', ALLOWED, 40)]]);
    const saved = [];
    const listener = createListener({
      api,
      huntControl: fakeHuntControl(),
      allowedUserId: ALLOWED,
      initialOffset: 10,
      persistOffset: (value) => saved.push(value),
    });
    await listener.pollOnce();
    ok('40. el listener avanza el offset despues de procesar', listener.offset === 41);
    ok('41. el offset avanzado se PERSISTE', saved[saved.length - 1] === 41, JSON.stringify(saved));
    ok('42. el listener usa long polling y pide solo mensajes',
      api.requests[0].timeout === 30 && JSON.stringify(api.requests[0].allowed_updates) === '["message"]'
      && api.requests[0].offset === 10);
    ok('43. responde al chat correcto con el teclado',
      api.sent.length === 1 && api.sent[0].chat_id === 555 && api.sent[0].reply_markup === C.REPLY_KEYBOARD);
  }

  {
    // Un update rezagado no puede hacer RETROCEDER el offset: retroceder seria
    // pedirle a Telegram que reenvie comandos ya ejecutados.
    const api = fakeApi([[privateMessage('/status', ALLOWED, 5)]]);
    const listener = createListener({ api, huntControl: fakeHuntControl(), allowedUserId: ALLOWED, initialOffset: 500 });
    await listener.pollOnce();
    ok('43b. el offset nunca retrocede', listener.offset === 500);
  }

  {
    const update = privateMessage('/hunt', ALLOWED, 60);
    const api = fakeApi([[update], [update]]);
    const huntControl = fakeHuntControl();
    const listener = createListener({ api, huntControl, allowedUserId: ALLOWED, initialOffset: 0 });
    await listener.pollOnce();
    await listener.pollOnce();
    ok('44. el mismo update NO se procesa dos veces aunque Telegram lo reenvie',
      huntControl.calls.start === 1, 'starts=' + huntControl.calls.start);
  }

  {
    const api = fakeApi([[groupMessage('/hunt')]]);
    const huntControl = fakeHuntControl();
    const listener = createListener({ api, huntControl, allowedUserId: ALLOWED, initialOffset: 0 });
    await listener.pollOnce();
    ok('45. el listener no responde nada a un grupo', api.sent.length === 0 && huntControl.calls.start === 0);
  }

  {
    const api = fakeApi([[{ update_id: 70, message: null }, privateMessage('/status', ALLOWED, 71)]]);
    const listener = createListener({ api, huntControl: fakeHuntControl(), allowedUserId: ALLOWED, initialOffset: 0 });
    await listener.pollOnce();
    ok('46. un update envenenado no bloquea la cola', api.sent.length === 1 && listener.offset === 72);
  }

  {
    const api = fakeApi([[privateMessage('/status', ALLOWED, 80)]]);
    api.sendMessage = async () => { throw new Error('fallo al responder'); };
    const listener = createListener({ api, huntControl: fakeHuntControl(), allowedUserId: ALLOWED, initialOffset: 0 });
    let threw = false;
    try { await listener.pollOnce(); } catch (_) { threw = true; }
    ok('47. un fallo al responder no tumba el listener', !threw && listener.offset === 81);
  }

  {
    // Arranque en frio: hay backlog viejo con un /hunt que NO debe ejecutarse.
    const api = fakeApi([[privateMessage('/hunt', ALLOWED, 99)], []]);
    const huntControl = fakeHuntControl();
    const saved = [];
    const listener = createListener({ api, huntControl, allowedUserId: ALLOWED, persistOffset: (v) => saved.push(v) });
    await listener.pollOnce();
    ok('48. arranque en frio: el backlog se descarta sin ejecutarlo',
      huntControl.calls.start === 0 && api.sent.length === 0, 'starts=' + huntControl.calls.start);
    ok('49. el primer sondeo pide solo el ultimo update', api.requests[0].offset === -1 && api.requests[0].timeout === 0);
    ok('50. y el offset queda mas alla del backlog', listener.offset === 100 && saved[0] === 100);
    await listener.pollOnce();
    ok('51. el sondeo siguiente ya usa el offset persistido', api.requests[1].offset === 100);
  }

  {
    const api = fakeApi([[], [privateMessage('/status')]]);
    const listener = createListener({ api, huntControl: fakeHuntControl(), allowedUserId: ALLOWED });
    await listener.pollOnce();
    ok('52. sin backlog el arranque en frio no inventa un offset', listener.offset === null);
    await listener.pollOnce();
    ok('53. y los mensajes nuevos si se procesan', api.sent.length === 1);
  }

  {
    const api = fakeApi([[privateMessage('/status', ALLOWED, 90)]]);
    const listener = createListener({
      api,
      huntControl: fakeHuntControl(),
      allowedUserId: ALLOWED,
      initialOffset: 0,
      persistOffset: () => { throw new Error('disco lleno'); },
    });
    let threw = false;
    try { await listener.pollOnce(); } catch (_) { threw = true; }
    ok('54. un fallo al persistir el offset no rompe el listener', !threw && listener.offset === 91);
  }

  /* --------------------------------------------------------------- */
  section('Listener: errores de red y parada');

  {
    const waits = [];
    const api = fakeApi([
      new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET'),
      [privateMessage('/status', ALLOWED, 200)],
    ]);
    const listener = createListener({
      api,
      huntControl: fakeHuntControl(),
      allowedUserId: ALLOWED,
      initialOffset: 0,
      sleep: async (ms) => { waits.push(ms); },
    });
    const loop = listener.run();
    await loop.constructor.resolve(); // deja arrancar el loop
    // El fake aparca tras la ultima pagina: el loop se detiene solo ahi.
    while (api.sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    listener.stop();
    await loop;
    ok('55. ante errores de red reintenta con backoff exponencial',
      waits.join(',') === '1000,2000,4000', JSON.stringify(waits));
    ok('56. y se recupera solo cuando la red vuelve', api.sent.length === 1 && listener.failures === 0);
  }

  {
    // Caida permanente: se comprueba que el backoff no crece sin limite.
    const waits = [];
    let listener;
    listener = createListener({
      api: { getUpdates: async () => { throw new Error('caida permanente'); }, sendMessage: async () => ({}) },
      huntControl: fakeHuntControl(),
      allowedUserId: ALLOWED,
      initialOffset: 0,
      maxBackoffMs: 5000,
      sleep: async (ms) => { waits.push(ms); if (waits.length >= 8) listener.stop(); },
    });
    await listener.run();
    ok('57. el backoff tiene techo',
      Math.max(...waits) === 5000 && waits[waits.length - 1] === 5000, JSON.stringify(waits));
    ok('58. una caida de Telegram no deja el listener girando en vacio', listener.running === false);
  }

  {
    const logs = [];
    let listener;
    listener = createListener({
      api: {
        getUpdates: async () => { throw new TelegramApiError(redactToken(`401 en /bot${TOKEN}/getUpdates`, TOKEN)); },
        sendMessage: async () => ({}),
      },
      huntControl: fakeHuntControl(),
      allowedUserId: ALLOWED,
      initialOffset: 0,
      sleep: async () => { listener.stop(); },
      log: (m) => logs.push(m),
    });
    await listener.run();
    ok('59. los logs del listener no contienen el token',
      logs.length > 0 && !logs.join(' ').includes(TOKEN) && logs.join(' ').includes('[token]'), logs[0]);
  }

  {
    const listener = createListener({
      api: { getUpdates: async () => [], sendMessage: async () => ({}) },
      huntControl: fakeHuntControl(),
      allowedUserId: ALLOWED,
      initialOffset: 0,
    });
    const loop = listener.run();
    listener.stop();
    let threw = false;
    try { await loop; } catch (_) { threw = true; }
    ok('60. stop corta el loop sin lanzar', !threw && listener.running === false);
  }

  console.log(`\n=== RESULT: ${failed === 0 ? 'ALL PASS' : 'FAILURES'} (${passed} passed, ${failed} failed) ===`);
  if (failed) process.exitCode = 1;
})();

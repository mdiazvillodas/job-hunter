'use strict';
(()=>{
 const host=document.getElementById('settingsForm');if(!host)return;
 const section=document.createElement('section');section.className='account-card notification-card';
 section.innerHTML=`<p class="eyebrow">CONECTÁ TU MÓVIL</p><h2>Avisos y control remoto</h2><p>Configuración propia de esta instancia. No se comparten destinos ni tokens con otra persona.</p>
 <div class="notification-block"><h3>Notificaciones con ntfy</h3><p>Recibí avisos de oportunidades destacadas y del resultado de las búsquedas.</p>
 <label class="toggle-row"><input id="ntfyEnabled" type="checkbox"> Activar avisos de ntfy</label>
 <div class="form-row"><div><label for="ntfyTopic">Topic</label><input id="ntfyTopic" autocomplete="off" placeholder="Un nombre largo y difícil de adivinar"></div><div><label for="ntfyThreshold">Avisar desde un puntaje de</label><input id="ntfyThreshold" type="number" min="50" max="100" value="90"></div></div>
 <p class="field-help">Instalá la app ntfy y suscribite al mismo topic. Cualquiera que conozca ese nombre puede recibir los avisos. Este puntaje solo controla avisos; no cambia la evaluación de las ofertas.</p>
 <details class="notification-advanced"><summary>Servidor de ntfy</summary><label for="ntfyBaseUrl">Dirección HTTPS</label><input id="ntfyBaseUrl" value="https://ntfy.sh"></details>
 <div class="button-row"><button class="btn primary" type="button" id="saveNtfy">Guardar avisos</button><button class="btn" type="button" id="testNtfy">Enviar prueba</button></div><p id="ntfyStatus" role="status" aria-live="polite"></p></div>
 <div class="notification-block"><h3>Telegram</h3><p>Consultá el estado con /status e iniciá búsquedas con /hunt desde tu móvil. Una búsqueda puede consumir OpenAI según tus límites.</p>
 <p id="telegramStatus" class="connection-state" role="status" aria-live="polite">Cargando conexión…</p>
 <label for="telegramToken">1. Token de tu bot</label><input id="telegramToken" type="password" autocomplete="new-password" placeholder="Dejá vacío para conservar el token actual">
 <p class="field-help">Creá un bot en <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a>. Usá uno exclusivo para esta instancia: el bot del Hunter original debe seguir independiente. El token se guarda de forma privada y no vuelve a mostrarse.</p>
 <div class="button-row"><button class="btn" type="button" id="validateTelegram">Validar y guardar bot</button></div>
 <label>2. Vinculá tu cuenta</label><p>Enviá un mensaje privado reciente a tu bot y pulsá Detectar mi cuenta. Elegí tu nombre de la lista.</p>
 <div class="button-row"><button class="btn" type="button" id="detectTelegram">Detectar mi cuenta</button></div><div id="telegramCandidates" class="candidate-list"></div>
 <label class="toggle-row"><input id="telegramEnabled" type="checkbox"> Activar control remoto de esta instancia</label>
 <div class="button-row"><button class="btn primary" type="button" id="saveTelegram">Guardar conexión</button><button class="btn" type="button" id="testTelegram">Enviar prueba</button><button class="btn ghost" type="button" id="unlinkTelegram">Desvincular cuenta</button></div>
 <p id="telegramAction" role="status" aria-live="polite"></p></div>`;
 host.insertBefore(section,host.querySelector('.account-actions'));
 section.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.tagName==='INPUT')e.preventDefault();});
 const el=id=>document.getElementById(id);let ready=false;
 const controls=[...section.querySelectorAll('button,input')];controls.forEach(c=>c.disabled=true);
 function render(d){
  for(const k of ['ntfyTopic','ntfyBaseUrl','ntfyThreshold'])el(k).value=d[k];
  el('ntfyEnabled').checked=d.ntfyEnabled;el('telegramEnabled').checked=d.telegramEnabled;
  el('telegramToken').placeholder=d.hasTelegramToken?'Token guardado. No necesitás volver a ingresarlo.':'Pegá el token de tu bot';
  el('telegramStatus').textContent=d.telegramError|| (d.telegramRunning?'Conectado · '+(d.telegramBot?'@'+d.telegramBot:'tu bot'):d.telegramUserId?'Cuenta vinculada · control remoto desactivado':d.hasTelegramToken?'Bot guardado · falta vincular tu cuenta':'Sin configurar');
 }
 async function request(action,data={}){
  const r=await window.SessionApi.request('/api/notifications'+(action?'/'+action:''),action?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:undefined);
  const d=await r.json();if(!r.ok)throw Error(d.error||'No se pudo completar la conexión.');return d;
 }
 async function run(status,work){if(!ready)return;controls.forEach(c=>c.disabled=true);el(status).textContent='Conectando…';try{const message=await work();el(status).textContent=message||'Configuración guardada.';}catch(e){el(status).textContent=e.message;}finally{controls.forEach(c=>c.disabled=false);}}
 request().then(d=>{render(d);ready=true;controls.forEach(c=>c.disabled=false);}).catch(e=>el('telegramStatus').textContent=e.message);
 el('saveNtfy').onclick=()=>run('ntfyStatus',async()=>{await request('save',{ntfyEnabled:el('ntfyEnabled').checked,ntfyTopic:el('ntfyTopic').value,ntfyBaseUrl:el('ntfyBaseUrl').value,ntfyThreshold:Number(el('ntfyThreshold').value)});return 'Avisos guardados. Se aplican a las próximas búsquedas.';});
 el('testNtfy').onclick=()=>run('ntfyStatus',async()=>(await request('ntfy-test')).message);
 el('validateTelegram').onclick=()=>run('telegramAction',async()=>{const d=await request('token',{token:el('telegramToken').value});el('telegramToken').value='';render(d);el('telegramCandidates').replaceChildren();return 'Bot validado. Ahora vinculá tu cuenta.';});
 el('detectTelegram').onclick=()=>run('telegramAction',async()=>{
  const d=await request('detect');el('telegramCandidates').replaceChildren();
  for(const candidate of d.candidates){const b=document.createElement('button');b.type='button';b.className='btn';b.textContent='Vincular '+candidate.name;b.onclick=()=>run('telegramAction',async()=>{render(await request('link',{detectionId:d.detectionId,userId:candidate.userId}));el('telegramCandidates').replaceChildren();return 'Cuenta vinculada. Activá el control remoto cuando quieras usarlo.';});el('telegramCandidates').append(b);}
  render(await request());return d.candidates.length?'Elegí tu cuenta de la lista.':'No encontré mensajes privados recientes. Enviá uno a tu bot y volvé a detectar.';
 });
 el('saveTelegram').onclick=()=>run('telegramAction',async()=>{render(await request('enabled',{enabled:el('telegramEnabled').checked}));return el('telegramEnabled').checked?'Control remoto activado. Solo tu cuenta puede ejecutar /hunt.':'Control remoto desactivado.';});
 el('testTelegram').onclick=()=>run('telegramAction',async()=>(await request('telegram-test')).message);
 el('unlinkTelegram').onclick=()=>run('telegramAction',async()=>{render(await request('unlink'));el('telegramCandidates').replaceChildren();return 'Cuenta desvinculada y control remoto desactivado.';});
})();

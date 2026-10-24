'use strict';
// Small UI adapter around the existing Telegram API, listener and shared runner.
const path=require('node:path'),crypto=require('node:crypto');
const {createNotificationSettings}=require('./notificationSettings');
const {createTelegramApi}=require('../telegram/api');
const {createListener}=require('../telegram/bot');
const {createTelegramStateStore}=require('../telegram/state');
const {getNtfyConfig,defaultSend}=require('../notifications/ntfy');
function createNotificationAccess(options={}){
 const root=options.root||path.resolve(__dirname,'../..'),store=options.store||createNotificationSettings(root);
 const apiFor=options.apiFor||createTelegramApi,makeListener=options.makeListener||createListener;
 let listener=null,loop=null,error=null,queue=Promise.resolve(),detection=null;
 const exclusive=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
 const status=()=>({...store.view(),telegramRunning:!!listener,telegramError:error});
 async function stop(){if(listener)listener.stop();if(loop)await loop;listener=null;loop=null;}
 async function sync(){
  await stop();const e=store.read();error=null;
  if(e.TELEGRAM_ENABLED!=='true')return status();
  if(!e.TELEGRAM_BOT_TOKEN||!/^\d+$/.test(e.TELEGRAM_ALLOWED_USER_ID||''))throw Error('Validá el bot y vinculá tu cuenta antes de activar Telegram.');
  const trigger=await options.getTrigger();
  const state=createTelegramStateStore({filePath:path.join(root,'state/telegram.json')});
  listener=makeListener({api:apiFor({token:e.TELEGRAM_BOT_TOKEN}),trigger,allowedUserId:e.TELEGRAM_ALLOWED_USER_ID,initialOffset:state.getNextUpdateId(),persistOffset:state.setNextUpdateId,log:()=>{}});
  const started=listener;
  loop=listener.run().catch(()=>{error='Telegram no pudo continuar. Revisá la conexión y el token.';}).finally(()=>{if(listener===started)listener=null;});
  return status();
 }
 async function action(kind,d={}){
  if(kind==='save')return store.save(d);
  if(kind==='ntfy-test'){
   const c=getNtfyConfig(store.read());if(!c.enabled||c.configError)throw Error('Guardá y activá una configuración válida de ntfy.');
   await (options.sendNtfy||defaultSend)(c.url,{title:'Job Hunter',body:'La conexión de notificaciones funciona.',priority:'default'});return {message:'Aviso de prueba enviado.'};
  }
  if(kind==='token'){
   const token=String(d.token||'').trim();if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token))throw Error('El token de Telegram no tiene un formato válido.');
   const me=await apiFor({token}).getMe();await stop();
   store.write({TELEGRAM_BOT_TOKEN:token,TELEGRAM_BOT_USERNAME:me.username||'',TELEGRAM_ALLOWED_USER_ID:'',TELEGRAM_ENABLED:false});detection=null;
   createTelegramStateStore({filePath:path.join(root,'state/telegram.json')}).clear();
   return status();
  }
  if(kind==='detect'){
   await stop();const e=store.read();if(!e.TELEGRAM_BOT_TOKEN)throw Error('Primero validá el bot.');
   store.write({TELEGRAM_ENABLED:false});
   const updates=await apiFor({token:e.TELEGRAM_BOT_TOKEN}).getUpdates({timeout:0,allowed_updates:['message']});
   const candidates=new Map();for(const u of updates||[]){const m=u.message;if(m?.chat?.type==='private'&&m.from?.id&&m.date*1000>=Date.now()-600000)candidates.set(String(m.from.id),{userId:String(m.from.id),name:[m.from.first_name,m.from.last_name].filter(Boolean).join(' ')||m.from.username||'Cuenta de Telegram'});}
   detection={id:crypto.randomBytes(16).toString('hex'),expires:Date.now()+600000,ids:new Set(candidates.keys())};
   return {detectionId:detection.id,candidates:[...candidates.values()]};
  }
  if(kind==='link'){
   if(!detection||detection.expires<Date.now()||detection.id!==d.detectionId||!detection.ids.has(String(d.userId)))throw Error('Detectá de nuevo tu cuenta y elegila de la lista.');
   store.write({TELEGRAM_ALLOWED_USER_ID:String(d.userId),TELEGRAM_ENABLED:false});detection=null;return status();
  }
  if(kind==='enabled'){
   if(typeof d.enabled!=='boolean')throw Error('Estado de Telegram inválido.');
   const e=store.read();if(d.enabled&&(!e.TELEGRAM_BOT_TOKEN||!/^\d+$/.test(e.TELEGRAM_ALLOWED_USER_ID||'')))throw Error('Validá el bot y vinculá tu cuenta primero.');
   store.write({TELEGRAM_ENABLED:d.enabled});return sync();
  }
  if(kind==='unlink'){await stop();store.write({TELEGRAM_ENABLED:false,TELEGRAM_ALLOWED_USER_ID:''});detection=null;return status();}
  if(kind==='telegram-test'){
   const e=store.read();if(!e.TELEGRAM_BOT_TOKEN||!e.TELEGRAM_ALLOWED_USER_ID)throw Error('Primero vinculá una cuenta.');
   await apiFor({token:e.TELEGRAM_BOT_TOKEN}).sendMessage({chat_id:e.TELEGRAM_ALLOWED_USER_ID,text:'Job Hunter conectado a tu instancia. Usá /status para consultar el estado.'});return {message:'Mensaje de prueba enviado.'};
  }
  throw Error('Acción no disponible.');
 }
 const send=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 async function handle(req,res,url,readBody){
  if(!url.pathname.startsWith('/api/notifications'))return false;
  if(req.method==='GET'&&url.pathname==='/api/notifications'){send(res,200,status());return true;}
  if(req.method!=='POST'){send(res,405,{error:'Método no permitido'});return true;}
  if(req.headers.origin!=='http://'+req.headers.host){send(res,403,{error:'Origen inválido'});return true;}
  const kind=url.pathname.split('/')[3];
  try{const d=await readBody(req);send(res,200,await exclusive(()=>action(kind,d)));}
  catch(e){send(res,400,{error:/^https?:|bot\d+:/.test(e.message)?'No se pudo completar la conexión.':e.message});}
  return true;
 }
 return {handle,status,action:(kind,data)=>exclusive(()=>action(kind,data)),start:()=>exclusive(sync),stop:()=>exclusive(stop)};
}
module.exports={createNotificationAccess};

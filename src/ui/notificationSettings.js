'use strict';
const fs=require('node:fs'),path=require('node:path'),{parseEnv}=require('node:util');
function createNotificationSettings(root=path.resolve(__dirname,'../..')){
 const file=path.join(root,'.env');
 const read=()=>fs.existsSync(file)?parseEnv(fs.readFileSync(file,'utf8')):{};
 function write(values){
  let text=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  for(const [key,value]of Object.entries(values)){
   text=text.replace(new RegExp('^'+key+'=.*(?:\\r?\\n|$)','gm'),'');
   if(!text.endsWith('\n'))text+='\n';
   text+=key+'='+JSON.stringify(String(value))+'\n';
  }
  fs.writeFileSync(file+'.tmp',text,{mode:0o600});fs.renameSync(file+'.tmp',file);
 }
 function view(){const e=read();return {
  ntfyEnabled:e.NTFY_ENABLED==='true',ntfyTopic:e.NTFY_TOPIC||'',ntfyBaseUrl:e.NTFY_BASE_URL||'https://ntfy.sh',ntfyThreshold:Number(e.NTFY_THRESHOLD)||90,
  telegramEnabled:e.TELEGRAM_ENABLED==='true',hasTelegramToken:!!e.TELEGRAM_BOT_TOKEN,telegramUserId:e.TELEGRAM_ALLOWED_USER_ID||'',telegramBot:e.TELEGRAM_BOT_USERNAME||''
 };}
 function save(d){
  if(typeof d.ntfyEnabled!=='boolean')throw Error('Indicá si querés activar ntfy.');
  const topic=String(d.ntfyTopic||'').trim();if(topic&&!/^[A-Za-z0-9_-]{1,64}$/.test(topic))throw Error('Topic: usá hasta 64 letras, números, guiones o guiones bajos.');
  if(d.ntfyEnabled&&!topic)throw Error('Completá el topic para activar ntfy.');
  const url=new URL(d.ntfyBaseUrl||'https://ntfy.sh');
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||/^(localhost|127\.|0\.|\[|169\.254\.|10\.|192\.168\.)/i.test(url.hostname))throw Error('Servidor ntfy: usá un origen HTTPS público sin rutas ni credenciales.');
  const threshold=Number(d.ntfyThreshold);if(!Number.isInteger(threshold)||threshold<50||threshold>100)throw Error('Puntaje de avisos: entre 50 y 100.');
  write({NTFY_ENABLED:d.ntfyEnabled,NTFY_TOPIC:topic,NTFY_BASE_URL:url.origin,NTFY_THRESHOLD:threshold});return view();
 }
 return {read,write,view,save};
}
module.exports={createNotificationSettings};

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createNotificationSettings}=require('../ui/notificationSettings');
const {createNotificationAccess}=require('../ui/notificationAccess');
const {createHighMatchNotifier}=require('../notifications/ntfy');
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'jh-notifications-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('preferencias por instancia: conserva clave/perfil y no publica tokens',t=>{
 const a=temp(t),b=temp(t);fs.writeFileSync(path.join(a,'.env'),'OPENAI_API_KEY="synthetic-private-key"\nTELEGRAM_BOT_TOKEN="123:synthetic-secret"\nANALYZE_LIMIT="5"\n');
 const store=createNotificationSettings(a),other=createNotificationSettings(b);
 store.save({ntfyEnabled:true,ntfyTopic:'private-fixture',ntfyBaseUrl:'https://ntfy.sh',ntfyThreshold:85});
 assert.equal(store.read().OPENAI_API_KEY,'synthetic-private-key');assert.equal(store.read().ANALYZE_LIMIT,'5');
 assert(!JSON.stringify(store.view()).includes('synthetic-secret'));assert.equal(other.view().ntfyEnabled,false);
 assert.equal(other.view().hasTelegramToken,false);assert.equal(createNotificationSettings(a).view().ntfyThreshold,85);
 const before=fs.readFileSync(path.join(a,'.env'),'utf8');
 for(const patch of [{ntfyTopic:'bad/topic'},{ntfyBaseUrl:'http://localhost'},{ntfyThreshold:101}])assert.throws(()=>store.save({ntfyEnabled:true,ntfyTopic:'valid',ntfyBaseUrl:'https://ntfy.sh',ntfyThreshold:90,...patch}));
 assert.equal(fs.readFileSync(path.join(a,'.env'),'utf8'),before);
});
test('Telegram: apagado sin tráfico, identidad explícita, un listener, desvinculación',async t=>{
 const root=temp(t);let traffic=0,starts=0,stops=0,triggerCalls=0;let resolve;
 const service=createNotificationAccess({root,getTrigger:async()=>{triggerCalls++;return {};},apiFor:()=>({getMe:async()=>{traffic++;return {username:'fixture_bot'};},getUpdates:async()=>{traffic++;return [{message:{chat:{type:'private'},from:{id:123,first_name:'Cuenta de prueba'},date:Math.floor(Date.now()/1000)}},{message:{chat:{type:'group'},from:{id:999},date:Math.floor(Date.now()/1000)}}];},sendMessage:async()=>{traffic++;}}),makeListener:()=>({run:()=>{starts++;return new Promise(r=>resolve=r);},stop:()=>{stops++;resolve();}})});
 await service.start();assert.equal(traffic,0);assert.equal(triggerCalls,0);
 await assert.rejects(service.action('enabled',{enabled:true}),/Validá/);
 await service.action('token',{token:'123456:'+ 'a'.repeat(30)});
 const found=await service.action('detect');assert.equal(found.candidates.length,1);
 await assert.rejects(service.action('link',{detectionId:found.detectionId,userId:'999'}),/Detectá/);
 await service.action('link',{detectionId:found.detectionId,userId:'123'});assert.equal(starts,0);
 await service.action('enabled',{enabled:true});assert.equal(starts,1);assert.equal(service.status().telegramRunning,true);
 await service.action('enabled',{enabled:true});assert.equal(stops,1);assert.equal(starts,2);
 await service.action('unlink');assert.equal(service.status().telegramRunning,false);assert.equal(service.status().telegramEnabled,false);assert.equal(service.status().telegramUserId,'');
 assert(!JSON.stringify(service.status()).includes('a'.repeat(30)));
});
test('API rechaza origen ajeno y GET nunca envía ni ejecuta acciones',async t=>{
 const service=createNotificationAccess({root:temp(t),getTrigger:()=>{throw Error('must not run');}});
 let status,body;const res={writeHead:s=>status=s,end:s=>body=JSON.parse(s)};
 await service.handle({method:'POST',headers:{origin:'https://foreign.test',host:'localhost'}},res,new URL('http://localhost/api/notifications/enabled'),()=>{throw Error('must not read');});assert.equal(status,403);
 await service.handle({method:'GET',headers:{}},res,new URL('http://localhost/api/notifications'),()=>{});assert.equal(status,200);assert.equal(body.telegramEnabled,false);
});
test('umbral configurable solo afecta notificación, sin mutar el análisis',async()=>{
 let sent=0;const notifier=createHighMatchNotifier({env:{NTFY_ENABLED:'true',NTFY_TOPIC:'fixture',NTFY_THRESHOLD:'85'},send:async()=>{sent++;}});
 const job={jobId:'fixture',aiAnalysis:{overallMatchScore:87},title:'Fixture'};const before=JSON.stringify(job);
 await notifier.notifyHighMatch(job);assert.equal(sent,1);assert.equal(JSON.stringify(job),before);
});

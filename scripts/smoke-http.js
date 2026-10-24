const {spawn}=require('child_process'),assert=require('assert/strict'),path=require('path'),fs=require('fs');
const root=path.resolve(__dirname,'..');
async function run(){
 const instance=fs.readdirSync(path.join(root,'instances')).filter(n=>n.startsWith('test-')).sort().at(-1);
 const cwd=path.join(root,'instances',instance);
 fs.cpSync(path.join(root,'src'),path.join(cwd,'src'),{recursive:true,filter:p=>!/(candidate\.md|mariano(?:MatchingProfile|CareerContext|Profile)\.json)$/.test(p)&&!p.includes(path.join('data','jobs')+path.sep)});
 const port=49873,origin='http://127.0.0.1:'+port;
 const envFile=path.join(cwd,'.env');fs.writeFileSync(envFile,fs.readFileSync(envFile,'utf8').replace(/^UI_PORT=.*$/m,'UI_PORT='+port));
 const child=spawn(process.execPath,['src/ui/server.js'],{cwd,env:{...process.env,UI_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No arrancó la UI')),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',c=>{clearTimeout(timer);reject(Error('UI terminó '+c));});});
  assert.equal((await fetch(origin+'/')).status,200);
  assert((await(await fetch(origin+'/')).text()).includes('manualHuntBtn'));
  assert.equal((await fetch(origin+'/api/hunt')).status,200);
  assert.equal((await(await fetch(origin+'/api/hunt')).json()).huntRunning,false);
  assert.equal((await fetch(origin+'/api/hunt',{method:'POST',headers:{Origin:'https://foreign.example'}})).status,403);
  assert.equal((await fetch(origin+'/profile.html')).status,200);
  assert((await(await fetch(origin+'/settings.html')).text()).includes('0 desactiva los análisis pagos'));
  assert((await(await fetch(origin+'/api/profile-guide')).text()).includes('ChatGPT'));
  let r=await fetch(origin+'/api/profile',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({text:'## Profesión y especialidad\nArquitecta edilicia\n\n## Objetivos\nObra residencial'})});
  assert.equal(r.status,200);assert((await r.json()).diagnosis.missing.includes('Experiencia y responsabilidades'));
  assert((await(await fetch(origin+'/api/profile')).json()).text.includes('Obra residencial'));
  r=await fetch(origin+'/api/profile',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:'{"text":"malicioso"}'});assert.equal(r.status,403);
  assert(!(await(await fetch(origin+'/api/profile')).json()).text.includes('malicioso'));
  const superficial=require('../docs/validation-pilot/fixtures.json').profiles.superficial;
  r=await fetch(origin+'/api/profile',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({text:superficial})});
  assert.equal(r.status,200);const diagnosis=(await r.json()).diagnosis;
  assert.notEqual(diagnosis.status,'Perfil suficientemente documentado');
  assert(diagnosis.questions.some(q=>q.section==='Experiencia y responsabilidades'));
  assert(diagnosis.questions.some(q=>q.section==='Capacidades y herramientas'));
  r=await fetch(origin+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({apiKey:'synthetic-local-key',limit:0,minutes:0,query:'Arquitecta',location:'Barcelona'})});assert.equal(r.status,200);
  const state=await(await fetch(origin+'/api/settings')).json();assert.equal(state.limit,0);assert.equal(state.hasApiKey,true);assert(!JSON.stringify(state).includes('synthetic-local-key'));
  r=await fetch(origin+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({apiKey:'',limit:5,minutes:0,query:'Arquitecta',location:'Barcelona'})});assert.equal(r.status,200);assert.equal((await(await fetch(origin+'/api/settings')).json()).limit,5);
  assert(fs.readFileSync(path.join(cwd,'.env'),'utf8').includes('synthetic-local-key'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd,'schedule.json'))).minutes,0);
  console.log('PASS: UI, guía, importación/edición, diagnóstico, persistencia y protección de origen HTTP');
 }finally{child.kill();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});

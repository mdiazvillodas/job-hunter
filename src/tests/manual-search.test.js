'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { createManualSearch } = require('../ui/manualSearch');
test('búsqueda manual: GET no dispara, POST exige origen y reutiliza exclusión del runner', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-hunt-')); let spawned = 0;
  const child = new EventEmitter(); child.pid = 999999; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const handle = createManualSearch({ projectRoot: directory, runsDir: path.join(directory, 'runs'), log: () => {}, inspectLock: () => ({ busy: false }), spawnHunt: () => { spawned++; return child; } });
  const server = http.createServer((req, res) => { if (!handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { child.stdout.end(); child.stderr.end(); child.emit('close', 0); await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(origin + '/api/hunt')).status, 200); assert.equal(spawned, 0);
  assert.equal((await fetch(origin + '/api/hunt', { method: 'POST', headers: { Origin: 'https://foreign.example' } })).status, 403); assert.equal(spawned, 0);
  const started = await fetch(origin + '/api/hunt', { method: 'POST', headers: { Origin: origin } });
  assert.equal(started.status, 202); assert.equal(spawned, 1);
  const { runId } = await started.json();
  assert.equal((await fetch(origin + '/api/hunt', { method: 'POST', headers: { Origin: origin } })).status, 409); assert.equal(spawned, 1);
  assert.equal((await fetch(origin + '/api/hunt/run/' + runId)).status, 200);
  assert.equal((await fetch(origin + '/api/hunt/run/../../.env')).status, 404);
});


test('interfaz: al terminar actualiza la lista sin repetir POST; una conexión no se anuncia como búsqueda',async()=>{
 const vm=require('node:vm');
 for(const running of [true,false]){
  const bar={hidden:true,attributes:{},setAttribute(k,v){this.attributes[k]=v;}},status={textContent:''},button={disabled:true,addEventListener(){}};const timers=[],events=[],calls=[];
  const responses=[{busy:true,huntRunning:running,currentRunId:running?'run_fixture':null},{busy:false,huntRunning:false},{summary:{sources:{infojobs:{label:'InfoJobs',status:'completed',discovery:{uniqueResults:2},analysis:{analyzed:0}}}}}];
  const context={document:{getElementById:id=>id==='huntActivity'?bar:id==='manualHuntBtn'?button:status},window:{SessionApi:{request:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>responses.shift()};}},dispatchEvent:e=>events.push(e.type)},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},Event:class{constructor(type){this.type=type;}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/public/manualSearch.js'),'utf8'),context);
  await new Promise(setImmediate);assert(status.textContent.includes(running?'Búsqueda en curso':'Instancia ocupada'));assert.equal(bar.attributes['data-state'],running?'busy':'occupied');assert.equal(bar.hidden,false);
  await timers.shift()();assert.equal(button.disabled,false);assert.deepEqual(events,['hunt-finished']);assert.equal(bar.attributes['data-state'],'complete');assert(calls.every(c=>!c.options));assert(!status.textContent.includes('Actualizá la lista'));
 }
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('InfoJobs usa Chrome oficial y conserva exactamente las opciones existentes',async()=>{
 for(const platform of ['win32','linux']){
  let received,script;const context={addInitScript:async fn=>script=fn};
  const sandbox={module:{exports:{}},process:{platform,env:{DISPLAY:':1'}},require:name=>name==='playwright'?{chromium:{launchPersistentContext:async(p,o)=>{received={p,o};return context;}}}:{HEADLESS:false}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../infojobs/browser.js'),'utf8'),sandbox);
  await sandbox.module.exports.launchInfoJobsBrowser('/isolated/profile');
  assert.equal(received.p,'/isolated/profile');assert.equal(received.o.headless,false);
  if(platform==='win32')assert.equal(received.o.channel,'chrome');else assert.equal(received.o.executablePath,'/usr/bin/google-chrome-stable');
  assert(received.o.args.includes('--disable-blink-features=AutomationControlled'));assert(received.o.ignoreDefaultArgs.includes('--enable-automation'));
  // The init script remains present and unchanged in intent, with no extra evasions.
  assert(script.toString().includes("Object.defineProperty(navigator, 'webdriver'"));assert(script.toString().includes('window.chrome = { runtime: {} }'));
 }
});

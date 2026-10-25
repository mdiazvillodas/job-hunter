'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
const configFile=path.resolve(__dirname,'../config.js');
function config(settings,env={}){const real=createRequire(configFile),s={module:{exports:{}},__dirname:path.dirname(configFile),process:{env},require:name=>name==='fs'?{existsSync:()=>!!settings,readFileSync:()=>JSON.stringify(settings)}:real(name)};vm.runInNewContext(fs.readFileSync(configFile,'utf8'),s);return s.module.exports;}
test('fuentes y perfil InfoJobs pertenecen a cada instancia; valores anteriores se conservan',()=>{
 const a=config({query:'Arquitecto retail',location:'Barcelona',sources:['linkedin','infojobs']},{INFOJOBS_BROWSER_PROFILE_DIR:'browser-profile-infojobs-personal'});
 const b=config({query:'Operations',location:'Barcelona'});
 assert.deepEqual(Array.from(a.SOURCES),['linkedin','infojobs']);assert.deepEqual(Array.from(b.SOURCES),['linkedin']);
 assert.equal(a.INFOJOBS_BROWSER_PROFILE_DIR,path.resolve(path.dirname(configFile),'..','browser-profile-infojobs-personal'));
 assert.equal(b.INFOJOBS_BROWSER_PROFILE_DIR,path.resolve(path.dirname(configFile),'..','browser-profile-infojobs'));
});
test('InfoJobs headless independiente no cambia el modo global del navegador LinkedIn',async()=>{
 for(const [override,expected] of [['true',true],['false',false],[undefined,false]]){
  let options;const s={module:{exports:{}},process:{platform:'linux',env:{INFOJOBS_HEADLESS:override}},require:name=>name==='playwright'?{chromium:{launchPersistentContext:async(p,o)=>{options=o;return {addInitScript:async()=>{}};}}}:{HEADLESS:false}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../infojobs/browser.js'),'utf8'),s);await s.module.exports.launchInfoJobsBrowser('/own-profile');assert.equal(options.headless,expected);
 }
});
